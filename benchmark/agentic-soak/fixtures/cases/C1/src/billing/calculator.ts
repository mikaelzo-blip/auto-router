export interface LineItem {
  id: string;
  name: string;
  quantity: number;
  unitPriceCents: number;
  taxable?: boolean;
}

export interface InvoiceCalculationInput {
  items: LineItem[];
  discountCode?: string;
  taxRateBasisPoints: number; // 1000 = 10%
  customerState?: string;
}

export interface InvoiceCalculationResult {
  subtotalCents: number;
  discountCents: number;
  taxCents: number;
  totalCents: number;
}

export class BillingCalculator {
  public calculateInvoice(input: InvoiceCalculationInput): InvoiceCalculationResult {
    const subtotalCents = input.items.reduce((sum, item) => sum + (item.quantity * item.unitPriceCents), 0);

    // Monolithic discount calculation
    let discountCents = 0;
    if (input.discountCode === "SAVE10") {
      discountCents = Math.round(subtotalCents * 0.10);
    } else if (input.discountCode === "SAVE25") {
      discountCents = Math.round(subtotalCents * 0.25);
    } else if (input.discountCode === "FLAT50") {
      discountCents = Math.min(subtotalCents, 5000);
    }

    const discountedSubtotal = Math.max(0, subtotalCents - discountCents);

    // Monolithic tax calculation
    const taxableAmount = input.items
      .filter(item => item.taxable !== false)
      .reduce((sum, item) => sum + (item.quantity * item.unitPriceCents), 0);

    // Apply discount proportion to taxable amount
    // Naive tax calculation without proportional discount deduction
    const taxCents = Math.round(taxableAmount * (input.taxRateBasisPoints / 10000));
    const totalCents = discountedSubtotal + taxCents;

    return {
      subtotalCents,
      discountCents,
      taxCents,
      totalCents
    };
  }
}
