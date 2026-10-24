import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer as http, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import type { DatabaseSync } from "node:sqlite";
import { openDb } from "./db.ts";
import { loadConfig, type Config } from "./config.ts";
import { emit, retryFailed, webhookTarget, type EventType } from "./events.ts";
import { MemoryMailer, type InMail } from "./mail.ts";
import { processInbox } from "./inbox.ts";
import { sendDue } from "./outreach.ts";
import type { ReplyAnalysis } from "./agent.ts";
import { maybeSummary, runSchedule } from "./schedule.ts";
import { createDashboard } from "./server.ts";
import type { TargetResult } from "./pipeline.ts";

const NOW = new Date("2026-10-21T06:00:00Z"); // Wednesday 10:00 in Dubai
const SECRET = "a-long-enough-secret";
const ENV = { WEBHOOK_URL: "http://127.0.0.1:9/hook", WEBHOOK_SECRET: SECRET };

function setup(mode: "review" | "auto" = "auto"): { db: DatabaseSync; cfg: Config; mailer: MemoryMailer; leadId: number } {
  const cfg = loadConfig("webdev", { allowExample: true });
  cfg.outreach.mode = mode;
  cfg.outreach.notifyEmail = "owner@studio.test";
  const db = openDb(":memory:");
  const leadId = Number(
    db
      .prepare(
        `INSERT INTO leads (company, domain, country, industry, person, title, email, email_status, source_url, source_date, reason, tier, score, status)
         VALUES ('Cafe One','cafeone.ae','AE','restaurant','Sara Ali','Owner','sara@cafeone.ae','valid','u','2026-10-01','r','A',90,'checked')`,
      )
      .run().lastInsertRowid,
  );
  db.prepare("INSERT INTO drafts (lead_id, subject, body, confidence, words, created_at, review) VALUES (?, 's', 'b', 'high', 1, 't', 'approved')").run(leadId);
  return { db, cfg, mailer: new MemoryMailer(), leadId };
}
const row = (db: DatabaseSync, sql: string) => db.prepare(sql).get() as Record<string, unknown>;

test("webhook target: https or your own network only, and a real secret is required", () => {
  const { cfg } = setup();
  assert.equal(webhookTarget(cfg, {}), null);
  assert.equal(webhookTarget(cfg, { WEBHOOK_URL: "nonsense", WEBHOOK_SECRET: SECRET })?.ok, false);
  assert.equal(webhookTarget(cfg, { WEBHOOK_URL: "http://evil.example.com/x", WEBHOOK_SECRET: SECRET })?.ok, false);
  assert.equal(webhookTarget(cfg, { WEBHOOK_URL: "https://n8n.example.com/webhook/x", WEBHOOK_SECRET: "short" })?.ok, false);
  assert.equal(webhookTarget(cfg, { WEBHOOK_URL: "https://n8n.example.com/webhook/x", WEBHOOK_SECRET: SECRET })?.ok, true);
  for (const host of ["localhost", "127.0.0.1", "192.168.1.5", "10.0.0.2", "172.20.1.1", "host.docker.internal", "box.local"])
    assert.equal(webhookTarget(cfg, { WEBHOOK_URL: `http://${host}:5678/webhook/x`, WEBHOOK_SECRET: SECRET })?.ok, true, host);
});

