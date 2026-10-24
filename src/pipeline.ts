import type { DatabaseSync } from "node:sqlite";
import type { Config, ScheduleTarget } from "./config.ts";
import { checkLead } from "./checker.ts";
import { discover, type DiscoverResult } from "./discover.ts";
import { draftAll } from "./draft.ts";
import { scoreAll } from "./score.ts";
import { pickVerifier, verifyLeads, type Verifier, type VerifySummary } from "./verify.ts";

/** Fetch the sites of companies that were found but not looked at yet, five at a time. */
export async function checkPending(
  db: DatabaseSync, cfg: Config, max: number, onProgress?: (done: number, total: number) => void,
): Promise<{ ok: number; unreachable: number }> {
  const rows = db
    .prepare("SELECT id, domain, email FROM leads WHERE status = 'new' LIMIT ?")
    .all(max) as unknown as { id: number; domain: string; email: string }[];
  const out = { ok: 0, unreachable: 0 };
  let next = 0;
  const worker = async () => {
    for (let i = next++; i < rows.length; i = next++) {
      const r = await checkLead(db, rows[i]!, cfg);
      out[r === "ok" ? "ok" : "unreachable"]++;
      onProgress?.(out.ok + out.unreachable, rows.length);
    }
  };
  await Promise.all(Array.from({ length: 5 }, worker));
  return out;
}

export interface TargetResult {
  label: string;
  discovered?: DiscoverResult;
  checked?: { ok: number; unreachable: number };
  verified?: VerifySummary;
  drafted?: number;
  error?: string;
}

export interface PipelineDeps {
  env?: Record<string, string | undefined>;
  doFetch?: typeof fetch;
  verifier?: Verifier;
  check?: typeof checkPending;
}

export const targetLabel = (t: ScheduleTarget) => `${t.industry} · ${t.city ? t.city + ", " : ""}${t.country}`;

/** The whole front half of the system for one search: find, look at the sites, score, confirm emails, draft. */
export async function runTarget(db: DatabaseSync, cfg: Config, t: ScheduleTarget, deps: PipelineDeps = {}): Promise<TargetResult> {
  const env = deps.env ?? process.env;
  const limit = Math.min(60, Math.max(1, t.limit ?? 30));
  const result: TargetResult = { label: targetLabel(t) };
  try {
    result.discovered = await discover(db, cfg, { country: t.country, industry: t.industry, city: t.city, limit, provider: t.provider ?? "osm" }, deps.doFetch ?? fetch, env);
    result.checked = await (deps.check ?? checkPending)(db, cfg, limit);
    scoreAll(db, cfg);
    result.verified = await verifyLeads(db, deps.verifier ?? pickVerifier(env), { max: limit, delayMs: 120 });
    scoreAll(db, cfg);
    result.drafted = draftAll(db, cfg).drafted;
  } catch (e) {
    result.error = (e as Error).message;
  }
  return result;
}
