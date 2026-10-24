import { test } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import type { DatabaseSync } from "node:sqlite";
import { openDb } from "./db.ts";
import { loadConfig, type Config } from "./config.ts";
import { MemoryMailer, type InMail } from "./mail.ts";
import { findYoutubeRef, gather, htmlToText } from "./research.ts";
import { prepareProposal, sendProposal, validateProposal } from "./proposal.ts";
import type { Llm, ProposalDraft, Proposer, ReplyAnalysis } from "./agent.ts";
import { processInbox } from "./inbox.ts";
import { sendDue } from "./outreach.ts";
import { computeHealth, resume } from "./health.ts";
import { createDashboard } from "./server.ts";

const NOW = new Date("2026-10-21T06:00:00Z"); // Wednesday 10:00 in Dubai

const SITE = `<html><head><title>Cafe One</title></head><body>
  <script>var x = "ignore me";</script><h1>Cafe One Dubai</h1><p>Family cafe with a new terrace.</p>
  <a href="https://www.youtube.com/@cafeone">YouTube</a></body></html>`;

function fakeWeb(): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes("googleapis.com/youtube/v3/channels"))
      return new Response(JSON.stringify({ items: [{ id: "UC1", contentDetails: { relatedPlaylists: { uploads: "UU1" } } }] }));
    if (url.includes("playlistItems")) return new Response(JSON.stringify({ items: [{ contentDetails: { videoId: "v1" } }] }));
    if (url.includes("/videos?"))
      return new Response(JSON.stringify({ items: [{ id: "v1", snippet: { title: "Terrace tour", description: "Our new terrace", publishedAt: "2026-09-30T00:00:00Z" }, statistics: { viewCount: "12000" } }] }));
    if (url === "https://cafeone.ae/" || url === "https://www.cafeone.ae/") return new Response(SITE, { headers: { "content-type": "text/html" } });
    if (url === "https://blog.example.org/post") return new Response("<title>Post</title><p>We are opening a second branch.</p>");
    return new Response("nope", { status: 404 });
  }) as unknown as typeof fetch;
}

function setup(): { db: DatabaseSync; cfg: Config; mailer: MemoryMailer; leadId: number } {
  const cfg = loadConfig("webdev", { allowExample: true });
  cfg.outreach.mode = "auto";
  cfg.outreach.notifyEmail = "owner@studio.test";
  const db = openDb(":memory:");
  const id = Number(
    db
      .prepare(
        `INSERT INTO leads (company, domain, country, industry, person, title, email, email_status, source_url, source_date, reason, tier, score, status)
         VALUES ('Cafe One','cafeone.ae','AE','restaurant','Sara Ali','Owner','sara@cafeone.ae','valid','u','2026-10-01','r','A',90,'checked')`,
      )
      .run().lastInsertRowid,
  );
  db.prepare("INSERT INTO drafts (lead_id, subject, body, confidence, words, created_at) VALUES (?, 'Cafe One: note', 'Hi Sara', 'high', 2, 't')").run(id);
  return { db, cfg, mailer: new MemoryMailer(), leadId: id };
}

const draft = (over: Partial<ProposalDraft> = {}): ProposalDraft => ({
  business_summary: "A family cafe in Dubai with a new terrace.",
  observations: [{ text: "Your site announces a new terrace", source: "site:home" }, { text: "Terrace tour video has 12,000 views", source: "yt:v1" }],
  recommendations: [{ title: "Terrace booking", why: "Guests ask for the terrace", what_we_build: "Online table booking with terrace preference", effort_days: 10 }],
  mockup_outline: ["Home with terrace hero", "Booking page"],
  content_ideas: ["Embed the terrace tour video on the booking page"],
  question: "Would a 20 minute call this week work?",
  email_subject: "An idea for your terrace",
  email_intro: "I saw the new terrace on your site and the tour video people watched.",
  ...over,
});

class FakeProposer implements Proposer {
  inputs: unknown[] = [];
  private out: ProposalDraft;
  constructor(out: ProposalDraft) {
    this.out = out;
  }
  async propose(input: unknown): Promise<ProposalDraft> {
    this.inputs.push(input);
    return this.out;
  }
}

test("research reads the company's pages, public YouTube videos, and refuses social platforms", async () => {
  assert.equal(htmlToText("<script>x()</script><p>Hello &amp; welcome</p>"), "Hello & welcome");
  assert.deepEqual(findYoutubeRef(SITE), { handle: "@cafeone" });
  const g = await gather("cafeone.ae", ["https://blog.example.org/post", "https://www.instagram.com/cafeone"], { YOUTUBE_API_KEY: "k" }, fakeWeb());
  const ids = g.items.map((i) => i.id);
  assert.deepEqual(ids, ["site:home", "yt:v1", "link:1"]);
  assert.match(g.items[0]!.text, /new terrace/);
  assert.doesNotMatch(g.items[0]!.text, /ignore me/);
  assert.match(g.items[1]!.text, /12000 views/);
  assert.ok(g.notes.some((n) => n.includes("instagram.com")));
  const noKey = await gather("cafeone.ae", [], {}, fakeWeb());
  assert.ok(noKey.notes.some((n) => /YOUTUBE_API_KEY/.test(n)));
});

