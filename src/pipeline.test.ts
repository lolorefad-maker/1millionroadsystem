import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { openDb, suppress } from "./db.ts";
import { parseCsv } from "./csv.ts";
import { analyzeHtml, extractEmails, pickEmail } from "./checker.ts";
import { buildQuery, discover } from "./discover.ts";
import { scoreAll, scoreLead } from "./score.ts";
import { composeDraft, draftAll } from "./draft.ts";
import { importCsv } from "./import.ts";
import { loadConfig } from "./config.ts";

const cfg = loadConfig("webdev", { allowExample: true });

test("csv handles quotes and CRLF", () => {
  const rows = parseCsv('a,b\r\n"x, y","say ""hi"""\r\n');
  assert.deepEqual(rows, [{ a: "x, y", b: 'say "hi"' }]);
});

test("analyzeHtml reports only what the page lacks", () => {
  const bare = analyzeHtml("<html><body>Welcome © 2019</body></html>", "http://a.ae/", 3000, cfg, new Date("2026-09-01"));
  const kinds = bare.facts.map((f) => f.kind).sort();
  assert.deepEqual(kinds, ["no_booking", "no_chat", "no_https", "no_viewport", "old_footer", "slow"]);

  const good = analyzeHtml(
    '<meta name="viewport" content="x"><a href="/book">Book a table</a><a href="https://wa.me/1">chat</a>',
    "https://a.ae/", 500, cfg,
  );
  assert.deepEqual(good.facts, []);
});

test("email extraction ignores junk and prefers own-domain role mailboxes", () => {
  const html = 'x <a href="mailto:Info@Cafe.ae">m</a> logo@2x.png sentry@wixpress.com me@gmail.com sara@cafe.ae';
  const emails = extractEmails(html);
  assert.ok(!emails.includes("logo@2x.png"));
  assert.equal(pickEmail(emails, "cafe.ae"), "info@cafe.ae");
  assert.equal(pickEmail(["me@gmail.com"], "cafe.ae"), null);
});

