import type { DatabaseSync } from "node:sqlite";
import { resolveMx } from "node:dns/promises";
import type { Config } from "./config.ts";

export interface Fact {
  kind: string;
  text: string;
}

export interface Analysis {
  facts: Fact[];
  emails: string[];
}

const BOOKING = /\b(book(ing)?|reserve|reservation|order online|order now|appointment|schedule)\b|احجز|حجز|اطلب|موعد/i;
const CHAT = /wa\.me|api\.whatsapp|whatsapp|tawk\.to|intercom|livechat|crisp\.chat|tidio|zendesk/i;
const EMAIL = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;
const JUNK_EMAIL = /\.(png|jpe?g|gif|svg|webp|css|js)$|sentry|wixpress|example\.|noreply|no-reply|your-?email|domain\.com/i;
const PREFERRED = /^(info|contact|hello|sales|office|admin|enquir|inquir|reception|marketing)/i;

/** Pure analysis of a fetched homepage; no network. */
export function analyzeHtml(html: string, finalUrl: string, ms: number, cfg: Config, now = new Date()): Analysis {
  const facts: Fact[] = [];
  if (!finalUrl.startsWith("https://")) facts.push({ kind: "no_https", text: "the site is served without HTTPS" });
  if (!/<meta[^>]+name=["']viewport["']/i.test(html))
    facts.push({ kind: "no_viewport", text: "the homepage has no mobile viewport setting, so it is not built for phones" });
  if (ms > cfg.slowMs)
    facts.push({ kind: "slow", text: `the homepage took ${(ms / 1000).toFixed(1)} seconds to respond` });
  if (!BOOKING.test(html))
    facts.push({ kind: "no_booking", text: "I could not find online booking or ordering on the homepage" });
  if (!CHAT.test(html))
    facts.push({ kind: "no_chat", text: "there is no WhatsApp or live chat button on the homepage" });
  const years = [...html.matchAll(/(?:©|&copy;|copyright)[^0-9]{0,40}(20\d\d)/gi)].map((m) => Number(m[1]));
  const latest = years.length ? Math.max(...years) : null;
  if (latest !== null && latest <= now.getFullYear() - 3)
    facts.push({ kind: "old_footer", text: `the footer still says © ${latest}` });
  return { facts, emails: extractEmails(html) };
}

export function extractEmails(html: string): string[] {
  const decoded = html.replace(/&#64;|&commat;|\[at\]|\(at\)/gi, "@");
  const found = new Set<string>();
  for (const m of decoded.match(EMAIL) ?? []) {
    const e = m.toLowerCase().replace(/^[.%+-]+/, "");
    if (!JUNK_EMAIL.test(e)) found.add(e);
  }
  return [...found];
}

/** Prefer an address on the company's own domain, then role mailboxes like info@. */
export function pickEmail(emails: string[], domain: string): string | null {
  const own = emails.filter((e) => e.endsWith("@" + domain) || e.endsWith("." + domain));
  const pool = own.length ? own : [];
  return pool.find((e) => PREFERRED.test(e)) ?? pool[0] ?? null;
}

export async function hasMx(domain: string): Promise<boolean> {
  try {
    return (await resolveMx(domain)).length > 0;
  } catch {
    return false;
  }
}

type Page = { html: string; finalUrl: string; ms: number };
/** `blocked` = the server answered with an HTTP error (bot protection), so the site exists. */
type Got = { page: Page } | { blocked: number } | { dead: string };

async function fetchPage(url: string): Promise<Got> {
  const t0 = Date.now();
  try {
    const res = await fetch(url, {
      redirect: "follow",
      signal: AbortSignal.timeout(20_000),
      headers: {
        "user-agent": "Mozilla/5.0 (compatible; gulf-leads/0.1; website review)",
        accept: "text/html,*/*;q=0.8",
        "accept-language": "en,ar",
      },
    });
    if (!res.ok) return { blocked: res.status };
    const html = (await res.text()).slice(0, 600_000);
    return { page: { html, finalUrl: res.url || url, ms: Date.now() - t0 } };
  } catch (e) {
    const code = (e as { cause?: { code?: string } }).cause?.code ?? (e as Error).name;
    return { dead: String(code) };
  }
}

async function get(url: string): Promise<Page | null> {
  const got = await fetchPage(url);
  return "page" in got ? got.page : null;
}

/** Try the bare domain, then www, then plain http; retry timeouts once. */
async function getHome(domain: string): Promise<{ page: Page } | { blocked: number } | { dead: string }> {
  let last: Got = { dead: "none" };
  for (const url of [`https://${domain}/`, `https://www.${domain}/`, `http://${domain}/`]) {
    for (let attempt = 0; attempt < 2; attempt++) {
      last = await fetchPage(url);
      if ("page" in last) return last;
      if (!("dead" in last) || !/TIMEOUT|AbortError|TimeoutError/.test(last.dead)) break;
    }
    if ("blocked" in last) return last;
  }
  return last;
}

interface Row {
  id: number;
  domain: string;
  email: string;
}

/** Fetch homepage (+ up to two contact pages), store facts, find and MX-check an email. */
export async function checkLead(db: DatabaseSync, row: Row, cfg: Config): Promise<"ok" | "unreachable"> {
  const now = new Date().toISOString();
  const got = await getHome(row.domain);
  if (!("page" in got)) {
    const status = "blocked" in got ? "blocked" : "unreachable";
    db.prepare("DELETE FROM site_facts WHERE domain = ?").run(row.domain);
    db.prepare("UPDATE leads SET status = ?, checked_at = ? WHERE id = ?").run(status, now, row.id);
    return "unreachable";
  }
  const home = got.page;
  const a = analyzeHtml(home.html, home.finalUrl, home.ms, cfg);
  const emails = [...a.emails];
  if (!pickEmail(emails, row.domain)) {
    for (const path of ["contact", "contact-us", "about"]) {
      const page = await get(new URL(`/${path}`, home.finalUrl).toString());
      if (page) emails.push(...extractEmails(page.html));
      if (pickEmail(emails, row.domain)) break;
    }
  }

  db.prepare("DELETE FROM site_facts WHERE domain = ?").run(row.domain);
  const ins = db.prepare("INSERT INTO site_facts (domain, kind, text, url, checked_at) VALUES (?, ?, ?, ?, ?)");
  for (const f of a.facts) ins.run(row.domain, f.kind, f.text, home.finalUrl, now);

  const email = row.email || pickEmail(emails, row.domain);
  if (email) {
    const mx = await hasMx(email.split("@")[1]!);
    try {
      db.prepare("UPDATE leads SET email = ?, email_status = ? WHERE id = ?").run(email, mx ? "unknown" : "invalid", row.id);
    } catch {
      /* same (domain, email) already stored on another row */
    }
  }
  db.prepare("UPDATE leads SET status = 'checked', checked_at = ? WHERE id = ?").run(now, row.id);
  return "ok";
}
