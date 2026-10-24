import type { DatabaseSync } from "node:sqlite";
import { mkdirSync, writeFileSync } from "node:fs";
import type { Config } from "./config.ts";
import type { ProposalDraft, Proposer } from "./agent.ts";
import { gatherForLead, type ResearchItem } from "./research.ts";
import type { Mailer } from "./mail.ts";

const MONEY = /\b(aed|usd|sar|qar|kwd|dirhams?|riyals?|dollars?)\b|[$€£]\s?\d|\d\s?(aed|usd|sar)\b|درهم|ريال|دولار/i;

export interface ValidatedProposal extends ProposalDraft {
  /** Observations kept after checking each one points at real research. */
  citations: { text: string; source: string; url: string }[];
}

export type ProposalResult =
  | { ok: true; id: number; proposal: ValidatedProposal }
  | { ok: false; id: number; reason: string };

function allText(p: ProposalDraft): string {
  return [
    p.business_summary, p.email_subject, p.email_intro, p.question, ...p.mockup_outline, ...p.content_ideas,
    ...p.observations.map((o) => o.text),
    ...p.recommendations.flatMap((r) => [r.title, r.why, r.what_we_build]),
  ].join("\n");
}

/** Code, not the model, decides whether a proposal may go to a person. */
export function validateProposal(p: ProposalDraft, research: ResearchItem[]): { ok: true; proposal: ValidatedProposal } | { ok: false; reason: string } {
  const byId = new Map(research.map((r) => [r.id, r]));
  const citations = p.observations.filter((o) => byId.has(o.source)).map((o) => ({ text: o.text, source: o.source, url: byId.get(o.source)!.url }));
  if (citations.length === 0) return { ok: false, reason: "no observation points at real research, so nothing in it can be trusted" };
  if (MONEY.test(allText(p))) return { ok: false, reason: "the proposal mentions a price; prices are for you to set" };
  return { ok: true, proposal: { ...p, observations: citations.map(({ text, source }) => ({ text, source })), citations } };
}

export function composeEmail(p: ValidatedProposal, lead: { company: string; person: string }, cfg: Config): { subject: string; body: string } {
  const first = lead.person.split(/\s+/)[0];
  const recs = p.recommendations
    .map((r, i) => `${i + 1}. ${r.title}: ${r.what_we_build} (about ${r.effort_days} working days)`)
    .join("\n");
  const content = p.content_ideas.length ? `\n\nOn your content: ${p.content_ideas[0]}` : "";
  const body = `${first ? `Hi ${first},` : `Hi ${lead.company} team,`}

${p.email_intro}

Here is what I would do for ${lead.company}:
${recs}${content}

${p.question}

${cfg.sender.name}, ${cfg.sender.company}`;
  return { subject: p.email_subject, body };
}

