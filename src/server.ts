import { createServer as httpServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { timingSafeEqual } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { Config } from "./config.ts";
import type { Mailer } from "./mail.ts";
import { approveDrafts, localParts } from "./outreach.ts";
import { approveReply, rejectReply } from "./inbox.ts";
import { sendProposal } from "./proposal.ts";
import { computeHealth, resume } from "./health.ts";
import { getState, suppress } from "./db.ts";
import { emit, retryFailed, webhookTarget } from "./events.ts";
import { OSM_TAGS } from "./discover.ts";
import { runTarget } from "./pipeline.ts";

const N8N_FILE = new URL("../integrations/n8n/gulf-leads.workflow.json", import.meta.url);

export interface DashboardOptions {
  profile: string;
  env: Record<string, string | undefined>;
  /** Replaceable in tests so the search endpoint never touches the network. */
  run?: typeof runTarget;
}

const PAGE_URL = new URL("./dashboard.html", import.meta.url);
/** Read on every request so edits to the page show up on reload without restarting. */
const page = () => readFileSync(PAGE_URL, "utf8");

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 100_000) throw new Error("body too large");
  }
  return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
}

function sameToken(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Local dashboard: shows leads and conversations, and is where a person approves what goes out. */
export function createDashboard(
  db: DatabaseSync, cfg: Config, getMailer: () => Mailer, token: string,
  opts: DashboardOptions = { profile: "default", env: process.env },
): Server {
  let discovering = false;
  const all = (sql: string, ...p: (string | number)[]) => db.prepare(sql).all(...p) as unknown as Record<string, unknown>[];
  const one = (sql: string, ...p: (string | number)[]) => db.prepare(sql).get(...p) as unknown as Record<string, unknown> | undefined;

  /** Numbers behind the charts: a daily trend, this period against the one before, the funnel and the mixes. */
  function analytics(days: number, now = new Date()): unknown {
    const dayKey = (d: Date) => d.toISOString().slice(0, 10);
    // Whole UTC days, so the totals and the daily series always agree.
    const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
    const start = new Date(today - (days - 1) * 86_400_000);
    const end = new Date(today + 86_400_000);
    const prevStart = new Date(start.getTime() - days * 86_400_000);
    const labels = Array.from({ length: days }, (_, i) => dayKey(new Date(start.getTime() + i * 86_400_000)));
    const series = (sql: string) => {
      const m = new Map(all(sql, labels[0]!).map((r) => [String(r.d), Number(r.n)]));
      return labels.map((d) => m.get(d) ?? 0);
    };
    const sent = series("SELECT substr(at,1,10) AS d, COUNT(*) AS n FROM messages WHERE direction = 'out' AND kind LIKE 'touch%' AND substr(at,1,10) >= ? GROUP BY d");
    const replies = series("SELECT substr(at,1,10) AS d, COUNT(*) AS n FROM messages WHERE direction = 'in' AND substr(at,1,10) >= ? GROUP BY d");
    const qualified = series("SELECT substr(created_at,1,10) AS d, COUNT(*) AS n FROM handoffs WHERE reason = 'qualified' AND substr(created_at,1,10) >= ? GROUP BY d");
    const count = (sql: string, ...p: string[]) => Number((one(sql, ...p) as { n: number }).n);
    const between = (table: string, col: string, extra: string, from: Date, to: Date) =>
      count(`SELECT COUNT(*) AS n FROM ${table} WHERE ${extra} AND ${col} >= ? AND ${col} < ?`, from.toISOString(), to.toISOString());
    const periods = (table: string, col: string, extra: string) => ({
      now: between(table, col, extra, start, end),
      before: between(table, col, extra, prevStart, start),
    });
    return {
      days, labels, sent, replies, qualified,
      totals: {
        sent: periods("messages", "at", "direction = 'out' AND kind LIKE 'touch%'"),
        replies: periods("messages", "at", "direction = 'in'"),
        qualified: periods("handoffs", "created_at", "reason = 'qualified'"),
        proposals: periods("proposals", "sent_at", "status = 'sent'"),
      },
      funnel: [
        { key: "found", n: count("SELECT COUNT(*) AS n FROM leads") },
        { key: "contacted", n: count("SELECT COUNT(*) AS n FROM leads WHERE touches > 0") },
        { key: "replied", n: count("SELECT COUNT(DISTINCT lead_id) AS n FROM messages WHERE direction = 'in'") },
        { key: "qualified", n: count("SELECT COUNT(*) AS n FROM handoffs WHERE reason = 'qualified'") },
        { key: "proposal", n: count("SELECT COUNT(DISTINCT lead_id) AS n FROM proposals WHERE status = 'sent'") },
      ],
      tiers: Object.fromEntries(all("SELECT COALESCE(tier,'-') AS t, COUNT(*) AS n FROM leads GROUP BY t").map((r) => [r.t, r.n])),
      industries: all("SELECT industry, COUNT(*) AS n, ROUND(AVG(score)) AS avg_score FROM leads GROUP BY industry ORDER BY n DESC LIMIT 8"),
      signals: all("SELECT kind, COUNT(DISTINCT domain) AS n FROM site_facts GROUP BY kind ORDER BY n DESC"),
    };
  }

  async function route(method: string, path: string, query: URLSearchParams, body: Record<string, unknown>): Promise<unknown> {
    if (method === "GET" && path === "/api/overview") {
      const stages = Object.fromEntries(all("SELECT stage, COUNT(*) AS n FROM leads GROUP BY stage").map((r) => [r.stage, r.n]));
      const tiers = Object.fromEntries(all("SELECT COALESCE(tier,'-') AS t, COUNT(*) AS n FROM leads GROUP BY t").map((r) => [r.t, r.n]));
      return {
        mode: cfg.outreach.mode,
        health: computeHealth(db),
        sendToday: {
          cap: cfg.outreach.dailyCap,
          sent: Number(
            (one(
              "SELECT COUNT(*) AS n FROM messages WHERE direction = 'out' AND kind LIKE 'touch%' AND at >= ?",
              localParts(new Date(), cfg.outreach).midnightUtc.toISOString(),
            ) as { n: number }).n,
          ),
        },
        emails: Object.fromEntries(
          all("SELECT email_status AS s, COUNT(*) AS n FROM leads WHERE email != '' GROUP BY email_status").map((r) => [r.s, r.n]),
        ),
        stages,
        tiers,
        waiting: {
          drafts: one("SELECT COUNT(*) AS n FROM drafts d JOIN leads l ON l.id = d.lead_id WHERE d.review = 'needs_review' AND l.tier IN ('A','B') AND l.stage = 'prospect'")!.n,
          replies: one("SELECT COUNT(*) AS n FROM messages WHERE status = 'pending_approval'")!.n,
          proposals: one("SELECT COUNT(*) AS n FROM proposals WHERE status = 'pending_approval'")!.n,
          handoffs: one("SELECT COUNT(*) AS n FROM handoffs h JOIN leads l ON l.id = h.lead_id WHERE l.stage = 'handoff'")!.n,
        },
      };
    }
    if (method === "GET" && path === "/api/analytics") {
      const days = Math.min(90, Math.max(7, Number(query.get("days")) || 14));
      return analytics(days);
    }
    if (method === "GET" && path === "/api/integrations") {
      const t = webhookTarget(cfg, opts.env);
      const plan = cfg.schedule?.discover;
      const n = (status: string) => Number((one("SELECT COUNT(*) AS n FROM events WHERE status = ?", status) as { n: number }).n);
      return {
        webhook: !t ? { state: "off" } : t.ok ? { state: "on", host: t.url.host, events: cfg.integrations?.events ?? "all" } : { state: "error", reason: t.reason },
        hooks: Boolean(opts.env.HOOK_TOKEN),
        schedule: plan
          ? { hour: plan.hour, days: plan.days ?? cfg.outreach.sendDays, targets: plan.targets, maxPerDay: plan.maxPerDay ?? 100, lastRun: getState(db, "discover_last"), summaryHour: cfg.schedule?.summaryHour ?? 18 }
          : null,
        counts: { delivered: n("delivered"), failed: n("failed"), skipped: n("skipped") },
        events: all("SELECT id, type, at, status, attempts, last_error, payload FROM events ORDER BY at DESC LIMIT 30").map((e) => ({
          id: e.id, type: e.type, at: e.at, status: e.status, attempts: e.attempts, error: e.last_error,
          company: String(((JSON.parse(String(e.payload)) as { data?: { company?: string } }).data ?? {}).company ?? ""),
        })),
      };
    }
    if (method === "GET" && path === "/api/integrations/n8n") return JSON.parse(readFileSync(N8N_FILE, "utf8"));
    if (method === "GET" && path === "/api/pending") {
      return {
        drafts: all(
          `SELECT l.id AS lead_id, l.company, l.email, l.tier, l.score, d.subject, d.body, d.fact_text, d.fact_url
           FROM drafts d JOIN leads l ON l.id = d.lead_id
           WHERE d.review = 'needs_review' AND l.tier IN ('A','B') AND l.stage = 'prospect' AND l.email != '' ORDER BY l.score DESC LIMIT 100`,
        ),
        replies: all(
          `SELECT m.id, m.lead_id, l.company, m.subject, m.body FROM messages m JOIN leads l ON l.id = m.lead_id WHERE m.status = 'pending_approval' ORDER BY m.id`,
        ),
        proposals: all(
          `SELECT p.id, p.lead_id, l.company, p.subject, p.body, p.content FROM proposals p JOIN leads l ON l.id = p.lead_id WHERE p.status = 'pending_approval' ORDER BY p.id`,
        ).map((p) => ({ ...p, citations: (JSON.parse(String(p.content)) as { citations?: unknown }).citations ?? [], content: undefined })),
        blocked: all(
          `SELECT p.id, l.company, p.block_reason FROM proposals p JOIN leads l ON l.id = p.lead_id WHERE p.status = 'blocked' ORDER BY p.id DESC LIMIT 20`,
        ),
      };
    }
    if (method === "GET" && path === "/api/handoffs")
      return all(
        `SELECT h.*, l.company, l.domain, l.person, l.email, l.phone FROM handoffs h JOIN leads l ON l.id = h.lead_id WHERE l.stage = 'handoff' ORDER BY h.created_at DESC`,
      );
    if (method === "GET" && path === "/api/leads") {
      const stage = query.get("stage");
      const q = `%${(query.get("q") ?? "").toLowerCase()}%`;
      return all(
        `SELECT id, company, domain, city, industry, tier, score, stage, email, email_status, touches FROM leads
         WHERE (? = '' OR stage = ?) AND (lower(company) LIKE ? OR lower(domain) LIKE ?) ORDER BY COALESCE(score, -1) DESC LIMIT 200`,
        stage ?? "", stage ?? "", q, q,
      );
    }
    const lead = path.match(/^\/api\/leads\/(\d+)$/);
    if (method === "GET" && lead) {
      const id = Number(lead[1]);
      const l = one("SELECT * FROM leads WHERE id = ?", id);
      if (!l) throw new Error("not found");
      return {
        lead: l,
        messages: all("SELECT id, direction, kind, subject, body, status, at FROM messages WHERE lead_id = ? ORDER BY id", id),
        facts: all("SELECT kind, text, url FROM site_facts WHERE domain = ?", String(l.domain)),
        handoff: one("SELECT * FROM handoffs WHERE lead_id = ?", id) ?? null,
        proposals: all("SELECT id, status, subject, block_reason, created_at FROM proposals WHERE lead_id = ? ORDER BY id DESC", id),
        research: one("SELECT notes, gathered_at FROM research WHERE lead_id = ?", id) ?? null,
      };
    }

    if (method !== "POST") throw new Error("not found");
    if (path === "/api/integrations/test") {
      const e = await emit(db, cfg, "test", { message: "اختبار من لوحة التحكم" }, { env: opts.env, profile: opts.profile });
      const r = one("SELECT status, last_error FROM events WHERE id = ?", e.id) as { status: string; last_error: string | null };
      return { status: r.status, error: r.last_error };
    }
    if (path === "/api/integrations/retry") return retryFailed(db, cfg, { env: opts.env });
    let m: RegExpMatchArray | null;
    if ((m = path.match(/^\/api\/drafts\/(\d+)\/(approve|reject)$/))) {
      const id = Number(m[1]);
      if (m[2] === "approve") {
        if (typeof body.body === "string" && body.body.trim())
          db.prepare("UPDATE drafts SET body = ? WHERE lead_id = ?").run(body.body.trim(), id);
        approveDrafts(db, [id]);
      } else db.prepare("UPDATE drafts SET review = 'rejected' WHERE lead_id = ?").run(id);
      return { ok: true };
    }
    if ((m = path.match(/^\/api\/replies\/(\d+)\/(approve|reject)$/))) {
      const id = Number(m[1]);
      if (m[2] === "approve") {
        if (typeof body.body === "string" && body.body.trim())
          db.prepare("UPDATE messages SET body = ? WHERE id = ? AND status = 'pending_approval'").run(body.body.trim(), id);
        await approveReply(db, cfg, getMailer(), id);
      } else rejectReply(db, id);
      return { ok: true };
    }
    if ((m = path.match(/^\/api\/proposals\/(\d+)\/(approve|reject)$/))) {
      const id = Number(m[1]);
      if (m[2] === "approve") {
        if (typeof body.body === "string" && body.body.trim())
          db.prepare("UPDATE proposals SET body = ? WHERE id = ? AND status = 'pending_approval'").run(body.body.trim(), id);
        await sendProposal(db, cfg, getMailer(), id);
      } else db.prepare("UPDATE proposals SET status = 'rejected' WHERE id = ? AND status = 'pending_approval'").run(id);
      return { ok: true };
    }
    if ((m = path.match(/^\/api\/leads\/(\d+)\/suppress$/))) {
      const l = one("SELECT email FROM leads WHERE id = ?", Number(m[1]));
      if (!l?.email) throw new Error("this lead has no email");
      suppress(db, String(l.email), "manual");
      db.prepare("UPDATE leads SET stage = 'closed_lost', next_touch_at = NULL WHERE id = ?").run(Number(m[1]));
      return { ok: true };
    }
    if (path === "/api/resume") {
      resume(db);
      return { ok: true };
    }
    throw new Error("not found");
  }

  async function hook(path: string, body: Record<string, unknown>): Promise<unknown> {
    if (path === "/api/hooks/suppress") {
      const v = String(body.value ?? "").trim().toLowerCase();
      if (!v || v.length > 200) throw new Error("value is required");
      suppress(db, v, "n8n");
      db.prepare("UPDATE leads SET stage = 'closed_lost', next_touch_at = NULL WHERE (email = ? OR domain = ?) AND stage IN ('prospect','contacted')").run(v, v);
      return { ok: true };
    }
    if (path === "/api/hooks/discover") {
      const country = String(body.country ?? "").toUpperCase();
      const industry = String(body.industry ?? "").toLowerCase();
      if (!cfg.icp.countries.includes(country)) throw new Error("country is not in the profile");
      if (!(industry in OSM_TAGS) || cfg.exclude.industries.includes(industry)) throw new Error("unknown or excluded industry");
      if (discovering) throw new Error("a search is already running");
      const provider = body.provider === "google" ? "google" : "osm";
      const limit = Math.min(60, Math.max(1, Number(body.limit) || 30));
      discovering = true;
      void (opts.run ?? runTarget)(db, cfg, { country, industry, city: typeof body.city === "string" ? body.city.slice(0, 60) : undefined, limit, provider }, { env: opts.env })
        .then((r) =>
          emit(db, cfg, "discovery.done", { added: r.discovered?.added ?? 0, targets: [{ label: r.label, added: r.discovered?.added ?? 0, checked: r.checked?.ok ?? 0, drafted: r.drafted ?? 0, error: r.error ?? "" }] }, { env: opts.env, profile: opts.profile }),
        )
        .finally(() => { discovering = false; });
      return { accepted: true };
    }
    throw new Error("not found");
  }

  return httpServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (req.method === "GET" && url.pathname === "/") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
        res.end(page());
        return;
      }
      if (!url.pathname.startsWith("/api/")) return json(res, 404, { error: "not found" });

      // Endpoints for n8n. They use their own token and can only do harmless things: they can never approve or send a message.
      if (url.pathname.startsWith("/api/hooks/")) {
        const ht = opts.env.HOOK_TOKEN;
        if (!ht) return json(res, 404, { error: "not found" });
        if (req.method !== "POST" || !sameToken(String(req.headers["x-hook-token"] ?? ""), ht)) return json(res, 401, { error: "bad token" });
        return json(res, 200, await hook(url.pathname, await readJson(req)));
      }
      if (!sameToken(String(req.headers["x-token"] ?? ""), token)) return json(res, 401, { error: "bad token" });
      const body = req.method === "POST" ? await readJson(req) : {};
      json(res, 200, await route(req.method ?? "GET", url.pathname, url.searchParams, body));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      json(res, msg === "not found" ? 404 : 400, { error: msg });
    }
  });
}
