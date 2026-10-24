import { createHmac, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { Config } from "./config.ts";

export const EVENT_TYPES = [
  "lead.qualified",
  "lead.needs_human",
  "proposal.ready",
  "reply.pending",
  "sending.paused",
  "lead.unsubscribed",
  "lead.bounced",
  "discovery.done",
  "daily.summary",
  "test",
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

export interface GulfEvent {
  id: string;
  type: EventType;
  at: string;
  profile: string;
  dashboard: string;
  data: Record<string, unknown>;
}

type Env = Record<string, string | undefined>;
type Fetch = typeof fetch;

export type Target = { ok: true; url: URL; secret: string } | { ok: false; reason: string };

const PRIVATE_HOST = /^(localhost|127\.\d+\.\d+\.\d+|\[::1\]|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|host\.docker\.internal|[\w-]+\.local)$/i;

/** Where events go, or null when no webhook is set up. Plain http is only allowed for your own machine or network. */
export function webhookTarget(cfg: Config, env: Env): Target | null {
  const raw = env.WEBHOOK_URL || cfg.integrations?.webhookUrl;
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: "WEBHOOK_URL is not a valid address" };
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && PRIVATE_HOST.test(url.hostname)))
    return { ok: false, reason: "WEBHOOK_URL must be https (http is allowed only for localhost or your local network)" };
  const secret = env.WEBHOOK_SECRET ?? "";
  if (secret.length < 12) return { ok: false, reason: "Set WEBHOOK_SECRET in .env (at least 12 characters) so the receiver can trust events" };
  return { ok: true, url, secret };
}

/** One delivery attempt. Redirects are not followed, so the payload can never be forwarded somewhere else. */
export async function deliver(t: Extract<Target, { ok: true }>, event: GulfEvent, doFetch: Fetch = fetch): Promise<void> {
  const body = JSON.stringify(event);
  const res = await doFetch(t.url, {
    method: "POST",
    redirect: "manual",
    signal: AbortSignal.timeout(8_000),
    headers: {
      "content-type": "application/json",
      "x-gulf-secret": t.secret,
      "x-gulf-event": event.type,
      "x-gulf-signature": "sha256=" + createHmac("sha256", t.secret).update(body).digest("hex"),
    },
    body,
  });
  if (res.status < 200 || res.status >= 300) throw new Error(`receiver answered ${res.status}`);
}

export interface EmitOptions {
  env?: Env;
  doFetch?: Fetch;
  now?: Date;
  profile?: string;
}

/** Record an event and push it to the webhook. This never throws: a broken receiver must not stop the pipeline. */
export async function emit(db: DatabaseSync, cfg: Config, type: EventType, data: Record<string, unknown>, o: EmitOptions = {}): Promise<GulfEvent> {
  const now = (o.now ?? new Date()).toISOString();
  const event: GulfEvent = {
    id: randomUUID(), type, at: now, profile: o.profile ?? "default",
    dashboard: cfg.integrations?.dashboardUrl ?? "http://localhost:4300", data,
  };
  const wanted = !cfg.integrations?.events || cfg.integrations.events.includes(type);
  const target = wanted ? webhookTarget(cfg, o.env ?? process.env) : null;
  let status = "skipped";
  let error: string | null = null;
  let attempts = 0;
  if (target) {
    attempts = 1;
    if (!target.ok) {
      status = "failed";
      error = target.reason;
    } else {
      try {
        await deliver(target, event, o.doFetch);
        status = "delivered";
      } catch (e) {
        status = "failed";
        error = (e as Error).message;
      }
    }
  }
  try {
    db.prepare(
      "INSERT INTO events (id, type, payload, at, status, attempts, last_error, last_attempt_at, delivered_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(event.id, type, JSON.stringify(event), now, status, attempts, error, attempts ? now : null, status === "delivered" ? now : null);
  } catch {
    /* the log is best effort */
  }
  return event;
}

/** Try again for events that failed in the last 24 hours, waiting longer after each attempt. */
export async function retryFailed(db: DatabaseSync, cfg: Config, o: EmitOptions = {}): Promise<{ retried: number; delivered: number }> {
  const target = webhookTarget(cfg, o.env ?? process.env);
  const out = { retried: 0, delivered: 0 };
  if (!target || !target.ok) return out;
  const now = o.now ?? new Date();
  const rows = db
    .prepare("SELECT id, payload, attempts, last_attempt_at FROM events WHERE status = 'failed' AND attempts < 6 AND at >= ? ORDER BY at LIMIT 20")
    .all(new Date(now.getTime() - 86_400_000).toISOString()) as unknown as { id: string; payload: string; attempts: number; last_attempt_at: string | null }[];
  for (const r of rows) {
    if (r.last_attempt_at && new Date(r.last_attempt_at).getTime() + r.attempts * 5 * 60_000 > now.getTime()) continue;
    out.retried++;
    try {
      await deliver(target, JSON.parse(r.payload) as GulfEvent, o.doFetch);
      db.prepare("UPDATE events SET status = 'delivered', attempts = attempts + 1, delivered_at = ?, last_attempt_at = ?, last_error = NULL WHERE id = ?").run(now.toISOString(), now.toISOString(), r.id);
      out.delivered++;
    } catch (e) {
      db.prepare("UPDATE events SET attempts = attempts + 1, last_attempt_at = ?, last_error = ? WHERE id = ?").run(now.toISOString(), (e as Error).message, r.id);
    }
  }
  return out;
}
