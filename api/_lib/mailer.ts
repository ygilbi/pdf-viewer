// Email transport abstraction. Production uses nodemailer SMTP (Gmail App Password by default);
// tests call setMailerForTests() with a fake that records messages.
import nodemailer from 'nodemailer';
import type { MailConfig } from './config.js';

export interface MailMessage {
  to: string;
  subject: string;
  html: string;
  text: string;
  replyTo?: string;
}

export interface Mailer {
  send(message: MailMessage): Promise<void>;
  /** Connect + authenticate without sending (used by /api/health). */
  verify?(): Promise<void>;
}

let override: Mailer | null = null;

/** Test hook: replace the transport (pass null to restore SMTP). */
export function setMailerForTests(mailer: Mailer | null): void {
  override = mailer;
}

export function createSmtpMailer(config: MailConfig): Mailer {
  const transport = nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure,
    auth: { user: config.user, pass: config.pass },
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 15_000,
  });
  return {
    async send(message) {
      await transport.sendMail({
        from: config.from,
        to: message.to,
        replyTo: message.replyTo,
        subject: message.subject,
        text: message.text,
        html: message.html,
      });
    },
    async verify() {
      await transport.verify();
    },
  };
}

export function getMailer(config: MailConfig): Mailer {
  return override ?? createSmtpMailer(config);
}

/**
 * Short, secret-free description of an SMTP failure for diagnostics, e.g. "auth failed 535".
 * Uses only nodemailer's error code / SMTP response code, never the server's message text.
 */
export function describeSmtpError(err: unknown): string {
  const e = (err ?? {}) as { code?: unknown; responseCode?: unknown; message?: unknown };
  const code = typeof e.code === 'string' ? e.code : '';
  const rc = typeof e.responseCode === 'number' ? e.responseCode : null;
  if (code === 'EAUTH' || rc === 535 || rc === 534) return `auth failed${rc ? ` ${rc}` : ''}`;
  if (code === 'TIMEOUT' || code === 'ETIMEDOUT' || code === 'ETIMEDOUT_HEALTH') return 'timeout';
  if (code === 'EDNS' || code === 'ENOTFOUND') return 'host not found';
  if (code === 'ESOCKET' || code === 'ECONNECTION' || code === 'ECONNREFUSED' || code === 'ECONNRESET') return `connection failed (${code})`;
  if (code === 'ETLS') return 'tls failed';
  if (rc) return `smtp ${rc}`;
  return code ? `failed (${code})` : 'failed';
}
