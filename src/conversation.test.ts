import { test } from "node:test";
import assert from "node:assert/strict";
import type { DatabaseSync } from "node:sqlite";
import { openDb, isSuppressed } from "./db.ts";
import { loadConfig, type Config } from "./config.ts";
import { MemoryMailer, stripQuoted, type InMail } from "./mail.ts";
import { approveDrafts, inSendWindow, sendDue } from "./outreach.ts";
import { approveReply, processInbox } from "./inbox.ts";
import type { Llm, ReplyAnalysis } from "./agent.ts";

const WED_10AM_DUBAI = new Date("2026-10-21T06:00:00Z");
const DAY = 86_400_000;

function setup(mode: "review" | "auto" = "review"): { db: DatabaseSync; cfg: Config; mailer: MemoryMailer; leadId: number } {
  const cfg = loadConfig("webdev", { allowExample: true });
  cfg.outreach.mode = mode;
  cfg.outreach.notifyEmail = "owner@studio.test";
  const db = openDb(":memory:");
  const r = db
    .prepare(
      `INSERT INTO leads (company, domain, country, industry, person, title, email, email_status, source_url, source_date, reason, tier, score, status)
       VALUES ('Cafe One','cafeone.ae','AE','restaurant','Sara Ali','Owner','sara@cafeone.ae','valid','u','2026-10-01','r','A',90,'checked')`,
    )
    .run();
  const leadId = Number(r.lastInsertRowid);
  db.prepare("INSERT INTO drafts (lead_id, subject, body, confidence, words, created_at) VALUES (?, 'Cafe One: note', 'Hi Sara, hello.', 'high', 3, 't')").run(leadId);
  return { db, cfg, mailer: new MemoryMailer(), leadId };
}

const analysis = (over: Partial<ReplyAnalysis>): ReplyAnalysis => ({
  category: "interested", fit: "warm", wants_meeting: false, needs_human_topic: false, asked_if_ai: false,
  need: "", timeline: "", budget_signal: "", days_until_followup: 0, summary: "s", reply: "Happy to help. What do you need?", ...over,
});

class FakeLlm implements Llm {
  calls = 0;
  private next: ReplyAnalysis | Error;
  constructor(next: ReplyAnalysis | Error) {
    this.next = next;
  }
  async analyze(): Promise<ReplyAnalysis> {
    this.calls++;
    if (this.next instanceof Error) throw this.next;
    return this.next;
  }
}

let uid = 0;
const incoming = (text: string, over: Partial<InMail> = {}): InMail => ({
  uid: ++uid, messageId: `<in-${uid}@x>`, inReplyTo: "<out-1@test>", references: [], fromEmail: "sara@cafeone.ae",
  subject: "Re: Cafe One: note", text, automatic: false, ...over,
});

test("sending window follows the configured weekdays and hours", () => {
  const { cfg } = setup();
  assert.equal(inSendWindow(WED_10AM_DUBAI, cfg.outreach), true);
  assert.equal(inSendWindow(new Date("2026-10-21T01:00:00Z"), cfg.outreach), false); // 05:00 Dubai
  assert.equal(inSendWindow(new Date("2026-10-24T06:00:00Z"), cfg.outreach), false); // Saturday
});

test("review mode holds the first message until approved; footer and unsubscribe header are added", async () => {
  const { db, cfg, mailer } = setup();
  assert.deepEqual(await sendDue(db, cfg, mailer, WED_10AM_DUBAI), { sent: 0, heldForApproval: 1, outsideWindow: false, capReached: false, heldUnverified: 0 });
  assert.equal(approveDrafts(db, "A"), 1);
  assert.equal((await sendDue(db, cfg, mailer, WED_10AM_DUBAI)).sent, 1);
  assert.match(mailer.sent[0]!.text, /reply "unsubscribe"/);
  assert.equal(mailer.sent[0]!.unsubscribeMailto, cfg.outreach.from.email);
});

test("nothing is sent outside the window or beyond the daily cap", async () => {
  const { db, cfg, mailer } = setup("auto");
  assert.equal((await sendDue(db, cfg, mailer, new Date("2026-10-24T06:00:00Z"))).outsideWindow, true);
  assert.equal(mailer.sent.length, 0);
  cfg.outreach.dailyCap = 0;
  assert.equal((await sendDue(db, cfg, mailer, WED_10AM_DUBAI)).capReached, true);
  assert.equal(mailer.sent.length, 0);
});

