// The agent's single tool: web search, backed by Tavily.
// Tavily returns extracted page text with each hit (so we need no separate fetch tool)
// and supports real date filters, which is what makes "what changed since Monday" work.

export interface SearchArgs {
  query: string;
  since?: string; // YYYY-MM-DD, only results published on/after
  until?: string;
  news?: boolean; // news topic: better for "what's new / announced"
  thorough?: boolean; // advanced depth: slower, better passage extraction
}

export interface SearchHit {
  title: string;
  url: string;
  date?: string;
  content: string;
  /** "recent" = from the dated (since) search; "current" = undated look at the live state. */
  kind?: "recent" | "current";
  /** Domain looks like the subject's own site (e.g. supabase.com for "Supabase pricing"). */
  official?: boolean;
}

const cache = new Map<string, { at: number; hits: SearchHit[] }>();
const TTL_MS = 10 * 60_000;
const TIMEOUT_MS = 20_000;

export async function webSearch(args: SearchArgs): Promise<SearchHit[]> {
  const key = JSON.stringify(args);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.hits;

  const apiKey = process.env.TAVILY_API_KEY;
  if (!apiKey) throw new Error("TAVILY_API_KEY is not set");

  const body: Record<string, unknown> = {
    query: args.query,
    search_depth: args.thorough ? "advanced" : "basic",
    topic: args.news ? "news" : "general",
    max_results: 6,
    include_answer: false,
    ...(args.since ? { start_date: args.since } : {}),
    ...(args.until ? { end_date: args.until } : {}),
    ...(args.thorough ? { chunks_per_source: 3 } : {}),
  };

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    let res = await fetchOnce(body, apiKey, ctl.signal);
    // One retry on transient failure; searches are idempotent.
    if (res.status >= 500 || res.status === 429) res = await fetchOnce(body, apiKey, ctl.signal);
    if (!res.ok) throw new Error(`search failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
    const json = (await res.json()) as {
      results?: { title: string; url: string; content: string; published_date?: string }[];
    };
    const hits = (json.results ?? []).map((r) => ({
      title: r.title,
      url: r.url,
      date: r.published_date,
      content: r.content.length > 1400 ? r.content.slice(0, 1400) + " …" : r.content,
    }));
    cache.set(key, { at: Date.now(), hits });
    return hits;
  } finally {
    clearTimeout(timer);
  }
}

function fetchOnce(body: unknown, apiKey: string, signal: AbortSignal) {
  return fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(body),
    signal,
  });
}

const QUERY_NOISE = new Set(
  "pricing price prices plan plans cost costs news features feature update updates latest current new announcement announcements release releases change changes changed review compare vs free tier starter pro team enterprise sales support cloud hosting managed".split(" "),
);

/** Registrable-ish name of a host: "docs.supabase.com" -> "supabase". */
function hostLabel(url: string): string {
  try {
    const parts = new URL(url).hostname.replace(/^www\./, "").split(".");
    return (parts.length >= 2 ? parts[parts.length - 2] : parts[0]).toLowerCase();
  } catch {
    return "";
  }
}

/**
 * Cheap, deterministic "is this the subject's own site?" check: the site's name must equal a
 * distinctive word of the query. Not perfect (a subject with an unrelated domain is missed) but
 * it reliably separates supabase.com from listicle blogs, which is what the verdict rules need.
 */
export function isOfficial(url: string, query: string): boolean {
  const label = hostLabel(url);
  if (label.length < 3) return false;
  const words = query.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 3 && !QUERY_NOISE.has(w) && !/^\d+$/.test(w));
  const joined = words.join("");
  return words.some((w) => w === label) || (label.length >= 5 && joined.includes(label));
}

const PRICEY = /pric|plan|cost|\$|tier|subscription|fee/i;

/**
 * The tool the model actually calls. A dated ("since X") search is only half the evidence for a
 * re-check: it finds news, but "nothing new" does not prove a value is unchanged. So whenever
 * `since` is set we ALSO fetch the current state of the same subject in parallel (no added
 * latency), merge, mark official sources, and put them first. The model cannot skip this.
 */
export async function searchWithBaseline(args: SearchArgs): Promise<SearchHit[]> {
  const jobs: Promise<SearchHit[]>[] = [webSearch(args)];
  if (args.since) {
    const current = args.query.replace(/\b(20\d\d|news|latest|updates?|announcements?|since)\b/gi, " ").replace(/\s+/g, " ").trim();
    jobs.push(webSearch({ query: current, thorough: PRICEY.test(current), news: false }).catch(() => []));
  }
  const [recent, cur = []] = await Promise.all(jobs);
  const seen = new Set<string>();
  const merged: SearchHit[] = [];
  for (const [kind, hits] of [["current", cur], ["recent", recent]] as const) {
    for (const h of hits) {
      if (seen.has(h.url)) continue;
      seen.add(h.url);
      merged.push({ ...h, kind: args.since ? kind : undefined, official: isOfficial(h.url, args.query) });
    }
  }
  // Official first, then keep the provider's relevance order.
  return merged.sort((a, b) => Number(!!b.official) - Number(!!a.official)).slice(0, 10);
}

export function formatHits(hits: SearchHit[]): string {
  if (!hits.length) return "No results. Try a different or broader query.";
  return hits
    .map((h, i) => {
      const tags = [h.official ? "OFFICIAL SITE" : "third-party", h.kind === "current" ? "current-state lookup" : h.kind === "recent" ? "dated since-search" : ""].filter(Boolean);
      return `Result ${i + 1}: ${h.title} (${tags.join("; ")})\nURL: ${h.url}${h.date ? `\nPublished: ${h.date}` : "\nPublished: unknown"}\n${h.content}`;
    })
    .join("\n\n");
}

/**
 * A machine-written verdict guide appended to every tool result. Instructions placed right next
 * to the evidence are followed far more reliably (esp. by small/fast models) than rules in the
 * system prompt, so the "may I say UNCHANGED?" decision is computed here, in code.
 */
export function evidenceNote(hits: SearchHit[], args: SearchArgs): string {
  const official = hits.filter((h) => h.official);
  const lines = ["", "--- EVIDENCE STATUS (computed by the tool, binding) ---"];
  lines.push(
    official.length
      ? `Official-site results: ${official.length} (${official.map((h) => hostLabel(h.url) + " " + new URL(h.url).pathname).slice(0, 3).join(", ")}). A value may be called UNCHANGED only if one of THESE shows it.`
      : "Official-site results: NONE. You may NOT label this subject UNCHANGED or confirm its current value. Say you could not confirm it on the official site.",
  );
  if (args.since) {
    const dated = hits.filter((h) => h.kind === "recent" && h.date && h.date >= args.since!);
    lines.push(
      dated.length
        ? `Dated developments on/after ${args.since}: ${dated.length} (${dated.map((h) => `${h.title.slice(0, 60)} [${h.date}]`).slice(0, 3).join("; ")}).`
        : `Dated developments on/after ${args.since}: none found. This is absence of news, not proof of no change.`,
    );
    lines.push("Never write a blanket 'nothing changed' unless EVERY subject has official-site confirmation.");
  }
  return lines.join("\n");
}
