import { annotateDiff, diffStats, lineDelta, parseDiff } from "./diff.js";
import { gateFixerDiff } from "./diffGate.js";
import { applyFix, proposeFix, readFileInRepo, writeFileInRepo } from "./fixer.js";
import { countFixerCommits, workingTreeChanges, workingTreeHunks, workingTreeNumstat } from "./git.js";
import { LENSES } from "./lenses.js";
import { runReviewer } from "./reviewer.js";
import { computeVerdict, verifyFindings } from "./synthesis.js";
import type { PipelineResult, RoundLog, Verdict, VerifiedFinding } from "./types.js";

/** Hard cap: total Fixer commits per PR lifetime, then always escalate. */
export const MAX_FIXER_COMMITS = 3;
/** Cost ceiling: PRs larger than this are escalated to a human, unreviewed. */
export const MAX_DIFF_FILES = 25;
export const MAX_DIFF_LINES = 1000;

/** How each run mode talks to the outside world. The pipeline itself never
 *  posts, commits, pushes, or runs tests directly — only through this. */
export interface Reporter {
  info(message: string): void;
  postReview(body: string): Promise<void>;
  postVerdict(body: string): Promise<void>;
  /** Commit the gated fix + push. Returns short sha, or null when not committing (interactive). */
  commitAndPush(file: string, message: string): Promise<string | null>;
  /** Re-run the scoped unit tests after a fix. True = passed (or not configured). */
  retest(): Promise<boolean>;
}

export interface PipelineContext {
  repoRoot: string;
  diffText: string;
  /** Base ref for lifetime commit counting; null in interactive mode. */
  baseRef: string | null;
  reporter: Reporter;
}

export async function runPipeline(ctx: PipelineContext): Promise<PipelineResult> {
  const { reporter, repoRoot } = ctx;
  const diffFiles = parseDiff(ctx.diffText);
  const stats = diffStats(diffFiles);
  const rounds: RoundLog[] = [];
  const fixerCommits: string[] = [];

  // ---- Cost ceiling: diff-size gate --------------------------------------
  if (stats.fileCount > MAX_DIFF_FILES || stats.changedLines > MAX_DIFF_LINES) {
    const body =
      `## Agent review: escalated to a human\n\n` +
      `This PR is too large for automatic review (${stats.fileCount} files, ` +
      `${stats.changedLines} changed lines; caps are ${MAX_DIFF_FILES} files / ` +
      `${MAX_DIFF_LINES} lines). Skipping to keep costs bounded — please review manually.`;
    await reporter.postVerdict(body);
    rounds.push(round(1, "ESCALATED", 0, 0, "diff-size gate: skipped auto-review"));
    return emptyResult("ESCALATED", rounds);
  }

  // ---- Reviewer ----------------------------------------------------------
  reporter.info(`Reviewing ${stats.fileCount} file(s), ${stats.changedLines} changed line(s)…`);
  const findings = await runReviewer(annotateDiff(ctx.diffText), LENSES);
  reporter.info(`Reviewer returned ${findings.length} finding(s).`);

  let verified = verifyFindings(findings, repoRoot, diffFiles, LENSES);
  await reporter.postReview(renderReviewComment(verified));

  // ---- Synthesis / Fixer loop ---------------------------------------------
  const priorCommits = ctx.baseRef ? countFixerCommits(repoRoot, ctx.baseRef) : 0;
  if (priorCommits > 0) {
    reporter.info(`${priorCommits} Fixer commit(s) already on this PR (lifetime cap ${MAX_FIXER_COMMITS}).`);
  }
  const attempted = new Set<string>();
  const resolvedIds = new Set<string>();
  const failedIds = new Map<string, string>();
  let verdict: Verdict = "APPROVED";
  let escalation: string | null = null;

  for (let r = 1; ; r++) {
    verified = applyHistory(
      verifyFindings(findings, repoRoot, diffFiles, LENSES),
      resolvedIds,
      failedIds,
    );
    verdict = computeVerdict(verified);
    const isActive = (f: VerifiedFinding) => f.status === "confirmed" || f.status === "fix_failed";
    const blocking = verified.filter((f) => isActive(f) && f.severity === "blocking");
    const suggestions = verified.filter((f) => isActive(f) && f.severity === "suggestion");

    if (verdict !== "CHANGES_REQUIRED") {
      rounds.push(round(r, verdict, blocking.length, suggestions.length, "no blocking findings left"));
      break;
    }

    // Hard cap — checked BEFORE each fix, across the PR's whole lifetime.
    if (priorCommits + fixerCommits.length >= MAX_FIXER_COMMITS) {
      escalation = `the hard cap of ${MAX_FIXER_COMMITS} Fixer commits per PR is reached`;
      verdict = "ESCALATED";
      rounds.push(round(r, verdict, blocking.length, suggestions.length, "commit cap reached — human takes over"));
      break;
    }

    const target = blocking.find((f) => f.fixable && !attempted.has(f.id));
    if (!target) {
      escalation = "the remaining blocking findings cannot be fixed automatically";
      verdict = "ESCALATED";
      rounds.push(round(r, verdict, blocking.length, suggestions.length, "no auto-fixable finding — human takes over"));
      break;
    }
    attempted.add(target.id);
    reporter.info(`Fixer attempting ${target.id} in ${target.file}:${target.matchedLine ?? target.line}…`);

    const outcome = await attemptFix(ctx, target);
    if (!outcome.ok) {
      failedIds.set(target.id, outcome.error);
      reporter.info(`Fix rejected: ${outcome.error}`);
      rounds.push(round(r, "CHANGES_REQUIRED", blocking.length, suggestions.length, `fix rejected: ${outcome.error}`, undefined, outcome.testsPassed));
      continue; // try the next fixable finding (attempts stay bounded by the cap + attempted set)
    }

    fixerCommits.push(outcome.commit ?? "(not committed)");
    resolvedIds.add(target.id);
    rounds.push(round(r, "CHANGES_REQUIRED", blocking.length, suggestions.length, `fixed ${target.id}`, outcome.commit ?? undefined, outcome.testsPassed));
  }

  verified = applyHistory(verifyFindings(findings, repoRoot, diffFiles, LENSES), resolvedIds, failedIds);
  const result: PipelineResult = {
    verdict,
    rounds,
    findings: verified,
    fixerCommits,
    resolvedByFixer: verified.filter((f) => f.status === "resolved").length,
    totalBlocking: verified.filter((f) => f.severity === "blocking" && f.status !== "out_of_scope" && f.status !== "stale").length,
  };
  await reporter.postVerdict(renderVerdictComment(result, escalation));
  return result;
}