test("follow-ups come on schedule and stop after three touches", async () => {
  const { db, cfg, mailer } = setup("auto");
  let now = WED_10AM_DUBAI;
  await sendDue(db, cfg, mailer, now);
  assert.equal((await sendDue(db, cfg, mailer, new Date(now.getTime() + DAY))).sent, 0); // too early
  now = new Date(now.getTime() + 4 * DAY); // Sunday... move to next weekday inside window
  now = new Date("2026-10-26T06:00:00Z"); // Monday, 5 days later
  assert.equal((await sendDue(db, cfg, mailer, now)).sent, 1);
  now = new Date("2026-11-03T06:00:00Z"); // Tuesday, 8 days later
  assert.equal((await sendDue(db, cfg, mailer, now)).sent, 1);
  assert.equal((await sendDue(db, cfg, mailer, new Date("2026-12-01T06:00:00Z"))).sent, 0);
  assert.deepEqual(mailer.sent.map((m) => m.subject), ["Cafe One: note", "Re: Cafe One: note", "Re: Cafe One: note"]);
  assert.equal(mailer.sent[1]!.inReplyTo, "<out-1@test>");
});

test("any reply stops the sequence before the model is even asked", async () => {
  const { db, cfg, mailer, leadId } = setup("auto");
  await sendDue(db, cfg, mailer, WED_10AM_DUBAI);
  mailer.inbox.push(incoming("Tell me more"));
  await processInbox(db, cfg, mailer, new FakeLlm(new Error("llm down")), WED_10AM_DUBAI);
  const lead = db.prepare("SELECT stage, next_touch_at FROM leads WHERE id = ?").get(leadId) as { stage: string; next_touch_at: string | null };
  assert.equal(lead.stage, "handoff");
  assert.equal(lead.next_touch_at, null);
  assert.equal((await sendDue(db, cfg, mailer, new Date("2026-10-30T06:00:00Z"))).sent, 0);
});

test("unsubscribe words suppress at once without asking the model", async () => {
  const { db, cfg, mailer, leadId } = setup("auto");
  await sendDue(db, cfg, mailer, WED_10AM_DUBAI);
  const llm = new FakeLlm(analysis({}));
  mailer.inbox.push(incoming("Please unsubscribe me"));
  const r = await processInbox(db, cfg, mailer, llm, WED_10AM_DUBAI);
  assert.equal(r.suppressed, 1);
  assert.equal(llm.calls, 0);
  assert.equal(isSuppressed(db, "sara@cafeone.ae", "cafeone.ae"), true);
  assert.equal((db.prepare("SELECT stage FROM leads WHERE id = ?").get(leadId) as { stage: string }).stage, "unsubscribed");
  assert.equal(mailer.sent.length, 1); // only the first touch
});

test("a polite no is respected and suppressed", async () => {
  const { db, cfg, mailer } = setup("auto");
  await sendDue(db, cfg, mailer, WED_10AM_DUBAI);
  mailer.inbox.push(incoming("Not for us, thanks"));
  await processInbox(db, cfg, mailer, new FakeLlm(analysis({ category: "not_interested", reply: "" })), WED_10AM_DUBAI);
  assert.equal(isSuppressed(db, "sara@cafeone.ae", "cafeone.ae"), true);
  assert.equal(mailer.sent.length, 1);
});

test("out-of-office does not stop the sequence, only delays it", async () => {
  const { db, cfg, mailer, leadId } = setup("auto");
  await sendDue(db, cfg, mailer, WED_10AM_DUBAI);
  const llm = new FakeLlm(analysis({}));
  mailer.inbox.push(incoming("I am away until Monday", { automatic: true }));
  await processInbox(db, cfg, mailer, llm, WED_10AM_DUBAI);
  const lead = db.prepare("SELECT stage, next_touch_at FROM leads WHERE id = ?").get(leadId) as { stage: string; next_touch_at: string };
  assert.equal(lead.stage, "contacted");
  assert.equal(new Date(lead.next_touch_at).getTime(), WED_10AM_DUBAI.getTime() + 3 * DAY);
  assert.equal(llm.calls, 0);
});

