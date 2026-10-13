import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { absolutePath, type AppConfig } from '../config/index.js';
import type { Logger } from './logger.js';

/**
 * Mail delivery abstraction.
 *
 *  - `console`  : development, prints to the log (never used in production),
 *  - `memory`   : tests — messages are retrievable in-process to extract tokens,
 *  - `file`     : a local outbox on disk, useful for air-gapped/offline deployments
 *                 where a mail transfer agent picks the directory up later,
 *  - `smtp`     : any SMTP server the owner controls (sovereignty: no SaaS required).
 */

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

export interface Mailer {
  readonly driver: AppConfig['MAIL_DRIVER'];
  send(message: MailMessage): Promise<{ id: string; delivered: boolean; preview?: string }>;
}

export interface CapturedMail extends MailMessage {
  id: string;
  sentAt: string;
  preview: string;
}

const outbox = new Map<string, CapturedMail[]>();

export function capturedMail(to?: string): CapturedMail[] {
  if (!to) return [...outbox.values()].flat();
  return outbox.get(to.toLowerCase()) ?? [];
}

export function lastMailTo(to: string): CapturedMail | undefined {
  const list = capturedMail(to);
  return list[list.length - 1];
}

/** Extracts the first link matching `pattern` from a captured message (used by e2e tests). */
export function extractLink(message: CapturedMail, pattern: RegExp): string | null {
  const haystack = `${message.text}\n${message.preview}`;
  const match = pattern.exec(haystack);
  return match ? (match[0] ?? null) : null;
}

export function clearCapturedMail(): void {
  outbox.clear();
}

function record(message: MailMessage, id: string): CapturedMail {
  const entry: CapturedMail = {
    ...message,
    id,
    sentAt: new Date().toISOString(),
    preview: message.text.slice(0, 500),
  };
  const key = message.to.toLowerCase();
  const list = outbox.get(key) ?? [];
  list.push(entry);
  outbox.set(key, list);
  return entry;
}

class ConsoleMailer implements Mailer {
  readonly driver = 'console' as const;
  constructor(private readonly logger: Logger) {}
  async send(message: MailMessage) {
    const id = `console-${Date.now()}`;
    record(message, id);
    this.logger.info(
      { to: message.to, subject: message.subject, preview: message.text.slice(0, 240) },
      'mail (console driver)',
    );
    return { id, delivered: true };
  }
}

class MemoryMailer implements Mailer {
  readonly driver = 'memory' as const;
  constructor(private readonly logger: Logger) {}
  async send(message: MailMessage) {
    const id = `mem-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    record(message, id);
    this.logger.debug({ to: message.to, subject: message.subject }, 'mail captured in memory');
    return { id, delivered: true, preview: message.text.slice(0, 200) };
  }
}

class FileMailer implements Mailer {
  readonly driver = 'file' as const;
  private readonly dir: string;
  constructor(
    cfg: AppConfig,
    private readonly logger: Logger,
  ) {
    this.dir = absolutePath(cfg, cfg.MAIL_OUTBOX_DIR);
    mkdirSync(this.dir, { recursive: true });
  }
  async send(message: MailMessage) {
    const id = `file-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const file = path.join(this.dir, `${id}.json`);
    writeFileSync(
      file,
      JSON.stringify({ id, ...message, sentAt: new Date().toISOString() }, null, 2),
      { mode: 0o600 },
    );
    record(message, id);
    this.logger.info({ file, to: message.to }, 'mail written to outbox');
    return { id, delivered: true };
  }
}

class SmtpMailer implements Mailer {
  readonly driver = 'smtp' as const;
  private transporter: import('nodemailer').Transporter | null = null;
  private readonly from: string;

  constructor(
    private readonly cfg: AppConfig,
    private readonly logger: Logger,
  ) {
    this.from = cfg.MAIL_FROM;
  }

  private async ensure() {
    if (this.transporter) return this.transporter;
    const nodemailer = await import('nodemailer');
    this.transporter = nodemailer.createTransport({
      host: this.cfg.SMTP_HOST,
      port: this.cfg.SMTP_PORT,
      secure: this.cfg.SMTP_SECURE,
      auth: this.cfg.SMTP_USER ? { user: this.cfg.SMTP_USER, pass: this.cfg.SMTP_PASSWORD } : undefined,
      pool: true,
      maxConnections: 3,
    });
    return this.transporter;
  }

  async send(message: MailMessage) {
    const transporter = await this.ensure();
    const info = await transporter.sendMail({ from: this.from, ...message });
    this.logger.info({ to: message.to, messageId: info.messageId }, 'mail sent via smtp');
    return { id: info.messageId as string, delivered: true };
  }
}

export function createMailer(cfg: AppConfig, logger: Logger): Mailer {
  switch (cfg.MAIL_DRIVER) {
    case 'memory':
      return new MemoryMailer(logger);
    case 'file':
      return new FileMailer(cfg, logger);
    case 'smtp':
      return new SmtpMailer(cfg, logger);
    case 'console':
    default:
      if (cfg.isProduction) {
        throw new Error('MAIL_DRIVER=console is not allowed in production: configure smtp or file');
      }
      return new ConsoleMailer(logger);
  }
}

/** ------------------------------------------------------------------ templates */

const BRAND = 'Sovereign';

export function verificationEmail(displayName: string, link: string, locale: 'ar' | 'en' = 'ar'): MailMessage & { to: string } {
  const ar = locale === 'ar';
  return {
    to: '',
    subject: ar ? `${BRAND}: تأكيد البريد الإلكتروني` : `${BRAND}: verify your email`,
    text: ar
      ? `مرحباً ${displayName}،\n\nلتأكيد عنوان بريدك الإلكتروني افتح الرابط التالي:\n${link}\n\nالرابط صالح لمدة ساعة واحدة. إذا لم تطلب هذا، تجاهل الرسالة.`
      : `Hi ${displayName},\n\nConfirm your email address by opening:\n${link}\n\nThe link is valid for one hour. Ignore this message if you did not sign up.`,
  };
}

export function passwordResetEmail(displayName: string, link: string, locale: 'ar' | 'en' = 'ar'): MailMessage & { to: string } {
  const ar = locale === 'ar';
  return {
    to: '',
    subject: ar ? `${BRAND}: إعادة تعيين كلمة المرور` : `${BRAND}: password reset`,
    text: ar
      ? `مرحباً ${displayName}،\n\nلإعادة تعيين كلمة المرور افتح الرابط التالي:\n${link}\n\nصالح لمدة 30 دقيقة.`
      : `Hi ${displayName},\n\nReset your password by opening:\n${link}\n\nValid for 30 minutes.`,
  };
}

export function newDeviceEmail(displayName: string, info: { device: string; ip: string; at: string }): MailMessage & { to: string } {
  return {
    to: '',
    subject: `${BRAND}: new sign-in detected`,
    text: `Hi ${displayName},\n\nA new sign-in was detected:\n  device: ${info.device}\n  ip: ${info.ip}\n  time: ${info.at}\n\nIf this wasn't you, revoke the session from your account settings and change your password.`,
  };
}

export function loginCodeEmail(displayName: string, code: string): MailMessage & { to: string } {
  return {
    to: '',
    subject: `${BRAND}: sign-in code`,
    text: `Hi ${displayName},\n\nYour sign-in code is: ${code}\n\nIt expires in 10 minutes.`,
  };
}
