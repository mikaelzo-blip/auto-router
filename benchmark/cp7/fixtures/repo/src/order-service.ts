import type { OrderItem, OrderDiscount, OrderCalculationResult } from "./types.js";

export class OrderService {
  calculate(items: OrderItem[], discount?: OrderDiscount): OrderCalculationResult {
    if (!items || items.length === 0) {
      return {
        subtotalCents: 0,
        discountCents: 0,
        taxCents: 0,
        totalCents: 0,
        itemCount: 0
      };
    }

    let subtotalCents = 0;
    let itemCount = 0;

    for (const item of items) {
      if (item.quantity <= 0 || item.unitPriceCents < 0) {
        throw new Error(`Invalid item quantity or price for item ${item.id}`);
      }
      subtotalCents += item.unitPriceCents * item.quantity;
      itemCount += item.quantity;
    }

    // Discount calculation
    let discountCents = 0;
    if (discount) {
      if (discount.type === "percentage") {
        const pct = Math.max(0, Math.min(100, discount.value));
        discountCents = Math.round((subtotalCents * pct) / 100);
      } else if (discount.type === "fixed_cents") {
        discountCents = Math.min(subtotalCents, Math.max(0, discount.value));
      }
    }

    const discountedSubtotal = Math.max(0, subtotalCents - discountCents);

    // Tax calculation per category rate
    // Food: 0%, Clothing: 5%, Electronics: 15%, General: 10%
    let taxCents = 0;
    const discountRatio = subtotalCents > 0 ? discountedSubtotal / subtotalCents : 1;

    for (const item of items) {
      const itemSubtotal = item.unitPriceCents * item.quantity * discountRatio;
      let rate = 0.10; // general
      if (item.category === "food") rate = 0;
      else if (item.category === "clothing") rate = 0.05;
      else if (item.category === "electronics") rate = 0.15;

      taxCents += Math.round(itemSubtotal * rate);
    }

    const totalCents = discountedSubtotal + taxCents;

    return {
      subtotalCents,
      discountCents,
      taxCents,
      totalCents,
      itemCount
    };
  }
}
