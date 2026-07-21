/** Minimal GitHub REST helpers (Node's global fetch; no extra deps).
 *  Note what is absent: there is no merge call anywhere in this pipeline —
 *  a human always owns the merge. */

const API = "https://api.github.com";

async function gh<T>(token: string, method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/vnd.github+json",
      "content-type": "application/json",
      "x-github-api-version": "2022-11-28",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`GitHub API ${method} ${path} failed: ${res.status} ${await res.text()}`);
  }
  return (await res.json()) as T;
}

export async function fetchPrDiff(token: string, repo: string, prNumber: number): Promise<string> {
  const res = await fetch(`${API}/repos/${repo}/pulls/${prNumber}`, {
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/vnd.github.diff",
      "x-github-api-version": "2022-11-28",
    },
  });
  if (!res.ok) {
    throw new Error(`fetching PR diff failed: ${res.status} ${await res.text()}`);
  }
  return res.text();
}

export async function createComment(token: string, repo: string, prNumber: number, body: string): Promise<void> {
  await gh(token, "POST", `/repos/${repo}/issues/${prNumber}/comments`, { body });
}

/** Create-or-update a comment identified by an invisible marker, so the
 *  verdict stays a single evolving comment instead of a pile. */
export async function upsertComment(
  token: string,
  repo: string,
  prNumber: number,
  marker: string,
  body: string,
): Promise<void> {
  const comments = await gh<Array<{ id: number; body: string }>>(
    token,
    "GET",
    `/repos/${repo}/issues/${prNumber}/comments?per_page=100`,
  );
  const existing = comments.find((c) => c.body.includes(marker));
  const full = `${marker}\n${body}`;
  if (existing) {
    await gh(token, "PATCH", `/repos/${repo}/issues/comments/${existing.id}`, { body: full });
  } else {
    await gh(token, "POST", `/repos/${repo}/issues/${prNumber}/comments`, { body: full });
  }
}
