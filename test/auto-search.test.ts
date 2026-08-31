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

describe("automatic grounded research", () => {

  it("grounds auto web-research through search", async () => {

    const fetchMock =
      vi.spyOn(globalThis, "fetch")
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              provider: "antigravity",
              answer: {
                text: "Grounded AI answer"
              },
              results: [{
                title: "Example",
                url: "https://example.com",
                position: 1
              }]
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
        url: "/v1/chat/completions",
        payload: {
          model: "auto",
          stream: false,
          messages: [{
            role: "user",
            content:
              "cari berita AI terbaru hari ini"
          }]
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
        "x-auto-router-grounded"
      ]
    ).toBe("true");

    expect(fetchMock)
      .toHaveBeenCalledOnce();

    expect(
      String(fetchMock.mock.calls[0]![0])
    ).toContain("/search");

    const body = response.json();

    expect(
      body.choices[0].message.content
    ).toContain(
      "Grounded AI answer"
    );

    expect(
      body.choices[0].message.content
    ).toContain(
      "https://example.com"
    );

    await app.close();
  });
});
