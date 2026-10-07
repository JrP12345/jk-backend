import nodemailer, { type Transporter } from "nodemailer";
import { withConcurrencyBudget } from "../../utilities/concurrencyBudget.ts";
import { MAX_PROVIDER_CONCURRENCY } from "../../utilities/scalability.ts";
import { decryptField, isEncrypted } from "../../utilities/cryptoEnvelope.ts";

export interface EmailOptions {
  to: string;
  subject: string;
  html: string;
  text?: string;
  from?: string;
}

export interface SmtpConfig {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  pass: string;
  fromEmail: string;
  fromName: string;
}

export class EmailProvider {
  private transporter: Transporter | null = null;
  private lastConfigKey: string = "";

  constructor() {
    this.initTransporter();
  }

  public initTransporter() {
    const host = process.env.SMTP_HOST;
    const port = Number(process.env.SMTP_PORT) || 587;
    const secure = process.env.SMTP_SECURE === "true" || port === 465;
    const user = process.env.SMTP_USER;
    const pass = process.env.SMTP_PASS;

    const currentKey = `${host}:${port}:${user}:${pass}:${secure}`;
    this.lastConfigKey = currentKey;

    if (host && user && pass) {
      this.transporter = nodemailer.createTransport({
        host,
        port,
        secure,
        auth: { user, pass },
        tls: { rejectUnauthorized: process.env.NODE_ENV === "production" },
        requireTLS: process.env.NODE_ENV === "production" && !secure,
        connectionTimeout: 10_000,
        greetingTimeout: 10_000,
        socketTimeout: 30_000,
      });
      console.log("[EmailProvider] Nodemailer initialized");
    } else {
      this.transporter = null;
      console.log("[EmailProvider] SMTP credentials are not configured; outbound email is unavailable.");
    }
  }

  /**
   * Build a one-time transporter from an org-level SMTP config (decrypting password if encrypted).
   */
  private buildTransientTransporter(cfg: SmtpConfig): Transporter {
    const rawPass = cfg.pass && isEncrypted(cfg.pass) ? decryptField(cfg.pass) : cfg.pass;
    return nodemailer.createTransport({
      host: cfg.host,
      port: cfg.port || 587,
      secure: cfg.secure || false,
      auth: { user: cfg.user, pass: rawPass },
      tls: { rejectUnauthorized: process.env.NODE_ENV === "production" },
      requireTLS: process.env.NODE_ENV === "production" && !cfg.secure,
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 30_000,
    });
  }

  /**
   * Send outbound email.
   * If orgSmtp is provided and has credentials, it is used instead of .env.
   */
  public async sendEmail(options: EmailOptions, orgSmtp?: SmtpConfig | null): Promise<boolean> {
    return withConcurrencyBudget("provider:email", MAX_PROVIDER_CONCURRENCY, () => this.sendEmailBounded(options, orgSmtp));
  }
  private async sendEmailBounded(options: EmailOptions, orgSmtp?: SmtpConfig | null): Promise<boolean> {
    const fromEmail = orgSmtp?.fromEmail || options.from || process.env.SMTP_FROM_EMAIL || process.env.SMTP_USER || "noreply@ekavyu.com";
    const configuredName = process.env.SMTP_FROM_NAME?.trim();
    const platformName = configuredName || "Ekavyu";
    const fromName = orgSmtp?.fromName || platformName;
    const formattedFrom = fromEmail.includes("<") ? fromEmail : `"${fromName}" <${fromEmail}>`;

    // Use org-level SMTP if fully configured
    if (orgSmtp?.host && orgSmtp?.user && orgSmtp?.pass) {
      const transporter = this.buildTransientTransporter(orgSmtp);
      try {
        await transporter.sendMail({
          from: formattedFrom,
          to: options.to,
          subject: options.subject,
          text: options.text || options.html.replace(/<[^>]*>?/gm, ""),
          html: options.html,
        });
        console.log("[EmailProvider] Sent via org SMTP");
        return true;
      } catch (err: any) {
        console.error("[EmailProvider] Org SMTP delivery failed", {
          code: typeof err?.code === "string" && /^[A-Z_]{1,32}$/.test(err.code) ? err.code : "SMTP_FAILED",
        });
        return false;
      }
    }

    // Fallback: use .env transporter
    const host = process.env.SMTP_HOST;
    const port = Number(process.env.SMTP_PORT) || 587;
    const secure = process.env.SMTP_SECURE === "true" || port === 465;
    const user = process.env.SMTP_USER;
    const pass = process.env.SMTP_PASS;
    const currentKey = `${host}:${port}:${user}:${pass}:${secure}`;

    if (currentKey !== this.lastConfigKey || (!this.transporter && host && user && pass)) {
      this.initTransporter();
    }

    if (this.transporter) {
      try {
        await this.transporter.sendMail({
          from: formattedFrom,
          to: options.to,
          subject: options.subject,
          text: options.text || options.html.replace(/<[^>]*>?/gm, ""),
          html: options.html,
        });
        console.log("[EmailProvider] Email sent");
        return true;
      } catch (err: any) {
        console.error("[EmailProvider] Email delivery failed", {
          code: typeof err?.code === "string" && /^[A-Z_]{1,32}$/.test(err.code) ? err.code : "SMTP_FAILED",
        });
        return false;
      }
    }

    if (process.env.NODE_ENV === "test") {
      return true;
    }
    console.error("[EmailProvider] SMTP is not configured; refusing to report email delivery as successful");
    return false;
  }

  public async verifyConnection(orgSmtp?: SmtpConfig | null): Promise<{ success: boolean; message: string }> {
    if (orgSmtp?.host && orgSmtp?.user && orgSmtp?.pass) {
      const transporter = this.buildTransientTransporter(orgSmtp);
      try {
        await transporter.verify();
        return { success: true, message: `SMTP verified: ${orgSmtp.host}:${orgSmtp.port} (${orgSmtp.user})` };
      } catch (err: any) {
        return { success: false, message: `SMTP verification failed: ${err.message}` };
      }
    }
    if (!this.transporter) {
      return {
        success: false,
        message: "SMTP is not configured. Set credentials in Organization Settings or backend/.env.",
      };
    }
    try {
      await this.transporter.verify();
      return { success: true, message: "SMTP connection verified successfully!" };
    } catch (err: any) {
      return { success: false, message: `SMTP verification failed: ${err.message}` };
    }
  }
}

export const emailProvider = new EmailProvider();
