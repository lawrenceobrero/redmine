import { execFileSync } from "node:child_process";
import type { HunkPos, NumstatEntry } from "./diffGate.js";

export const FIXER_NAME = "redmine-agent-fixer";
export const FIXER_EMAIL = "agent-fixer@users.noreply.github.com";
export const FIXER_MARKER = "[agent-fixer]";

export function git(repoRoot: string, args: string[]): string {
  return execFileSync("git", args, { cwd: repoRoot, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

/** Paths modified/added in the working tree (what the Fixer actually did). */
export function workingTreeChanges(repoRoot: string): string[] {
  return git(repoRoot, ["status", "--porcelain"])
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => l.slice(3).trim());
}

export function workingTreeNumstat(repoRoot: string): NumstatEntry[] {
  return git(repoRoot, ["diff", "--numstat"])
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => {
      const [added, removed, ...path] = l.split("\t");
      return { path: path.join("\t"), added: Number(added) || 0, removed: Number(removed) || 0 };
    });
}

/** Hunk positions of the working-tree diff for one file (for the proximity check). */
export function workingTreeHunks(repoRoot: string, file: string): HunkPos[] {
  const out = git(repoRoot, ["diff", "-U0", "--", file]);
  const hunks: HunkPos[] = [];
  for (const line of out.split("\n")) {
    const m = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
    if (m) hunks.push({ newStart: parseInt(m[1]!, 10), newCount: m[2] ? parseInt(m[2], 10) : 1 });
  }
  return hunks;
}

/**
 * The hard cap counts Fixer commits over the PR's ENTIRE lifetime, not per
 * run — counted mechanically from git history. Note the fail-safe direction:
 * a forged marker in someone else's commit can only make the pipeline do
 * LESS (hit the cap sooner and escalate to a human), never more.
 */
export function countFixerCommits(repoRoot: string, baseRef: string): number {
  const log = git(repoRoot, ["log", "--format=%an\t%s", `${baseRef}..HEAD`]);
  return log
    .split("\n")
    .filter((l) => l.trim() !== "")
    .filter((l) => {
      const [author = "", subject = ""] = l.split("\t");
      return author === FIXER_NAME || subject.includes(FIXER_MARKER);
    }).length;
}

export function revertFile(repoRoot: string, file: string): void {
  git(repoRoot, ["checkout", "--", file]);
}

/** Commit ONLY the gated file with the bot identity; returns the short sha. */
export function commitFixer(repoRoot: string, file: string, message: string): string {
  git(repoRoot, ["add", "--", file]);
  git(repoRoot, [
    "-c", `user.name=${FIXER_NAME}`,
    "-c", `user.email=${FIXER_EMAIL}`,
    "commit", "-m", message,
  ]);
  return git(repoRoot, ["rev-parse", "--short", "HEAD"]).trim();
}

export function push(repoRoot: string, headRef: string): void {
  git(repoRoot, ["push", "origin", `HEAD:refs/heads/${headRef}`]);
}
