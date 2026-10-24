import type { DatabaseSync } from "node:sqlite";
import type { Config } from "./config.ts";
import { getState, setState } from "./db.ts";

export interface Health {
  sent7d: number;
  bounced7d: number;
  bounceRate: number;
  unsubscribed7d: number;
  unsubscribeRate: number;
  replies7d: number;
  paused: string | null;
}

export const DEFAULT_LIMITS = { maxBounceRate: 0.02, maxUnsubscribeRate: 0.01, minSample: 20 };

export function limitsOf(cfg: Config): typeof DEFAULT_LIMITS {
  return { ...DEFAULT_LIMITS, ...(cfg.outreach.limits ?? {}) };
}

export function computeHealth(db: DatabaseSync, now = new Date()): Health {
  const since = new Date(now.getTime() - 7 * 86_400_000).toISOString();
  const n = (sql: string) => (db.prepare(sql).get(since) as { n: number }).n;
  const sent7d = n("SELECT COUNT(*) AS n FROM messages WHERE direction = 'out' AND kind LIKE 'touch%' AND at >= ?");
  const bounced7d = n("SELECT COUNT(*) AS n FROM leads WHERE stage = 'bounced' AND last_contact_at >= ?");
  const unsubscribed7d = n("SELECT COUNT(*) AS n FROM suppression WHERE reason = 'unsubscribed' AND added_at >= ?");
  const replies7d = n("SELECT COUNT(*) AS n FROM messages WHERE direction = 'in' AND at >= ?");
  return {
    sent7d, bounced7d, unsubscribed7d, replies7d,
    bounceRate: sent7d ? bounced7d / sent7d : 0,
    unsubscribeRate: sent7d ? unsubscribed7d / sent7d : 0,
    paused: getState(db, "paused"),
  };
}

/** Pause all sending when bounces or opt-outs pass the limit. Returns the reason if sending must stop. */
export function enforceHealth(db: DatabaseSync, cfg: Config, now = new Date()): string | null {
  const h = computeHealth(db, now);
  if (h.paused) return h.paused;
  const lim = limitsOf(cfg);
  if (h.sent7d < lim.minSample) return null;
  let reason: string | null = null;
  if (h.bounceRate > lim.maxBounceRate)
    reason = `bounce rate ${(h.bounceRate * 100).toFixed(1)}% is above ${(lim.maxBounceRate * 100).toFixed(1)}%: check the email addresses`;
  else if (h.unsubscribeRate > lim.maxUnsubscribeRate)
    reason = `opt-out rate ${(h.unsubscribeRate * 100).toFixed(1)}% is above ${(lim.maxUnsubscribeRate * 100).toFixed(1)}%: check who you target and what you write`;
  if (reason) setState(db, "paused", reason);
  return reason;
}

export function resume(db: DatabaseSync): void {
  db.prepare("DELETE FROM mail_state WHERE key IN ('paused', 'paused_notified')").run();
}