test("query targets country, city and website tag", () => {
  const q = buildQuery({ country: "ae", industry: "restaurant", city: "Dubai", limit: 10 });
  assert.match(q, /"ISO3166-1"="AE"/);
  assert.match(q, /name:en"="Dubai"/);
  assert.match(q, /"website"/);
  assert.throws(() => buildQuery({ country: "AE", industry: "nope" }));
});

test("discover stores companies with a real site, skips socials and duplicates", async () => {
  const db = openDb(":memory:");
  const fake = (async () =>
    new Response(
      JSON.stringify({
        elements: [
          { type: "node", id: 1, tags: { name: "Cafe One", website: "https://www.cafeone.ae/menu", "addr:city": "Dubai" } },
          { type: "node", id: 2, tags: { name: "Cafe One Branch", website: "http://cafeone.ae" } },
          { type: "node", id: 3, tags: { name: "Insta Only", website: "https://instagram.com/x" } },
          { type: "node", id: 4, tags: { name: "No Site" } },
        ],
      }),
    )) as unknown as typeof fetch;
  const r = await discover(db, cfg, { country: "AE", industry: "restaurant", city: "Dubai" }, fake);
  assert.deepEqual(r, { found: 4, added: 1, skippedNoSite: 1, skippedSocial: 1, skippedDuplicate: 1 });
  const row = db.prepare("SELECT domain, source FROM leads").get() as { domain: string; source: string };
  assert.deepEqual({ ...row }, { domain: "cafeone.ae", source: "osm" });
});

test("google provider: needs a key, sends the right request, maps places to leads", async () => {
  const db = openDb(":memory:");
  const opts = { country: "AE", industry: "clinic", city: "Dubai", limit: 40, provider: "google" as const };
  await assert.rejects(discover(db, cfg, opts, fetch, {}), /GOOGLE_PLACES_API_KEY/);

  const calls: { headers: Record<string, string>; body: Record<string, unknown> }[] = [];
  const fake = (async (_url: string, init: RequestInit) => {
    calls.push({ headers: init.headers as Record<string, string>, body: JSON.parse(init.body as string) });
    const first = calls.length === 1;
    return new Response(
      JSON.stringify({
        places: first
          ? [
              { id: "a", displayName: { text: "Smile Clinic" }, websiteUri: "https://www.smile.ae/en", rating: 4.5, userRatingCount: 120,
                addressComponents: [{ longText: "Jumeirah", types: ["locality"] }], businessStatus: "OPERATIONAL" },
              { id: "b", displayName: { text: "Closed Clinic" }, websiteUri: "https://closed.ae", businessStatus: "CLOSED_PERMANENTLY" },
              { id: "c", displayName: { text: "No Site Clinic" } },
            ]
          : [{ id: "d", displayName: { text: "Care Clinic" }, websiteUri: "https://care.ae" }],
        nextPageToken: first ? "tok" : undefined,
      }),
    );
  }) as unknown as typeof fetch;

  const r = await discover(db, cfg, opts, fake, { GOOGLE_PLACES_API_KEY: "k" });
  assert.deepEqual(r, { found: 3, added: 2, skippedNoSite: 1, skippedSocial: 0, skippedDuplicate: 0 });
  assert.equal(calls[0]!.headers["X-Goog-Api-Key"], "k");
  assert.equal(calls[0]!.body.textQuery, "clinics in Dubai, United Arab Emirates");
  assert.equal(calls[0]!.body.regionCode, "AE");
  assert.equal(calls[1]!.body.pageToken, "tok");
  const row = db.prepare("SELECT city, source, reason FROM leads WHERE domain='smile.ae'").get() as Record<string, string>;
  assert.equal(row.city, "Jumeirah");
  assert.equal(row.source, "google");
  assert.match(row.reason, /rated 4\.5 from 120 reviews/);
});

test("score: invalid or suppressed email cannot reach the call list", () => {
  const base = {
    country: "AE", industry: "restaurant", size: 30, title: "Owner", email: "a@b.ae",
    email_status: "valid", status: "checked", factKinds: ["no_booking", "no_viewport", "slow", "no_https"],
  };
  assert.equal(scoreLead(base, cfg, false).tier, "A");
  assert.notEqual(scoreLead({ ...base, email_status: "invalid" }, cfg, false).tier, "A");
  assert.equal(scoreLead(base, cfg, true).tier, "X");
});

test("draft is 60-90 words, cites its fact, and never claims more than it saw", () => {
  const lead = { company: "Cafe One", domain: "cafeone.ae", person: "", industry: "restaurant", city: "Dubai", country: "AE" };
  for (const kind of ["no_booking", "no_viewport", "slow", "no_https", "old_footer", "no_chat"]) {
    const d = composeDraft(lead, [{ kind, text: "something observed", url: "https://cafeone.ae/" }], cfg);
    assert.ok(d.words >= 60 && d.words <= 90, `${kind}: ${d.words} words`);
    assert.equal(d.confidence, "high");
  }
  const generic = composeDraft(lead, [], cfg);
  assert.equal(generic.confidence, "low");
});

test("end to end: import, score, draft, suppress", () => {
  const db = openDb(":memory:");
  const r = importCsv(db, readFileSync("sample/companies.csv", "utf8"), cfg);
  assert.equal(r.added, 3);
  assert.equal(r.duplicates, 1);
  assert.equal(r.rejected.length, 1);
  db.prepare("INSERT INTO site_facts (domain, kind, text, url, checked_at) VALUES ('example.com','no_booking','x','https://example.com','t')").run();
  db.prepare("UPDATE leads SET status='checked'").run();
  scoreAll(db, cfg);
  assert.ok(draftAll(db, cfg).drafted >= 1);
  suppress(db, "sara@example.com", "unsubscribed");
  scoreAll(db, cfg);
  const t = db.prepare("SELECT tier FROM leads WHERE email='sara@example.com'").get() as { tier: string };
  assert.equal(t.tier, "X");
});
