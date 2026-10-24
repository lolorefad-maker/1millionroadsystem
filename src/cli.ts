import { parseArgs } from "node:util";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dbPathFor, loadConfig } from "./config.ts";
import { getState, isSuppressed, openDb, setState, suppress } from "./db.ts";
import { discover, OSM_TAGS } from "./discover.ts";
import { checkLead } from "./checker.ts";
import { scoreAll } from "./score.ts";
import { draftAll } from "./draft.ts";
import { importCsv } from "./import.ts";
import { toCsv } from "./csv.ts";
import type { DatabaseSync } from "node:sqlite";
import type { Config } from "./config.ts";
import { SmtpImapMailer } from "./mail.ts";
import { ClaudeLlm } from "./agent.ts";
import { approveDrafts, sendDue } from "./outreach.ts";
import { approveReply, processInbox, rejectReply } from "./inbox.ts";
import { prepareProposal, sendProposal } from "./proposal.ts";
import { resume } from "./health.ts";
import { pickVerifier, verifyLeads } from "./verify.ts";
import { checkPending } from "./pipeline.ts";
import { emit as emitEvent, retryFailed, webhookTarget, type EventType } from "./events.ts";
import { maybeSummary, runSchedule } from "./schedule.ts";
import { createDashboard } from "./server.ts";
import { randomBytes } from "node:crypto";

function exportHandoffs(db: DatabaseSync, profile: string): string {
  mkdirSync("out", { recursive: true });
  const rows = db
    .prepare(
      `SELECT h.*, l.company, l.domain, l.person, l.email, l.phone FROM handoffs h JOIN leads l ON l.id = h.lead_id ORDER BY h.created_at DESC`,
    )
    .all() as unknown as Record<string, string>[];
  const md = rows
    .map(
      (h) =>
        `## ${h.company} (${h.domain}) [${h.reason}]\n\nContact: ${h.person || "unknown"} <${h.email}> ${h.phone}\nSummary: ${h.summary}\nNeed: ${h.need}\nTimeline: ${h.timeline}\nBudget signal: ${h.budget_signal}\nNext step: ${h.next_step}\nHanded off: ${h.created_at}\n`,
    )
    .join("\n---\n\n");
  const path = `out/${profile}-handoffs.md`;
  writeFileSync(path, `# Leads waiting for you\n\n${md || "None yet.\n"}`, "utf8");
  return path;
}

/** Pushes an event to the webhook (n8n) and records it. Never throws. */
function emitter(db: DatabaseSync, cfg: Config, profile: string) {
  return (type: EventType, data: Record<string, unknown>) => emitEvent(db, cfg, type, data, { env: process.env, profile }).then(() => undefined);
}

/** When a lead qualifies: study their company and prepare a tailored proposal for the owner to approve. */
function proposalHook(db: DatabaseSync, cfg: Config, llm: ClaudeLlm, ev: ReturnType<typeof emitter>) {
  return {
    emit: ev,
    onQualified: async (lead: { id: number; company: string }) => {
      const r = await prepareProposal(db, cfg, llm, lead.id);
      console.log(r.ok ? `proposal #${r.id} for ${lead.company} is waiting for your approval` : `proposal for ${lead.company} not created: ${r.reason}`);
      if (r.ok) await ev("proposal.ready", { leadId: lead.id, company: lead.company, proposalId: r.id });
    },
  };
}

async function cycle(db: DatabaseSync, cfg: Config, profile: string): Promise<void> {
  const ev = emitter(db, cfg, profile);
  await retryFailed(db, cfg, { env: process.env });
  const plan = await runSchedule(db, cfg, ev, { env: process.env });
  if (plan.ran) console.log("scheduled search finished", plan.results?.map((r) => `${r.label}: +${r.discovered?.added ?? 0}${r.error ? " (" + r.error + ")" : ""}`));
  const verified = await verifyLeads(db, pickVerifier(process.env), { max: 50, delayMs: 120 });
  if (verified.checked || verified.stoppedBecause) console.log("verified", verified);
  const mailer = new SmtpImapMailer(process.env); // needed from here on; the daily search above works without it
  const sent = await sendDue(db, cfg, mailer);
  if (sent.paused && getState(db, "paused_notified") !== sent.paused) {
    setState(db, "paused_notified", sent.paused);
    await ev("sending.paused", { reason: sent.paused });
  }
  const llm = new ClaudeLlm(cfg);
  const inbox = await processInbox(db, cfg, mailer, llm, new Date(), proposalHook(db, cfg, llm, ev));
  await maybeSummary(db, cfg, ev);
  console.log(`[${new Date().toISOString()}] sent`, sent, "inbox", inbox, "->", exportHandoffs(db, profile));
}

