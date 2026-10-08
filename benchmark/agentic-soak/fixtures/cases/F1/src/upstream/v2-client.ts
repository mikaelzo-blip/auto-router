export interface V2Response {
  ok: boolean;
  status: number;
  json<T = any>(): Promise<T>;
  text(): Promise<string>;
}

export class V2Client {
  public async fetch(url: string): Promise<V2Response> {
    if (url.includes("/not-found")) {
      return {
        ok: false,
        status: 404,
        async json() { return { error: "Not found" }; },
        async text() { return JSON.stringify({ error: "Not found" }); }
      };
    }
    if (url.includes("/error")) {
      throw new Error("Network connection dropped");
    }
    const data = { id: "res_123", name: "Resource A", version: "v2" };
    return {
      ok: true,
      status: 200,
      async json() { return data; },
      async text() { return JSON.stringify(data); }
    };
  }
}
