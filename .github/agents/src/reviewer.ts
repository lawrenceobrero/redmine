import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { structuredCall } from "./llm.js";
import { checklistItem } from "./lenses.js";
import type { Finding, Lens } from "./types.js";

/**
 * REVIEWER agent. Scoped by construction: it receives one annotated diff as
 * text and returns findings — it has no file, git, shell, or network access.
 * Posting the resulting comment is done by the orchestrator, not the model.
 */

const PROMPTS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "prompts");

const FINDINGS_SCHEMA = {
  type: "object",
  properties: {
    findings: {
      type: "array",
      items: {
        type: "object",
        properties: {
          item: { type: "string", description: "Checklist item id, e.g. CQ1" },
          file: { type: "string", description: "Repo-relative path from the diff" },
          line: { type: "integer", description: "New-file line number (shown in the annotation)" },
          snippet: { type: "string", description: "Exactly one source line, copied verbatim" },
          issue: { type: "string" },
          suggestion: { type: "string" },
        },
        required: ["item", "file", "line", "snippet", "issue", "suggestion"],
        additionalProperties: false,
      },
    },
  },
  required: ["findings"],
  additionalProperties: false,
};

interface RawFinding {
  item: string;
  file: string;
  line: number;
  snippet: string;
  issue: string;
  suggestion: string;
}

const MAX_FINDINGS_PER_LENS = 10;

export async function runReviewer(annotatedDiff: string, lenses: Lens[]): Promise<Finding[]> {
  const findings: Finding[] = [];

  for (const lens of lenses) {
    const lensPrompt = readFileSync(join(PROMPTS_DIR, lens.promptFile), "utf8");
    const result = await structuredCall<{ findings: RawFinding[] }>({
      system: lensPrompt,
      user:
        "Review the following pull-request diff. Lines are prefixed with their " +
        "new-file line numbers.\n\n```diff\n" + annotatedDiff + "\n```",
      schema: FINDINGS_SCHEMA,
    });

    let n = 0;
    for (const raw of result.findings.slice(0, MAX_FINDINGS_PER_LENS)) {
      // Findings that reference unknown checklist items are discarded — the
      // model cannot invent categories (or severities; those live in code).
      if (!checklistItem([lens], raw.item)) continue;
      n += 1;
      findings.push({ ...raw, id: `${lens.id}/${raw.item}#${n}` });
    }
  }
  return findings;
}
