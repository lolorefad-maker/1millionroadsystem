import { readFileSync } from "node:fs";

/**
 * One profile per client of the system: what the client sells, who they want to reach,
 * and where to look. Each profile has its own database (data/<profile>.db).
 */
export interface Config {
  sender: { name: string; company: string };
  offer: string;
  icp: {
    countries: string[];
    industries: string[];
    minSize: number;
    maxSize: number;
    decisionTitles: string[];
  };
  exclude: { industries: string[]; domains: string[] };
  tiers: { A: number; B: number };
  slowMs: number;
  outreach: Outreach;
  qualification: Qualification;
  integrations?: Integrations;
  schedule?: Schedule;
}

/** Where important events are pushed (n8n, Make, Zapier or your own endpoint). The URL and secret live in .env. */
export interface Integrations {
  /** Fallback for WEBHOOK_URL in .env. */
  webhookUrl?: string;
  /** Only these event types are delivered. Omit for all. */
  events?: string[];
  /** Link placed inside events so alerts can open the dashboard. */
  dashboardUrl?: string;
}

export interface ScheduleTarget {
  country: string;
  industry: string;
  city?: string;
  limit?: number;
  provider?: "osm" | "google";
}

/** Runs the whole search pipeline by itself once a day. */
export interface Schedule {
  discover?: {
    /** Local hour (0-23, sender timezone) after which the daily run may start. */
    hour: number;
    /** Weekdays, 0 = Sunday. Defaults to the sending days. */
    days?: number[];
    targets: ScheduleTarget[];
    /** Hard cap on companies added per day across all targets. Default 100. */
    maxPerDay?: number;
  };
  /** Local hour after which a daily summary event is sent. Default 18. */
  summaryHour?: number;
}

export interface Outreach {
  /** review: a person approves each first message and each AI reply. auto: the system sends by itself. */
  mode: "review" | "auto";
  from: { name: string; email: string };
  /** Address that receives the "new qualified lead" alert. */
  notifyEmail: string;
  /** Days after the previous touch for touches 2.. (touch 1 is sent as soon as it is due). */
  touchGapDays: number[];
  dailyCap: number;
  /** Local sending window, hours 0-23 in the sender's timezone, and allowed weekdays (0 = Sunday). */
  sendHours: { start: number; end: number };
  sendDays: number[];
  utcOffsetHours: number;
  /** Spoken in AI replies so nobody thinks they are writing to a person. */
  assistantName: string;
  senderAddressLine: string;
  /** After this many AI replies without a decision the conversation goes to a person. */
  maxAiReplies: number;
  /** Sending stops by itself when these are exceeded (defaults: 2% bounces, 1% opt-outs, judged after 20 sends). */
  limits?: { maxBounceRate?: number; maxUnsubscribeRate?: number; minSample?: number };
  /**
   * First messages go only to addresses confirmed valid. Catch-all and unconfirmed ones are a small daily test
   * (riskyDailyCap, default 3). Set require to false to send to unconfirmed addresses without limit.
   */
  verification?: { require?: boolean; riskyDailyCap?: number };
}

export interface Qualification {
  /** What a good lead looks like, in plain words, for the AI to judge against. */
  goodLead: string;
  /** The only facts the AI may state about the offer. Anything else must go to a person. */
  facts: string[];
  /** Topics the AI must hand to a person instead of answering. */
  humanOnly: string[];
}

export function profilePath(profile: string): string {
  if (!/^[a-z0-9-]+$/.test(profile)) throw new Error(`Bad profile name "${profile}"`);
  return `profiles/${profile}.json`;
}

export function dbPathFor(profile: string): string {
  return `data/${profile}.db`;
}

export function loadConfig(profile: string): Config {
  return JSON.parse(readFileSync(profilePath(profile), "utf8")) as Config;
}