// ---------------------------------------------------------------------------

async function attemptFix(
  ctx: PipelineContext,
  target: VerifiedFinding,
): Promise<{ ok: true; commit: string | null; testsPassed?: boolean } | { ok: false; error: string; testsPassed?: boolean }> {
  const { repoRoot, reporter } = ctx;

  let fix;
  try {
    fix = await proposeFix(repoRoot, target);
  } catch (err) {
    return { ok: false, error: `fixer model call failed: ${(err as Error).message}` };
  }

  // Snapshot the working tree BEFORE the fix, so the gate judges only the
  // delta the Fixer produced — pre-existing local changes (e.g. interactive
  // mode's applied sample diff) are not the Fixer's doing.
  const preChanged = new Set(workingTreeChanges(repoRoot));
  const preNumstat = new Map(workingTreeNumstat(repoRoot).map((n) => [n.path, n]));
  const originalContent = readFileInRepo(repoRoot, target.file);
  const rollback = () => writeFileInRepo(repoRoot, target.file, originalContent);

  const applied = applyFix(repoRoot, target.file, fix);
  if (!applied.ok) return { ok: false, error: applied.error ?? "apply failed" };

  // Guardrail: gate the diff the Fixer ACTUALLY produced, not what it said.
  // The target file's delta is measured from content (before vs after) —
  // numstat counts alone can miss an edit inside already-uncommitted lines.
  const newContent = readFileInRepo(repoRoot, target.file);
  const postNumstat = workingTreeNumstat(repoRoot);
  const otherChanged = workingTreeChanges(repoRoot).filter((file) => {
    if (file === target.file) return false;
    if (!preChanged.has(file)) return true; // newly touched by the fix
    const pre = preNumstat.get(file);
    const post = postNumstat.find((n) => n.path === file);
    return pre?.added !== post?.added || pre?.removed !== post?.removed;
  });
  const changedFiles = [
    ...(newContent === originalContent ? [] : [target.file]),
    ...otherChanged,
  ];
  const numstatDelta = [
    { path: target.file, ...lineDelta(originalContent, newContent) },
    ...otherChanged.map((file) => {
      const pre = preNumstat.get(file) ?? { path: file, added: 0, removed: 0 };
      const post = postNumstat.find((n) => n.path === file) ?? { path: file, added: 0, removed: 0 };
      return {
        path: file,
        added: Math.max(0, post.added - pre.added),
        removed: Math.max(0, post.removed - pre.removed),
      };
    }),
  ];
  const gate = gateFixerDiff({
    allowedFile: target.file,
    findingLine: target.matchedLine ?? target.line,
    changedFiles,
    numstat: numstatDelta,
    hunks: workingTreeHunks(repoRoot, target.file),
  });
  if (!gate.allowed) {
    rollback();
    return { ok: false, error: `diff gate rejected the edit (${gate.reasons.join("; ")})` };
  }

  // Guardrail: the fix must keep the scoped unit tests green.
  const testsPassed = await reporter.retest();
  if (!testsPassed) {
    rollback();
    return { ok: false, error: "the fix broke the scoped unit tests; reverted", testsPassed };
  }

  const commit = await ctx.reporter.commitAndPush(
    target.file,
    `agent-fix: ${target.item} in ${target.file} [agent-fixer]\n\n${target.issue}\n\nFix rationale: ${fix.rationale}`,
  );
  return { ok: true, commit, testsPassed };
}

