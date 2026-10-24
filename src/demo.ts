import { copyFileSync, existsSync, rmSync } from "node:fs";
import { openDb } from "./db.ts";

/** Fills a separate "demo" profile with made-up companies so the dashboard can be shown without real data. */
if (!existsSync("profiles/demo.json")) copyFileSync("profiles/webdev.json", "profiles/demo.json");
rmSync("data/demo.db", { force: true });
const db = openDb("data/demo.db");
const now = new Date().toISOString();

const lead = (company: string, domain: string, tier: string, score: number, stage: string, email: string, extra: Record<string, string | number> = {}): number =>
  Number(
    db
      .prepare(
        `INSERT INTO leads (company, domain, country, industry, city, person, title, email, email_status, source, source_url, source_date, reason, tier, score, stage, status, touches)
         VALUES (?, ?, 'AE', 'restaurant', 'Dubai', ?, 'Owner', ?, 'unknown', 'demo', 'https://example.com', '2026-10-01', 'demo company', ?, ?, ?, 'checked', ?)`,
      )
      .run(company, domain, String(extra.person ?? ""), email, tier, score, stage, Number(extra.touches ?? 0)).lastInsertRowid,
  );
const draft = (id: number, company: string, fact: string) =>
  db
    .prepare("INSERT INTO drafts (lead_id, subject, body, fact_text, fact_url, confidence, words, created_at) VALUES (?, ?, ?, ?, ?, 'high', 70, ?)")
    .run(id, `${company}: a quick note about your website`, `Hi team,\n\nWhile looking at the site I noticed ${fact}. Are bookings still handled by phone?\n\nI build booking systems for restaurants in Dubai. Would a short example be useful?\n\nYour Name, Your Studio`, fact, "https://example.com", now);

const a = lead("Terrace Cafe", "terracecafe.ae", "A", 88, "prospect", "info@terracecafe.ae");
draft(a, "Terrace Cafe", "I could not find online booking on the homepage");
const b = lead("Al Noor Grill", "alnoorgrill.ae", "B", 61, "prospect", "hello@alnoorgrill.ae");
draft(b, "Al Noor Grill", "the homepage has no mobile viewport setting");
lead("Sunset Bites", "sunsetbites.ae", "C", 30, "prospect", "");

const c = lead("Palm Kitchen", "palmkitchen.ae", "A", 92, "handoff", "sara@palmkitchen.ae", { person: "Sara Ali", touches: 1 });
db.prepare("INSERT INTO messages (lead_id, direction, kind, subject, body, message_id, status, at) VALUES (?, 'out', 'touch1', 'Palm Kitchen: note', 'Hi Sara, I noticed there is no online booking.', '<o1@x>', 'sent', ?)").run(c, now);
db.prepare("INSERT INTO messages (lead_id, direction, kind, subject, body, message_id, status, at) VALUES (?, 'in', 'inbound', 'Re: note', 'Yes we need this. We are opening a second branch next month. Can we talk this week?', '<i1@x>', 'received', ?)").run(c, now);
db.prepare("INSERT INTO handoffs (lead_id, reason, summary, need, timeline, budget_signal, next_step, created_at) VALUES (?, 'qualified', 'Owner wants online booking for a second branch opening next month.', 'Online booking for two branches', 'Next month', 'Not stated', 'They want a call: reach out personally', ?)").run(c, now);
db.prepare("INSERT INTO messages (lead_id, direction, kind, subject, body, status, at) VALUES (?, 'out', 'reply', 'Re: note', 'Great to hear. I will ask Your Name to call you this week.\n\n— the Studio assistant, assistant to Your Name at Your Studio', 'pending_approval', ?)").run(c, now);
db.prepare("INSERT INTO proposals (lead_id, content, subject, body, status, created_at) VALUES (?, ?, 'An idea for your second branch', ?, 'pending_approval', ?)").run(
  c,
  JSON.stringify({ citations: [{ text: "Your site announces the second branch opening", source: "site:home", url: "https://palmkitchen.ae" }, { text: "Your branch tour video has 8,000 views", source: "yt:v1", url: "https://youtube.com/watch?v=v1" }] }),
  "Hi Sara,\n\nI saw the second branch announcement on your site and the tour video people watched.\n\nHere is what I would do for Palm Kitchen:\n1. Two-branch table booking: choose branch, date and party size (about 12 working days)\n2. Branch landing pages with the tour video embedded (about 4 working days)\n\nWould a 20 minute call this week work?\n\nYour Name, Your Studio",
  now,
);

