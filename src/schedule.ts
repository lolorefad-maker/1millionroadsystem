import type { DatabaseSync } from "node:sqlite";
import type { Config } from "./config.ts";
import { getState, setState } from "./db.ts";
import { localParts } from "./outreach.ts";
import { runTarget, type PipelineDeps, type TargetResult } from "./pipeline.ts";
import type { EventType } from "./events.ts";

type Ev = (type: EventType, data: Record<string, unknown>) => Promise<unknown>;

/** The sender's calendar date, e.g. "2026-10-21", so "once a day" follows local midnight. */
export function localDate(now: Date, cfg: Config): string {
  return new Date(now.getTime() + cfg.outreach.utcOffsetHours * 3_600_000).toISOString().slice(0, 10);
}

export interface ScheduleResult {
  ran: boolean;
  skipped?: string;
  results?: TargetResult[];
}

/** Start the daily search when its hour has come and it has not run today. Safe to call every few minutes. */
export async function runSchedule(
  db: DatabaseSync, cfg: Config, ev: Ev, deps: PipelineDeps & { run?: typeof runTarget } = {}, now = new Date(),
): Promise<ScheduleResult> {
  const plan = cfg.schedule?.discover;
  if (!plan || plan.targets.length === 0) return { ran: false, skipped: "no schedule" };
  const { day, hour } = localParts(now, cfg.outreach);
  if (!(plan.days ?? cfg.outreach.sendDays).includes(day)) return { ran: false, skipped: "not a scheduled day" };
  if (hour < plan.hour) return { ran: false, skipped: "too early" };
  const today = localDate(now, cfg);
  if (getState(db, "discover_last") === today) return { ran: false, skipped: "already ran today" };
  setState(db, "discover_last", today); // marked first: a crash halfway must not repeat the search all day

  const run = deps.run ?? runTarget;
  const results: TargetResult[] = [];
  let added = 0;
  const cap = plan.maxPerDay ?? 100;
  for (const t of plan.targets) {
    if (added >= cap) {
      results.push({ label: `${t.industry} · ${t.country}`, error: `skipped: daily cap of ${cap} companies reached` });
      continue;
    }
    const r = await run(db, cfg, { ...t, limit: Math.min(t.limit ?? 30, cap - added) }, deps);
    added += r.discovered?.added ?? 0;
    results.push(r);
  }
  await ev("discovery.done", {
    added,
    targets: results.map((r) => ({ label: r.label, added: r.discovered?.added ?? 0, checked: r.checked?.ok ?? 0, drafted: r.drafted ?? 0, error: r.error ?? "" })),
  });
  return { ran: true, results };
}

/** One summary event a day, after the summary hour (default 18:00 local). */
export async function maybeSummary(db: DatabaseSync, cfg: Config, ev: Ev, now = new Date()): Promise<boolean> {
  const { hour } = localParts(now, cfg.outreach);
  if (hour < (cfg.schedule?.summaryHour ?? 18)) return false;
  const today = localDate(now, cfg);
  if (getState(db, "summary_last") === today) return false;
  setState(db, "summary_last", today);
  const since = localParts(now, cfg.outreach).midnightUtc.toISOString();
  const n = (sql: string, ...p: string[]) => (db.prepare(sql).get(...p) as { n: number }).n;
  await ev("daily.summary", {
    date: today,
    sent: n("SELECT COUNT(*) AS n FROM messages WHERE direction = 'out' AND kind LIKE 'touch%' AND at >= ?", since),
    replies: n("SELECT COUNT(*) AS n FROM messages WHERE direction = 'in' AND at >= ?", since),
    qualified: n("SELECT COUNT(*) AS n FROM handoffs WHERE reason = 'qualified' AND created_at >= ?", since),
    waitingApproval:
      n("SELECT COUNT(*) AS n FROM messages WHERE status = 'pending_approval'") +
      n("SELECT COUNT(*) AS n FROM proposals WHERE status = 'pending_approval'") +
      n("SELECT COUNT(*) AS n FROM drafts d JOIN leads l ON l.id = d.lead_id WHERE d.review = 'needs_review' AND l.tier IN ('A','B') AND l.stage = 'prospect'"),
    openHandoffs: n("SELECT COUNT(*) AS n FROM leads WHERE stage = 'handoff'"),
  });
  return true;
}
