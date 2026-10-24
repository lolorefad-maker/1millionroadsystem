import type { DatabaseSync } from "node:sqlite";
import type { Config } from "./config.ts";
import { getState, setState, suppress } from "./db.ts";
import type { InMail, Mailer } from "./mail.ts";
import type { Llm, ReplyAnalysis, Turn } from "./agent.ts";
import type { EventType } from "./events.ts";

type Ev = (type: EventType, data: Record<string, unknown>) => Promise<void>;

const UNSUBSCRIBE = /\b(unsubscribe|remove me|opt[- ]?out|do not (contact|email)|don'?t (contact|email)|stop (emailing|sending|contacting|messaging))\b|إلغاء الاشتراك|الغاء الاشتراك|لا تراسل|توقف عن/i;
const MONEY = /\b(aed|usd|sar|qar|kwd|dirhams?|riyals?|dollars?)\b|[$€£]\s?\d|\d\s?(aed|usd|sar)\b|درهم|ريال|دولار/i;

export interface InboxResult {
  processed: number;
  ignored: number;
  replied: number;
  queuedForApproval: number;
  handoffs: number;
  suppressed: number;
  bounced: number;
}

export interface InboxHooks {
  /** Called for every important event (qualified lead, reply waiting, opt-out...). Never allowed to break the inbox run. */
  emit?: Ev;
  /** Called once a lead is handed over as qualified; failures here never block the handoff. */
  onQualified?: (lead: { id: number; company: string }) => Promise<void>;
}

interface LeadRow {
  id: number;
  company: string;
  domain: string;
  industry: string;
  person: string;
  email: string;
  phone?: string;
  stage: string;
  ai_replies: number;
}

const signature = (cfg: Config) =>
  `\n\n— ${cfg.outreach.assistantName}, assistant to ${cfg.sender.name} at ${cfg.sender.company}`;

function findLead(db: DatabaseSync, m: InMail): LeadRow | undefined {
  const ids = [m.inReplyTo, ...m.references].filter((x): x is string => !!x);
  for (const id of ids) {
    const hit = db.prepare("SELECT l.* FROM messages x JOIN leads l ON l.id = x.lead_id WHERE x.message_id = ?").get(id) as unknown as LeadRow | undefined;
    if (hit) return hit;
  }
  return db.prepare("SELECT * FROM leads WHERE email = ? AND stage != 'prospect'").get(m.fromEmail) as unknown as LeadRow | undefined;
}

function history(db: DatabaseSync, leadId: number): Turn[] {
  const rows = db
    .prepare("SELECT direction, body FROM messages WHERE lead_id = ? AND status IN ('sent','received') ORDER BY id DESC LIMIT 8")
    .all(leadId) as unknown as { direction: string; body: string }[];
  return rows.reverse().map((r) => ({ role: r.direction === "out" ? "us" : "them", text: r.body.slice(0, 1500) }));
}

async function suppressLead(db: DatabaseSync, lead: LeadRow, reason: string, stage: string, ev: Ev): Promise<void> {
  suppress(db, lead.email, reason);
  db.prepare("UPDATE leads SET stage = ?, next_touch_at = NULL WHERE id = ?").run(stage, lead.id);
  db.prepare("DELETE FROM drafts WHERE lead_id = ?").run(lead.id);
  await ev("lead.unsubscribed", { leadId: lead.id, company: lead.company, domain: lead.domain, reason });
}

async function handoff(
  db: DatabaseSync, cfg: Config, mailer: Mailer, lead: LeadRow, reason: string, a: Partial<ReplyAnalysis>, now: Date, ev: Ev,
): Promise<void> {
  const nextStep =
    reason === "later" && a.days_until_followup
      ? `Follow up in about ${a.days_until_followup} days`
      : a.wants_meeting ? "They want a call: reach out personally" : "Read the thread and reply personally";
  db.prepare(
    `INSERT OR REPLACE INTO handoffs (lead_id, reason, summary, need, timeline, budget_signal, next_step, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(lead.id, reason, a.summary ?? "", a.need ?? "", a.timeline ?? "", a.budget_signal ?? "", nextStep, now.toISOString());
  db.prepare("UPDATE leads SET stage = 'handoff', next_touch_at = NULL WHERE id = ?").run(lead.id);

  const thread = history(db, lead.id).map((t) => `${t.role === "us" ? "US" : "THEM"}: ${t.text}`).join("\n\n");
  await mailer.send({
    to: cfg.outreach.notifyEmail,
    fromName: cfg.outreach.from.name,
    fromEmail: cfg.outreach.from.email,
    subject: `[Lead ${reason}] ${lead.company} (${a.fit ?? "?"})`,
    text: `${lead.company} (${lead.domain})\nContact: ${lead.person || "unknown"} <${lead.email}>\n\nSummary: ${a.summary ?? ""}\nNeed: ${a.need ?? ""}\nTimeline: ${a.timeline ?? ""}\nBudget signal: ${a.budget_signal ?? ""}\nNext step: ${nextStep}\n\n--- thread ---\n${thread}`,
    unsubscribeMailto: cfg.outreach.from.email,
  });
  db.prepare("UPDATE handoffs SET notified_at = ? WHERE lead_id = ?").run(now.toISOString(), lead.id);
  await ev(reason === "qualified" ? "lead.qualified" : "lead.needs_human", {
    leadId: lead.id, company: lead.company, domain: lead.domain, person: lead.person, email: lead.email, phone: lead.phone ?? "",
    reason, fit: a.fit ?? "", summary: a.summary ?? "", need: a.need ?? "", timeline: a.timeline ?? "", budgetSignal: a.budget_signal ?? "", nextStep,
  });
}

async function reply(
  db: DatabaseSync, cfg: Config, mailer: Mailer, lead: LeadRow, m: InMail, text: string, now: Date, out: InboxResult, ev: Ev,
): Promise<void> {
  const body = text.trim() + signature(cfg);
  const subject = /^re:/i.test(m.subject) ? m.subject : `Re: ${m.subject}`;
  if (cfg.outreach.mode === "review") {
    db.prepare(
      "INSERT INTO messages (lead_id, direction, kind, subject, body, in_reply_to, status, at) VALUES (?, 'out', 'reply', ?, ?, ?, 'pending_approval', ?)",
    ).run(lead.id, subject, body, m.messageId, now.toISOString());
    out.queuedForApproval++;
    await ev("reply.pending", { leadId: lead.id, company: lead.company, subject });
    return;
  }
  const { messageId } = await mailer.send({
    to: lead.email, fromName: cfg.outreach.from.name, fromEmail: cfg.outreach.from.email, subject, text: body,
    inReplyTo: m.messageId, references: [...m.references, m.messageId], unsubscribeMailto: cfg.outreach.from.email,
  });
  db.prepare(
    "INSERT INTO messages (lead_id, direction, kind, subject, body, message_id, in_reply_to, status, at) VALUES (?, 'out', 'reply', ?, ?, ?, ?, 'sent', ?)",
  ).run(lead.id, subject, body, messageId, m.messageId, now.toISOString());
  db.prepare("UPDATE leads SET ai_replies = ai_replies + 1, last_contact_at = ? WHERE id = ?").run(now.toISOString(), lead.id);
  out.replied++;
}

/** Read new mail, stop sequences on any reply, let the model judge it, and act on the verdict. */
export async function processInbox(
  db: DatabaseSync, cfg: Config, mailer: Mailer, llm: Llm, now = new Date(), hooks: InboxHooks = {},
): Promise<InboxResult> {
  const out: InboxResult = { processed: 0, ignored: 0, replied: 0, queuedForApproval: 0, handoffs: 0, suppressed: 0, bounced: 0 };
  // An event receiver that is down must never break reading the inbox.
  const ev: Ev = async (type, data) => {
    try {
      await hooks.emit?.(type, data);
    } catch {
      /* ignored */
    }
  };
  const after = Number(getState(db, "imap_uid") ?? 0);
  const mails = await mailer.fetchInbound(after);

  for (const m of mails) {
    setState(db, "imap_uid", String(Math.max(Number(getState(db, "imap_uid") ?? 0), m.uid)));
    if (db.prepare("SELECT 1 AS x FROM messages WHERE message_id = ?").get(m.messageId)) continue;

    // Delivery failure notices: the address is dead. Mark it and never write to it again.
    if (/^(mailer-daemon|postmaster)@/i.test(m.fromEmail)) {
      const haystack = `${m.subject}\n${m.text}`.toLowerCase();
      const hit = (db.prepare("SELECT id, email, company FROM leads WHERE email != '' AND stage IN ('contacted','conversing','handoff')").all() as unknown as { id: number; email: string; company: string }[]).find((l) =>
        haystack.includes(l.email),
      );
      if (hit) {
        suppress(db, hit.email, "bounced");
        db.prepare("UPDATE leads SET stage = 'bounced', email_status = 'invalid', next_touch_at = NULL, last_contact_at = ? WHERE id = ?").run(now.toISOString(), hit.id);
        out.bounced++;
        await ev("lead.bounced", { leadId: hit.id, company: hit.company });
      } else out.ignored++;
      continue;
    }
    const lead = findLead(db, m);
    if (!lead || lead.stage === "unsubscribed") {
      out.ignored++;
      continue;
    }
    db.prepare(
      "INSERT INTO messages (lead_id, direction, kind, subject, body, message_id, in_reply_to, status, at) VALUES (?, 'in', 'inbound', ?, ?, ?, ?, 'received', ?)",
    ).run(lead.id, m.subject, m.text, m.messageId, m.inReplyTo, now.toISOString());
    out.processed++;

    // Out-of-office and other automatic mail: not a human answer. Pause a few days, keep the sequence.
    if (m.automatic) {
      const resume = new Date(now.getTime() + 3 * 86_400_000).toISOString();
      db.prepare("UPDATE leads SET next_touch_at = ? WHERE id = ? AND stage = 'contacted' AND next_touch_at IS NOT NULL").run(resume, lead.id);
      continue;
    }

    // Any real reply stops the sequence first, before anything else can fail.
    db.prepare("UPDATE leads SET stage = 'conversing', next_touch_at = NULL WHERE id = ?").run(lead.id);

    if (UNSUBSCRIBE.test(m.text)) {
      await suppressLead(db, lead, "unsubscribed", "unsubscribed", ev);
      out.suppressed++;
      continue;
    }

    let a: ReplyAnalysis;
    try {
      const facts = db.prepare("SELECT text FROM site_facts WHERE domain = ?").all(lead.domain) as unknown as { text: string }[];
      a = await llm.analyze({
        company: lead.company, industry: lead.industry, site_facts: facts.map((f) => f.text),
        history: history(db, lead.id).slice(0, -1), inbound: m.text,
      });
    } catch (e) {
      await handoff(db, cfg, mailer, lead, "ai_error", { summary: `Automatic analysis failed: ${(e as Error).message}. Read the reply yourself.` }, now, ev);
      out.handoffs++;
      continue;
    }
    db.prepare("UPDATE messages SET analysis = ? WHERE message_id = ?").run(JSON.stringify(a), m.messageId);

    if (a.category === "unsubscribe") {
      await suppressLead(db, lead, "unsubscribed", "unsubscribed", ev);
      out.suppressed++;
    } else if (a.category === "not_interested") {
      await suppressLead(db, lead, "declined", "closed_lost", ev);
      out.suppressed++;
    } else if (a.needs_human_topic || a.category === "other") {
      await handoff(db, cfg, mailer, lead, "needs_human", a, now, ev);
      out.handoffs++;
    } else {
      // The model's draft is checked by code before it can go out.
      const unsafe = !a.reply.trim() || MONEY.test(a.reply) || a.reply.split(/\s+/).length > 140;
      const qualified = a.wants_meeting || a.fit === "hot";
      const tooLong = lead.ai_replies + 1 >= cfg.outreach.maxAiReplies;
      if (!unsafe && a.category !== "later") await reply(db, cfg, mailer, lead, m, a.reply, now, out, ev);
      if (a.category === "later") {
        await handoff(db, cfg, mailer, lead, "later", a, now, ev);
        out.handoffs++;
      } else if (qualified || tooLong || unsafe) {
        await handoff(db, cfg, mailer, lead, qualified ? "qualified" : unsafe ? "ai_reply_blocked" : "long_thread", a, now, ev);
        out.handoffs++;
        if (qualified && hooks.onQualified) {
          try {
            await hooks.onQualified({ id: lead.id, company: lead.company });
          } catch (e) {
            console.error(`proposal for ${lead.company} failed: ${(e as Error).message}`);
          }
        }
      }
    }
  }
  return out;
}

/** Send a reply that was waiting for a person's approval (review mode). */
export async function approveReply(db: DatabaseSync, cfg: Config, mailer: Mailer, messageRowId: number, now = new Date()): Promise<void> {
  const row = db
    .prepare("SELECT m.*, l.email, l.stage FROM messages m JOIN leads l ON l.id = m.lead_id WHERE m.id = ? AND m.status = 'pending_approval'")
    .get(messageRowId) as unknown as { id: number; lead_id: number; subject: string; body: string; in_reply_to: string | null; email: string; stage: string } | undefined;
  if (!row) throw new Error(`No pending reply with id ${messageRowId}`);
  if (row.stage === "unsubscribed" || row.stage === "closed_lost") throw new Error("This person opted out or declined; the reply was not sent");
  const { messageId } = await mailer.send({
    to: row.email, fromName: cfg.outreach.from.name, fromEmail: cfg.outreach.from.email, subject: row.subject, text: row.body,
    inReplyTo: row.in_reply_to ?? undefined, references: row.in_reply_to ? [row.in_reply_to] : undefined,
    unsubscribeMailto: cfg.outreach.from.email,
  });
  db.prepare("UPDATE messages SET status = 'sent', message_id = ?, at = ? WHERE id = ?").run(messageId, now.toISOString(), row.id);
  db.prepare("UPDATE leads SET ai_replies = ai_replies + 1, last_contact_at = ? WHERE id = ?").run(now.toISOString(), row.lead_id);
}

export function rejectReply(db: DatabaseSync, messageRowId: number): void {
  db.prepare("UPDATE messages SET status = 'rejected' WHERE id = ? AND status = 'pending_approval'").run(messageRowId);
}
