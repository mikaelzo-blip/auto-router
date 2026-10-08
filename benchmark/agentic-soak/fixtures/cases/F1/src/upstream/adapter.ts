import { V1Client } from "./v1-client.js";
import { V2Client } from "./v2-client.js";

export class UpstreamAdapter {
  // Outdated: still initialized with legacy V1Client
  private readonly client = new V1Client();

  public async getResource(resourceId: string): Promise<any> {
    // Legacy broken implementation relying on callback adapter
    return new Promise((resolve, reject) => {
      this.client.fetchCallback(`/resources/${resourceId}`, (err, res) => {
        if (err) return reject(err);
        if (!res || res.status !== 200) {
          return reject(new Error(`Upstream returned ${res?.status || 500}`));
        }
        try {
          resolve(JSON.parse(res.body));
        } catch (parseErr) {
          reject(parseErr);
        }
      });
    });
  }
}