test("emit: delivers a signed event to a real receiver and logs it", async () => {
  const { db, cfg } = setup();
  let got: { headers: IncomingHttpHeaders; body: string } | null = null;
  const receiver = http((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      got = { headers: req.headers, body };
      res.writeHead(200).end("ok");
    });
  });
  await new Promise<void>((ok) => receiver.listen(0, "127.0.0.1", ok));
  try {
    const env = { WEBHOOK_URL: `http://127.0.0.1:${(receiver.address() as AddressInfo).port}/hook`, WEBHOOK_SECRET: SECRET };
    const e = await emit(db, cfg, "lead.qualified", { company: "Cafe One" }, { env, now: NOW, profile: "webdev" });
    assert.ok(got);
    const g = got as { headers: IncomingHttpHeaders; body: string };
    assert.equal(g.headers["x-gulf-secret"], SECRET);
    assert.equal(g.headers["x-gulf-event"], "lead.qualified");
    assert.equal(g.headers["x-gulf-signature"], "sha256=" + createHmac("sha256", SECRET).update(g.body).digest("hex"));
    const sent = JSON.parse(g.body) as { id: string; type: string; profile: string; data: { company: string } };
    assert.deepEqual({ id: sent.id, type: sent.type, profile: sent.profile, company: sent.data.company }, { id: e.id, type: "lead.qualified", profile: "webdev", company: "Cafe One" });
    assert.equal(row(db, "SELECT status FROM events").status, "delivered");
  } finally {
    receiver.close();
  }
});

test("emit: never throws, skips when nothing is configured or the type is filtered, and does not follow redirects", async () => {
  const { db, cfg } = setup();
  await emit(db, cfg, "test", {}, { env: {}, now: NOW });
  assert.equal(row(db, "SELECT status FROM events").status, "skipped");

  let init: RequestInit | undefined;
  const boom = (async (_u: unknown, i: RequestInit) => {
    init = i;
    throw new Error("connection refused");
  }) as unknown as typeof fetch;
  await assert.doesNotReject(emit(db, cfg, "lead.bounced", {}, { env: ENV, doFetch: boom, now: NOW }));
  assert.equal(init?.redirect, "manual");
  const failed = row(db, "SELECT status, attempts, last_error FROM events WHERE type = 'lead.bounced'");
  assert.deepEqual({ ...failed }, { status: "failed", attempts: 1, last_error: "connection refused" });

  cfg.integrations = { events: ["lead.qualified"] };
  await emit(db, cfg, "daily.summary", {}, { env: ENV, doFetch: boom, now: NOW });
  assert.equal(row(db, "SELECT status FROM events WHERE type = 'daily.summary'").status, "skipped");

  const redirect = (async () => new Response("", { status: 302, headers: { location: "https://elsewhere.example" } })) as unknown as typeof fetch;
  cfg.integrations = {};
  await emit(db, cfg, "lead.unsubscribed", {}, { env: ENV, doFetch: redirect, now: NOW });
  assert.match(String(row(db, "SELECT last_error FROM events WHERE type = 'lead.unsubscribed'").last_error), /302/);
});

test("retryFailed waits longer after each attempt and gives up after six", async () => {
  const { db, cfg } = setup();
  const down = (async () => new Response("", { status: 500 })) as unknown as typeof fetch;
  const up = (async () => new Response("ok")) as unknown as typeof fetch;
  await emit(db, cfg, "test", {}, { env: ENV, doFetch: down, now: NOW });
  assert.equal((await retryFailed(db, cfg, { env: ENV, doFetch: up, now: new Date(NOW.getTime() + 60_000) })).retried, 0); // 1 minute: too soon
  const later = new Date(NOW.getTime() + 6 * 60_000);
  assert.deepEqual(await retryFailed(db, cfg, { env: ENV, doFetch: up, now: later }), { retried: 1, delivered: 1 });
  assert.equal(row(db, "SELECT status FROM events").status, "delivered");

  db.prepare("UPDATE events SET status = 'failed', attempts = 6").run();
  assert.equal((await retryFailed(db, cfg, { env: ENV, doFetch: up, now: new Date(NOW.getTime() + 3_600_000) })).retried, 0);
});

let uid = 300;
const incoming = (text: string, over: Partial<InMail> = {}): InMail => ({
  uid: ++uid, messageId: `<e-${uid}@x>`, inReplyTo: "<out-1@test>", references: [], fromEmail: "sara@cafeone.ae", subject: "Re: s", text, automatic: false, ...over,
});
const analysis = (over: Partial<ReplyAnalysis>): ReplyAnalysis => ({
  category: "interested", fit: "hot", wants_meeting: true, needs_human_topic: false, asked_if_ai: false, need: "booking", timeline: "now",
  budget_signal: "", days_until_followup: 0, summary: "wants booking", reply: "Great, we will be in touch.", ...over,
});

