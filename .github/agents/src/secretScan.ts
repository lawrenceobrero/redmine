/** Output secret scanning: every comment body passes through redactSecrets()
 *  before it is posted, in case a crafted diff tricks an agent into printing
 *  a credential. */

const PATTERNS: RegExp[] = [
  /sk-ant-[A-Za-z0-9_-]{8,}/g, // Anthropic API keys
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, // GitHub tokens (ghp_, gho_, ghu_, ghs_, ghr_)
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, // GitHub fine-grained PATs
  /\bAKIA[0-9A-Z]{16}\b/g, // AWS access key ids
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, // Slack tokens
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, // JWTs
  // Generic "key = 'value'" assignments with secret-ish names
  /((?:api[_-]?key|secret|token|password|passwd)\s*[:=]>?\s*["'])[^"']{12,}(["'])/gi,
];

export function redactSecrets(text: string): { text: string; hits: number } {
  let hits = 0;
  let out = text;
  for (const re of PATTERNS) {
    out = out.replace(re, (...args) => {
      hits += 1;
      // Keep the surrounding quotes for the generic assignment pattern.
      const groups = args.slice(1, -2).filter((g) => typeof g === "string");
      if (groups.length === 2) return `${groups[0]}[REDACTED]${groups[1]}`;
      return "[REDACTED]";
    });
  }
  return { text: out, hits };
}
