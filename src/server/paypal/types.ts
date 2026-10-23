export interface PayPalResponse<T = any> {
  /** HTTP status; 0 when no response was received (network error, timeout, or an injected lost response). */
  status: number;
  body: T | null;
  debugId: string | null;
  networkError?: string;
}

export interface WebhookVerifyInput {
  authAlgo: string; certUrl: string; transmissionId: string; transmissionSig: string; transmissionTime: string;
  webhookId: string; event: unknown;
  /** Exact request body text; PayPal verifies the signature over the original event bytes. */
  rawEvent?: string;
}

export interface PayPalApi {
  readonly mode: "sandbox" | "fake";
  createOrder(body: unknown, requestId: string): Promise<PayPalResponse>;
  getOrder(orderId: string): Promise<PayPalResponse>;
  authorizeOrder(orderId: string, requestId: string): Promise<PayPalResponse>;
  getAuthorization(authorizationId: string): Promise<PayPalResponse>;
  captureAuthorization(authorizationId: string, body: unknown, requestId: string): Promise<PayPalResponse>;
  voidAuthorization(authorizationId: string, requestId: string): Promise<PayPalResponse>;
  getCapture(captureId: string): Promise<PayPalResponse>;
  refundCapture(captureId: string, body: unknown, requestId: string): Promise<PayPalResponse>;
  getRefund(refundId: string): Promise<PayPalResponse>;
  verifyWebhook(input: WebhookVerifyInput): Promise<PayPalResponse<{ verification_status: string }>>;
  createWebhook(url: string, eventTypes: string[]): Promise<PayPalResponse>;
  listWebhooks(): Promise<PayPalResponse>;
}

export const WEBHOOK_EVENTS = [
  "CHECKOUT.ORDER.APPROVED",
  "PAYMENT.AUTHORIZATION.CREATED",
  "PAYMENT.AUTHORIZATION.VOIDED",
  "PAYMENT.CAPTURE.COMPLETED",
  "PAYMENT.CAPTURE.PENDING",
  "PAYMENT.CAPTURE.DENIED",
  "PAYMENT.CAPTURE.REFUNDED",
  "PAYMENT.CAPTURE.REVERSED",
];
