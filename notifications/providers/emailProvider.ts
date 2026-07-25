import nodemailer from "nodemailer";

export interface EmailOptions {
  to: string;
  subject: string;
  html: string;
  text?: string;
  from?: string;
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
        auth: {
          user,
          pass,
        },
        tls: {
          rejectUnauthorized: false,
        },
      });
      console.log(`[EmailProvider] Nodemailer initialized for SMTP Host: ${host}:${port} (${user})`);
    } else {
      this.transporter = null;
      console.log("[EmailProvider] Warning: SMTP Host/User credentials not set in .env. Running in simulation mode.");
    }
  }

  /**
   * Send outbound email via Nodemailer or log fallback if credentials not configured.
   */
  public async sendEmail(options: EmailOptions): Promise<boolean> {
    const rawFrom = options.from || process.env.SMTP_FROM_EMAIL || process.env.SMTP_USER || "noreply@ananta.health";
    const fromName = process.env.SMTP_FROM_NAME || "Ananta Health";
    
    // Clean formatted email address
    let formattedFrom = rawFrom;
    if (!rawFrom.includes("<")) {
      formattedFrom = `"${fromName}" <${rawFrom}>`;
    }

    // Always check if env vars have changed
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
        console.log(`[EmailProvider Success] Email sent to ${options.to}. MessageId: ${info.messageId}`);
        return true;
      } catch (err: any) {
        console.error(`[EmailProvider Error] Failed to transmit email to ${options.to}:`, err?.message || err);
        return false;
      }
    }

    // Simulation / Fallback mode when SMTP credentials are not configured in .env
    console.log("\n==========================================================");
    console.log(`[ENTERPRISE EMAIL PROVIDER - DISPATCH (SIMULATION MODE)]`);
    console.log(`From    : ${formattedFrom}`);
    console.log(`To      : ${options.to}`);
    console.log(`Subject : ${options.subject}`);
    console.log(`Summary : ${options.text || "HTML Email Body Generated"}`);
    console.log(`Note    : To send REAL emails to inboxes, set SMTP_HOST, SMTP_USER, & SMTP_PASS in backend/.env`);
    console.log("==========================================================\n");
    return true;
  }

  public async verifyConnection(): Promise<{ success: boolean; message: string }> {
    if (!this.transporter) {
      return {
        success: false,
        message: "SMTP is not configured. Please set SMTP_HOST, SMTP_USER, and SMTP_PASS in backend/.env file.",
      };
    }
    try {
      await this.transporter.verify();
      return { success: true, message: "SMTP Server connection verified successfully!" };
    } catch (err: any) {
      return { success: false, message: `SMTP verification failed: ${err.message}` };
    }
  }
}

export const emailProvider = new EmailProvider();


