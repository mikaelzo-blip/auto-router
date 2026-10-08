export class V1Client {
  public fetchCallback(
    url: string,
    callback: (err: Error | null, res?: { status: number; body: string }) => void
  ): void {
    if (url.includes("/not-found")) {
      callback(null, { status: 404, body: JSON.stringify({ error: "Not found" }) });
      return;
    }
    if (url.includes("/error")) {
      callback(new Error("Network connection dropped"));
      return;
    }
    callback(null, { status: 200, body: JSON.stringify({ id: "res_123", name: "Resource A" }) });
  }
}
