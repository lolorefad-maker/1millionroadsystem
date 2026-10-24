import type { DatabaseSync } from "node:sqlite";
import type { Config } from "./config.ts";
import { normalizeDomain } from "./import.ts";
import { searchGoogle } from "./google.ts";

/** Industry label -> OpenStreetMap tag filters (OR-ed). */
export const OSM_TAGS: Record<string, string[]> = {
  restaurant: ['"amenity"~"^(restaurant|cafe|fast_food)$"'],
  clinic: ['"amenity"~"^(clinic|dentist|doctors)$"', '"healthcare"~"^(clinic|dentist|doctor)$"'],
  "real estate": ['"office"="estate_agent"'],
  logistics: ['"office"="logistics"', '"industrial"="warehouse"'],
  retail: ['"shop"~"^(clothes|electronics|furniture|jewelry|beauty|cosmetics|mobile_phone|sports)$"'],
  gym: ['"leisure"="fitness_centre"'],
  hotel: ['"tourism"~"^(hotel|guest_house|apartment)$"'],
  education: ['"amenity"~"^(school|kindergarten|language_school|training)$"'],
};

const SOCIAL = /(^|\.)(facebook|instagram|linktr\.ee|twitter|x|tiktok|youtube|wa|snapchat|linkedin|google|goo\.gl|wixsite|business\.site)\./i;

export type Provider = "osm" | "google";

export interface DiscoverOptions {
  country: string;
  industry: string;
  city?: string;
  limit?: number;
  provider?: Provider;
}

/** A company found by any provider, before it is filtered and stored. */
export interface Candidate {
  name: string;
  website: string;
  city: string;
  phone: string;
  sourceUrl: string;
  source: Provider;
  /** Extra phrase appended to the selection reason, e.g. ", rated 4.2 from 80 reviews". */
  detail: string;
}

export interface DiscoverResult {
  found: number;
  added: number;
  skippedNoSite: number;
  skippedSocial: number;
  skippedDuplicate: number;
}

type Fetch = typeof fetch;

export function buildQuery(o: DiscoverOptions): string {
  const filters = OSM_TAGS[o.industry];
  if (!filters) throw new Error(`Unknown industry "${o.industry}". Known: ${Object.keys(OSM_TAGS).join(", ")}`);
  const scope = o.city
    ? `area["name:en"="${o.city.replace(/"/g, "")}"](area.c)->.a;`
    : `.c->.a;`;
  const sel = filters
    .flatMap((f) => [`nwr[${f}]["website"](area.a);`, `nwr[${f}]["contact:website"](area.a);`])
    .join("\n  ");
  return `[out:json][timeout:90];
area["ISO3166-1"="${o.country.toUpperCase()}"][admin_level=2]->.c;
${scope}
(
  ${sel}
);
out center tags ${o.limit ?? 200};`;
}

interface OsmElement {
  type: string;
  id: number;
  tags?: Record<string, string>;
}

async function searchOsm(o: DiscoverOptions, doFetch: Fetch): Promise<Candidate[]> {
  const res = await doFetch("https://overpass-api.de/api/interpreter", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", "user-agent": "gulf-leads/0.1" },
    body: new URLSearchParams({ data: buildQuery(o) }),
  });
  if (!res.ok) throw new Error(`Overpass returned ${res.status}`);
  const { elements } = (await res.json()) as { elements: OsmElement[] };
  return elements.map((el) => {
    const t = el.tags ?? {};
    return {
      name: t.name ?? t["name:en"] ?? "",
      website: t.website ?? t["contact:website"] ?? "",
      city: t["addr:city"] ?? o.city ?? "",
      phone: t.phone ?? t["contact:phone"] ?? "",
      sourceUrl: `https://www.openstreetmap.org/${el.type}/${el.id}`,
      source: "osm" as const,
      detail: "",
    };
  });
}

export async function discover(
  db: DatabaseSync,
  cfg: Config,
  o: DiscoverOptions,
  doFetch: Fetch = fetch,
  env: Record<string, string | undefined> = process.env,
): Promise<DiscoverResult> {
  const country = o.country.toUpperCase();
  if (!cfg.icp.countries.includes(country)) throw new Error(`Country ${country} is not in profile icp.countries`);
  if (cfg.exclude.industries.includes(o.industry)) throw new Error(`Industry "${o.industry}" is excluded in the profile`);

  const provider = o.provider ?? "osm";
  let candidates: Candidate[];
  if (provider === "google") {
    const key = env.GOOGLE_PLACES_API_KEY;
    if (!key) throw new Error("Set GOOGLE_PLACES_API_KEY in .env (see .env.example) to use --provider google");
    candidates = await searchGoogle(o, key, doFetch);
  } else {
    candidates = await searchOsm(o, doFetch);
  }

  const out: DiscoverResult = { found: candidates.length, added: 0, skippedNoSite: 0, skippedSocial: 0, skippedDuplicate: 0 };
  const today = new Date().toISOString().slice(0, 10);
  const exists = db.prepare("SELECT 1 AS x FROM leads WHERE domain = ?");
  const insert = db.prepare(
    `INSERT OR IGNORE INTO leads
     (company, domain, country, industry, city, phone, source, source_url, source_date, reason)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const c of candidates) {
    if (!c.website || !c.name) {
      out.skippedNoSite++;
      continue;
    }
    const domain = normalizeDomain(c.website);
    if (!domain.includes(".") || SOCIAL.test(domain + ".")) {
      out.skippedSocial++;
      continue;
    }
    if (cfg.exclude.domains.includes(domain) || exists.get(domain)) {
      out.skippedDuplicate++;
      continue;
    }
    const city = c.city || o.city || "";
    insert.run(
      c.name, domain, country, o.industry, city, c.phone, c.source, c.sourceUrl, today,
      `${o.industry} business in ${city || country} with a public website${c.detail}`,
    );
    out.added++;
  }
  return out;
}
