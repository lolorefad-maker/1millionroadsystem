import type { Candidate, DiscoverOptions } from "./discover.ts";

const ENDPOINT = "https://places.googleapis.com/v1/places:searchText";
const FIELDS = [
  "places.id",
  "places.displayName",
  "places.websiteUri",
  "places.nationalPhoneNumber",
  "places.googleMapsUri",
  "places.rating",
  "places.userRatingCount",
  "places.addressComponents",
  "places.businessStatus",
  "nextPageToken",
].join(",");

/** Search phrase per industry label. */
export const GOOGLE_QUERY: Record<string, string> = {
  restaurant: "restaurants",
  clinic: "clinics",
  "real estate": "real estate agencies",
  logistics: "logistics and freight companies",
  retail: "retail stores",
  gym: "gyms",
  hotel: "hotels",
  education: "schools and training centers",
};

const COUNTRY_NAME: Record<string, string> = {
  AE: "United Arab Emirates", SA: "Saudi Arabia", QA: "Qatar", KW: "Kuwait", BH: "Bahrain", OM: "Oman",
};

interface Place {
  id: string;
  displayName?: { text?: string };
  websiteUri?: string;
  nationalPhoneNumber?: string;
  googleMapsUri?: string;
  rating?: number;
  userRatingCount?: number;
  businessStatus?: string;
  addressComponents?: { longText?: string; types?: string[] }[];
}

export function placesQuery(o: DiscoverOptions): string {
  const what = GOOGLE_QUERY[o.industry];
  if (!what) throw new Error(`Unknown industry "${o.industry}". Known: ${Object.keys(GOOGLE_QUERY).join(", ")}`);
  const where = [o.city, COUNTRY_NAME[o.country.toUpperCase()] ?? o.country].filter(Boolean).join(", ");
  return `${what} in ${where}`;
}

/** Google Places API (New) Text Search, up to 3 pages of 20 results. */
export async function searchGoogle(
  o: DiscoverOptions,
  apiKey: string,
  doFetch: typeof fetch = fetch,
): Promise<Candidate[]> {
  const out: Candidate[] = [];
  const max = o.limit ?? 60;
  let pageToken: string | undefined;
  for (let page = 0; page < 3 && out.length < max; page++) {
    const res = await doFetch(ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json", "X-Goog-Api-Key": apiKey, "X-Goog-FieldMask": FIELDS },
      body: JSON.stringify({
        textQuery: placesQuery(o),
        regionCode: o.country.toUpperCase(),
        pageSize: Math.min(20, max - out.length),
        ...(pageToken ? { pageToken } : {}),
      }),
    });
    if (!res.ok) {
      const detail = ((await res.json().catch(() => null)) as { error?: { message?: string } } | null)?.error?.message;
      throw new Error(`Google Places returned ${res.status}${detail ? `: ${detail}` : ""}`);
    }
    const data = (await res.json()) as { places?: Place[]; nextPageToken?: string };
    for (const p of data.places ?? []) {
      if (p.businessStatus && p.businessStatus !== "OPERATIONAL") continue;
      const city = p.addressComponents?.find((c) => c.types?.includes("locality"))?.longText ?? o.city ?? "";
      const rated = p.rating ? `, rated ${p.rating} from ${p.userRatingCount ?? 0} reviews on Google` : "";
      out.push({
        name: p.displayName?.text ?? "",
        website: p.websiteUri ?? "",
        city,
        phone: p.nationalPhoneNumber ?? "",
        sourceUrl: p.googleMapsUri ?? `https://www.google.com/maps/place/?q=place_id:${p.id}`,
        source: "google",
        detail: rated,
      });
    }
    pageToken = data.nextPageToken;
    if (!pageToken) break;
  }
  return out;
}
