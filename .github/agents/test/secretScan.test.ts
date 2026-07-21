import assert from "node:assert/strict";
import { test } from "node:test";
import { redactSecrets } from "../src/secretScan.js";

test("redacts Anthropic API keys", () => {
  const { text, hits } = redactSecrets("here: sk-ant-api03-AbCdEfGh123456789012 done");
  assert.equal(hits, 1);
  assert.ok(!text.includes("sk-ant-api03"));
  assert.ok(text.includes("[REDACTED]"));
});

test("redacts GitHub tokens (classic and fine-grained)", () => {
  const sample = "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345 and github_pat_11ABCDEFG0_abcdefghijklmnopqrstu";
  const { text, hits } = redactSecrets(sample);
  assert.equal(hits, 2);
  assert.ok(!/gh[p]_[A-Za-z0-9]{20}/.test(text));
});

test("redacts AWS access key ids and Slack tokens", () => {
  const { text, hits } = redactSecrets("AKIAIOSFODNN7EXAMPLE xoxb-123456789012-abcdef");
  assert.equal(hits, 2);
  assert.ok(!text.includes("AKIA"));
  assert.ok(!text.includes("xoxb-"));
});

test("redacts private key blocks", () => {
  const pem = "-----BEGIN RSA PRIVATE KEY-----\nMIIEow...\n-----END RSA PRIVATE KEY-----";
  const { text, hits } = redactSecrets(pem);
  assert.equal(hits, 1);
  assert.ok(!text.includes("BEGIN RSA"));
});

test("redacts generic secret-looking assignments but keeps the quotes", () => {
  const { text, hits } = redactSecrets(`config.api_key = "super-secret-value-123"`);
  assert.equal(hits, 1);
  assert.ok(text.includes(`"[REDACTED]"`));
});

test("leaves ordinary code untouched", () => {
  const code = `def project_issue_authors(project)\n  project.issues.map { |i| i.author.name }\nend`;
  const { text, hits } = redactSecrets(code);
  assert.equal(hits, 0);
  assert.equal(text, code);
});