/** Research the company, let the model draft a proposal, validate it, and store it for approval. */
export async function prepareProposal(
  db: DatabaseSync, cfg: Config, proposer: Proposer, leadId: number,
  env: Record<string, string | undefined> = process.env, doFetch: typeof fetch = fetch, now = new Date(),
): Promise<ProposalResult> {
  const lead = db.prepare("SELECT * FROM leads WHERE id = ?").get(leadId) as unknown as
    | { company: string; domain: string; industry: string; country: string; person: string }
    | undefined;
  if (!lead) throw new Error(`No lead ${leadId}`);

  const g = await gatherForLead(db, leadId, env, doFetch, now);
  const h = db.prepare("SELECT need, timeline FROM handoffs WHERE lead_id = ?").get(leadId) as { need: string; timeline: string } | undefined;
  const conversation = (
    db.prepare("SELECT direction, body FROM messages WHERE lead_id = ? AND status IN ('sent','received') ORDER BY id DESC LIMIT 6").all(leadId) as unknown as { direction: string; body: string }[]
  )
    .reverse()
    .map((m) => `${m.direction === "out" ? "US" : "THEM"}: ${m.body.slice(0, 1200)}`)
    .join("\n\n");

  const save = (status: string, subject: string, body: string, content: string, reason: string | null): number =>
    Number(
      db
        .prepare("INSERT INTO proposals (lead_id, content, subject, body, status, block_reason, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(leadId, content, subject, body, status, reason, now.toISOString()).lastInsertRowid,
    );

  if (g.items.length === 0) return { ok: false, id: save("blocked", "", "", "{}", `nothing could be read: ${g.notes.join("; ")}`), reason: "no research" };

  const draft = await proposer.propose({
    company: lead.company, industry: lead.industry, country: lead.country, conversation,
    need: h?.need ?? "", timeline: h?.timeline ?? "",
    research: g.items.map(({ id, title, text, url, date }) => ({ id, title, text, url, date })),
  });
  const v = validateProposal(draft, g.items);
  if (!v.ok) return { ok: false, id: save("blocked", "", "", JSON.stringify(draft), v.reason), reason: v.reason };

  const email = composeEmail(v.proposal, lead, cfg);
  const id = save("pending_approval", email.subject, email.body, JSON.stringify(v.proposal), null);
  writeProposalFile(lead.domain, lead.company, v.proposal, email.body);
  return { ok: true, id, proposal: v.proposal };
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

/** A readable one-page version for the owner to review. */
export function writeProposalFile(domain: string, company: string, p: ValidatedProposal, emailBody: string): string {
  mkdirSync("out/proposals", { recursive: true });
  const path = `out/proposals/${domain}.html`;
  const list = (xs: string[]) => (xs.length ? `<ul>${xs.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>` : "<p>None</p>");
  writeFileSync(
    path,
    `<!doctype html><meta charset="utf-8"><title>Proposal for ${esc(company)}</title>
<style>body{font:16px/1.6 system-ui;max-width:760px;margin:2rem auto;padding:0 1rem;color:#1a1a1a}h2{margin-top:2rem}small{color:#666}pre{white-space:pre-wrap;background:#f6f6f6;padding:1rem;border-radius:8px}</style>
<h1>${esc(company)}</h1><p>${esc(p.business_summary)}</p>
<h2>What I saw (with sources)</h2><ul>${p.citations.map((c) => `<li>${esc(c.text)} <small>[${esc(c.source)}] <a href="${esc(c.url)}">${esc(c.url)}</a></small></li>`).join("")}</ul>
<h2>What we would build</h2>${p.recommendations.map((r) => `<h3>${esc(r.title)} <small>about ${r.effort_days} days</small></h3><p>${esc(r.why)}</p><p><b>${esc(r.what_we_build)}</b></p>`).join("")}
<h2>First screens to show them</h2>${list(p.mockup_outline)}
<h2>Content ideas</h2>${list(p.content_ideas)}
<h2>Email that will be sent (after your approval)</h2><pre>${esc(emailBody)}</pre>`,
    "utf8",
  );
  return path;
}

/** Proposals always need a person's approval, in both modes: they commit you to a plan. */
export async function sendProposal(db: DatabaseSync, cfg: Config, mailer: Mailer, proposalId: number, now = new Date()): Promise<void> {
  const row = db
    .prepare("SELECT p.*, l.email, l.stage FROM proposals p JOIN leads l ON l.id = p.lead_id WHERE p.id = ? AND p.status = 'pending_approval'")
    .get(proposalId) as unknown as { id: number; lead_id: number; subject: string; body: string; email: string; stage: string } | undefined;
  if (!row) throw new Error(`No proposal waiting for approval with id ${proposalId}`);
  if (row.stage === "unsubscribed" || row.stage === "closed_lost") throw new Error("This person opted out or declined; nothing was sent");
  const last = db.prepare("SELECT message_id FROM messages WHERE lead_id = ? AND direction = 'in' ORDER BY id DESC LIMIT 1").get(row.lead_id) as { message_id: string } | undefined;
  const { messageId } = await mailer.send({
    to: row.email, fromName: cfg.outreach.from.name, fromEmail: cfg.outreach.from.email, subject: row.subject, text: row.body,
    inReplyTo: last?.message_id, references: last ? [last.message_id] : undefined, unsubscribeMailto: cfg.outreach.from.email,
  });
  const at = now.toISOString();
  db.prepare("INSERT INTO messages (lead_id, direction, kind, subject, body, message_id, in_reply_to, status, at) VALUES (?, 'out', 'proposal', ?, ?, ?, ?, 'sent', ?)").run(
    row.lead_id, row.subject, row.body, messageId, last?.message_id ?? null, at,
  );
  db.prepare("UPDATE proposals SET status = 'sent', sent_at = ? WHERE id = ?").run(at, row.id);
}
