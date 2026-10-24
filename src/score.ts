import type { DatabaseSync } from "node:sqlite";
import type { Config } from "./config.ts";
import { isSuppressed } from "./db.ts";

export interface ScoreInput {
  country: string;
  industry: string;
  size: number | null;
  title: string;
  email: string;
  email_status: string;
  status: string;
  factKinds: string[];
}

export interface Score {
  fit: number;
  intent: number;
  relationship: number;
  risk: number;
  total: number;
  tier: "A" | "B" | "C" | "X";
}

/** Weight of each website problem as a buying signal (intent is capped at 40). */
export const FACT_WEIGHT: Record<string, number> = {
  no_booking: 12,
  no_viewport: 10,
  slow: 8,
  no_https: 8,
  old_footer: 7,
  no_chat: 5,
};

/** Priority = fit/40 + intent/40 + relationship/20 - risk, as in the sales framework. */
export function scoreLead(l: ScoreInput, cfg: Config, suppressed: boolean): Score {
  if (suppressed || l.status === "unreachable")
    return { fit: 0, intent: 0, relationship: 0, risk: 100, total: -100, tier: "X" };

  let fit = 0;
  if (cfg.icp.countries.includes(l.country)) fit += 10;
  if (cfg.icp.industries.includes(l.industry)) fit += 10;
  if (l.size === null) fit += 5;
  else if (l.size >= cfg.icp.minSize && l.size <= cfg.icp.maxSize) fit += 10;
  if (l.status === "checked") fit += 10;

  const intent = Math.min(40, l.factKinds.reduce((s, k) => s + (FACT_WEIGHT[k] ?? 0), 0));

  let relationship = 0;
  if (l.email && l.email_status !== "invalid") relationship += 10;
  const title = l.title.toLowerCase();
  if (title && cfg.icp.decisionTitles.some((t) => title.includes(t))) relationship += 10;

  let risk = 0;
  if (!l.email) risk += 25;
  if (l.email_status === "invalid") risk += 40;
  if (l.email_status === "catch-all" || l.email_status === "unknown") risk += 5;

  const total = Math.max(-100, Math.min(100, fit + intent + relationship - risk));
  const tier = total >= cfg.tiers.A ? "A" : total >= cfg.tiers.B ? "B" : "C";
  return { fit, intent, relationship, risk, total, tier };
}

export function scoreAll(db: DatabaseSync, cfg: Config): { A: number; B: number; C: number; X: number } {
  const counts = { A: 0, B: 0, C: 0, X: 0 };
  const rows = db.prepare("SELECT * FROM leads").all() as unknown as (ScoreInput & { id: number; domain: string })[];
  const facts = db.prepare("SELECT kind FROM site_facts WHERE domain = ?");
  const update = db.prepare("UPDATE leads SET score = ?, tier = ?, score_detail = ? WHERE id = ?");
  for (const l of rows) {
    const factKinds = (facts.all(l.domain) as unknown as { kind: string }[]).map((f) => f.kind);
    const s = scoreLead({ ...l, factKinds }, cfg, isSuppressed(db, l.email, l.domain));
    update.run(s.total, s.tier, JSON.stringify(s), l.id);
    counts[s.tier]++;
  }
  return counts;
}
