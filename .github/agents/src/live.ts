import { execSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { commitFixer, push } from "./git.js";
import { createComment, fetchPrDiff, upsertComment } from "./github.js";
import { redactSecrets } from "./secretScan.js";
import { runPipeline, type Reporter } from "./run.js";

/**
 * LIVE mode entry — runs inside GitHub Actions on same-repo branches only
 * (the workflow's job-level `if` enforces that; fork PRs never reach this
 * code or the secrets it uses).
 */

const VERDICT_MARKER = "<!-- agent-pipeline:verdict -->";

function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing required env var ${name}`);
  return v;
}

const token = env("GITHUB_TOKEN");
const repo = env("REPO");
const prNumber = Number(env("PR_NUMBER"));
const baseRef = env("BASE_REF");
const headRef = env("HEAD_REF");
const retestCmd = process.env.RETEST_CMD ?? "";
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

/** Everything leaving this process is secret-scanned and size-capped first. */
function outbound(body: string): string {
  const { text, hits } = redactSecrets(body);
  if (hits > 0) console.warn(`secret scan redacted ${hits} match(es) from an outgoing comment`);
  return text.length > 60000 ? `${text.slice(0, 60000)}\n\n_(truncated)_` : text;
}

const reporter: Reporter = {
  info: (message) => console.log(message),

  postReview: (body) => createComment(token, repo, prNumber, outbound(body)),

  postVerdict: (body) => upsertComment(token, repo, prNumber, VERDICT_MARKER, outbound(body)),

  async commitAndPush(file, message) {
    const sha = commitFixer(repoRoot, file, message);
    // Pushing with the workflow's GITHUB_TOKEN never triggers another
    // workflow run (GitHub platform behavior) — one of three layers that
    // prevent the pipeline from re-triggering itself.
    push(repoRoot, headRef);
    return sha;
  },

  async retest() {
    if (!retestCmd) return true;
    try {
      execSync(retestCmd, { cwd: repoRoot, stdio: "inherit", timeout: 15 * 60 * 1000 });
      return true;
    } catch {
      return false;
    }
  },
};

const diffText = await fetchPrDiff(token, repo, prNumber);
const result = await runPipeline({ repoRoot, diffText, baseRef: `origin/${baseRef}`, reporter });

console.log(`\nDone. Verdict: ${result.verdict}; Fixer commits this run: ${result.fixerCommits.length}.`);
console.log(JSON.stringify({ verdict: result.verdict, rounds: result.rounds, resolvedByFixer: result.resolvedByFixer, totalBlocking: result.totalBlocking }, null, 2));
if (result.verdict === "ESCALATED") process.exitCode = 0; // escalation is a designed outcome, not a failure
