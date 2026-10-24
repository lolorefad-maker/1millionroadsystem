import type { DatabaseSync } from "node:sqlite";
import { parseCsv } from "./csv.ts";
import type { Config } from "./config.ts";

export interface ImportResult {
  added: number;
  duplicates: number;
  rejected: { row: number; why: string }[];
}

const REQUIRED = ["company", "domain", "country", "industry", "person", "title", "email", "source_url", "source_date", "reason"];
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const EMAIL_STATUSES = new Set(["valid", "catch-all", "unknown", "invalid"]);

export function normalizeDomain(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/[/?#].*$/, "");
}

export function importCsv(db: DatabaseSync, text: string, cfg: Config): ImportResult {
  const result: ImportResult = { added: 0, duplicates: 0, rejected: [] };
  const insert = db.prepare(
    `INSERT OR IGNORE INTO leads
     (company, domain, country, industry, size, person, title, email, email_status, source_url, source_date, reason)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  parseCsv(text).forEach((r, idx) => {
    const line = idx + 2;
    const missing = REQUIRED.filter((k) => !r[k]);
    if (missing.length) return void result.rejected.push({ row: line, why: `missing: ${missing.join(", ")}` });
    const email = r.email!.toLowerCase();
    if (!EMAIL.test(email)) return void result.rejected.push({ row: line, why: "bad email format" });
    const domain = normalizeDomain(r.domain!);
    const industry = r.industry!.toLowerCase();
    if (cfg.exclude.industries.includes(industry) || cfg.exclude.domains.includes(domain))
      return void result.rejected.push({ row: line, why: "excluded by ICP rules" });
    const status = (r.email_status ?? "unknown").toLowerCase();
    if (!EMAIL_STATUSES.has(status)) return void result.rejected.push({ row: line, why: `bad email_status "${status}"` });
    const info = insert.run(
      r.company!, domain, r.country!.toUpperCase(), industry, r.size ? Number(r.size) : null,
      r.person!, r.title!, email, status, r.source_url!, r.source_date!, r.reason!,
    );
    if (info.changes === 0) result.duplicates++;
    else result.added++;
  });
  return result;
}