const HELP = `gulf-leads: finds companies, checks their sites, scores them, sends a safe sequence, handles replies, hands qualified leads to you.

  npm run leads -- <command> --profile <name> [options]

Commands
  run       --country AE --industry restaurant [--city Dubai] [--limit 50] [--provider osm|google]
            search + check + score + draft. google needs GOOGLE_PLACES_API_KEY in .env (max 60 per search)
  discover  same options as run, only search
  check     [--max 100]                                                       fetch sites, find emails
  score                                                                       tier A/B/C
  draft                                                                       write messages for A/B leads
  export                                                                      out/<profile>-leads.csv and -drafts.md
  verify    [--max 50] [--all]   confirm emails before sending (ZeroBounce/Hunter key in .env; free local checks otherwise)
  approve   [A|all|1,2,3]   approve first messages for sending (review mode)
  send      send what is due now (respects window and daily cap)
  inbox     read replies, judge them, answer or hand off
  replies / approve-reply <id> / reject-reply <id>   AI replies waiting for you (review mode)
  handoffs  qualified leads waiting for you -> out/<profile>-handoffs.md
  dashboard [--port 4300]   web page to approve messages, replies and proposals (localhost only)
  propose <leadId>   study the company (site, YouTube, added links) and prepare a tailored proposal
  research-add <leadId> <url>   add a public page for the proposal research
  approve-proposal <id> / resume (after an automatic pause)
  webhook-test   send a test event to WEBHOOK_URL (n8n)    events   last 20 events and whether they were delivered
  loop      [--every 10]   send + inbox every N minutes, forever
  stats
  suppress  <email-or-domain> [--reason unsubscribed]
  import    <file.csv>                                                        fallback: your own list

Industries: ${Object.keys(OSM_TAGS).join(", ")}`;

function exportAll(db: DatabaseSync, profile: string): string[] {
  mkdirSync("out", { recursive: true });
  const leads = db
    .prepare(
      `SELECT l.tier, l.score, l.company, l.domain, l.country, l.city, l.industry, l.email, l.email_status,
              l.phone, l.status, l.source_url, d.subject, d.words, d.confidence, d.fact_text, d.fact_url, d.review
       FROM leads l LEFT JOIN drafts d ON d.lead_id = l.id
       ORDER BY l.score DESC`,
    )
    .all() as unknown as Record<string, string | number | null>[];
  const csvPath = `out/${profile}-leads.csv`;
  writeFileSync(csvPath, toCsv(leads), "utf8");

  const drafts = db
    .prepare(
      `SELECT l.tier, l.score, l.company, l.email, d.* FROM drafts d JOIN leads l ON l.id = d.lead_id ORDER BY l.score DESC`,
    )
    .all() as unknown as Record<string, string | number>[];
  const md = drafts
    .map(
      (d) =>
        `## [${d.tier}] ${d.company} (score ${d.score})\n\nTo: ${d.email}\nSubject: ${d.subject}\nWords: ${d.words}, confidence: ${d.confidence}\nEvidence: ${d.fact_text ?? "none (segment-level message)"} ${d.fact_url ?? ""}\n\n${d.body}\n\n---\n`,
    )
    .join("\n");
  const mdPath = `out/${profile}-drafts.md`;
  writeFileSync(mdPath, `# Drafts for review (nothing has been sent)\n\n${md}`, "utf8");
  return [csvPath, mdPath];
}

