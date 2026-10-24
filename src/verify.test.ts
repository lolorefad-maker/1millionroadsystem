import { test } from "node:test";
import assert from "node:assert/strict";
import type { DatabaseSync } from "node:sqlite";
import { openDb, suppress } from "./db.ts";
import { loadConfig, type Config } from "./config.ts";
import { MemoryMailer } from "./mail.ts";
import { sendDue } from "./outreach.ts";
import {
  HunterVerifier, LocalVerifier, ZeroBounceVerifier, VerifyStop, localCheck, pickVerifier, verifyLeads,
  type VerifyResult, type Verifier,
} from "./verify.ts";

const NOW = new Date("2026-10-21T06:00:00Z"); // Wednesday 10:00 in Dubai
const yes = async () => true;
const no = async () => false;

const reply = (status: number, body: unknown = {}) =>
  (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

test("local checks reject bad syntax, disposable domains and domains with no mail server", async () => {
  assert.deepEqual(await localCheck("not-an-email", yes), { status: "invalid", provider: "local", detail: "bad syntax" });
  assert.equal((await localCheck("a@mailinator.com", yes))?.detail, "disposable domain");
  assert.match((await localCheck("a@nomail.example", no))?.detail ?? "", /no MX/);
  assert.equal(await localCheck("info@cafe.ae", yes), null); // passes: still unconfirmed
});

test("Hunter: maps statuses and stops the batch on key, credit or rate-limit errors", async () => {
  const hunter = (s: string) => new HunterVerifier("k", reply(200, { data: { status: s } }));
  const st = async (s: string) => (await hunter(s).verify("a@b.ae"))?.status;
  assert.equal(await st("valid"), "valid");
  assert.equal(await st("invalid"), "invalid");
  assert.equal(await st("disposable"), "invalid");
  assert.equal(await st("accept_all"), "catch-all");
  assert.equal(await st("webmail"), "unknown");
  assert.equal(await st("unknown"), "unknown");
  assert.equal(await new HunterVerifier("k", reply(202)).verify("a@b.ae"), null);
  assert.equal(await new HunterVerifier("k", reply(222)).verify("a@b.ae"), null);
  assert.equal((await new HunterVerifier("k", reply(451)).verify("a@b.ae"))?.status, "invalid");
  await assert.rejects(new HunterVerifier("k", reply(401)).verify("a@b.ae"), /API key/);
  await assert.rejects(new HunterVerifier("k", reply(429)).verify("a@b.ae"), /credits/);
  await assert.rejects(new HunterVerifier("k", reply(403)).verify("a@b.ae"), /rate limit/);

  let seen: { url: string; key: string | null } | null = null;
  const spy = (async (url: string, init: RequestInit) => {
    seen = { url, key: new Headers(init.headers).get("x-api-key") };
    return new Response(JSON.stringify({ data: { status: "valid" } }));
  }) as unknown as typeof fetch;
  await new HunterVerifier("secret", spy).verify("a@b.ae");
  assert.match(seen!.url, /^https:\/\/api\.hunter\.io\/v2\/email-verifier\?email=a%40b\.ae$/); // key in the header, never in the URL
  assert.equal(seen!.key, "secret");
});

test("ZeroBounce: maps statuses and stops at the first error", async () => {
  const zb = (s: string) => new ZeroBounceVerifier("k", reply(200, { status: s, sub_status: "x" }));
  const st = async (s: string) => (await zb(s).verify("a@b.ae"))?.status;
  assert.equal(await st("valid"), "valid");
  for (const bad of ["invalid", "spamtrap", "abuse", "do_not_mail"]) assert.equal(await st(bad), "invalid", bad);
  assert.equal(await st("catch-all"), "catch-all");
  assert.equal(await st("unknown"), "unknown");
  await assert.rejects(new ZeroBounceVerifier("k", reply(200, { error: "Invalid API Key or your account ran out of credits" })).verify("a@b.ae"), VerifyStop);
});

test("provider choice follows the keys in .env", () => {
  assert.equal(pickVerifier({}).name, "local");
  assert.equal(pickVerifier({ HUNTER_API_KEY: "h" }).name, "hunter");
  assert.equal(pickVerifier({ HUNTER_API_KEY: "h", ZEROBOUNCE_API_KEY: "z" }).name, "zerobounce");
  assert.equal(pickVerifier({ ZEROBOUNCE_API_KEY: "z", VERIFY_PROVIDER: "local" }).name, "local");
  assert.throws(() => pickVerifier({ VERIFY_PROVIDER: "hunter" }), /not set/);
});

function setup(emails: { email: string; tier?: string; status?: string; stage?: string }[]): { db: DatabaseSync; cfg: Config; ids: number[] } {
  const cfg = loadConfig("webdev", { allowExample: true });
  cfg.outreach.mode = "auto";
  const db = openDb(":memory:");
  const ids = emails.map((e, i) => {
    const id = Number(
      db
        .prepare(
          `INSERT INTO leads (company, domain, country, industry, person, email, email_status, source_url, source_date, reason, tier, score, status, stage)
           VALUES (?, ?, 'AE', 'restaurant', 'Owner', ?, ?, 'u', 'd', 'r', ?, ?, 'checked', ?)`,
        )
        .run(`Co${i}`, e.email.split("@")[1]!, e.email, e.status ?? "unknown", e.tier ?? "A", 90 - i, e.stage ?? "prospect").lastInsertRowid,
    );
    db.prepare("INSERT INTO drafts (lead_id, subject, body, confidence, words, created_at, review) VALUES (?, 's', 'b', 'high', 1, 't', 'approved')").run(id);
    return id;
  });
  return { db, cfg, ids };
}

class Counting implements Verifier {
  readonly name = "fake";
  calls: string[] = [];
  private answers: Record<string, VerifyResult | null | Error>;
  constructor(answers: Record<string, VerifyResult | null | Error>) {
    this.answers = answers;
  }
  async verify(email: string): Promise<VerifyResult | null> {
    this.calls.push(email);
    const a = email in this.answers ? this.answers[email]! : { status: "valid" as const, provider: "fake", detail: "ok" };
    if (a instanceof Error) throw a;
    return a;
  }
}

test("verifyLeads: free checks first, cached answers reused, only A/B leads, credits never wasted", async () => {
  const { db, ids } = setup([
    { email: "good@a.ae" }, { email: "dead@b.ae" }, { email: "x@c.ae", tier: "C" }, { email: "later@d.ae" },
  ]);
  const v = new Counting({ "later@d.ae": null });
  // b.ae has no mail server: rejected locally, so the paid provider is never asked about it.
  const sum = await verifyLeads(db, v, { now: NOW, mx: async (d) => d !== "b.ae" });
  assert.deepEqual(v.calls.sort(), ["good@a.ae", "later@d.ae"]);
  assert.deepEqual({ valid: sum.valid, invalid: sum.invalid, retryLater: sum.retryLater }, { valid: 1, invalid: 1, retryLater: 1 });
  const status = (id: number) => (db.prepare("SELECT email_status, verified_at FROM leads WHERE id = ?").get(id) as { email_status: string; verified_at: string | null });
  assert.equal(status(ids[0]!).email_status, "valid");
  assert.equal(status(ids[1]!).email_status, "invalid");
  assert.equal(status(ids[2]!).verified_at, null); // tier C untouched
  assert.equal(status(ids[3]!).verified_at, null); // undecided, tried again next time

  // A second run asks only about the one that was undecided; the rest are remembered for 30 days.
  const v2 = new Counting({});
  await verifyLeads(db, v2, { now: new Date(NOW.getTime() + 86_400_000), mx: yes });
  assert.deepEqual(v2.calls, ["later@d.ae"]);
});

test("verifyLeads: a provider error stops the batch and leaves the rest unverified", async () => {
  const { db, ids } = setup([{ email: "a@a.ae" }, { email: "b@b.ae" }, { email: "c@c.ae" }]);
  const v = new Counting({ "b@b.ae": new VerifyStop("credits are used up") });
  const sum = await verifyLeads(db, v, { now: NOW, mx: yes });
  assert.equal(sum.stoppedBecause, "credits are used up");
  assert.deepEqual(v.calls, ["a@a.ae", "b@b.ae"]); // c was never asked
  assert.equal((db.prepare("SELECT verified_at FROM leads WHERE id = ?").get(ids[2]!) as { verified_at: string | null }).verified_at, null);
});

test("verifyLeads: already-valid imported emails, suppressed people and a claimed address are handled", async () => {
  const { db, ids } = setup([{ email: "imp@a.ae", status: "valid" }, { email: "gone@b.ae" }, { email: "claimed@c.ae" }]);
  suppress(db, "gone@b.ae", "unsubscribed");
  const v = new Counting({ "claimed@c.ae": { status: "invalid", provider: "hunter", detail: "person asked not to be processed" } });
  await verifyLeads(db, v, { now: NOW, mx: yes });
  assert.deepEqual(v.calls, ["claimed@c.ae"]);
  assert.equal((db.prepare("SELECT 1 AS x FROM suppression WHERE value = 'claimed@c.ae'").get() as { x: number } | undefined)?.x, 1);
  assert.ok(ids.length);
});

test("local-only provider leaves addresses unconfirmed, never 'valid'", async () => {
  const { db, ids } = setup([{ email: "a@a.ae" }]);
  await verifyLeads(db, new LocalVerifier(), { now: NOW, mx: yes });
  assert.equal((db.prepare("SELECT email_status FROM leads WHERE id = ?").get(ids[0]!) as { email_status: string }).email_status, "unknown");
});

test("sending: only confirmed-valid addresses get a first message; unconfirmed ones share a small daily test", async () => {
  const { db, cfg } = setup([
    { email: "v1@a.ae", status: "valid" }, { email: "v2@b.ae", status: "valid" },
    { email: "u1@c.ae" }, { email: "u2@d.ae" }, { email: "c1@e.ae", status: "catch-all" }, { email: "u3@f.ae" }, { email: "u4@g.ae" },
    { email: "bad@h.ae", status: "invalid" },
  ]);
  cfg.outreach.dailyCap = 50;
  const mailer = new MemoryMailer();
  const r = await sendDue(db, cfg, mailer, NOW);
  // 2 valid + 3 risky test sends (default allowance) = 5; 2 more risky held; the invalid one never.
  assert.equal(r.sent, 5);
  assert.equal(r.heldUnverified, 2);
  assert.ok(!mailer.sent.some((m) => m.to === "bad@h.ae"));
  assert.equal(mailer.sent.filter((m) => !/^v/.test(m.to)).length, 3);

  // Same day again: the test allowance is spent, nothing more goes out.
  assert.equal((await sendDue(db, cfg, mailer, NOW)).sent, 0);
});

test("sending: require=false restores unlimited sending to unconfirmed addresses; a zero allowance blocks them", async () => {
  const a = setup([{ email: "u1@c.ae" }, { email: "u2@d.ae" }, { email: "u3@e.ae" }, { email: "u4@f.ae" }]);
  a.cfg.outreach.verification = { require: false };
  assert.equal((await sendDue(a.db, a.cfg, new MemoryMailer(), NOW)).sent, 4);
  const b = setup([{ email: "u1@c.ae" }, { email: "v@d.ae", status: "valid" }]);
  b.cfg.outreach.verification = { riskyDailyCap: 0 };
  const m = new MemoryMailer();
  assert.equal((await sendDue(b.db, b.cfg, m, NOW)).sent, 1);
  assert.equal(m.sent[0]!.to, "v@d.ae");
});

test("follow-ups to someone already contacted are not blocked by the verification gate", async () => {
  const { db, cfg, ids } = setup([{ email: "u1@c.ae" }]);
  cfg.outreach.verification = { riskyDailyCap: 1 };
  const m = new MemoryMailer();
  await sendDue(db, cfg, m, NOW);
  const later = new Date("2026-10-26T06:00:00Z"); // Monday, 5 days on
  assert.equal((await sendDue(db, cfg, m, later)).sent, 1);
  assert.equal(m.sent.length, 2);
  assert.ok(ids.length);
});
