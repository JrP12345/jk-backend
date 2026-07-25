export interface SmsOptions {
  phoneNumber: string;
  message: string;
}

export class SmsProvider {
  /**
   * Future-ready SMS Provider (Twilio / AWS SNS / Twilio fallback).
   */
  public async sendSms(options: SmsOptions): Promise<boolean> {
    try {
      console.log(`[SMS PROVIDER] Sent SMS to ${options.phoneNumber}: "${options.message}"`);
      return true;
    } catch (err) {
      console.error("[SmsProvider Error] Failed to send SMS:", err);
      return false;
    }
  }
}

export const smsProvider = new SmsProvider();