test("proposal validation: unsupported claims and prices never reach the owner", () => {
  const research = [{ id: "site:home", source: "site" as const, title: "t", text: "x", url: "https://cafeone.ae/" }];
  const good = validateProposal(draft(), research);
  assert.equal(good.ok, true);
  if (good.ok) assert.deepEqual(good.proposal.citations.map((c) => c.source), ["site:home"]); // the yt:v1 claim had no evidence and was dropped
  assert.equal(validateProposal(draft({ observations: [{ text: "invented", source: "site:nowhere" }] }), research).ok, false);
  const priced = validateProposal(draft({ recommendations: [{ title: "x", why: "y", what_we_build: "from AED 5,000", effort_days: 3 }] }), research);
  assert.equal(priced.ok, false);
});

test("prepareProposal stores a proposal that always waits for approval, then sends it in the thread", async () => {
  const { db, cfg, mailer, leadId } = setup();
  db.prepare("INSERT INTO handoffs (lead_id, reason, summary, need, created_at) VALUES (?, 'qualified', 's', 'online booking', 't')").run(leadId);
  db.prepare("INSERT INTO messages (lead_id, direction, kind, subject, body, message_id, status, at) VALUES (?, 'in', 'inbound', 'Re: x', 'Yes please', '<in-9@x>', 'received', 't')").run(leadId);
  const proposer = new FakeProposer(draft());
  const r = await prepareProposal(db, cfg, proposer, leadId, { YOUTUBE_API_KEY: "k" }, fakeWeb(), NOW);
  assert.equal(r.ok, true);
  assert.match(JSON.stringify(proposer.inputs[0]), /online booking/);
  rmSync("out/proposals/cafeone.ae.html", { force: true });

  const row = db.prepare("SELECT id, status, body FROM proposals").get() as { id: number; status: string; body: string };
  assert.equal(row.status, "pending_approval");
  assert.match(row.body, /Terrace booking/);
  assert.equal(mailer.sent.length, 0); // auto mode, still nothing leaves without a person

  await sendProposal(db, cfg, mailer, row.id, NOW);
  assert.equal(mailer.sent.at(-1)!.to, "sara@cafeone.ae");
  assert.equal(mailer.sent.at(-1)!.inReplyTo, "<in-9@x>");
  assert.equal((db.prepare("SELECT status FROM proposals WHERE id = ?").get(row.id) as { status: string }).status, "sent");
  await assert.rejects(sendProposal(db, cfg, mailer, row.id, NOW), /waiting for approval/);
});

test("an uncited proposal is saved as blocked with the reason, not as something to approve", async () => {
  const { db, cfg, leadId } = setup();
  const r = await prepareProposal(db, cfg, new FakeProposer(draft({ observations: [{ text: "invented", source: "nope" }] })), leadId, {}, fakeWeb(), NOW);
  assert.equal(r.ok, false);
  assert.equal((db.prepare("SELECT status FROM proposals").get() as { status: string }).status, "blocked");
});

let uid = 100;
const inbound = (over: Partial<InMail>): InMail => ({
  uid: ++uid, messageId: `<m-${uid}@x>`, inReplyTo: null, references: [], fromEmail: "sara@cafeone.ae", subject: "s", text: "t", automatic: false, ...over,
});

const hot: ReplyAnalysis = {
  category: "interested", fit: "hot", wants_meeting: true, needs_human_topic: false, asked_if_ai: false, need: "booking", timeline: "now",
  budget_signal: "", days_until_followup: 0, summary: "hot lead", reply: "Great, we will be in touch.",
};

test("a qualified reply triggers the proposal hook; a failing hook does not break the handoff", async () => {
  const { db, cfg, mailer, leadId } = setup();
  await sendDue(db, cfg, mailer, NOW);
  const llm: Llm = { analyze: async () => hot };
  let hooked = 0;
  mailer.inbox.push(inbound({ inReplyTo: "<out-1@test>", text: "Yes, call me" }));
  const r = await processInbox(db, cfg, mailer, llm, NOW, { onQualified: async () => { hooked++; throw new Error("research down"); } });
  assert.equal(hooked, 1);
  assert.equal(r.handoffs, 1);
  assert.equal((db.prepare("SELECT stage FROM leads WHERE id = ?").get(leadId) as { stage: string }).stage, "handoff");
});

