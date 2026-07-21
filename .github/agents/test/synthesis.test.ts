import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { parseDiff } from "../src/diff.js";
import { LENSES } from "../src/lenses.js";
import { computeVerdict, matchSnippet, verifyFindings } from "../src/synthesis.js";
import type { Finding } from "../src/types.js";

// ---- fixture: a fake repo with one file, and the diff that "created" it ----

const FILE_LINES = [
  "module ProjectsHelper", // 1
  "  def version_options_for_select(versions, selected = nil)", // 2
  "    options_for_select(versions)", // 3
  "  end", // 4
  "", // 5
  "  def recent_issue_authors(project)", // 6
  "    project.issues.limit(10).map { |issue| issue.author.name }.uniq", // 7
  "  end", // 8
  "end", // 9
];

const DIFF = `diff --git a/app/helpers/projects_helper.rb b/app/helpers/projects_helper.rb
index 1111111..2222222 100644
--- a/app/helpers/projects_helper.rb
+++ b/app/helpers/projects_helper.rb
@@ -4,3 +4,7 @@
   end
+
+  def recent_issue_authors(project)
+    project.issues.limit(10).map { |issue| issue.author.name }.uniq
+  end
 end
`;

function makeRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "agents-test-"));
  const file = join(root, "app/helpers/projects_helper.rb");
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, FILE_LINES.join("\n"));
  return root;
}

function finding(overrides: Partial<Finding>): Finding {
  return {
    id: "code-quality/CQ1#1",
    item: "CQ1",
    file: "app/helpers/projects_helper.rb",
    line: 7,
    snippet: "    project.issues.limit(10).map { |issue| issue.author.name }.uniq",
    issue: "N+1: author is loaded per issue",
    suggestion: "eager-load with includes(:author)",
    ...overrides,
  };
}

// ---- parseDiff --------------------------------------------------------------

test("parseDiff extracts added lines with correct new-file numbers", () => {
  const files = parseDiff(DIFF);
  assert.equal(files.length, 1);
  assert.equal(files[0]!.path, "app/helpers/projects_helper.rb");
  assert.equal(files[0]!.addedCount, 4);
  assert.equal(
    files[0]!.addedLines.get(7),
    "    project.issues.limit(10).map { |issue| issue.author.name }.uniq",
  );
});

// ---- matchSnippet -----------------------------------------------------------

test("matchSnippet confirms an exact line and tolerates drift within the window", () => {
  assert.equal(matchSnippet(FILE_LINES, 7, FILE_LINES[6]!), 7);
  assert.equal(matchSnippet(FILE_LINES, 9, FILE_LINES[6]!), 7); // drifted by 2
  assert.equal(matchSnippet(FILE_LINES, 7, "something_that_is_not_there"), null);
});

// ---- verifyFindings: the mechanical staleness/scope check -------------------

test("confirms a finding whose snippet matches a changed line", () => {
  const repo = makeRepo();
  const [v] = verifyFindings([finding({})], repo, parseDiff(DIFF), LENSES);
  assert.equal(v!.status, "confirmed");
  assert.equal(v!.matchedLine, 7);
  assert.equal(v!.severity, "blocking"); // CQ1 severity comes from code, not the model
});

test("marks a finding stale when the snippet no longer exists", () => {
  const repo = makeRepo();
  const [v] = verifyFindings(
    [finding({ snippet: "    project.issues.includes(:author).map { |i| i.author.name }" })],
    repo,
    parseDiff(DIFF),
    LENSES,
  );
  assert.equal(v!.status, "stale");
});

test("marks a finding stale when the flagged file does not exist", () => {
  const repo = makeRepo();
  const [v] = verifyFindings([finding({ file: "app/models/deleted.rb" })], repo, parseDiff(DIFF), LENSES);
  assert.equal(v!.status, "stale");
});

test("marks a finding out_of_scope when the line was not changed by the PR", () => {
  const repo = makeRepo();
  const [v] = verifyFindings(
    [finding({ line: 3, snippet: "    options_for_select(versions)" })],
    repo,
    parseDiff(DIFF),
    LENSES,
  );
  assert.equal(v!.status, "out_of_scope");
});

test("discards model-supplied paths that escape the repository", () => {
  const repo = makeRepo();
  const [v] = verifyFindings([finding({ file: "../../etc/passwd" })], repo, parseDiff(DIFF), LENSES);
  assert.equal(v!.status, "stale");
  assert.match(v!.note ?? "", /escapes/);
});

test("discards findings whose checklist item id is unknown (no invented categories)", () => {
  const repo = makeRepo();
  const [v] = verifyFindings([finding({ item: "MADE_UP" })], repo, parseDiff(DIFF), LENSES);
  // unknown item -> defaults to suggestion severity and never blocks
  assert.equal(v!.severity, "suggestion");
});

// ---- computeVerdict ---------------------------------------------------------

test("verdict is CHANGES_REQUIRED only while a confirmed blocking finding remains", () => {
  const repo = makeRepo();
  const confirmed = verifyFindings([finding({})], repo, parseDiff(DIFF), LENSES);
  assert.equal(computeVerdict(confirmed), "CHANGES_REQUIRED");

  const stale = confirmed.map((f) => ({ ...f, status: "stale" as const }));
  assert.equal(computeVerdict(stale), "APPROVED");

  const suggestion = confirmed.map((f) => ({ ...f, severity: "suggestion" as const }));
  assert.equal(computeVerdict(suggestion), "APPROVE_WITH_SUGGESTIONS");
});
