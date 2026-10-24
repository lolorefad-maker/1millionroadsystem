import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export const DB_PATH = process.env.LEADS_DB ?? "data/leads.db";

export function openDb(path: string = DB_PATH): DatabaseSync {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS leads (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      company TEXT NOT NULL,
      domain TEXT NOT NULL,
      country TEXT NOT NULL,
      industry TEXT NOT NULL,
      size INTEGER,
      city TEXT NOT NULL DEFAULT '',
      phone TEXT NOT NULL DEFAULT '',
      person TEXT NOT NULL DEFAULT '',
      title TEXT NOT NULL DEFAULT '',
      email TEXT NOT NULL DEFAULT '',
      email_status TEXT NOT NULL DEFAULT 'unknown',
      source TEXT NOT NULL DEFAULT 'import',
      source_url TEXT NOT NULL,
      source_date TEXT NOT NULL,
      reason TEXT NOT NULL,
      checked_at TEXT,
      score INTEGER,
      tier TEXT,
      score_detail TEXT,
      status TEXT NOT NULL DEFAULT 'new',
      UNIQUE (domain, email)
    );
    CREATE TABLE IF NOT EXISTS site_facts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      domain TEXT NOT NULL,
      kind TEXT NOT NULL,
      text TEXT NOT NULL,
      url TEXT NOT NULL,
      checked_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS site_facts_domain ON site_facts (domain);
    CREATE TABLE IF NOT EXISTS suppression (
      value TEXT PRIMARY KEY,
      reason TEXT NOT NULL,
      added_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS drafts (
      lead_id INTEGER PRIMARY KEY REFERENCES leads(id),
      subject TEXT NOT NULL,
      body TEXT NOT NULL,
      fact_text TEXT,
      fact_url TEXT,
      confidence TEXT NOT NULL,
      words INTEGER NOT NULL,
      review TEXT NOT NULL DEFAULT 'needs_review',
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      lead_id INTEGER NOT NULL REFERENCES leads(id),
      direction TEXT NOT NULL,            -- out | in
      kind TEXT NOT NULL,                 -- touch1 | touch2 | touch3 | reply | inbound
      subject TEXT NOT NULL,
      body TEXT NOT NULL,
      message_id TEXT,
      in_reply_to TEXT,
      status TEXT NOT NULL,               -- sent | pending_approval | rejected | received
      analysis TEXT,
      at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS messages_mid ON messages (message_id) WHERE message_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS messages_lead ON messages (lead_id);
    CREATE TABLE IF NOT EXISTS handoffs (
      lead_id INTEGER PRIMARY KEY REFERENCES leads(id),
      reason TEXT NOT NULL,
      summary TEXT NOT NULL,
      need TEXT NOT NULL DEFAULT '',
      timeline TEXT NOT NULL DEFAULT '',
      budget_signal TEXT NOT NULL DEFAULT '',
      next_step TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      notified_at TEXT
    );
    CREATE TABLE IF NOT EXISTS research (
      lead_id INTEGER PRIMARY KEY REFERENCES leads(id),
      items TEXT NOT NULL,                -- JSON: [{id, source, title, text}]
      notes TEXT NOT NULL DEFAULT '',     -- what could not be read, and why
      gathered_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS research_links (
      lead_id INTEGER NOT NULL REFERENCES leads(id),
      url TEXT NOT NULL,
      PRIMARY KEY (lead_id, url)
    );
    CREATE TABLE IF NOT EXISTS proposals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      lead_id INTEGER NOT NULL REFERENCES leads(id),
      content TEXT NOT NULL,              -- JSON of the validated proposal
      subject TEXT NOT NULL,
      body TEXT NOT NULL,
      status TEXT NOT NULL,               -- pending_approval | sent | rejected | blocked
      block_reason TEXT,
      created_at TEXT NOT NULL,
      sent_at TEXT
    );
    CREATE TABLE IF NOT EXISTS email_checks (
      email TEXT PRIMARY KEY,
      status TEXT NOT NULL,               -- valid | invalid | catch-all | unknown
      provider TEXT NOT NULL,
      detail TEXT NOT NULL DEFAULT '',
      checked_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS events (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      payload TEXT NOT NULL,
      at TEXT NOT NULL,
      status TEXT NOT NULL,               -- skipped | delivered | failed
      attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      last_attempt_at TEXT,
      delivered_at TEXT
    );
    CREATE INDEX IF NOT EXISTS events_at ON events (at);
    CREATE TABLE IF NOT EXISTS mail_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `);
  addColumns(db, "leads", {
    stage: "TEXT NOT NULL DEFAULT 'prospect'", // prospect | contacted | conversing | handoff | closed_lost | unsubscribed
    touches: "INTEGER NOT NULL DEFAULT 0",
    next_touch_at: "TEXT",
    last_contact_at: "TEXT",
    ai_replies: "INTEGER NOT NULL DEFAULT 0",
    verified_at: "TEXT",
  });
  return db;
}

function addColumns(db: DatabaseSync, table: string, cols: Record<string, string>): void {
  const have = new Set((db.prepare(`PRAGMA table_info(${table})`).all() as unknown as { name: string }[]).map((c) => c.name));
  for (const [name, def] of Object.entries(cols)) if (!have.has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${def}`);
}

export function getState(db: DatabaseSync, key: string): string | null {
  const r = db.prepare("SELECT value FROM mail_state WHERE key = ?").get(key) as { value: string } | undefined;
  return r?.value ?? null;
}

export function setState(db: DatabaseSync, key: string, value: string): void {
  db.prepare("INSERT INTO mail_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
}

export function isSuppressed(db: DatabaseSync, email: string, domain: string): boolean {
  const row = db
    .prepare("SELECT 1 AS x FROM suppression WHERE value = ? OR value = ?")
    .get(email.toLowerCase(), domain.toLowerCase());
  return row !== undefined;
}

export function suppress(db: DatabaseSync, value: string, reason: string): void {
  db.prepare(
    "INSERT INTO suppression (value, reason, added_at) VALUES (?, ?, ?) ON CONFLICT(value) DO UPDATE SET reason = excluded.reason",
  ).run(value.toLowerCase(), reason, new Date().toISOString());
}