test("inbox events: qualified lead, opt-out, bounce and a reply waiting for approval", async () => {
  const seen: { type: EventType; data: Record<string, unknown> }[] = [];
  const hooks = {
    emit: async (type: EventType, data: Record<string, unknown>) => {
      seen.push({ type, data });
    },
  };

  const a = setup("review");
  await sendDue(a.db, a.cfg, a.mailer, NOW);
  a.mailer.inbox.push(incoming("Yes, call me this week"));
  await processInbox(a.db, a.cfg, a.mailer, { analyze: async () => analysis({}) }, NOW, hooks);
  assert.deepEqual(seen.map((s) => s.type), ["reply.pending", "lead.qualified"]);
  const q = seen.find((s) => s.type === "lead.qualified")!.data;
  assert.deepEqual({ company: q.company, need: q.need, email: q.email, reason: q.reason }, { company: "Cafe One", need: "booking", email: "sara@cafeone.ae", reason: "qualified" });

  seen.length = 0;
  const b = setup();
  await sendDue(b.db, b.cfg, b.mailer, NOW);
  b.mailer.inbox.push(incoming("please unsubscribe me"));
  await processInbox(b.db, b.cfg, b.mailer, { analyze: async () => analysis({}) }, NOW, hooks);
  assert.deepEqual(seen.map((s) => s.type), ["lead.unsubscribed"]);
  assert.equal(JSON.stringify(seen[0]!.data).includes("sara@cafeone.ae"), false); // no email address in opt-out events

  seen.length = 0;
  const c = setup();
  await sendDue(c.db, c.cfg, c.mailer, NOW);
  c.mailer.inbox.push(incoming("Address not found: sara@cafeone.ae", { fromEmail: "mailer-daemon@googlemail.com", inReplyTo: null }));
  await processInbox(c.db, c.cfg, c.mailer, { analyze: async () => analysis({}) }, NOW, hooks);
  assert.deepEqual(seen.map((s) => s.type), ["lead.bounced"]);
});

test("a broken event receiver never breaks reading the inbox", async () => {
  const { db, cfg, mailer, leadId } = setup();
  await sendDue(db, cfg, mailer, NOW);
  mailer.inbox.push(incoming("Yes, call me"));
  const r = await processInbox(db, cfg, mailer, { analyze: async () => analysis({}) }, NOW, {
    emit: async () => {
      throw new Error("n8n is down");
    },
  });
  assert.equal(r.handoffs, 1);
  assert.equal(row(db, `SELECT stage FROM leads WHERE id = ${leadId}`).stage, "handoff");
});

const target = { country: "AE", industry: "clinic", city: "Dubai", limit: 20 };