test("interested lead who wants a call: AI reply queued, owner alerted, handed off", async () => {
  const { db, cfg, mailer, leadId } = setup("review");
  approveDrafts(db, "A");
  await sendDue(db, cfg, mailer, WED_10AM_DUBAI);
  mailer.inbox.push(incoming("Yes, we need online booking. Can we talk this week?"));
  const llm = new FakeLlm(analysis({ fit: "hot", wants_meeting: true, need: "online booking", timeline: "this week", summary: "Wants booking system" }));
  const r = await processInbox(db, cfg, mailer, llm, WED_10AM_DUBAI);
  assert.equal(r.queuedForApproval, 1);
  assert.equal(r.handoffs, 1);
  const notice = mailer.sent.at(-1)!;
  assert.equal(notice.to, "owner@studio.test");
  assert.match(notice.text, /online booking/);
  const h = db.prepare("SELECT reason, need FROM handoffs WHERE lead_id = ?").get(leadId) as { reason: string; need: string };
  assert.deepEqual({ ...h }, { reason: "qualified", need: "online booking" });

  // Review mode: nothing reached the prospect until the owner approves the reply.
  assert.equal(mailer.sent.filter((m) => m.to === "sara@cafeone.ae").length, 1);
  const pending = db.prepare("SELECT id, body FROM messages WHERE status = 'pending_approval'").get() as { id: number; body: string };
  assert.match(pending.body, /assistant to Your Name/);
  await approveReply(db, cfg, mailer, pending.id, WED_10AM_DUBAI);
  assert.equal(mailer.sent.filter((m) => m.to === "sara@cafeone.ae").length, 2);
});

test("auto mode answers a question and keeps the conversation going without handoff", async () => {
  const { db, cfg, mailer, leadId } = setup("auto");
  await sendDue(db, cfg, mailer, WED_10AM_DUBAI);
  mailer.inbox.push(incoming("How long does it take?"));
  const r = await processInbox(db, cfg, mailer, new FakeLlm(analysis({ category: "question" })), WED_10AM_DUBAI);
  assert.equal(r.replied, 1);
  assert.equal(r.handoffs, 0);
  const sent = mailer.sent.at(-1)!;
  assert.match(sent.text, /Happy to help/);
  assert.match(sent.text, /assistant to Your Name at Your Studio/);
  assert.equal(sent.inReplyTo, "<in-" + uid + "@x>");
  assert.equal((db.prepare("SELECT stage FROM leads WHERE id = ?").get(leadId) as { stage: string }).stage, "conversing");
});

test("a model reply that quotes a price is never sent; a person takes over", async () => {
  const { db, cfg, mailer, leadId } = setup("auto");
  await sendDue(db, cfg, mailer, WED_10AM_DUBAI);
  mailer.inbox.push(incoming("What does it cost?"));
  const r = await processInbox(db, cfg, mailer, new FakeLlm(analysis({ category: "question", reply: "It is usually AED 5,000." })), WED_10AM_DUBAI);
  assert.equal(r.replied, 0);
  assert.equal(r.handoffs, 1);
  assert.equal(mailer.sent.filter((m) => m.to === "sara@cafeone.ae").length, 1);
  assert.equal((db.prepare("SELECT reason FROM handoffs WHERE lead_id = ?").get(leadId) as { reason: string }).reason, "ai_reply_blocked");
});

test("model failure hands the thread to a person instead of going silent", async () => {
  const { db, cfg, mailer, leadId } = setup("auto");
  await sendDue(db, cfg, mailer, WED_10AM_DUBAI);
  mailer.inbox.push(incoming("Interested!"));
  await processInbox(db, cfg, mailer, new FakeLlm(new Error("boom")), WED_10AM_DUBAI);
  assert.equal((db.prepare("SELECT reason FROM handoffs WHERE lead_id = ?").get(leadId) as { reason: string }).reason, "ai_error");
});

test("mail from strangers is ignored and the same message is never processed twice", async () => {
  const { db, cfg, mailer } = setup("auto");
  await sendDue(db, cfg, mailer, WED_10AM_DUBAI);
  const llm = new FakeLlm(analysis({}));
  mailer.inbox.push(incoming("hello", { fromEmail: "stranger@else.com", inReplyTo: null }));
  const dup = incoming("Tell me more");
  mailer.inbox.push(dup);
  const first = await processInbox(db, cfg, mailer, llm, WED_10AM_DUBAI);
  assert.equal(first.ignored, 1);
  assert.equal(first.processed, 1);
  const second = await processInbox(db, cfg, mailer, llm, WED_10AM_DUBAI);
  assert.equal(second.processed, 0);
  assert.equal(llm.calls, 1);
});

test("quoted thread text is stripped from replies", () => {
  assert.equal(stripQuoted("Sounds good.\n\nOn Mon, 5 Oct 2026, Sara wrote:\n> old text"), "Sounds good.");
  assert.equal(stripQuoted("Yes\n> quoted"), "Yes");
});
