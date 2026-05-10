/**
 * Firecrawl client — backs the Researcher agent's live web access.
 *
 * Firecrawl runs locally in Docker (a docker-compose.yml at the firecrawl
 * checkout) and uses an internal Playwright service to
 * render JS-heavy sites. From the backend we only talk to the firecrawl API
 * on :3002; Playwright is an implementation detail of the scraper, not a
 * separate codepath.
 *
 * Two methods used by Researcher:
 *   - firecrawlSearch(q, n)  — POST /v1/search, returns search hits.
 *   - firecrawlScrape(url)   — POST /v1/scrape, returns clean markdown.
 *
 * Health probe + reachability return values are treated as soft failure
 * everywhere: Researcher continues with synthesis-only when firecrawl is
 * down (preserves Phase 1 behavior). Set RESEARCHER_USE_WEB=0 to disable
 * the web path entirely without touching this file.
 */

const FIRECRAWL_BASE_URL = process.env.FIRECRAWL_BASE_URL ?? "http://localhost:3002";
const FIRECRAWL_API_KEY = process.env.FIRECRAWL_API_KEY ?? null;
const FIRECRAWL_SEARCH_TIMEOUT_MS = 15_000;
const FIRECRAWL_SCRAPE_TIMEOUT_MS = 25_000;
const FIRECRAWL_HEALTH_TIMEOUT_MS = 3_000;

export interface FirecrawlSearchResult {
  url: string;
  title: string;
  description: string;
}

export interface FirecrawlScrapeResult {
  url: string;
  markdown: string;
  title: string | null;
}

export interface FirecrawlHealth {
  reachable: boolean;
  baseUrl: string;
  reason: string | null;
}

function authHeaders(): Record<string, string> {
  return FIRECRAWL_API_KEY
    ? { "Content-Type": "application/json", "Authorization": `Bearer ${FIRECRAWL_API_KEY}` }
    : { "Content-Type": "application/json" };
}

async function withTimeout<T>(ms: number, fn: (signal: AbortSignal) => Promise<T>): Promise<T | null> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fn(ctrl.signal);
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

export async function firecrawlHealth(): Promise<FirecrawlHealth> {
  const result = await withTimeout(FIRECRAWL_HEALTH_TIMEOUT_MS, async (signal) => {
    const r = await fetch(`${FIRECRAWL_BASE_URL}/`, { signal });
    return r.ok;
  });
  return {
    reachable: result === true,
    baseUrl: FIRECRAWL_BASE_URL,
    reason: result === true ? null : "no response on /",
  };
}

export async function firecrawlSearch(query: string, limit = 5): Promise<FirecrawlSearchResult[] | null> {
  return withTimeout(FIRECRAWL_SEARCH_TIMEOUT_MS, async (signal) => {
    const r = await fetch(`${FIRECRAWL_BASE_URL}/v1/search`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ query, limit }),
      signal,
    });
    if (!r.ok) return null;
    const d = (await r.json()) as {
      success?: boolean;
      data?: Array<{ url?: string; title?: string; description?: string }>;
    };
    if (!d.success || !Array.isArray(d.data)) return null;
    return d.data
      .filter((x): x is { url: string; title?: string; description?: string } => typeof x.url === "string")
      .map((x) => ({ url: x.url, title: x.title ?? "", description: x.description ?? "" }));
  });
}

export async function firecrawlScrape(url: string): Promise<FirecrawlScrapeResult | null> {
  return withTimeout(FIRECRAWL_SCRAPE_TIMEOUT_MS, async (signal) => {
    const r = await fetch(`${FIRECRAWL_BASE_URL}/v1/scrape`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ url, formats: ["markdown"], onlyMainContent: true }),
      signal,
    });
    if (!r.ok) return null;
    const d = (await r.json()) as {
      success?: boolean;
      data?: { markdown?: string; metadata?: { title?: string } };
    };
    if (!d.success || !d.data) return null;
    return {
      url,
      markdown: d.data.markdown ?? "",
      title: d.data.metadata?.title ?? null,
    };
  });
}
