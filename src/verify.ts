import type { DatabaseSync } from "node:sqlite";
import { resolveMx } from "node:dns/promises";
import { isSuppressed, suppress } from "./db.ts";

export type VerifyStatus = "valid" | "invalid" | "catch-all" | "unknown";

export interface VerifyResult {
  status: VerifyStatus;
  provider: string;
  detail: string;
}

/** Thrown when the whole batch must stop (bad key, no credits, rate limit) so nothing is wasted or blocked. */
export class VerifyStop extends Error {}

export interface Verifier {
  readonly name: string;
  /** Returns null when the provider could not decide yet; the lead is simply tried again later. */
  verify(email: string): Promise<VerifyResult | null>;
}

const SYNTAX = /^[a-z0-9._%+'-]+@[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$/i;
const DISPOSABLE = new Set([
  "mailinator.com", "guerrillamail.com", "10minutemail.com", "tempmail.com", "temp-mail.org", "yopmail.com",
  "trashmail.com", "sharklasers.com", "getnada.com", "throwawaymail.com", "dispostable.com", "maildrop.cc",
]);

/** Free checks that need no provider. A pass proves only that the domain can receive mail, never that the mailbox exists. */
export async function localCheck(email: string, mx: (d: string) => Promise<boolean> = hasMx): Promise<VerifyResult | null> {
  if (!SYNTAX.test(email)) return { status: "invalid", provider: "local", detail: "bad syntax" };
  const domain = email.split("@")[1]!.toLowerCase();
  if (DISPOSABLE.has(domain)) return { status: "invalid", provider: "local", detail: "disposable domain" };
  if (!(await mx(domain))) return { status: "invalid", provider: "local", detail: "domain cannot receive mail (no MX)" };
  return null;
}

async function hasMx(domain: string): Promise<boolean> {
  try {
    return (await resolveMx(domain)).length > 0;
  } catch {
    return false;
  }
}

export class LocalVerifier implements Verifier {
  readonly name = "local";
  async verify(): Promise<VerifyResult> {
    return { status: "unknown", provider: "local", detail: "syntax and mail server checked; mailbox not confirmed (no provider key)" };
  }
}

export class HunterVerifier implements Verifier {
  readonly name = "hunter";
  private key: string;
  private doFetch: typeof fetch;
  constructor(key: string, doFetch: typeof fetch = fetch) {
    this.key = key;
    this.doFetch = doFetch;
  }
  async verify(email: string): Promise<VerifyResult | null> {
    const res = await this.doFetch(`https://api.hunter.io/v2/email-verifier?${new URLSearchParams({ email })}`, {
      headers: { "X-API-KEY": this.key },
      signal: AbortSignal.timeout(30_000),
    });
    if (res.status === 401) throw new VerifyStop("Hunter rejected the API key");
    if (res.status === 429) throw new VerifyStop("Hunter credits are used up");
    if (res.status === 403) throw new VerifyStop("Hunter rate limit reached; run again in a minute");
    if (res.status === 202 || res.status === 222) return null; // still verifying, or the mail server answered oddly: try later
    if (res.status === 451) return { status: "invalid", provider: "hunter", detail: "person asked not to be processed" };
    if (res.status === 400) return { status: "invalid", provider: "hunter", detail: "not a valid address" };
    if (!res.ok) throw new VerifyStop(`Hunter returned ${res.status}`);
    const s = ((await res.json()) as { data?: { status?: string } }).data?.status;
    const map: Record<string, VerifyStatus> = { valid: "valid", invalid: "invalid", disposable: "invalid", accept_all: "catch-all", webmail: "unknown", unknown: "unknown" };
    return { status: map[s ?? ""] ?? "unknown", provider: "hunter", detail: s ?? "no status" };
  }
}

export class ZeroBounceVerifier implements Verifier {
  readonly name = "zerobounce";
  private key: string;
  private doFetch: typeof fetch;
  constructor(key: string, doFetch: typeof fetch = fetch) {
    this.key = key;
    this.doFetch = doFetch;
  }
  async verify(email: string): Promise<VerifyResult | null> {
    const res = await this.doFetch(`https://api.zerobounce.net/v2/validate?${new URLSearchParams({ api_key: this.key, email })}`, {
      signal: AbortSignal.timeout(65_000),
    });
    const body = (await res.json().catch(() => ({}))) as { status?: string; sub_status?: string; error?: string };
    // ZeroBounce blocks a key for an hour after 200 bad-key requests, so stop at the first error.
    if (body.error) throw new VerifyStop(`ZeroBounce: ${body.error}`);
    if (!res.ok) throw new VerifyStop(`ZeroBounce returned ${res.status}`);
    const map: Record<string, VerifyStatus> = {
      valid: "valid", invalid: "invalid", spamtrap: "invalid", abuse: "invalid", do_not_mail: "invalid", "catch-all": "catch-all", unknown: "unknown",
    };
    return { status: map[body.status ?? ""] ?? "unknown", provider: "zerobounce", detail: [body.status, body.sub_status].filter(Boolean).join("/") };
  }
}

export function pickVerifier(env: Record<string, string | undefined>, doFetch: typeof fetch = fetch): Verifier {
  const want = env.VERIFY_PROVIDER?.toLowerCase();
  if (want === "local") return new LocalVerifier();
  if ((want === "zerobounce" || !want) && env.ZEROBOUNCE_API_KEY) return new ZeroBounceVerifier(env.ZEROBOUNCE_API_KEY, doFetch);
  if ((want === "hunter" || !want) && env.HUNTER_API_KEY) return new HunterVerifier(env.HUNTER_API_KEY, doFetch);
  if (want) throw new Error(`VERIFY_PROVIDER=${want} but its API key is not set in .env`);
  return new LocalVerifier();
}

export interface VerifySummary {
  provider: string;
  checked: number;
  valid: number;
  invalid: number;
  catchAll: number;
  unknown: number;
  fromCache: number;
  retryLater: number;
  stoppedBecause?: string;
}

const CACHE_DAYS = 30;

export interface VerifyOptions {
  max?: number;
  /** Also verify leads that are not in tier A/B yet. Costs credits, so it is off by default. */
  all?: boolean;
  now?: Date;
  /** Pause between provider calls (Hunter allows 10 requests a second). */
  delayMs?: number;
  mx?: (domain: string) => Promise<boolean>;
}

/** Check addresses before anything is sent, cheapest test first, and remember every answer for 30 days. */
export async function verifyLeads(db: DatabaseSync, verifier: Verifier, o: VerifyOptions = {}): Promise<VerifySummary> {
  const now = o.now ?? new Date();
  const sum: VerifySummary = { provider: verifier.name, checked: 0, valid: 0, invalid: 0, catchAll: 0, unknown: 0, fromCache: 0, retryLater: 0 };
  const fresh = new Date(now.getTime() - CACHE_DAYS * 86_400_000).toISOString();
  const rows = db
    .prepare(
      `SELECT id, email, domain FROM leads
       WHERE email != '' AND stage = 'prospect' AND (? = 1 OR tier IN ('A','B'))
         AND ((verified_at IS NULL AND email_status != 'valid') OR verified_at < ?)
       ORDER BY COALESCE(score, 0) DESC LIMIT ?`,
    )
    .all(o.all ? 1 : 0, fresh, o.max ?? 50) as unknown as { id: number; email: string; domain: string }[];

  const cached = db.prepare("SELECT status, provider, detail FROM email_checks WHERE email = ? AND checked_at >= ?");
  const saveCheck = db.prepare(
    "INSERT INTO email_checks (email, status, provider, detail, checked_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(email) DO UPDATE SET status = excluded.status, provider = excluded.provider, detail = excluded.detail, checked_at = excluded.checked_at",
  );
  const apply = db.prepare("UPDATE leads SET email_status = ?, verified_at = ? WHERE id = ?");

  for (const lead of rows) {
    if (isSuppressed(db, lead.email, lead.domain)) continue;
    let result: VerifyResult | null;
    const hit = cached.get(lead.email, fresh) as { status: VerifyStatus; provider: string; detail: string } | undefined;
    if (hit) {
      result = hit;
      sum.fromCache++;
    } else {
      result = await localCheck(lead.email, o.mx);
      if (!result) {
        try {
          result = await verifier.verify(lead.email);
        } catch (e) {
          if (e instanceof VerifyStop) {
            sum.stoppedBecause = e.message;
            break;
          }
          throw e;
        }
        if (o.delayMs) await new Promise((r) => setTimeout(r, o.delayMs));
      }
      if (!result) {
        sum.retryLater++;
        continue;
      }
      saveCheck.run(lead.email, result.status, result.provider, result.detail, now.toISOString());
    }
    apply.run(result.status, now.toISOString(), lead.id);
    if (result.detail === "person asked not to be processed") suppress(db, lead.email, "claimed");
    sum.checked++;
    if (result.status === "valid") sum.valid++;
    else if (result.status === "invalid") sum.invalid++;
    else if (result.status === "catch-all") sum.catchAll++;
    else sum.unknown++;
  }
  return sum;
}
