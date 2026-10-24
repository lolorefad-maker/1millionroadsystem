import type { DatabaseSync } from "node:sqlite";
import type { Config, Outreach } from "./config.ts";
import { isSuppressed } from "./db.ts";
import type { Mailer } from "./mail.ts";
import { enforceHealth } from "./health.ts";

const DAY_MS = 86_400_000;

/** Local wall-clock parts for the sender's configured UTC offset. */
export function localParts(now: Date, o: Outreach): { day: number; hour: number; midnightUtc: Date } {
  const local = new Date(now.getTime() + o.utcOffsetHours * 3_600_000);
  const midnight = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()) - o.utcOffsetHours * 3_600_000;
  return { day: local.getUTCDay(), hour: local.getUTCHours(), midnightUtc: new Date(midnight) };
}

export function inSendWindow(now: Date, o: Outreach): boolean {
  const { day, hour } = localParts(now, o);
  return o.sendDays.includes(day) && hour >= o.sendHours.start && hour < o.sendHours.end;
}

export function footer(cfg: Config): string {
  return `\n\n--\n${cfg.outreach.senderAddressLine}\nIf you would rather not get messages from me, reply "unsubscribe" and I will stop right away.`;
}

function firstName(person: string): string {
  return person.split(/\s+/)[0] ?? "";
}

export function followUpBody(touch: 2 | 3, lead: { company: string; domain: string; person: string }, cfg: Config): string {
  const hi = firstName(lead.person) ? `Hi ${firstName(lead.person)},` : `Hi ${lead.company} team,`;
  const sign = `${cfg.sender.name}, ${cfg.sender.company}`;
  if (touch === 2)
    return `${hi}\n\nI am following up on my note about ${lead.domain}. I can send a short example of what it could look like for ${lead.company}, with no commitment. If it is not a priority right now, that is completely fine.\n\n${sign}`;
  return `${hi}\n\nThis is my last note. If improving ${lead.domain} is not on your list this quarter, I will close this out. If it is, a one-line reply is all I need and I will take it from there.\n\n${sign}`;
}

export interface SendResult {
  sent: number;
  heldForApproval: number;
  outsideWindow: boolean;
  capReached: boolean;
  /** First messages not sent because the address is not confirmed valid and today's test allowance is used. */
  heldUnverified: number;
  /** Set when sending is stopped because bounces or opt-outs passed the limit. */
  paused?: string;
}

interface Due {
  id: number;
  company: string;
  domain: string;
  person: string;
  email: string;
  touches: number;
  email_status: string;
}

/** Send every touch that is due, inside the daily cap and the sending window. */
export async function sendDue(db: DatabaseSync, cfg: Config, mailer: Mailer, now = new Date()): Promise<SendResult> {
  const o = cfg.outreach;
  const result: SendResult = { sent: 0, heldForApproval: 0, outsideWindow: false, capReached: false, heldUnverified: 0 };
  const paused = enforceHealth(db, cfg, now);
  if (paused) return { ...result, paused };
  if (!inSendWindow(now, o)) return { ...result, outsideWindow: true };

  const { midnightUtc } = localParts(now, o);
  const sentToday = (
    db.prepare("SELECT COUNT(*) AS n FROM messages WHERE direction = 'out' AND kind LIKE 'touch%' AND at >= ?").get(midnightUtc.toISOString()) as { n: number }
  ).n;
  let room = o.dailyCap - sentToday;

  const requireValid = o.verification?.require ?? true;
  let riskyRoom =
    (o.verification?.riskyDailyCap ?? 3) -
    (
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM messages m JOIN leads l ON l.id = m.lead_id
           WHERE m.direction = 'out' AND m.kind = 'touch1' AND m.at >= ? AND l.email_status != 'valid'`,
        )
        .get(midnightUtc.toISOString()) as { n: number }
    ).n;

  const due = db
    .prepare(
      `SELECT id, company, domain, person, email, touches, email_status FROM leads
       WHERE tier IN ('A','B') AND email != '' AND email_status != 'invalid'
         AND ((stage = 'prospect') OR (stage = 'contacted' AND next_touch_at IS NOT NULL AND next_touch_at <= ?))
       ORDER BY score DESC`,
    )
    .all(now.toISOString()) as unknown as Due[];

  for (const lead of due) {
    if (room <= 0) {
      result.capReached = true;
      break;
    }
    if (isSuppressed(db, lead.email, lead.domain)) continue;
    const touch = lead.touches + 1;
    if (touch > o.touchGapDays.length + 1 || touch > 3) continue;
    // New contacts must be confirmed valid; unconfirmed ones only fill a small daily test allowance.
    const risky = touch === 1 && requireValid && lead.email_status !== "valid";
    if (risky && riskyRoom <= 0) {
      result.heldUnverified++;
      continue;
    }
    let subject: string;
    let body: string;
    let inReplyTo: string | undefined;

    if (touch === 1) {
      const d = db.prepare("SELECT subject, body, review FROM drafts WHERE lead_id = ?").get(lead.id) as
        | { subject: string; body: string; review: string }
        | undefined;
      if (!d || d.review === "rejected") continue;
      if (o.mode === "review" && d.review !== "approved") {
        result.heldForApproval++;
        continue;
      }
      subject = d.subject;
      body = d.body;
    } else {
      const first = db
        .prepare("SELECT subject, message_id FROM messages WHERE lead_id = ? AND kind = 'touch1' ORDER BY id LIMIT 1")
        .get(lead.id) as { subject: string; message_id: string } | undefined;
      if (!first) continue;
      subject = `Re: ${first.subject.replace(/^Re:\s*/i, "")}`;
      inReplyTo = first.message_id;
      body = followUpBody(touch as 2 | 3, lead, cfg);
    }

    const text = body + footer(cfg);
    const { messageId } = await mailer.send({
      to: lead.email,
      fromName: o.from.name,
      fromEmail: o.from.email,
      subject,
      text,
      inReplyTo,
      references: inReplyTo ? [inReplyTo] : undefined,
      unsubscribeMailto: o.from.email,
    });
    const at = now.toISOString();
    db.prepare(
      "INSERT INTO messages (lead_id, direction, kind, subject, body, message_id, in_reply_to, status, at) VALUES (?, 'out', ?, ?, ?, ?, ?, 'sent', ?)",
    ).run(lead.id, `touch${touch}`, subject, text, messageId, inReplyTo ?? null, at);
    const gap = o.touchGapDays[touch - 1];
    const next = gap === undefined ? null : new Date(now.getTime() + gap * DAY_MS).toISOString();
    db.prepare("UPDATE leads SET stage = 'contacted', touches = ?, last_contact_at = ?, next_touch_at = ? WHERE id = ?").run(touch, at, next, lead.id);
    result.sent++;
    room--;
    if (risky) riskyRoom--;
  }
  return result;
}

/** Mark first-touch drafts as approved so the sender may send them (review mode). */
export function approveDrafts(db: DatabaseSync, which: "A" | "all" | number[]): number {
  if (Array.isArray(which)) {
    const stmt = db.prepare("UPDATE drafts SET review = 'approved' WHERE lead_id = ? AND review != 'approved'");
    return which.reduce((n, id) => n + Number(stmt.run(id).changes), 0);
  }
  const sql =
    which === "A"
      ? "UPDATE drafts SET review = 'approved' WHERE review != 'approved' AND lead_id IN (SELECT id FROM leads WHERE tier = 'A')"
      : "UPDATE drafts SET review = 'approved' WHERE review != 'approved'";
  return Number(db.prepare(sql).run().changes);
}
