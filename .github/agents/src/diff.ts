/** Unified-diff parsing. All staleness/scope checks build on this — real line
 *  comparisons, not a second model opinion. */

export interface DiffFile {
  path: string;
  /** New-file line number -> line content (without the leading '+'). */
  addedLines: Map<number, string>;
  addedCount: number;
  removedCount: number;
}

export function parseDiff(diffText: string): DiffFile[] {
  const files: DiffFile[] = [];
  let current: DiffFile | null = null;
  let newLine = 0;

  for (const raw of diffText.split("\n")) {
    if (raw.startsWith("+++ ")) {
      const p = raw.slice(4).trim();
      if (p === "/dev/null") {
        current = null; // file deletion — nothing added to track
      } else {
        current = { path: p.replace(/^b\//, ""), addedLines: new Map(), addedCount: 0, removedCount: 0 };
        files.push(current);
      }
      continue;
    }
    if (!current) continue;

    const hunk = raw.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) {
      newLine = parseInt(hunk[1]!, 10);
      continue;
    }
    if (raw.startsWith("+") && !raw.startsWith("+++")) {
      current.addedLines.set(newLine, raw.slice(1));
      current.addedCount += 1;
      newLine += 1;
    } else if (raw.startsWith("-") && !raw.startsWith("---")) {
      current.removedCount += 1;
    } else if (raw.startsWith(" ")) {
      newLine += 1;
    }
    // lines starting with "\" ("No newline at end of file") and blank
    // separators are ignored
  }
  return files;
}

/** Prefix added/context lines with their new-file line numbers so the
 *  Reviewer can report accurate locations. */
export function annotateDiff(diffText: string): string {
  const out: string[] = [];
  let newLine = 0;
  let inHunk = false;

  for (const raw of diffText.split("\n")) {
    const hunk = raw.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) {
      newLine = parseInt(hunk[1]!, 10);
      inHunk = true;
      out.push(raw);
      continue;
    }
    if (raw.startsWith("diff --git") || raw.startsWith("+++") || raw.startsWith("---") ||
        raw.startsWith("index ") || raw.startsWith("new file") || raw.startsWith("deleted file")) {
      inHunk = false;
      out.push(raw);
      continue;
    }
    if (!inHunk) {
      out.push(raw);
      continue;
    }
    if (raw.startsWith("+")) {
      out.push(`${String(newLine).padStart(5)} ${raw}`);
      newLine += 1;
    } else if (raw.startsWith("-")) {
      out.push(`      ${raw}`);
    } else if (raw.startsWith(" ")) {
      out.push(`${String(newLine).padStart(5)} ${raw}`);
      newLine += 1;
    } else {
      out.push(raw);
    }
  }
  return out.join("\n");
}

export function diffStats(files: DiffFile[]): { fileCount: number; changedLines: number } {
  return {
    fileCount: files.length,
    changedLines: files.reduce((sum, f) => sum + f.addedCount + f.removedCount, 0),
  };
}
