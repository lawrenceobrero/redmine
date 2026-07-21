import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import Anthropic from "@anthropic-ai/sdk";

/** One model for all agents; swap here if needed. */
export const MODEL = "claude-opus-4-8";

/**
 * Backends (LLM_BACKEND env var):
 *   api        — default; the Anthropic API with schema-enforced structured
 *                outputs. The only backend live mode uses.
 *   claude-cli — local testing on a Claude subscription: routes the call
 *                through the Claude Code CLI (`claude -p`). JSON is requested
 *                by prompt, not enforced by the API.
 *   mock       — deterministic dry run, no credentials, no cost: canned
 *                responses for the seeded sample diff, so the whole
 *                pipeline (gates included) can be exercised offline.
 */
export interface LlmRequest {
  system: string;
  user: string;
  schema: Record<string, unknown>;
  maxTokens?: number;
}

export async function structuredCall<T>(opts: LlmRequest): Promise<T> {
  switch (process.env.LLM_BACKEND ?? "api") {
    case "mock":
      return mockCall<T>(opts);
    case "claude-cli":
      return cliCall<T>(opts);
    default:
      return apiCall<T>(opts);
  }
}

// ---- api (default) ---------------------------------------------------------

let client: Anthropic | null = null;

async function apiCall<T>(opts: LlmRequest): Promise<T> {
  client ??= new Anthropic();
  const response = await client.messages.create({
    model: MODEL,
    max_tokens: opts.maxTokens ?? 16000,
    thinking: { type: "adaptive" },
    system: opts.system,
    output_config: { format: { type: "json_schema", schema: opts.schema } },
    messages: [{ role: "user", content: opts.user }],
  });

  if (response.stop_reason === "refusal") {
    throw new Error("Model declined the request (stop_reason: refusal).");
  }
  if (response.stop_reason === "max_tokens") {
    throw new Error("Model output was truncated (stop_reason: max_tokens).");
  }
  const text = response.content.find((b) => b.type === "text");
  if (!text || text.type !== "text") {
    throw new Error("No text block in model response.");
  }
  return JSON.parse(text.text) as T;
}

// ---- claude-cli (local subscription testing) --------------------------------

const execFileAsync = promisify(execFile);

async function cliCall<T>(opts: LlmRequest): Promise<T> {
  const prompt = [
    opts.system,
    "",
    opts.user,
    "",
    "Respond with ONLY a single JSON object that validates against this JSON schema — no markdown fences, no commentary:",
    JSON.stringify(opts.schema),
  ].join("\n");

  const { stdout } = await execFileAsync("claude", ["-p", prompt, "--output-format", "json"], {
    maxBuffer: 32 * 1024 * 1024,
    timeout: 10 * 60 * 1000,
  });
  const envelope = JSON.parse(stdout) as { result?: string };
  const text = (envelope.result ?? "").trim();
  const jsonText = text.startsWith("```")
    ? text.replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, "")
    : text;
  return JSON.parse(jsonText) as T;
}

// ---- mock (deterministic dry run) -------------------------------------------

function mockCall<T>(opts: LlmRequest): T {
  const fixtures = JSON.parse(
    readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "..", "samples", "mock-responses.json"),
      "utf8",
    ),
  ) as { findings: unknown; fix: unknown };
  const properties = opts.schema.properties as Record<string, unknown> | undefined;
  const value = properties && "findings" in properties ? fixtures.findings : fixtures.fix;
  return value as T;
}
