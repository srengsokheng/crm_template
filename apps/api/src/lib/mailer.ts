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
import { q, sql, type Db, pool } from '../db/index.ts';

export interface Mail { to: string; subject: string; text: string; html: string }
export interface Transport { name: 'console' | 'smtp' | 'memory'; send(mail: Mail, from: string): Promise<void> }
export interface SmtpConfig { host: string; port: number; secure: boolean; user?: string; pass?: string }

/** Messages "sent" by the memory transport (tests). */
export const outbox: (Mail & { from: string })[] = [];
/** Tests: make the next N memory sends fail. */
export const memoryFailures = { next: 0 };

const consoleTransport: Transport = {
  name: 'console',
  async send(mail, from) {
    console.log(`\n── email (not sent: EMAIL_TRANSPORT=console) ──\nFrom: ${from}\nTo: ${mail.to}\nSubject: ${mail.subject}\n\n${mail.text}\n──\n`);
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
    async send(mail, from) { await t.sendMail({ from, to: mail.to, subject: mail.subject, text: mail.text, html: mail.html }); },
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

export async function deliver(mail: Mail): Promise<void> {
  await transport().send(mail, config.mail.from);
}

/** Queue a message for the worker (use the caller's transaction so the mail is only sent if the change commits). */
export async function queueMail(mail: Mail, db: Db = pool): Promise<void> {
  await q(sql`INSERT INTO jobs (type, payload) VALUES ('email.send', ${JSON.stringify(mail)})`, db);
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

export function testMail(o: { to: string; workspace: string }): Mail {
  return {
    to: o.to, subject: 'Acme CRM test email',
    ...layout({ heading: 'Email delivery works', lines: [`This is a test message from the ${o.workspace} workspace.`], footer: 'Sent from Settings → Workspace → Email delivery.' }),
  };
}
