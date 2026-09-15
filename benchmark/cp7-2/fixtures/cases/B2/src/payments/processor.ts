import { PaymentRequest, PaymentResponse } from "./types.js";
import { validatePaymentRequest } from "./validator.js";

export class PaymentProcessor {
  private readonly processedKeys: Map<string, PaymentResponse> = new Map();
  private nextTxId = 1000;

  public processPayment(req: PaymentRequest): PaymentResponse {
    const val = validatePaymentRequest(req);
    if (!val.valid) {
      return {
        status: "FAILED",
        idempotencyKey: req?.idempotencyKey || "unknown",
        error: val.error,
        message: val.message
      };
    }

    // Incomplete: does not handle duplicate idempotencyKey correctly
    const txId = `tx_${this.nextTxId++}`;
    const response: PaymentResponse = {
      status: "SUCCESS",
      idempotencyKey: req.idempotencyKey,
      transactionId: txId
    };

    this.processedKeys.set(req.idempotencyKey, response);
    return response;
  }
}
