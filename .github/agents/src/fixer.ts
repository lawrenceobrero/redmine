import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve, sep } from "node:path";
import { structuredCall } from "./llm.js";
import type { VerifiedFinding } from "./types.js";

/**
 * FIXER agent. The model's entire output is one search/replace pair applied
 * mechanically — it cannot run commands, choose files, or write diffs
 * directly. What it produces is then checked again by the programmatic diff
 * gate (diffGate.ts) before any commit is allowed.
 */

const PROMPTS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "prompts");

const FIX_SCHEMA = {
  type: "object",
  properties: {
    search: { type: "string", description: "Verbatim excerpt of the current file, unique within it" },
    replace: { type: "string", description: "Replacement for the excerpt — the smallest change that resolves the finding" },
    rationale: { type: "string" },
  },
  required: ["search", "replace", "rationale"],
  additionalProperties: false,
};

export interface Fix {
  search: string;
  replace: string;
  rationale: string;
}

/** Lines of file context shown around the flagged line. */
const CONTEXT = 60;

export async function proposeFix(repoRoot: string, finding: VerifiedFinding): Promise<Fix> {
  const prompt = readFileSync(join(PROMPTS_DIR, "fixer.md"), "utf8");
  const abs = resolveInsideRepo(repoRoot, finding.file);
  const lines = readFileSync(abs, "utf8").split("\n");
  const line = finding.matchedLine ?? finding.line;
  const start = Math.max(0, line - 1 - CONTEXT);
  const end = Math.min(lines.length, line - 1 + CONTEXT);
  const excerpt = lines
    .slice(start, end)
    .map((l, i) => `${String(start + i + 1).padStart(5)}| ${l}`)
    .join("\n");

  return structuredCall<Fix>({
    system: prompt,
    user: [
      `File: ${finding.file}`,
      `Flagged line ${line}: ${finding.snippet.trim()}`,
      `Finding (${finding.item}): ${finding.issue}`,
      `Suggested direction: ${finding.suggestion}`,
      "",
      `Excerpt of the current file (line| content — do NOT include the "line| " prefix in your search string):`,
      "```",
      excerpt,
      "```",
    ].join("\n"),
    schema: FIX_SCHEMA,
  });
}

export function applyFix(repoRoot: string, file: string, fix: Fix): { ok: boolean; error?: string } {
  if (fix.search.trim() === "") return { ok: false, error: "empty search string" };
  if (fix.search === fix.replace) return { ok: false, error: "search and replace are identical" };

  const abs = resolveInsideRepo(repoRoot, file);
  const content = readFileSync(abs, "utf8");
  const first = content.indexOf(fix.search);
  if (first === -1) return { ok: false, error: "search string not found verbatim in the file" };
  if (content.indexOf(fix.search, first + 1) !== -1) {
    return { ok: false, error: "search string is not unique in the file" };
  }
  writeFileSync(abs, content.replace(fix.search, fix.replace));
  return { ok: true };
}

function resolveInsideRepo(repoRoot: string, file: string): string {
  const root = resolve(repoRoot);
  const abs = resolve(root, file);
  if (!abs.startsWith(root + sep)) throw new Error(`path escapes repository: ${file}`);
  return abs;
}