test("daily search: waits for its hour and day, runs once, respects the daily cap, and tells you", async () => {
  const { db, cfg } = setup();
  cfg.schedule = { discover: { hour: 8, targets: [target, { ...target, industry: "restaurant" }, { ...target, industry: "retail" }], maxPerDay: 25 } };
  const events: { type: EventType; data: Record<string, unknown> }[] = [];
  const ev = async (type: EventType, data: Record<string, unknown>) => {
    events.push({ type, data });
  };
  let calls: string[] = [];
  const run = (async (_d: unknown, _c: unknown, t: { industry: string; limit?: number }): Promise<TargetResult> => {
    calls.push(`${t.industry}:${t.limit}`);
    return { label: t.industry, discovered: { found: 30, added: t.limit ?? 0, skippedNoSite: 0, skippedSocial: 0, skippedDuplicate: 0 }, drafted: 3 };
  }) as never;

  const early = new Date("2026-10-21T03:00:00Z"); // 07:00 Dubai
  assert.equal((await runSchedule(db, cfg, ev, { run }, early)).skipped, "too early");
  assert.equal((await runSchedule(db, cfg, ev, { run }, new Date("2026-10-24T06:00:00Z"))).skipped, "not a scheduled day"); // Saturday
  assert.equal(calls.length, 0);

  const r = await runSchedule(db, cfg, ev, { run }, NOW);
  assert.equal(r.ran, true);
  assert.deepEqual(calls, ["clinic:20", "restaurant:5"]); // 20 + 5 reaches the cap of 25; retail never starts
  assert.equal(r.results?.[2]?.error?.startsWith("skipped"), true);
  assert.equal(events[0]!.type, "discovery.done");
  assert.equal(events[0]!.data.added, 25);

  calls = [];
  assert.equal((await runSchedule(db, cfg, ev, { run }, new Date(NOW.getTime() + 3_600_000))).skipped, "already ran today");
  assert.equal((await runSchedule(db, cfg, ev, { run }, new Date(NOW.getTime() + 86_400_000))).ran, true); // next day runs again
});

test("daily summary: once a day after the summary hour, with the day's numbers", async () => {
  const { db, cfg, mailer } = setup();
  const events: { type: EventType; data: Record<string, unknown> }[] = [];
  const ev = async (type: EventType, data: Record<string, unknown>) => {
    events.push({ type, data });
  };
  await sendDue(db, cfg, mailer, NOW);
  const evening = new Date("2026-10-21T15:00:00Z"); // 19:00 Dubai
  assert.equal(await maybeSummary(db, cfg, ev, NOW), false);
  assert.equal(await maybeSummary(db, cfg, ev, evening), true);
  assert.equal(await maybeSummary(db, cfg, ev, evening), false);
  assert.deepEqual({ type: events[0]!.type, sent: events[0]!.data.sent, date: events[0]!.data.date }, { type: "daily.summary", sent: 1, date: "2026-10-21" });
});

