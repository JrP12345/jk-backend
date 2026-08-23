import crypto from "node:crypto";
import { SaaSConfig } from "../../models/SaaSConfig.ts";

export interface CreateOrderParams {
  amount: number; // in INR
  currency?: string;
  receipt: string;
  notes?: Record<string, string>;
}

export interface RazorpayOrderResponse {
  id: string;
  entity: string;
  amount: number;
  amount_paid: number;
  amount_due: number;
  currency: string;
  receipt: string;
  status: string;
  attempts: number;
  notes?: Record<string, string>;
  created_at: number;
}

export interface RefundParams {
  paymentId: string;
  amount?: number;
  notes?: Record<string, string>;
}

export class RazorpayService {
  /**
   * Fetch active platform Razorpay credentials dynamically from MongoDB (SaaSConfig)
   * Fallback to environment variables.
   */
  async getCredentials() {
    let keyId = (process.env.RAZORPAY_KEY_ID || "").trim();
    let keySecret = (process.env.RAZORPAY_KEY_SECRET || "").trim();
    let webhookSecret = (process.env.RAZORPAY_WEBHOOK_SECRET || "").trim();

    try {
      const config = await SaaSConfig.findOne({ key: "platform_config" });
      if (config && config.razorpayKeyId && config.razorpayKeySecret) {
        keyId = config.razorpayKeyId.trim();
        keySecret = config.razorpayKeySecret.trim();
        webhookSecret = (config.razorpayWebhookSecret || webhookSecret).trim();
      }
    } catch (err) {
      console.warn("Failed to fetch dynamic SaaSConfig from MongoDB, checking process.env");
    }

    if (!keyId || !keySecret) {
      throw new Error(
        "Razorpay Credentials Not Saved in MongoDB. Please go to Root Admin Console (http://localhost:3000/dashboard/admin/billing -> Razorpay Platform Gateway tab), enter your Razorpay Key ID & Key Secret, and click 'Save Gateway Credentials'."
      );
    }

    return { keyId, keySecret, webhookSecret };
  }

  async getPublicParams() {
    try {
      const { keyId } = await this.getCredentials();
      return { keyId, configured: true };
    } catch {
      return { keyId: "", configured: false };
    }
  }

  /**
   * Create an order directly in Razorpay REST API
   */
  async createOrder(params: CreateOrderParams): Promise<RazorpayOrderResponse> {
    const { keyId, keySecret } = await this.getCredentials();

    if (process.env.NODE_ENV === "test" || keyId.startsWith("rzp_test_mock")) {
      return {
        id: `order_test_${Date.now()}`,
        entity: "order",
        amount: Math.round(params.amount * 100),
        amount_paid: 0,
        amount_due: Math.round(params.amount * 100),
        currency: params.currency || "INR",
        receipt: params.receipt,
        status: "created",
        attempts: 0,
        notes: params.notes || {},
        created_at: Math.floor(Date.now() / 1000),
      };
    }

    const auth = Buffer.from(`${keyId}:${keySecret}`).toString("base64");
    const payload = {
      amount: Math.round(params.amount * 100), // convert to paise
      currency: params.currency || "INR",
      receipt: params.receipt,
      notes: params.notes || {},
    };

    const response = await fetch("https://api.razorpay.com/v1/orders", {
      method: "POST",
      headers: {
        "Authorization": `Basic ${auth}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const errText = await response.text();
      if (response.status === 401) {
        throw new Error(
          `Razorpay Authentication Failed (401): The Key ID '${keyId}' or Key Secret saved in MongoDB is invalid or rejected by Razorpay. Please re-enter your valid Razorpay Key ID (rzp_test_...) and Key Secret at http://localhost:3000/dashboard/admin/billing and click Save.`
        );
      }
      throw new Error(`Razorpay API Order Creation Failed (${response.status}): ${errText}`);
    }

    return (await response.json()) as RazorpayOrderResponse;
  }

  /**
   * Verify Razorpay Payment HMAC SHA256 Signature
   */
  async verifyPaymentSignature(orderId: string, paymentId: string, signature: string): Promise<boolean> {
    try {
      const { keySecret } = await this.getCredentials();
      const generatedSignature = crypto
        .createHmac("sha256", keySecret)
        .update(`${orderId}|${paymentId}`)
        .digest("hex");
      return generatedSignature === signature;
    } catch {
      if (process.env.NODE_ENV === "test") {
        const generatedSignature = crypto
          .createHmac("sha256", "test_secret")
          .update(`${orderId}|${paymentId}`)
          .digest("hex");
        return generatedSignature === signature;
      }
      return false;
    }
  }

  /**
   * Verify Razorpay Webhook HMAC SHA256 Signature
   */
  async verifyWebhookSignature(rawBody: string, signature: string): Promise<boolean> {
    const { webhookSecret } = await this.getCredentials();
    if (!webhookSecret) throw new Error("Razorpay webhook secret is not configured");

    const expectedSignature = crypto
      .createHmac("sha256", webhookSecret)
      .update(rawBody)
      .digest("hex");

    return expectedSignature === signature;
  }

  /**
   * Process Razorpay Refund
   */
  async processRefund(params: RefundParams) {
    const { keyId, keySecret } = await this.getCredentials();

    const auth = Buffer.from(`${keyId}:${keySecret}`).toString("base64");
    const payload: any = {};
    if (params.amount) payload.amount = Math.round(params.amount * 100);

    const response = await fetch(`https://api.razorpay.com/v1/payments/${params.paymentId}/refund`, {
      method: "POST",
      headers: {
        "Authorization": `Basic ${auth}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Razorpay Refund Failed (${response.status}): ${errText}`);
    }

    return await response.json();
  }
}

export const razorpayService = new RazorpayService();
