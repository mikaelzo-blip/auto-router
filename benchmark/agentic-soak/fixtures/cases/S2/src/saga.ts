export interface Order {
  id: string;
  sku: string;
  quantity: number;
  amountCents: number;
  status: "PENDING" | "CONFIRMED" | "CANCELLED";
}

export class FulfillmentSaga {
  public inventory: Map<string, number> = new Map();
  public payments: Map<string, number> = new Map();
  public deliveryDispatches: Set<string> = new Set();

  constructor() {
    this.inventory.set("widget_pro", 10);
  }

  public async execute(order: Order): Promise<{ success: boolean; error?: string }> {
    // Step 1: Reserve Inventory
    const stock = this.inventory.get(order.sku) ?? 0;
    if (stock < order.quantity) {
      order.status = "CANCELLED";
      return { success: false, error: "OUT_OF_STOCK" };
    }
    this.inventory.set(order.sku, stock - order.quantity);

    // Step 2: Charge Payment (simulated failure for test card 9999)
    if (order.amountCents === 9999) {
      // FLAW: Does NOT compensate inventory reservation!
      order.status = "CANCELLED";
      return { success: false, error: "PAYMENT_DECLINED" };
    }
    this.payments.set(order.id, order.amountCents);

    // Step 3: Dispatch Delivery (simulated failure for remote zip 00000)
    if (order.id.endsWith("_remote")) {
      // FLAW: Does NOT compensate payment or inventory!
      order.status = "CANCELLED";
      return { success: false, error: "DELIVERY_UNAVAILABLE" };
    }
    this.deliveryDispatches.add(order.id);

    order.status = "CONFIRMED";
    return { success: true };
  }
}
