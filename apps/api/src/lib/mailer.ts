/**
 * Pluggable email delivery.
 *
 *   console  (default in development) prints the message to the server log — nothing leaves the machine
 *   smtp     (production) sends through the server configured with SMTP_* environment variables
 *   memory   (tests) keeps messages in `outbox`
 *
 * Callers normally use `queueMail()`: the message becomes an `email.send` job in the same transaction as the change
 * that caused it, and the worker delivers it with the job queue's retries. `deliver()` sends immediately.
 */
import nodemailer from 'nodemailer';
import { config } from '../config.ts';
import { q, q1, sql, type Db, pool } from '../db/index.ts';

export interface Mail {
  to: string; subject: string; text: string; html: string;
  /** Display name for the From header (the workspace's sender name); the address is always the configured one. */
  fromName?: string | null;
  /** Where replies go (e.g. the salesperson who sent a quote). */
  replyTo?: string | null;
  /** Files, base64-encoded (kept small: quotes and invoices). */
  attachments?: { filename: string; contentType: string; content: string }[];
}
export interface Transport { name: 'console' | 'smtp' | 'memory'; send(mail: Mail, from: string): Promise<void> }
export interface SmtpConfig { host: string; port: number; secure: boolean; user?: string; pass?: string }

/** Messages "sent" by the memory transport (tests). */
export const outbox: (Mail & { from: string })[] = [];
/** Tests: make the next N memory sends fail. */
export const memoryFailures = { next: 0 };

const consoleTransport: Transport = {
  name: 'console',
  async send(mail, from) {
    const files = mail.attachments?.length ? `\nAttachments: ${mail.attachments.map((a) => a.filename).join(', ')}` : '';
    console.log(`\n── email (not sent: EMAIL_TRANSPORT=console) ──\nFrom: ${from}\nTo: ${mail.to}${mail.replyTo ? `\nReply-To: ${mail.replyTo}` : ''}\nSubject: ${mail.subject}${files}\n\n${mail.text}\n──\n`);
  },
};

const memoryTransport: Transport = {
  name: 'memory',
  async send(mail, from) {
    if (memoryFailures.next > 0) { memoryFailures.next--; throw new Error('Simulated delivery failure'); }
    outbox.push({ ...mail, from });
  },
};

export function createSmtpTransport(cfg: SmtpConfig): Transport {
  const t = nodemailer.createTransport({
    host: cfg.host, port: cfg.port, secure: cfg.secure,
    auth: cfg.user ? { user: cfg.user, pass: cfg.pass ?? '' } : undefined,
    connectionTimeout: 15_000, greetingTimeout: 15_000, socketTimeout: 30_000,
  });
  return {
    name: 'smtp',
    async send(mail, from) {
      await t.sendMail({
        from, to: mail.to, subject: mail.subject, text: mail.text, html: mail.html, replyTo: mail.replyTo ?? undefined,
        attachments: mail.attachments?.map((a) => ({ filename: a.filename, contentType: a.contentType, content: a.content, encoding: 'base64' })),
      });
    },
  };
}

let current: Transport | null = null;
export function transport(): Transport {
  if (current) return current;
  const kind = config.mail.transport;
  if (kind === 'smtp') {
    if (!config.mail.smtp.host) throw new Error('EMAIL_TRANSPORT=smtp needs SMTP_HOST');
    current = createSmtpTransport(config.mail.smtp as SmtpConfig);
  } else current = kind === 'memory' ? memoryTransport : consoleTransport;
  return current;
}
/** Tests: swap the transport (pass null to go back to the configured one). */
export function setTransport(t: Transport | null) { current = t; }

/** What admins see in Settings — never includes credentials. */
export function mailStatus() {
  const t = config.mail.transport;
  return {
    transport: t, delivers: t === 'smtp', from: config.mail.from,
    host: t === 'smtp' ? `${config.mail.smtp.host}:${config.mail.smtp.port}` : null,
  };
}