const d = lead("Blue Door", "bluedoor.ae", "A", 80, "contacted", "info@bluedoor.ae", { touches: 2 });
db.prepare("INSERT INTO messages (lead_id, direction, kind, subject, body, message_id, status, at) VALUES (?, 'out', 'touch1', 'Blue Door: note', 'Hi team', '<o2@x>', 'sent', ?)").run(d, now);
lead("Closed Spoon", "closedspoon.ae", "B", 55, "closed_lost", "contact@closedspoon.ae", { touches: 1 });
// More made-up history so the charts have something to show: leads across industries, email states, and two weeks of activity.
const industries = ["restaurant", "clinic", "real estate", "retail", "logistics", "gym"];
const emailStates = ["valid", "valid", "valid", "valid", "catch-all", "unknown", "invalid"];
const factKinds: [string, string][] = [["no_booking", "no online booking"], ["no_viewport", "not built for phones"], ["slow", "slow homepage"], ["no_chat", "no WhatsApp button"], ["old_footer", "outdated footer"], ["no_https", "no HTTPS"]];
let seed = 7;
const rnd = (n: number) => ((seed = (seed * 9301 + 49297) % 233280) / 233280) * n;
const extraLeads: number[] = [];
for (let i = 0; i < 46; i++) {
  const ind = industries[i % industries.length]!;
  const score = Math.round(30 + rnd(65));
  const tier = score >= 70 ? "A" : score >= 45 ? "B" : "C";
  const touches = tier === "C" ? 0 : rnd(1) > 0.35 ? 1 + Math.floor(rnd(3)) : 0;
  const id = Number(
    db
      .prepare(
        `INSERT INTO leads (company, domain, country, industry, city, email, email_status, source, source_url, source_date, reason, tier, score, stage, status, touches)
         VALUES (?, ?, 'AE', ?, 'Dubai', ?, ?, 'demo', 'https://example.com', '2026-10-01', 'demo company', ?, ?, ?, 'checked', ?)`,
      )
      .run(`${ind[0]!.toUpperCase()}${ind.slice(1)} Co ${i + 1}`, `demo${i + 1}.ae`, ind, `info@demo${i + 1}.ae`, emailStates[i % emailStates.length]!, tier, score, touches > 0 ? "contacted" : "prospect", touches).lastInsertRowid,
  );
  extraLeads.push(id);
  for (const [k, t] of factKinds) if (rnd(1) > 0.62) db.prepare("INSERT INTO site_facts (domain, kind, text, url, checked_at) VALUES (?, ?, ?, 'https://example.com', ?)").run(`demo${i + 1}.ae`, k, t, now);
}
const dayAgo = (d: number, h = 10) => new Date(Date.now() - d * 86_400_000 + (h - 12) * 3_600_000).toISOString();
const contacted = extraLeads.slice(0, 30);
let mid = 1;
for (let d = 13; d >= 0; d--) {
  const weekday = new Date(dayAgo(d)).getUTCDay();
  if (weekday === 5 || weekday === 6) continue;
  const sentToday = Math.round(4 + (13 - d) * 0.9 + rnd(5));
  for (let k = 0; k < sentToday; k++)
    db.prepare("INSERT INTO messages (lead_id, direction, kind, subject, body, message_id, status, at) VALUES (?, 'out', 'touch1', 's', 'b', ?, 'sent', ?)").run(contacted[(d * 3 + k) % contacted.length]!, `<d${mid++}@demo>`, dayAgo(d, 9 + (k % 7)));
  const repliesToday = Math.round(sentToday * (0.14 + rnd(0.12)) * (d < 12 ? 1 : 0.4));
  for (let k = 0; k < repliesToday; k++)
    db.prepare("INSERT INTO messages (lead_id, direction, kind, subject, body, message_id, status, at) VALUES (?, 'in', 'inbound', 's', 'thanks', ?, 'received', ?)").run(contacted[(d * 5 + k) % contacted.length]!, `<d${mid++}@demo>`, dayAgo(d, 13 + k));
  if (rnd(1) > 0.55) db.prepare("INSERT OR IGNORE INTO handoffs (lead_id, reason, summary, created_at) VALUES (?, 'qualified', 'demo', ?)").run(contacted[(d + 11) % contacted.length]!, dayAgo(d, 15));
}
// A few past events for the integrations page.
const ev = (type: string, minsAgo: number, status: string, data: Record<string, unknown>, error: string | null = null) =>
  db
    .prepare("INSERT INTO events (id, type, payload, at, status, attempts, last_error, last_attempt_at, delivered_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(`demo-${type}-${minsAgo}`, type, JSON.stringify({ type, data }), new Date(Date.now() - minsAgo * 60_000).toISOString(), status, status === "skipped" ? 0 : 1, error, status === "skipped" ? null : now, status === "delivered" ? now : null);
ev("lead.qualified", 22, "delivered", { company: "Palm Kitchen" });
ev("proposal.ready", 20, "delivered", { company: "Palm Kitchen" });
ev("reply.pending", 19, "delivered", { company: "Palm Kitchen" });
ev("discovery.done", 330, "delivered", { added: 18 });
ev("lead.unsubscribed", 140, "failed", { company: "Closed Spoon" }, "receiver answered 500");
ev("daily.summary", 1400, "delivered", { sent: 12 });
console.log("demo ready: npm run leads -- dashboard --profile demo");
