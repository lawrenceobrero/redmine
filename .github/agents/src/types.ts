export type Severity = "blocking" | "suggestion";

export interface ChecklistItem {
  id: string;
  title: string;
  /** Severity is fixed per checklist item, in code — the LLM never chooses it. */
  severity: Severity;
  /** Whether the Fixer is allowed to attempt an automatic fix for this item. */
  fixable: boolean;
}

export interface Lens {
  id: string;
  name: string;
  /** Prompt file, relative to .github/prompts/. */
  promptFile: string;
  checklist: ChecklistItem[];
}

/** What the Reviewer returns for one issue (shape enforced via structured outputs). */
export interface Finding {
  id: string;
  /** Checklist item id, e.g. "CQ1". */
  item: string;
  /** Repo-relative path of the flagged file. */
  file: string;
  /** New-file line number of the flagged code. */
  line: number;
  /** Exactly one source line, quoted verbatim — the anchor for the mechanical staleness check. */
  snippet: string;
  issue: string;
  suggestion: string;
}

export type FindingStatus =
  | "confirmed" // snippet still present at/near the reported line, inside the PR's changed lines
  | "stale" // flagged file/line no longer matches what was described
  | "out_of_scope" // matches, but not on a line this PR changed — excluded from the verdict
  | "resolved" // was confirmed, then no longer matches after a Fixer commit
  | "fix_failed"; // a fix was attempted and rejected (gate, tests, or apply failure)

export interface VerifiedFinding extends Finding {
  status: FindingStatus;
  severity: Severity;
  fixable: boolean;
  /** Line where the snippet actually matched (may differ from the reported line). */
  matchedLine?: number;
  note?: string;
}

export type Verdict =
  | "APPROVED"
  | "APPROVE_WITH_SUGGESTIONS"
  | "CHANGES_REQUIRED"
  | "ESCALATED";

/** One row of the verdict → fix → outcome log. */
export interface RoundLog {
  round: number;
  verdict: Verdict;
  blocking: number;
  suggestions: number;
  action: string;
  commit?: string;
  testsPassed?: boolean;
}

export interface PipelineResult {
  verdict: Verdict;
  rounds: RoundLog[];
  findings: VerifiedFinding[];
  fixerCommits: string[];
  /** The real metric: confirmed blocking findings resolved by the Fixer's own commits. */
  resolvedByFixer: number;
  totalBlocking: number;
}