function stats(db: DatabaseSync): void {
  const one = (sql: string) => (db.prepare(sql).get() as { n: number }).n;
  const tiers = db.prepare("SELECT COALESCE(tier,'-') AS t, COUNT(*) AS n FROM leads GROUP BY t ORDER BY t").all() as unknown as { t: string; n: number }[];
  console.log(`leads: ${one("SELECT COUNT(*) AS n FROM leads")}`);
  console.log(`  checked: ${one("SELECT COUNT(*) AS n FROM leads WHERE status='checked'")}, unreachable: ${one("SELECT COUNT(*) AS n FROM leads WHERE status='unreachable'")}`);
  console.log(`  with email: ${one("SELECT COUNT(*) AS n FROM leads WHERE email != ''")}`);
  console.log(`  tiers: ${tiers.map((x) => `${x.t}=${x.n}`).join(" ")}`);
  console.log(`drafts: ${one("SELECT COUNT(*) AS n FROM drafts")}, suppressed: ${one("SELECT COUNT(*) AS n FROM suppression")}`);
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      profile: { type: "string", default: "webdev" },
      country: { type: "string" },
      industry: { type: "string" },
      city: { type: "string" },
      provider: { type: "string", default: "osm" },
      limit: { type: "string", default: "50" },
      max: { type: "string", default: "100" },
      reason: { type: "string", default: "manual" },
      every: { type: "string", default: "10" },
      port: { type: "string", default: "4300" },
      all: { type: "boolean", default: false },
    },
  });
  const [command, arg] = positionals;
  if (!command || command === "help") return void console.log(HELP);

  const cfg = loadConfig(values.profile!);
  const db = openDb(dbPathFor(values.profile!));
  const search = () => {
    if (!values.country || !values.industry) throw new Error("--country and --industry are required");
    if (values.provider !== "osm" && values.provider !== "google") throw new Error("--provider must be osm or google");
    return {
      country: values.country,
      industry: values.industry.toLowerCase(),
      city: values.city,
      limit: Number(values.limit),
      provider: values.provider,
    };
  };

  switch (command) {
    case "discover":
      console.log(await discover(db, cfg, search()));
      break;
    case "check":
      console.log(await checkPending(db, cfg, Number(values.max)));
      break;
    case "score":
      console.log(scoreAll(db, cfg));
      break;
    case "draft":
      console.log(draftAll(db, cfg));
      break;
    case "run": {
      console.log(`1/4 searching ${values.provider === "google" ? "Google Places" : "OpenStreetMap"}...`);
      console.log(await discover(db, cfg, search()));
      console.log("2/4 checking websites and looking for public emails...");
      console.log(await checkPending(db, cfg, Number(values.limit)));
      console.log("3/5 scoring...");
      console.log(scoreAll(db, cfg));
      console.log("4/5 confirming emails of the best leads (A/B)...");
      console.log(await verifyLeads(db, pickVerifier(process.env), { max: Number(values.max), delayMs: 120 }));
      console.log(scoreAll(db, cfg));
      console.log("5/5 drafting...");
      console.log(draftAll(db, cfg));
      console.log("exported:", exportAll(db, values.profile!).join(", "));
      break;
    }
    case "export":
      console.log(exportAll(db, values.profile!).join("\n"));
      break;
    case "stats":
      stats(db);
      break;
    case "suppress":
      if (!arg) throw new Error("usage: suppress <email-or-domain>");
      suppress(db, arg, values.reason!);
      db.prepare("DELETE FROM drafts WHERE lead_id IN (SELECT id FROM leads WHERE email = ? OR domain = ?)").run(arg.toLowerCase(), arg.toLowerCase());
      console.log(`suppressed ${arg} (${isSuppressed(db, arg, arg) ? "ok" : "failed"}); its drafts were removed`);
      break;
    case "verify": {
      const verifier = pickVerifier(process.env);
      if (verifier.name === "local")
        console.log("No ZEROBOUNCE_API_KEY or HUNTER_API_KEY in .env: only syntax and mail-server checks run. Mailboxes stay unconfirmed.");
      console.log(await verifyLeads(db, verifier, { max: Number(values.max), all: values.all, delayMs: 120 }));
      scoreAll(db, cfg);
      break;
    }
    case "approve": {
      // approve A | approve all | approve 3,5,8  (ids of leads)
      const which = !arg || arg === "A" ? "A" : arg === "all" ? "all" : arg.split(",").map(Number);
      console.log(`approved ${approveDrafts(db, which)} first messages`);
      break;
    }
    case "send":
      console.log(await sendDue(db, cfg, new SmtpImapMailer(process.env)));
      break;
    case "inbox": {
      const llm = new ClaudeLlm(cfg);
      console.log(await processInbox(db, cfg, new SmtpImapMailer(process.env), llm, new Date(), proposalHook(db, cfg, llm, emitter(db, cfg, values.profile!))));
      console.log("handoffs:", exportHandoffs(db, values.profile!));
      break;
    }
    case "research-add": {
      // research-add <leadId> <url>: a public page (their blog, a video, a news item) to include in the proposal research
      const url = positionals[2];
      if (!arg || !url || !/^https?:\/\//.test(url)) throw new Error("usage: research-add <leadId> <https://public-page>");
      db.prepare("INSERT OR IGNORE INTO research_links (lead_id, url) VALUES (?, ?)").run(Number(arg), url);
      console.log("added; it will be read when the proposal is prepared");
      break;
    }
    case "propose": {
      if (!arg) throw new Error("usage: propose <leadId>");
      const r = await prepareProposal(db, cfg, new ClaudeLlm(cfg), Number(arg));
      console.log(r.ok ? `proposal #${r.id} ready: out/proposals/${(db.prepare("SELECT domain FROM leads WHERE id = ?").get(Number(arg)) as { domain: string }).domain}.html` : `not created: ${r.reason}`);
      break;
    }
    case "approve-proposal":
      await sendProposal(db, cfg, new SmtpImapMailer(process.env), Number(arg));
      console.log("sent");
      break;
    case "webhook-test": {
      const t = webhookTarget(cfg, process.env);
      if (!t) return void console.log("No webhook set. Put WEBHOOK_URL and WEBHOOK_SECRET in .env");
      if (!t.ok) return void console.log("Problem:", t.reason);
      const e = await emitEvent(db, cfg, "test", { message: "hello from gulf-leads" }, { env: process.env, profile: values.profile });
      const row = db.prepare("SELECT status, last_error FROM events WHERE id = ?").get(e.id) as { status: string; last_error: string | null };
      console.log(row.status === "delivered" ? `delivered to ${t.url.host}` : `failed: ${row.last_error}`);
      break;
    }
    case "events": {
      const rows = db.prepare("SELECT at, type, status, attempts, last_error FROM events ORDER BY at DESC LIMIT 20").all() as unknown as Record<string, string>[];
      for (const r of rows) console.log(`${r.at}  ${r.type.padEnd(18)} ${r.status}${r.last_error ? " (" + r.last_error + ")" : ""}`);
      if (!rows.length) console.log("no events yet");
      break;
    }
    case "resume":
      resume(db);
      console.log("sending resumed");
      break;
    case "dashboard": {
      const token = process.env.DASHBOARD_TOKEN || randomBytes(9).toString("base64url");
      const port = Number(values.port);
      let mailer: SmtpImapMailer | null = null;
      const server = createDashboard(db, cfg, () => (mailer ??= new SmtpImapMailer(process.env)), token, { profile: values.profile!, env: process.env });
      server.listen(port, "127.0.0.1", () => console.log(`Dashboard (click to sign in): http://localhost:${port}/#token=${token}`));
      await new Promise(() => {});
      break;
    }
    case "replies": {
      const rows = db
        .prepare("SELECT m.id, l.company, m.body FROM messages m JOIN leads l ON l.id = m.lead_id WHERE m.status = 'pending_approval'")
        .all() as unknown as { id: number; company: string; body: string }[];
      for (const r of rows) console.log(`#${r.id} ${r.company}\n${r.body}\n`);
      if (!rows.length) console.log("no replies waiting for approval");
      break;
    }
    case "approve-reply":
      await approveReply(db, cfg, new SmtpImapMailer(process.env), Number(arg));
      console.log("sent");
      break;
    case "reject-reply":
      rejectReply(db, Number(arg));
      console.log("rejected");
      break;
    case "handoffs":
      console.log(exportHandoffs(db, values.profile!));
      break;
    case "loop": {
      const every = Number(values.every) * 60_000;
      console.log(`mode: ${cfg.outreach.mode}. Running every ${values.every} minutes. Ctrl+C to stop.`);
      for (;;) {
        try {
          await cycle(db, cfg, values.profile!);
        } catch (e) {
          console.error("cycle failed:", e instanceof Error ? e.message : e);
        }
        await new Promise((r) => setTimeout(r, every));
      }
    }
    case "import": {
      if (!arg) throw new Error("usage: import <file.csv>");
      console.log(importCsv(db, readFileSync(arg, "utf8"), cfg));
      break;
    }
    default:
      console.log(HELP);
  }
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
