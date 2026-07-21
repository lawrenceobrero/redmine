import type { Lens } from "./types.js";

/**
 * The Reviewer takes a LIST of lenses as input. Phase 1 ships exactly one
 * (code-quality); this list is the extension point for Phase 2 lenses.
 *
 * Severity and fixability are decided here, in code — never by the model.
 * A finding whose `item` is not in the active lens's checklist is discarded.
 */
export const LENSES: Lens[] = [
  {
    id: "code-quality",
    name: "Code quality (Rails)",
    promptFile: "lens-code-quality.md",
    checklist: [
      { id: "CQ1", title: "N+1 query pattern introduced", severity: "blocking", fixable: true },
      { id: "CQ2", title: "Mass assignment / missing strong-parameters check", severity: "blocking", fixable: true },
      { id: "CQ3", title: "Leftover debug output or commented-out code", severity: "blocking", fixable: true },
      { id: "CQ4", title: "CI-flakiness-prone code (time/order dependence, sleeps)", severity: "blocking", fixable: true },
      { id: "CQ5", title: "Fat controller/model: logic in the wrong layer", severity: "suggestion", fixable: false },
      { id: "CQ6", title: "Oversized or mixed-concern PR shape", severity: "suggestion", fixable: false },
      { id: "CQ7", title: "Changed behavior lacks test coverage", severity: "suggestion", fixable: false },
    ],
  },
];

export function checklistItem(lenses: Lens[], itemId: string) {
  for (const lens of lenses) {
    const item = lens.checklist.find((c) => c.id === itemId);
    if (item) return item;
  }
  return undefined;
}