/** The configured sender address ("Acme CRM <no-reply@x.com>" → "no-reply@x.com"). */
export function senderAddress(from = config.mail.from): string {
  return (/<([^>]+)>/.exec(from)?.[1] ?? from).trim();
}

/** A display name safe to put in a From header: no quotes, angle brackets, backslashes or line breaks; max 60 chars. */
export function cleanSenderName(name: string): string {
  // eslint-disable-next-line no-control-regex
  return name.replace(/[\u0000-\u001f\u007f"<>\\]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60);
}

/** From header for a message: the workspace's sender name (if any) with the configured address. */
export function fromHeader(name?: string | null): string {
  const n = name ? cleanSenderName(name) : '';
  return n ? `"${n}" <${senderAddress()}>` : config.mail.from;
}

export async function deliver(mail: Mail): Promise<void> {
  await transport().send(mail, fromHeader(mail.fromName));
}

/**
 * Queue a message for the worker (use the caller's transaction so the mail is only sent if the change commits).
 * `workspaceId` lets admins of that workspace see the message if delivery fails.
 */
export async function queueMail(mail: Mail, db: Db = pool, opts: { workspaceId?: number } = {}): Promise<void> {
  await q(sql`INSERT INTO jobs (type, payload, workspace_id) VALUES ('email.send', ${JSON.stringify(mail)}, ${opts.workspaceId ?? null})`, db);
}

/** The sender name a workspace chose (Settings → Workspace → Email delivery), or null for the default. */
export async function workspaceSender(workspaceId: number, db: Db = pool): Promise<string | null> {
  const r = await q1<{ name: string | null }>(sql`SELECT settings->>'emailSenderName' AS name FROM workspaces WHERE id = ${workspaceId}`, db);
  return r?.name || null;
}

// ───────────────────────── Messages ─────────────────────────

export const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** One simple, client-safe layout: heading, paragraphs, an optional button, a footer line. Inputs are escaped here. */
function layout(o: { heading: string; lines: string[]; button?: { label: string; url: string }; footer: string }): { text: string; html: string } {
  const text = [o.heading, '', ...o.lines, ...(o.button ? ['', `${o.button.label}: ${o.button.url}`] : []), '', '—', o.footer].join('\n');
  const html = `<!doctype html><html><body style="margin:0;padding:24px;background:#f8fafc;font-family:-apple-system,'Segoe UI',Roboto,Arial,sans-serif;color:#0f172a">
<div style="max-width:520px;margin:0 auto;background:#ffffff;border:1px solid #e2e8f0;border-radius:10px;padding:28px">
<h1 style="margin:0 0 16px;font-size:18px">${escapeHtml(o.heading)}</h1>
${o.lines.map((l) => `<p style="margin:0 0 12px;font-size:14px;line-height:1.5">${escapeHtml(l)}</p>`).join('\n')}
${o.button ? `<p style="margin:20px 0 8px"><a href="${escapeHtml(o.button.url)}" style="display:inline-block;background:#4f46e5;color:#ffffff;text-decoration:none;font-size:14px;font-weight:600;padding:10px 18px;border-radius:6px">${escapeHtml(o.button.label)}</a></p>
<p style="margin:0 0 12px;font-size:12px;color:#64748b;word-break:break-all">${escapeHtml(o.button.url)}</p>` : ''}
<p style="margin:20px 0 0;padding-top:14px;border-top:1px solid #e2e8f0;font-size:12px;color:#64748b">${escapeHtml(o.footer)}</p>
</div></body></html>`;
  return { text, html };
}

/** Subjects are single-line: strip line breaks so user text can't add headers. */
const oneLine = (s: string) => s.replace(/[\r\n]+/g, ' ').trim();

export function inviteMail(o: { to: string; name: string; workspace: string; inviter: string; url: string }): Mail {
  return {
    to: o.to, subject: oneLine(`${o.inviter} invited you to ${o.workspace} on Acme CRM`),
    ...layout({
      heading: `Join ${o.workspace}`,
      lines: [`Hi ${o.name},`, `${o.inviter} invited you to the ${o.workspace} workspace on Acme CRM. Choose a password to get started.`],
      button: { label: 'Accept invitation', url: o.url },
      footer: 'This link works once. If you did not expect this invitation, you can ignore this email.',
    }),
  };
}

export function reminderMail(o: { to: string; name: string; subject: string; kind: string; due: string | null; related: string[]; workspace: string; url: string }): Mail {
  return {
    to: o.to, subject: oneLine(`Reminder: ${o.subject}`),
    ...layout({
      heading: `Reminder: ${o.subject}`,
      lines: [
        `Hi ${o.name},`,
        `Your ${o.kind} “${o.subject}”${o.due ? ` is due ${o.due}` : ' is coming up'}.`,
        ...(o.related.length ? [`Related to: ${o.related.join(', ')}`] : []),
      ],
      button: { label: 'Open activities', url: o.url },
      footer: `You get this because you are assigned to this activity in ${o.workspace}. Turn reminder emails off in your account menu.`,
    }),
  };
}

export function resetMail(o: { to: string; name: string; url: string }): Mail {
  return {
    to: o.to, subject: 'Reset your Acme CRM password',
    ...layout({
      heading: 'Reset your password',
      lines: [`Hi ${o.name},`, 'Someone (hopefully you) asked to reset the password for this email address. Choose a new password with the button below. The link works once and expires in 1 hour.'],
      button: { label: 'Choose a new password', url: o.url },
      footer: 'If you did not ask for this, ignore this email — your password stays the same.',
    }),
  };
}

/** A quote or invoice sent to a customer, with the PDF attached. The user's message is plain text (escaped). */
export function documentMail(o: { to: string[]; replyTo: string; subject: string; message: string; sender: string; workspace: string; pdf: { filename: string; base64: string } }): Mail {
  return {
    to: o.to.join(', '), subject: oneLine(o.subject), replyTo: o.replyTo,
    attachments: [{ filename: o.pdf.filename, contentType: 'application/pdf', content: o.pdf.base64 }],
    ...layout({
      heading: oneLine(o.subject),
      lines: o.message.split(/\r?\n/).filter((l, i, all) => l.trim() || (i > 0 && all[i - 1].trim())),
      footer: `Sent by ${o.sender} from ${o.workspace}. The document is attached as a PDF. Reply to this email to reach ${o.sender}.`,
    }),
  };
}

export interface DigestItem { subject: string; kind: string; due: string; related: string[] }
export function digestMail(o: { to: string; name: string; workspace: string; items: DigestItem[]; total: number; url: string }): Mail {
  const shown = o.items.slice(0, 10);
  return {
    to: o.to, subject: oneLine(`${o.total} overdue ${o.total === 1 ? 'activity' : 'activities'} in ${o.workspace}`),
    ...layout({
      heading: `You have ${o.total} overdue ${o.total === 1 ? 'activity' : 'activities'}`,
      lines: [
        `Hi ${o.name},`,
        ...shown.map((i) => `• ${i.subject} (${i.kind}, due ${i.due})${i.related.length ? ` — ${i.related.join(', ')}` : ''}`),
        ...(o.total > shown.length ? [`…and ${o.total - shown.length} more.`] : []),
      ],
      button: { label: 'Open overdue activities', url: o.url },
      footer: `A daily summary from ${o.workspace}. Turn the daily summary off in your account menu.`,
    }),
  };
}

export function testMail(o: { to: string; workspace: string }): Mail {
  return {
    to: o.to, subject: 'Acme CRM test email',
    ...layout({ heading: 'Email delivery works', lines: [`This is a test message from the ${o.workspace} workspace.`], footer: 'Sent from Settings → Workspace → Email delivery.' }),
  };
}
