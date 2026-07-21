import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { git } from "./git.js";
import { redactSecrets } from "./secretScan.js";
import { runPipeline, type Reporter } from "./run.js";

/**
 * INTERACTIVE mode entry — the exact same reviewer/synthesis/fixer pipeline,
 * run from the CLI against a local sample diff, using YOUR OWN API key.
 * No GitHub Actions, no shared secrets, no fork-PR risk: nothing here talks
 * to GitHub at all, and nothing commits or pushes.
 *
 *   cd .github/agents && ANTHROPIC_API_KEY=sk-ant-… npm run demo
 *
 * Options:
 *   --diff <path>   review a different unified diff (default: samples/seeded-bug.diff)
 *   --no-apply      the diff is already applied to the working tree
 */

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..", "..");

const args = process.argv.slice(2);
const diffFlag = args.indexOf("--diff");
const diffPath =
  diffFlag !== -1 && args[diffFlag + 1]
    ? resolve(process.cwd(), args[diffFlag + 1]!)
    : join(here, "..", "samples", "seeded-bug.diff");
const noApply = args.includes("--no-apply");

if (!existsSync(diffPath)) {
  console.error(`diff not found: ${diffPath}`);
  process.exit(1);
}
const diffText = readFileSync(diffPath, "utf8");

if (!noApply) {
  // Simulate "the PR branch is checked out": apply the sample diff locally.
  try {
    git(repoRoot, ["apply", "--check", diffPath]);
  } catch {
    console.error(
      "The diff does not apply cleanly to your working tree.\n" +
        "If you already applied it, re-run with --no-apply; otherwise run `git status` and clean up first.",
    );
    process.exit(1);
  }
  git(repoRoot, ["apply", diffPath]);
  console.log(`Applied ${diffPath} to the working tree (simulating a checked-out PR branch).\n`);
}

function print(title: string, body: string): void {
  const { text } = redactSecrets(body);
  console.log(`\n${"=".repeat(72)}\n${title}\n${"=".repeat(72)}\n${text}\n`);
}

const reporter: Reporter = {
  info: (message) => console.log(`· ${message}`),
  postReview: async (body) => print("REVIEWER COMMENT (would be posted to the PR)", body),
  postVerdict: async (body) => print("SYNTHESIS VERDICT (would be posted to the PR)", body),
  async commitAndPush(file) {
    console.log(`· Fix applied to ${file} in the working tree — interactive mode never commits or pushes.`);
    return null;
  },
  async retest() {
    const cmd = process.env.RETEST_CMD;
    if (!cmd) {
      console.log("· RETEST_CMD not set — skipping the scoped-test re-run (live mode always runs it).");
      return true;
    }
    try {
      execSync(cmd, { cwd: repoRoot, stdio: "inherit", timeout: 15 * 60 * 1000 });
      return true;
    } catch {
      return false;
    }
  },
};

const result = await runPipeline({ repoRoot, diffText, baseRef: null, reporter });

console.log(`Verdict: ${result.verdict}`);
console.log(`Inspect what the Fixer changed with:  git diff`);
console.log(`Reset the demo with:                  git checkout -- . && git status`);
