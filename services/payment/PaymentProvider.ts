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

export interface PaymentWebhookPayload {
  paymentLinkId: string;
  transactionId: string;
  status: "captured" | "failed";
  paymentMethod: "card" | "upi" | "net-banking" | "wallet";
  paidAmount: number;
}

export interface PaymentRefundRequest {
  transactionId: string;
  amount: number;
  reason?: string;
}

export interface PaymentRefundResponse {
  refundId: string;
  status: "processed" | "failed";
  amount: number;
}

export interface PaymentProvider {
  name: string;
  createPaymentLink(request: PaymentLinkRequest): Promise<PaymentLinkResponse>;
  processRefund(request: PaymentRefundRequest): Promise<PaymentRefundResponse>;
}

class TestPaymentProvider implements PaymentProvider {
  name = "TestPaymentGateway";

  async createPaymentLink(request: PaymentLinkRequest): Promise<PaymentLinkResponse> {
    if (process.env.NODE_ENV !== "test") {
      throw new Error("Medical invoice payment provider is not configured");
    }
    const paymentLinkId = `paylink_${Math.random().toString(36).substr(2, 9)}`;
    return {
      paymentLinkId,
      checkoutUrl: `https://pay.ananta.health/checkout/${paymentLinkId}`,
      status: "created",
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    };
  }

  async processRefund(request: PaymentRefundRequest): Promise<PaymentRefundResponse> {
    if (process.env.NODE_ENV !== "test") {
      throw new Error("Medical invoice payment provider is not configured");
    }
    return {
      refundId: `rfnd_${Math.random().toString(36).substr(2, 9)}`,
      status: "processed",
      amount: request.amount,
    };
  }
}

export const paymentProvider: PaymentProvider = new TestPaymentProvider();
