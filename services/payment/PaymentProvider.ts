import { razorpayService } from "../billing/RazorpayService.ts";

export interface PaymentLinkRequest {
  invoiceId: string;
  amount: number;
  currency?: string;
  customerEmail?: string;
  description: string;
}

export interface PaymentLinkResponse {
  paymentLinkId: string;
  checkoutUrl: string;
  status: "created" | "paid" | "expired";
  expiresAt: string;
}

export interface PaymentRefundRequest {
  transactionId: string;
  amount: number;
  reason?: string;
}

export interface PaymentRefundResponse {
  refundId: string;
  status: "processed" | "pending" | "failed";
  amount: number;
}

export interface PaymentProvider {
  name: string;
  createPaymentLink(request: PaymentLinkRequest): Promise<PaymentLinkResponse>;
  processRefund(request: PaymentRefundRequest): Promise<PaymentRefundResponse>;
}

class LiveRazorpayPaymentProvider implements PaymentProvider {
  name = "RazorpayPaymentGateway";

  async createPaymentLink(request: PaymentLinkRequest): Promise<PaymentLinkResponse> {
    if (process.env.NODE_ENV === "test") {
      const paymentLinkId = `paylink_${Math.random().toString(36).substr(2, 9)}`;
      return {
        paymentLinkId,
        checkoutUrl: `https://pay.ekavyu.health/checkout/${paymentLinkId}`,
        status: "created",
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      };
    }

    try {
      const { keyId, keySecret } = await razorpayService.getCredentials();
      const auth = Buffer.from(`${keyId}:${keySecret}`).toString("base64");

      const payload = {
        amount: Math.round(request.amount * 100),
        currency: request.currency || "INR",
        accept_partial: false,
        description: request.description || `Medical Invoice #${request.invoiceId}`,
        customer: {
          email: request.customerEmail,
        },
        notify: {
          sms: true,
          email: !!request.customerEmail,
        },
        reminder_enable: true,
        notes: {
          invoiceId: request.invoiceId,
        },
      };

      const response = await fetch("https://api.razorpay.com/v1/payment_links", {
        method: "POST",
        headers: {
          "Authorization": `Basic ${auth}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(10_000),
        redirect: "error",
      });

      if (response.ok) {
        const data = (await response.json()) as any;
        return {
          paymentLinkId: data.id,
          checkoutUrl: data.short_url,
          status: "created",
          expiresAt: data.expire_by
            ? new Date(data.expire_by * 1000).toISOString()
            : new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
        };
      } else {
        throw new Error(`Razorpay API responded with status ${response.status}`);
      }
    } catch (err: any) {
      console.error("[PaymentProvider] Live Razorpay payment link generation failed", {
        reason: err?.name === "TimeoutError" ? "timeout" : "gateway_error",
      });
      if (process.env.NODE_ENV === "production") {
        throw new Error("Failed to generate online payment link: Payment gateway unavailable");
      }
    }

    // Development sandbox fallback only when not in production
    const paymentLinkId = `paylink_dev_${Math.random().toString(36).substr(2, 9)}`;
    return {
      paymentLinkId,
      checkoutUrl: `https://pay.ekavyu.health/checkout/${paymentLinkId}`,
      status: "created",
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    };
  }

  async processRefund(request: PaymentRefundRequest): Promise<PaymentRefundResponse> {
    if (process.env.NODE_ENV === "test") {
      return {
        refundId: `rfnd_${Math.random().toString(36).substr(2, 9)}`,
        status: "processed",
        amount: request.amount,
      };
    }

    try {
      const refundResult = await razorpayService.processRefund({
        paymentId: request.transactionId,
        amount: request.amount,
        notes: { reason: request.reason || "Patient Refund" },
      });
      return {
        refundId: refundResult.id || "",
        status: refundResult.status === "processed" && refundResult.id ? "processed" : refundResult.status === "failed" ? "failed" : "pending",
        amount: request.amount,
      };
    } catch (err: any) {
      console.error("[PaymentProvider] Refund processing failed:", err.message || err);
      return {
        refundId: "",
        status: "failed",
        amount: request.amount,
      };
    }
  }
}

export const paymentProvider: PaymentProvider = new LiveRazorpayPaymentProvider();