test("dashboard: integrations page data, test event, and n8n callbacks that can never send mail", async () => {
  const { db, cfg, mailer, leadId } = setup("review");
  cfg.schedule = { discover: { hour: 8, targets: [target] } };
  const ran: unknown[] = [];
  const env: Record<string, string | undefined> = { WEBHOOK_URL: "http://127.0.0.1:9/hook", WEBHOOK_SECRET: SECRET };
  const server = createDashboard(db, cfg, () => mailer, "admin", {
    profile: "webdev",
    env,
    run: (async (_d: unknown, _c: unknown, t: unknown) => {
      ran.push(t);
      return { label: "x" };
    }) as never,
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = (path: string, init: { method?: string; headers?: Record<string, string>; body?: unknown } = {}) =>
    fetch(base + path, { method: init.method ?? "GET", headers: { "content-type": "application/json", ...init.headers }, body: init.body ? JSON.stringify(init.body) : undefined });
  try {
    const info = (await (await call("/api/integrations", { headers: { "x-token": "admin" } })).json()) as { webhook: { state: string; host: string }; hooks: boolean; schedule: { hour: number } };
    assert.deepEqual({ state: info.webhook.state, host: info.webhook.host, hooks: info.hooks, hour: info.schedule.hour }, { state: "on", host: "127.0.0.1:9", hooks: false, hour: 8 });

    const t = (await (await call("/api/integrations/test", { method: "POST", headers: { "x-token": "admin" }, body: {} })).json()) as { status: string; error: string };
    assert.equal(t.status, "failed"); // nothing listens on port 9: the failure is reported, not hidden
    assert.ok(t.error);

    const wf = (await (await call("/api/integrations/n8n", { headers: { "x-token": "admin" } })).json()) as { nodes: unknown[] };
    assert.ok(wf.nodes.length >= 3);

    // Hook endpoints are off until HOOK_TOKEN is set, and the admin token does not open them.
    assert.equal((await call("/api/hooks/suppress", { method: "POST", headers: { "x-hook-token": "x" }, body: { value: "a@b.ae" } })).status, 404);
    env.HOOK_TOKEN = "hook-secret-token";
    assert.equal((await call("/api/hooks/suppress", { method: "POST", headers: { "x-token": "admin" }, body: { value: "a@b.ae" } })).status, 401);
    assert.equal((await call("/api/hooks/suppress", { method: "POST", headers: { "x-hook-token": "hook-secret-token" }, body: { value: "cafeone.ae" } })).status, 200);
    assert.equal(row(db, `SELECT stage FROM leads WHERE id = ${leadId}`).stage, "closed_lost");
    assert.equal((await call("/api/hooks/discover", { method: "POST", headers: { "x-hook-token": "hook-secret-token" }, body: { country: "XX", industry: "clinic" } })).status, 400);
    assert.equal((await call("/api/hooks/discover", { method: "POST", headers: { "x-hook-token": "hook-secret-token" }, body: { country: "ae", industry: "clinic", city: "Dubai", limit: 500 } })).status, 200);
    await new Promise((r) => setTimeout(r, 50));
    assert.equal((ran[0] as { limit: number }).limit, 60); // clamped
    for (const p of ["/api/hooks/approve", "/api/hooks/send", "/api/hooks/reply"])
      assert.equal((await call(p, { method: "POST", headers: { "x-hook-token": "hook-secret-token" }, body: {} })).status, 404);
    assert.equal(mailer.sent.length, 0);
  } finally {
    server.close();
  }
});

test("n8n workflow file: valid structure, wired up, and its message code handles every event", () => {
  const wf = JSON.parse(readFileSync("integrations/n8n/gulf-leads.workflow.json", "utf8")) as {
    nodes: { name: string; type: string; parameters: Record<string, unknown> }[];
    connections: Record<string, { main: { node: string }[][] }>;
  };
  const names = new Set(wf.nodes.map((n) => n.name));
  assert.equal(names.size, wf.nodes.length);
  for (const [from, c] of Object.entries(wf.connections)) {
    assert.ok(names.has(from), from);
    for (const to of c.main.flat()) assert.ok(names.has(to.node), to.node);
  }
  const hook = wf.nodes.find((n) => n.type === "n8n-nodes-base.webhook")!;
  assert.equal(hook.parameters.httpMethod, "POST");
  assert.equal(hook.parameters.authentication, "headerAuth");
  const code = wf.nodes.find((n) => n.type === "n8n-nodes-base.code")!;
  const run = new Function("$input", String(code.parameters.jsCode)) as (i: unknown) => { json: { text: string } }[];
  const samples: Record<string, Record<string, unknown>> = {
    "lead.qualified": { company: "Cafe One", summary: "wants booking", need: "booking", person: "Sara", email: "s@x.ae", nextStep: "call" },
    "lead.needs_human": { company: "Cafe One", reason: "needs_human", summary: "asked about price" },
    "proposal.ready": { company: "Cafe One" },
    "reply.pending": { company: "Cafe One" },
    "sending.paused": { reason: "bounce rate 5%" },
    "lead.unsubscribed": { company: "Cafe One", reason: "unsubscribed" },
    "lead.bounced": { company: "Cafe One" },
    "discovery.done": { added: 12, targets: [{ label: "clinic", added: 12 }] },
    "daily.summary": { date: "2026-10-21", sent: 5, replies: 1, qualified: 1, waitingApproval: 2, openHandoffs: 1 },
    test: {},
  };
  for (const [type, data] of Object.entries(samples)) {
    const out = run({ first: () => ({ json: { body: { type, data, dashboard: "http://localhost:4300" } } }) });
    assert.equal(out.length, 1, type);
    assert.ok(out[0]!.json.text.length > 10, type);
    if ("company" in data) assert.match(out[0]!.json.text, /Cafe One/, type);
  }
  assert.deepEqual(run({ first: () => ({ json: { body: { type: "something.else", data: {} } } }) }), []);
});
