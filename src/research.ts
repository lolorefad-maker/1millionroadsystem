import type { DatabaseSync } from "node:sqlite";

export interface ResearchItem {
  /** Stable id the proposal must cite, e.g. "site:/about" or "yt:abc123". */
  id: string;
  source: "site" | "youtube" | "link";
  title: string;
  text: string;
  url: string;
  date?: string;
}

type Fetch = typeof fetch;

const SITE_PATHS = ["about", "about-us", "services", "menu", "products", "our-story", "contact"];

export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|noscript|svg)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#\d+;|&[a-z]+;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function titleOf(html: string): string {
  return htmlToText(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "");
}

async function page(url: string, doFetch: Fetch): Promise<{ html: string; url: string } | null> {
  try {
    const res = await doFetch(url, {
      redirect: "follow",
      signal: AbortSignal.timeout(15_000),
      headers: { "user-agent": "Mozilla/5.0 (compatible; gulf-leads/0.1; website review)", "accept-language": "en,ar" },
    });
    if (!res.ok) return null;
    return { html: (await res.text()).slice(0, 400_000), url: res.url || url };
  } catch {
    return null;
  }
}

/** Public YouTube channel reference found on the company's own site. */
export function findYoutubeRef(html: string): { handle?: string; channelId?: string } | null {
  const m = html.match(/youtube\.com\/(@[\w.-]+|channel\/(UC[\w-]+))/i);
  if (!m) return null;
  return m[2] ? { channelId: m[2] } : { handle: m[1] };
}

interface YtVideo {
  id: string;
  snippet?: { title?: string; description?: string; publishedAt?: string };
  statistics?: { viewCount?: string };
}

/** Latest public videos through the official YouTube Data API (needs YOUTUBE_API_KEY). */
export async function youtubeItems(
  ref: { handle?: string; channelId?: string },
  key: string,
  doFetch: Fetch,
): Promise<ResearchItem[]> {
  const api = async <T>(path: string, params: Record<string, string>): Promise<T> => {
    const res = await doFetch(`https://www.googleapis.com/youtube/v3/${path}?${new URLSearchParams({ ...params, key })}`, {
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`YouTube API returned ${res.status}`);
    return (await res.json()) as T;
  };
  const ch = await api<{ items?: { id: string; snippet?: { title?: string }; contentDetails?: { relatedPlaylists?: { uploads?: string } } }[] }>(
    "channels",
    { part: "snippet,contentDetails", ...(ref.handle ? { forHandle: ref.handle } : { id: ref.channelId! }) },
  );
  const uploads = ch.items?.[0]?.contentDetails?.relatedPlaylists?.uploads;
  if (!uploads) return [];
  const pl = await api<{ items?: { contentDetails?: { videoId?: string } }[] }>("playlistItems", {
    part: "contentDetails", playlistId: uploads, maxResults: "8",
  });
  const ids = (pl.items ?? []).map((i) => i.contentDetails?.videoId).filter((x): x is string => !!x);
  if (!ids.length) return [];
  const vids = await api<{ items?: YtVideo[] }>("videos", { part: "snippet,statistics", id: ids.join(",") });
  return (vids.items ?? []).map((v) => ({
    id: `yt:${v.id}`,
    source: "youtube" as const,
    title: v.snippet?.title ?? "",
    text: `${v.snippet?.description ?? ""}`.slice(0, 600) + (v.statistics?.viewCount ? ` (${v.statistics.viewCount} views)` : ""),
    url: `https://www.youtube.com/watch?v=${v.id}`,
    date: v.snippet?.publishedAt?.slice(0, 10),
  }));
}

export interface Gathered {
  items: ResearchItem[];
  notes: string[];
}

/** Read the company's own public pages, its YouTube channel via the official API, and any links the owner added. */
export async function gather(
  domain: string,
  extraLinks: string[],
  env: Record<string, string | undefined>,
  doFetch: Fetch = fetch,
): Promise<Gathered> {
  const items: ResearchItem[] = [];
  const notes: string[] = [];

  const home = (await page(`https://${domain}/`, doFetch)) ?? (await page(`https://www.${domain}/`, doFetch));
  if (!home) {
    notes.push(`could not open ${domain}`);
  } else {
    items.push({ id: "site:home", source: "site", title: titleOf(home.html), text: htmlToText(home.html).slice(0, 2500), url: home.url });
    const seen = new Set<string>([home.url]);
    for (const p of SITE_PATHS) {
      if (items.length >= 5) break;
      const got = await page(new URL(`/${p}`, home.url).toString(), doFetch);
      if (!got || seen.has(got.url)) continue;
      seen.add(got.url);
      items.push({ id: `site:/${p}`, source: "site", title: titleOf(got.html), text: htmlToText(got.html).slice(0, 2000), url: got.url });
    }
    const yt = findYoutubeRef(home.html);
    if (yt && env.YOUTUBE_API_KEY) {
      try {
        const vids = await youtubeItems(yt, env.YOUTUBE_API_KEY, doFetch);
        items.push(...vids);
        if (!vids.length) notes.push("YouTube channel found but no public videos were returned");
      } catch (e) {
        notes.push(`YouTube skipped: ${(e as Error).message}`);
      }
    } else if (yt) notes.push("YouTube channel found, skipped: set YOUTUBE_API_KEY");
  }

  let n = 0;
  for (const url of extraLinks) {
    if (/instagram\.com|tiktok\.com|linkedin\.com|facebook\.com|x\.com|twitter\.com/i.test(url)) {
      notes.push(`not fetched (platform does not allow automated reading): ${url}`);
      continue;
    }
    const got = await page(url, doFetch);
    if (!got) {
      notes.push(`could not open ${url}`);
      continue;
    }
    items.push({ id: `link:${++n}`, source: "link", title: titleOf(got.html), text: htmlToText(got.html).slice(0, 2500), url: got.url });
  }
  return { items, notes };
}

export async function gatherForLead(
  db: DatabaseSync, leadId: number, env: Record<string, string | undefined>, doFetch: Fetch = fetch, now = new Date(),
): Promise<Gathered> {
  const lead = db.prepare("SELECT domain FROM leads WHERE id = ?").get(leadId) as { domain: string } | undefined;
  if (!lead) throw new Error(`No lead ${leadId}`);
  const links = (db.prepare("SELECT url FROM research_links WHERE lead_id = ?").all(leadId) as unknown as { url: string }[]).map((r) => r.url);
  const g = await gather(lead.domain, links, env, doFetch);
  db.prepare("INSERT OR REPLACE INTO research (lead_id, items, notes, gathered_at) VALUES (?, ?, ?, ?)").run(
    leadId, JSON.stringify(g.items), g.notes.join("; "), now.toISOString(),
  );
  return g;
}
