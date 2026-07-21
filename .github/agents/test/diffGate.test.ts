import assert from "node:assert/strict";
import { test } from "node:test";
import { gateFixerDiff, MAX_CHANGED_LINES } from "../src/diffGate.js";

const base = {
  allowedFile: "app/helpers/projects_helper.rb",
  findingLine: 100,
  changedFiles: ["app/helpers/projects_helper.rb"],
  numstat: [{ path: "app/helpers/projects_helper.rb", added: 2, removed: 1 }],
  hunks: [{ newStart: 99, newCount: 3 }],
};

test("accepts a small edit to the flagged file near the flagged line", () => {
  const result = gateFixerDiff(base);
  assert.equal(result.allowed, true, result.reasons.join("; "));
});

test("rejects an empty diff", () => {
  const result = gateFixerDiff({ ...base, changedFiles: [], numstat: [], hunks: [] });
  assert.equal(result.allowed, false);
});

test("rejects edits touching more than one file", () => {
  const result = gateFixerDiff({
    ...base,
    changedFiles: ["app/helpers/projects_helper.rb", "app/models/issue.rb"],
  });
  assert.equal(result.allowed, false);
  assert.match(result.reasons.join(" "), /2 files/);
});

test("rejects edits to a file other than the flagged one", () => {
  const result = gateFixerDiff({ ...base, changedFiles: ["app/models/issue.rb"] });
  assert.equal(result.allowed, false);
});

test("rejects the pipeline's own directory even if a finding points there", () => {
  const file = ".github/workflows/agent-review.yml";
  const result = gateFixerDiff({
    ...base,
    allowedFile: file,
    changedFiles: [file],
    numstat: [{ path: file, added: 1, removed: 1 }],
  });
  assert.equal(result.allowed, false);
  assert.match(result.reasons.join(" "), /denylisted/);
});

for (const file of ["Gemfile.lock", "yarn.lock", ".github/agents/package-lock.json", "bin/rails", "extra/svn/reposman.sh", ".devcontainer/devcontainer.json"]) {
  test(`rejects denylisted path: ${file}`, () => {
    const result = gateFixerDiff({
      ...base,
      allowedFile: file,
      changedFiles: [file],
      numstat: [{ path: file, added: 1, removed: 0 }],
      hunks: [{ newStart: base.findingLine, newCount: 1 }],
    });
    assert.equal(result.allowed, false);
  });
}

test("rejects oversized edits (smallest-change budget)", () => {
  const result = gateFixerDiff({
    ...base,
    numstat: [{ path: base.allowedFile, added: MAX_CHANGED_LINES, removed: 5 }],
  });
  assert.equal(result.allowed, false);
  assert.match(result.reasons.join(" "), /exceeds the cap/);
});

test("rejects edits far away from the flagged line", () => {
  const result = gateFixerDiff({ ...base, hunks: [{ newStart: 400, newCount: 2 }] });
  assert.equal(result.allowed, false);
  assert.match(result.reasons.join(" "), /away from the flagged line/);
});
