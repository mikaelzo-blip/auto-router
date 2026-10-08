export type PaymentErrorCode =
  | "INVALID_AMOUNT"
  | "INVALID_CURRENCY"
  | "MISSING_RECIPIENT"
  | "DUPLICATE_IDEMPOTENCY_KEY"
  | "PROCESSING_ERROR";

export interface PaymentRequest {
  idempotencyKey: string;
  amountCents: number;
  currency: string;
  recipientId: string;
  metadata?: Record<string, any>;
}

export interface PaymentResponse {
  status: "SUCCESS" | "FAILED";
  idempotencyKey: string;
  transactionId?: string;
  error?: PaymentErrorCode;
  message?: string;
}