test("a bounce notice kills the address; too many bounces pause all sending until resumed", async () => {
  const { db, cfg, mailer, leadId } = setup();
  await sendDue(db, cfg, mailer, NOW);
  mailer.inbox.push(inbound({ fromEmail: "mailer-daemon@googlemail.com", subject: "Delivery Status Notification (Failure)", text: "Address not found: sara@cafeone.ae" }));
  const r = await processInbox(db, cfg, mailer, { analyze: async () => hot }, NOW);
  assert.equal(r.bounced, 1);
  const l = db.prepare("SELECT stage, email_status FROM leads WHERE id = ?").get(leadId) as { stage: string; email_status: string };
  assert.deepEqual({ ...l }, { stage: "bounced", email_status: "invalid" });

  // 3 bounces out of 30 sent = 10%, far above the 2% limit.
  for (let i = 0; i < 30; i++) db.prepare("INSERT INTO messages (lead_id, direction, kind, subject, body, status, at) VALUES (?, 'out', 'touch1', 's', 'b', 'sent', ?)").run(leadId, NOW.toISOString());
  for (let i = 0; i < 2; i++) {
    const id = Number(db.prepare(`INSERT INTO leads (company, domain, country, industry, email, source_url, source_date, reason, stage, last_contact_at) VALUES ('b${i}','b${i}.ae','AE','restaurant','x@b${i}.ae','u','d','r','bounced',?)`).run(NOW.toISOString()).lastInsertRowid);
    assert.ok(id);
  }
  assert.ok(computeHealth(db, NOW).bounceRate > 0.02);
  const res = await sendDue(db, cfg, mailer, NOW);
  assert.match(res.paused ?? "", /bounce rate/);
  assert.equal((await sendDue(db, cfg, mailer, NOW)).sent, 0);
  resume(db);
  assert.equal(computeHealth(db, NOW).paused, null);
});

test("dashboard: needs the token, lists what waits, and approving goes through the same safe path", async () => {
  const { db, cfg, mailer, leadId } = setup();
  cfg.outreach.mode = "review";
  const server = createDashboard(db, cfg, () => mailer, "secret");
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = (path: string, method = "GET", body?: unknown, token = "secret") =>
    fetch(base + path, { method, headers: { "x-token": token, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  try {
    assert.equal((await call("/api/overview", "GET", undefined, "wrong")).status, 401);
    assert.match(await (await fetch(base + "/")).text(), /<html/);

    const pending = (await (await call("/api/pending")).json()) as { drafts: { lead_id: number }[] };
    assert.equal(pending.drafts.length, 1);

    // Editing the text in the dashboard changes what is sent; approving releases it to the sender.
    assert.equal((await call(`/api/drafts/${leadId}/approve`, "POST", { body: "Hi Sara, edited" })).status, 200);
    assert.equal((await sendDue(db, cfg, mailer, NOW)).sent, 1);
    assert.match(mailer.sent[0]!.text, /edited/);

    // A suppressed person can no longer be written to.
    assert.equal((await call(`/api/leads/${leadId}/suppress`, "POST", {})).status, 200);
    const detail = (await (await call(`/api/leads/${leadId}`)).json()) as { messages: unknown[]; lead: { stage: string } };
    assert.equal(detail.lead.stage, "closed_lost");
    assert.equal(detail.messages.length, 1);
    assert.equal((await call("/api/nothing")).status, 404);
  } finally {
    server.close();
  }
});

test("analytics: daily series and period totals agree, funnel and mixes are present", async () => {
  const { db, cfg, leadId } = setup();
  const day = (offset: number) => new Date(Date.now() - offset * 86_400_000).toISOString();
  const add = (dir: string, kind: string, at: string) =>
    db.prepare("INSERT INTO messages (lead_id, direction, kind, subject, body, status, at) VALUES (?, ?, ?, 's', 'b', 'sent', ?)").run(leadId, dir, kind, at);
  add("out", "touch1", day(0)); add("out", "touch1", day(2)); add("out", "touch2", day(3)); add("in", "inbound", day(1));
  add("out", "touch1", day(10)); // a week before the 7 day window: counted only as the previous period
  db.prepare("INSERT INTO handoffs (lead_id, reason, summary, created_at) VALUES (?, 'qualified', 's', ?)").run(leadId, day(1));
  db.prepare("UPDATE leads SET touches = 1 WHERE id = ?").run(leadId);

  const server = createDashboard(db, cfg, () => new MemoryMailer(), "t");
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const get = async (p: string) => (await fetch(base + p, { headers: { "x-token": "t" } })).json() as Promise<Record<string, any>>;
  try {
    const a = await get("/api/analytics?days=7");
    assert.equal(a.labels.length, 7);
    assert.equal(a.sent.reduce((x: number, y: number) => x + y, 0), a.totals.sent.now);
    assert.equal(a.totals.sent.now, 3);
    assert.equal(a.totals.sent.before, 1);
    assert.equal(a.totals.replies.now, 1);
    assert.equal(a.totals.qualified.now, 1);
    assert.deepEqual(a.funnel.map((f: { key: string }) => f.key), ["found", "contacted", "replied", "qualified", "proposal"]);
    assert.deepEqual(a.funnel.map((f: { n: number }) => f.n), [1, 1, 1, 1, 0]);
    assert.equal(a.tiers.A, 1);
    assert.equal(a.industries[0].industry, "restaurant");

    const o = await get("/api/overview");
    assert.equal(o.sendToday.cap, cfg.outreach.dailyCap);
    assert.equal(o.emails.valid, 1);
  } finally {
    server.close();
  }
});
