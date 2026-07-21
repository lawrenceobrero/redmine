/** The Fixer's scoped-edit guardrail, enforced twice: the prompt instructs
 *  the model to touch only the flagged file/line, and this gate checks the
 *  diff the Fixer ACTUALLY produced before any commit/push is allowed.
 *  An instruction alone isn't enough — a crafted PR diff could try to talk
 *  the agent out of it; this code can't be talked out of anything. */

export interface NumstatEntry {
  path: string;
  added: number;
  removed: number;
}

export interface HunkPos {
  newStart: number;
  newCount: number;
}

export interface GateInput {
  /** The single file the confirmed finding points at. */
  allowedFile: string;
  /** The confirmed finding's line in that file. */
  findingLine: number;
  /** Files actually modified in the working tree after the Fixer ran. */
  changedFiles: string[];
  numstat: NumstatEntry[];
  /** Hunks of the produced diff for the allowed file. */
  hunks: HunkPos[];
}

export interface GateResult {
  allowed: boolean;
  reasons: string[];
}

/** "Smallest possible change": total added+removed lines the Fixer may produce. */
export const MAX_CHANGED_LINES = 30;
/** Every edit hunk must sit within this many lines of the flagged line. */
export const LINE_PROXIMITY = 30;

/** Paths the Fixer may never touch, regardless of what any finding says:
 *  the pipeline itself, lockfiles, executables, and install scripts. */
export const DENYLIST: RegExp[] = [
  /^\.github\//,
  /^\.devcontainer\//,
  /(^|\/)Gemfile\.lock$/,
  /(^|\/)package-lock\.json$/,
  /(^|\/)yarn\.lock$/,
  /\.lock$/,
  /^bin\//,
  /\.sh$/i,
  /(^|\/)Dockerfile[^/]*$/,
  /^config\/(boot|application|environment)\.rb$/,
];

export function gateFixerDiff(input: GateInput): GateResult {
  const reasons: string[] = [];

  if (input.changedFiles.length === 0) {
    reasons.push("the fixer produced no changes");
  }
  if (input.changedFiles.length > 1) {
    reasons.push(`touched ${input.changedFiles.length} files; exactly 1 is allowed`);
  }
  for (const file of input.changedFiles) {
    if (file !== input.allowedFile) {
      reasons.push(`touched '${file}' but only '${input.allowedFile}' is allowed`);
    }
    for (const deny of DENYLIST) {
      if (deny.test(file)) {
        reasons.push(`'${file}' matches denylisted path pattern ${deny}`);
      }
    }
  }

  const totalLines = input.numstat.reduce((sum, n) => sum + n.added + n.removed, 0);
  if (totalLines > MAX_CHANGED_LINES) {
    reasons.push(`${totalLines} changed lines exceeds the cap of ${MAX_CHANGED_LINES}`);
  }

  for (const hunk of input.hunks) {
    const start = hunk.newStart;
    const end = hunk.newStart + Math.max(hunk.newCount - 1, 0);
    const distance =
      input.findingLine < start
        ? start - input.findingLine
        : input.findingLine > end
          ? input.findingLine - end
          : 0;
    if (distance > LINE_PROXIMITY) {
      reasons.push(
        `edit at line ${start} is ${distance} lines away from the flagged line ${input.findingLine} (max ${LINE_PROXIMITY})`,
      );
    }
  }

  return { allowed: reasons.length === 0, reasons };
}