function applyHistory(
  verified: VerifiedFinding[],
  resolvedIds: Set<string>,
  failedIds: Map<string, string>,
): VerifiedFinding[] {
  return verified.map((f) => {
    // A finding we fixed now fails its snippet match — that is resolution, not staleness.
    if (resolvedIds.has(f.id) && f.status === "stale") return { ...f, status: "resolved" as const };
    if (failedIds.has(f.id)) return { ...f, status: "fix_failed" as const, note: failedIds.get(f.id) };
    return f;
  });
}

function round(
  n: number,
  verdict: Verdict,
  blocking: number,
  suggestions: number,
  action: string,
  commit?: string,
  testsPassed?: boolean,
): RoundLog {
  return { round: n, verdict, blocking, suggestions, action, commit, testsPassed };
}

function emptyResult(verdict: Verdict, rounds: RoundLog[]): PipelineResult {
  return { verdict, rounds, findings: [], fixerCommits: [], resolvedByFixer: 0, totalBlocking: 0 };
}

// ---- Report rendering ------------------------------------------------------

const STATUS_LABEL: Record<string, string> = {
  confirmed: "🔴 confirmed",
  stale: "⚪ stale",
  out_of_scope: "⚪ out of scope",
  resolved: "✅ resolved by Fixer",
  fix_failed: "🟠 fix rejected — needs a human",
};

export function renderReviewComment(verified: VerifiedFinding[]): string {
  const lines = [
    "## 🔍 Reviewer findings (lens: code-quality)",
    "",
  ];
  if (verified.length === 0) {
    lines.push("No findings — nothing on the checklist matched this diff.");
    return lines.join("\n");
  }
  lines.push(
    "| # | Item | Severity | Location | Issue |",
    "|---|------|----------|----------|-------|",
  );
  for (const f of verified) {
    lines.push(
      `| ${f.id} | ${f.item} | ${f.severity} | \`${f.file}:${f.matchedLine ?? f.line}\` | ${escapeCell(f.issue)} |`,
    );
  }
  lines.push("", "_Each finding is verified mechanically (file/line/snippet comparison) before anything acts on it._");
  return lines.join("\n");
}

export function renderVerdictComment(result: PipelineResult, escalation: string | null): string {
  const emoji: Record<Verdict, string> = {
    APPROVED: "✅",
    APPROVE_WITH_SUGGESTIONS: "🟡",
    CHANGES_REQUIRED: "🔴",
    ESCALATED: "🙋",
  };
  const lines = [
    `## ${emoji[result.verdict]} Synthesis verdict: **${result.verdict}**`,
    "",
  ];
  if (escalation) {
    lines.push(`**Escalated to a human:** ${escalation}.`, "");
  }
  if (result.findings.length > 0) {
    lines.push(
      "| Finding | Severity | Location | Status |",
      "|---------|----------|----------|--------|",
    );
    for (const f of result.findings) {
      const note = f.note ? ` — ${escapeCell(f.note)}` : "";
      lines.push(
        `| ${f.id} | ${f.severity} | \`${f.file}:${f.matchedLine ?? f.line}\` | ${STATUS_LABEL[f.status] ?? f.status}${note} |`,
      );
    }
    lines.push("");
  }
  lines.push(
    "### Pipeline log (verdict → fix → outcome)",
    "",
    "| Round | Verdict | Blocking | Suggestions | Action | Commit | Tests |",
    "|-------|---------|----------|-------------|--------|--------|-------|",
  );
  for (const r of result.rounds) {
    const tests = r.testsPassed === undefined ? "—" : r.testsPassed ? "✅" : "❌";
    lines.push(
      `| ${r.round} | ${r.verdict} | ${r.blocking} | ${r.suggestions} | ${escapeCell(r.action)} | ${r.commit ?? "—"} | ${tests} |`,
    );
  }
  lines.push(
    "",
    `**Measured outcome:** ${result.resolvedByFixer}/${result.totalBlocking} confirmed blocking finding(s) resolved by the Fixer's own commit(s).`,
    "",
    "_This pipeline reviews, comments, and fixes — it never merges. A human owns the merge._",
  );
  return lines.join("\n");
}

function escapeCell(text: string): string {
  return text.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}
