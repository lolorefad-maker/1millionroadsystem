import type { DatabaseSync } from "node:sqlite";
import type { Config } from "./config.ts";
import { isSuppressed } from "./db.ts";
import { FACT_WEIGHT } from "./score.ts";

const QUESTION: Record<string, string> = {
  no_booking: "Are bookings and orders still handled by phone or WhatsApp?",
  no_viewport: "Are most of your customers finding you from their phones?",
  slow: "Do visitors leave before the page finishes loading?",
  no_https: "Have customers ever been warned that your site is not secure?",
  old_footer: "Is the site due for a refresh?",
  no_chat: "How do new customers usually reach you outside working hours?",
};

const VALUE: Record<string, string> = {
  no_booking: "A simple online booking flow usually takes that work off the team.",
  no_viewport: "A mobile-first layout is usually a small change with a clear effect.",
  slow: "Most slow pages come down to a few fixable things.",
  no_https: "It is a quick fix and removes the browser warning.",
  old_footer: "Even a light refresh makes the business look current.",
  no_chat: "A WhatsApp button lets customers reach you in one tap.",
};

const PLURAL: Record<string, string> = {
  restaurant: "restaurants", clinic: "clinics", "real estate": "real estate agencies",
  logistics: "logistics companies", retail: "retail stores", gym: "gyms", hotel: "hotels", education: "schools",
};

export interface DraftLead {
  company: string;
  domain: string;
  person: string;
  industry: string;
  city: string;
  country: string;
}

export interface Draft {
  subject: string;
  body: string;
  fact: { kind: string; text: string; url: string } | null;
  confidence: "high" | "low";
  words: number;
}

export function countWords(s: string): number {
  return s.split(/\s+/).filter(Boolean).length;
}

export function composeDraft(
  l: DraftLead,
  facts: { kind: string; text: string; url: string }[],
  cfg: Config,
): Draft {
  const fact = [...facts].sort((a, b) => (FACT_WEIGHT[b.kind] ?? 0) - (FACT_WEIGHT[a.kind] ?? 0))[0] ?? null;
  const first = l.person.split(/\s+/)[0] ?? "";
  const greet = first ? `Hi ${first},` : `Hi ${l.company} team,`;
  const who = PLURAL[l.industry] ?? "businesses";
  const place = l.city || l.country;
  const opening = fact
    ? `While looking at ${l.domain} I noticed ${fact.text}. ${QUESTION[fact.kind] ?? ""} ${VALUE[fact.kind] ?? ""}`
    : `I work with ${who} in ${place} and wanted to ask how you handle online bookings today.`;
  const body = [
    greet,
    opening.replace(/\s+/g, " ").trim(),
    `I build ${cfg.offer} for ${who} in ${place}.`,
    `Would a short example for ${l.company} be useful? If this is not relevant, reply "no" and I will not write again.`,
    `${cfg.sender.name}, ${cfg.sender.company}`,
  ].join("\n\n");
  return {
    subject: `${l.company}: a quick note about your website`,
    body,
    fact,
    confidence: fact ? "high" : "low",
    words: countWords(body),
  };
}

export function draftAll(db: DatabaseSync, cfg: Config): { drafted: number; skipped: number } {
  const leads = db
    .prepare(
      `SELECT l.* FROM leads l LEFT JOIN drafts d ON d.lead_id = l.id
       WHERE l.tier IN ('A','B') AND l.email != '' AND l.email_status != 'invalid' AND d.lead_id IS NULL`,
    )
    .all() as unknown as (DraftLead & { id: number; email: string })[];
  const factsStmt = db.prepare("SELECT kind, text, url FROM site_facts WHERE domain = ?");
  const insert = db.prepare(
    `INSERT INTO drafts (lead_id, subject, body, fact_text, fact_url, confidence, words, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  let drafted = 0;
  let skipped = 0;
  for (const l of leads) {
    if (isSuppressed(db, l.email, l.domain)) {
      skipped++;
      continue;
    }
    const facts = factsStmt.all(l.domain) as unknown as { kind: string; text: string; url: string }[];
    const d = composeDraft(l, facts, cfg);
    insert.run(l.id, d.subject, d.body, d.fact?.text ?? null, d.fact?.url ?? null, d.confidence, d.words, new Date().toISOString());
    drafted++;
  }
  return { drafted, skipped };
}
