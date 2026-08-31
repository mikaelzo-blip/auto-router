import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  afterEach,
  describe,
  expect,
  it,
  vi
} from "vitest";

import { buildApp } from "../src/app.js";

import type { AppConfig } from "../src/config.js";
import type { RoutingConfig } from "../src/types.js";

const routing = JSON.parse(
  await readFile(
    resolve("config/routes.json"),
    "utf8"
  )
) as RoutingConfig;

const config: AppConfig = {
  host: "127.0.0.1",
  port: 20200,
  upstreamBaseUrl:
    "http://127.0.0.1:20128/v1",
  classifierTimeoutMs: 100,
  upstreamTimeoutMs: 1000,
  logLevel: "silent",
  routing
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("native search API", () => {

  it("forwards search to Antigravity", async () => {

    const fetchMock =
      vi.spyOn(globalThis, "fetch")
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              provider: "antigravity",
              query: "AI terbaru",
              results: [{
                title: "Example",
                url: "https://example.com",
                position: 1
              }],
              answer: {
                source: "antigravity",
                text: "example answer",
                model: "gemini"
              }
            }),
            {
              status: 200,
              headers: {
                "content-type":
                  "application/json"
              }
            }
          )
        );

    const app = buildApp(config);

    const response =
      await app.inject({
        method: "POST",
        url: "/v1/search",
        payload: {
          query: "AI terbaru",
          max_results: 5
        }
      });

    expect(response.statusCode).toBe(200);

    expect(
      response.headers[
        "x-auto-router-route"
      ]
    ).toBe("web-research");

    expect(
      response.headers[
        "x-auto-router-search-provider"
      ]
    ).toBe("antigravity");

    const [url, init] =
      fetchMock.mock.calls[0]!;

    expect(String(url))
      .toContain("/search");

    const forwarded =
      JSON.parse(
        String(init!.body)
      );

    expect(forwarded.provider)
      .toBe("antigravity");

    expect(forwarded.query)
      .toBe("AI terbaru");

    await app.close();
  });

  it("rejects empty query before upstream", async () => {

    const fetchMock =
      vi.spyOn(globalThis, "fetch");

    const app = buildApp(config);

    const response =
      await app.inject({
        method: "POST",
        url: "/v1/search",
        payload: {
          query: ""
        }
      });

    expect(response.statusCode).toBe(400);

    expect(fetchMock)
      .not.toHaveBeenCalled();

    await app.close();
  });
});
