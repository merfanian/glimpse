// Small fetch wrapper for the metadata APIs: per-request timeout plus a single, bounded
// retry on HTTP 429 / 503 (Semantic Scholar's shared unauthenticated pool rate-limits
// aggressively; one short back-off recovers most requests).

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_RETRY_WAIT_MS = 3_000;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export async function apiFetch(
  url: string,
  { timeoutMs = DEFAULT_TIMEOUT_MS, retries = 1 }: { timeoutMs?: number; retries?: number } = {},
): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if ((res.status === 429 || res.status === 503) && attempt < retries) {
      const retryAfter = Number(res.headers.get("retry-after"));
      const wait = Number.isFinite(retryAfter) && retryAfter > 0
        ? Math.min(retryAfter * 1000, MAX_RETRY_WAIT_MS)
        : 1_100 + Math.random() * 600;
      await sleep(wait);
      continue;
    }
    return res;
  }
}
