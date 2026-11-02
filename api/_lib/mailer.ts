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
  };
}

export function getMailer(config: MailConfig): Mailer {
  return override ?? createSmtpMailer(config);
}
