import { PaymentRequest, PaymentErrorCode } from "./types.js";

export interface ValidationResult {
  valid: boolean;
  error?: PaymentErrorCode;
  message?: string;
}

export function validatePaymentRequest(req: PaymentRequest): ValidationResult {
  // Incomplete: only checks non-null object
  if (!req) {
    return { valid: false, error: "PROCESSING_ERROR", message: "Empty request" };
  }
  return { valid: true };
}
