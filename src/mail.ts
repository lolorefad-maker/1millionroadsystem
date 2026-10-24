import nodemailer from "nodemailer";
import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";

export interface OutMail {
  to: string;
  fromName: string;
  fromEmail: string;
  subject: string;
  text: string;
  inReplyTo?: string;
  references?: string[];
  /** mailto: target for the List-Unsubscribe header. */
  unsubscribeMailto: string;
}

export interface InMail {
  uid: number;
  messageId: string;
  inReplyTo: string | null;
  references: string[];
  fromEmail: string;
  subject: string;
  text: string;
  /** True for out-of-office and other machine-generated mail. */
  automatic: boolean;
}

/** Everything the pipeline needs from a mailbox, so tests can run without a real one. */
export interface Mailer {
  send(m: OutMail): Promise<{ messageId: string }>;
  /** Messages in the inbox with uid greater than `afterUid`, oldest first. */
  fetchInbound(afterUid: number): Promise<InMail[]>;
}

export class SmtpImapMailer implements Mailer {
  private smtp;
  private env: Record<string, string | undefined>;
  constructor(env: Record<string, string | undefined>) {
    this.env = env;
    const need = ["SMTP_HOST", "SMTP_USER", "SMTP_PASS", "IMAP_HOST"];
    const missing = need.filter((k) => !env[k]);
    if (missing.length) throw new Error(`Set ${missing.join(", ")} in .env (see .env.example)`);
    const port = Number(env.SMTP_PORT ?? 465);
    this.smtp = nodemailer.createTransport({
      host: env.SMTP_HOST,
      port,
      secure: port === 465,
      auth: { user: env.SMTP_USER, pass: env.SMTP_PASS },
    });
  }

  async send(m: OutMail): Promise<{ messageId: string }> {
    const info = await this.smtp.sendMail({
      from: { name: m.fromName, address: m.fromEmail },
      to: m.to,
      subject: m.subject,
      text: m.text,
      inReplyTo: m.inReplyTo,
      references: m.references,
      headers: { "List-Unsubscribe": `<mailto:${m.unsubscribeMailto}?subject=unsubscribe>` },
    });
    return { messageId: info.messageId };
  }

  async fetchInbound(afterUid: number): Promise<InMail[]> {
    const client = new ImapFlow({
      host: this.env.IMAP_HOST!,
      port: Number(this.env.IMAP_PORT ?? 993),
      secure: true,
      auth: { user: this.env.IMAP_USER ?? this.env.SMTP_USER!, pass: this.env.IMAP_PASS ?? this.env.SMTP_PASS! },
      logger: false,
    });
    const out: InMail[] = [];
    await client.connect();
    try {
      const lock = await client.getMailboxLock("INBOX");
      try {
        for await (const msg of client.fetch(`${afterUid + 1}:*`, { uid: true, source: true }, { uid: true })) {
          if (msg.uid <= afterUid || !msg.source) continue;
          const p = await simpleParser(msg.source);
          const from = p.from?.value[0]?.address?.toLowerCase();
          if (!from || !p.messageId) continue;
          const auto = String(p.headers.get("auto-submitted") ?? "").toLowerCase();
          const precedence = String(p.headers.get("precedence") ?? "").toLowerCase();
          out.push({
            uid: msg.uid,
            messageId: p.messageId,
            inReplyTo: p.inReplyTo ?? null,
            references: Array.isArray(p.references) ? p.references : p.references ? [p.references] : [],
            fromEmail: from,
            subject: p.subject ?? "",
            text: stripQuoted(p.text ?? ""),
            automatic:
              (auto !== "" && auto !== "no") || /bulk|auto_reply|junk/.test(precedence) || /^(auto(matic)? reply|out of office)/i.test(p.subject ?? ""),
          });
        }
      } finally {
        lock.release();
      }
    } finally {
      await client.logout();
    }
    return out.sort((a, b) => a.uid - b.uid);
  }
}

/** Keep only what the person wrote: drop the quoted earlier thread. */
export function stripQuoted(text: string): string {
  const lines = text.replace(/\r/g, "").split("\n");
  const cut = lines.findIndex((l) => /^(on .+ wrote:|-{2,} ?original message|from: .+@|>)/i.test(l.trim()));
  return (cut === -1 ? lines : lines.slice(0, cut)).join("\n").trim().slice(0, 4000);
}

/** In-memory mailbox for tests: records what was sent and serves queued inbound mail. */
export class MemoryMailer implements Mailer {
  sent: OutMail[] = [];
  inbox: InMail[] = [];
  private n = 0;
  async send(m: OutMail): Promise<{ messageId: string }> {
    this.sent.push(m);
    return { messageId: `<out-${++this.n}@test>` };
  }
  async fetchInbound(afterUid: number): Promise<InMail[]> {
    return this.inbox.filter((m) => m.uid > afterUid);
  }
}
