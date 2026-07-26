import nodemailer from "nodemailer";

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
  private transporter: nodemailer.Transporter | null = null;
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
        tls: { rejectUnauthorized: false },
      });
      console.log(`[EmailProvider] Nodemailer initialized for SMTP Host: ${host}:${port} (${user})`);
    } else {
      this.transporter = null;
      console.log("[EmailProvider] Warning: SMTP credentials not set in .env. Running in simulation mode.");
    }
  }

  /**
   * Build a one-time transporter from an org-level SMTP config.
   */
  private buildTransientTransporter(cfg: SmtpConfig): nodemailer.Transporter {
    return nodemailer.createTransport({
      host: cfg.host,
      port: cfg.port || 587,
      secure: cfg.secure || false,
      auth: { user: cfg.user, pass: cfg.pass },
      tls: { rejectUnauthorized: false },
    });
  }

  /**
   * Send outbound email.
   * If orgSmtp is provided and has credentials, it is used instead of .env.
   */
  public async sendEmail(options: EmailOptions, orgSmtp?: SmtpConfig | null): Promise<boolean> {
    const fromEmail = orgSmtp?.fromEmail || options.from || process.env.SMTP_FROM_EMAIL || process.env.SMTP_USER || "noreply@ananta.health";
    const fromName = orgSmtp?.fromName || process.env.SMTP_FROM_NAME || "Ananta Health";
    const formattedFrom = fromEmail.includes("<") ? fromEmail : `"${fromName}" <${fromEmail}>`;

    // Use org-level SMTP if fully configured
    if (orgSmtp?.host && orgSmtp?.user && orgSmtp?.pass) {
      const transporter = this.buildTransientTransporter(orgSmtp);
      try {
        const info = await transporter.sendMail({
          from: formattedFrom,
          to: options.to,
          subject: options.subject,
          text: options.text || options.html.replace(/<[^>]*>?/gm, ""),
          html: options.html,
        });
        console.log(`[EmailProvider] Sent via org SMTP to ${options.to}. MessageId: ${info.messageId}`);
        return true;
      } catch (err: any) {
        console.error(`[EmailProvider] Org SMTP failed for ${options.to}:`, err?.message || err);
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
        const info = await this.transporter.sendMail({
          from: formattedFrom,
          to: options.to,
          subject: options.subject,
          text: options.text || options.html.replace(/<[^>]*>?/gm, ""),
          html: options.html,
        });
        console.log(`[EmailProvider] Email sent to ${options.to}. MessageId: ${info.messageId}`);
        return true;
      } catch (err: any) {
        console.error(`[EmailProvider] Failed to send to ${options.to}:`, err?.message || err);
        return false;
      }
    }

    // Simulation mode — no SMTP configured anywhere
    console.log("\n==========================================================");
    console.log(`[EMAIL PROVIDER - SIMULATION MODE]`);
    console.log(`From    : ${formattedFrom}`);
    console.log(`To      : ${options.to}`);
    console.log(`Subject : ${options.subject}`);
    console.log(`Note    : Configure SMTP in Organization Settings or backend/.env to send real emails.`);
    console.log("==========================================================\n");
    return true;
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
