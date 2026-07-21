import { readFileSync, existsSync } from "node:fs";
import { resolve, sep } from "node:path";
import type { DiffFile } from "./diff.js";
import { checklistItem } from "./lenses.js";
import type { Finding, Lens, Verdict, VerifiedFinding } from "./types.js";

/**
 * SYNTHESIS agent — deliberately NOT a second LLM opinion. Every check here
 * is a real file/diff comparison:
 *   1. the flagged file still exists,
 *   2. the quoted snippet still matches at (or near) the reported line,
 *   3. the matched line is one this PR actually changed.
 * The verdict is computed from those results and fixed severity mappings.
 */

/** How far (in lines) a snippet may have drifted and still count as the same finding. */
const SEARCH_WINDOW = 20;
/** Tolerance for "is this line part of the PR's added lines" — ±1 only,
 *  since matchSnippet has already pinned the exact line of the flagged code. */
const SCOPE_TOLERANCE = 1;

export function matchSnippet(lines: string[], reportedLine: number, snippet: string): number | null {
  const target = (snippet.split("\n").find((l) => l.trim() !== "") ?? "").trim();
  if (!target) return null;
  const matches = (idx: number) => lines[idx] !== undefined && lines[idx]!.trim() === target;

  const center = reportedLine - 1;
  if (matches(center)) return reportedLine;
  for (let d = 1; d <= SEARCH_WINDOW; d++) {
    if (matches(center - d)) return reportedLine - d;
    if (matches(center + d)) return reportedLine + d;
  }
  return null;
}

function isChangedLine(diffFile: DiffFile | undefined, line: number): boolean {
  if (!diffFile) return false;
  for (let d = -SCOPE_TOLERANCE; d <= SCOPE_TOLERANCE; d++) {
    if (diffFile.addedLines.has(line + d)) return true;
  }
  return false;
}

export function verifyFindings(
  findings: Finding[],
  repoRoot: string,
  diffFiles: DiffFile[],
  lenses: Lens[],
): VerifiedFinding[] {
  const root = resolve(repoRoot);
  return findings.map((finding) => {
    const item = checklistItem(lenses, finding.item);
    const base: VerifiedFinding = {
      ...finding,
      status: "stale",
      severity: item?.severity ?? "suggestion",
      fixable: item?.fixable ?? false,
    };

    // The file path came from a model — never follow it outside the repo.
    const abs = resolve(root, finding.file);
    if (!abs.startsWith(root + sep)) {
      return { ...base, note: "path escapes the repository; discarded" };
    }
    if (!existsSync(abs)) {
      return { ...base, note: "flagged file no longer exists" };
    }

    const lines = readFileSync(abs, "utf8").split("\n");
    const matchedLine = matchSnippet(lines, finding.line, finding.snippet);
    if (matchedLine === null) {
      return { ...base, note: "quoted snippet no longer matches at or near the reported line" };
    }

    const diffFile = diffFiles.find((f) => f.path === finding.file);
    if (!isChangedLine(diffFile, matchedLine)) {
      return {
        ...base,
        status: "out_of_scope",
        matchedLine,
        note: "code exists but is not on a line this PR changed",
      };
    }
    return { ...base, status: "confirmed", matchedLine };
  });
}

export function computeVerdict(verified: VerifiedFinding[]): Verdict {
  const confirmed = verified.filter((f) => f.status === "confirmed");
  if (confirmed.some((f) => f.severity === "blocking")) return "CHANGES_REQUIRED";
  if (confirmed.length > 0) return "APPROVE_WITH_SUGGESTIONS";
  return "APPROVED";
}
