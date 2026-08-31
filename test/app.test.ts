import { readFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { resolve } from "node:path";
import {
  afterAll,
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
  await readFile(resolve("config/routes.json"), "utf8")
) as RoutingConfig;

const config: AppConfig = {
  host: "127.0.0.1",
  port: 20200,
  upstreamBaseUrl: "http://127.0.0.1:20128/v1",
  classifierTimeoutMs: 100,
  upstreamTimeoutMs: 100,
  logLevel: "silent",
  routing
};

const app = buildApp(config);

afterAll(() => app.close());
afterEach(() => vi.restoreAllMocks());

describe("API", () => {

  it("serves health", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/health"
    });

    expect(response.json()).toMatchObject({
      status: "ok"
    });
  });

  it("lists all virtual models", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/v1/models"
    });

    const models = response
      .json()
      .data
      .map((m: { id: string }) => m.id);

    expect(models).toEqual([
      "auto",
      "code",
      "analysis",
      "fast",
      "explore",
      "research"
    ]);
  });

  it.each([
    ["auto", "smart-code"],
    ["code", "smart-code"],
    ["analysis", "smart-analysis"],
    ["fast", "fast-chat"],
    ["explore", "explore"],
    ["research", "web-research"]
  ])("reports correct debug model for %s", async (
    model,
    route
  ) => {
    const response = await app.inject({
      method: "POST",
      url: "/debug/route",
      payload: {
        model,
        messages: [{
          role: "user",
          content: "fix this TypeScript error"
        }]
      }
    });

    const json = response.json();

    expect(json.route).toBe(route);
    expect(json.upstreamModel)
      .toBe(routing.routes[route]!.upstreamModel);
  });

  it.each([
    ["code", "smart-code"],
    ["analysis", "smart-analysis"],
    ["fast", "fast-chat"],
    ["explore", "explore"],
    ["research", "web-research"]
  ])("forwards alias %s to its 9Router combo", async (
    model,
    route
  ) => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ choices: [] }),
          {
            status: 200,
            headers: {
              "content-type": "application/json"
            }
          }
        )
      );

    const messages = [{
      role: "user",
      content: "hello"
    }];

    const response = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      payload: {
        model,
        messages,
        stream: false
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["x-auto-router-route"])
      .toBe(route);

    const forwarded = JSON.parse(
      String(fetchMock.mock.calls[0]![1]!.body)
    );

    expect(forwarded.model)
      .toBe(routing.routes[route]!.upstreamModel);

    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it.each([429, 502, 503, 504])(
    "does not perform second-layer fallback after 9Router status %i",
    async (status) => {

      const fetchMock = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              error: { message: "unavailable" }
            }),
            {
              status,
              headers: {
                "content-type": "application/json"
              }
            }
          )
        );

      const response = await app.inject({
        method: "POST",
        url: "/v1/chat/completions",
        payload: {
          model: "auto",
          messages: [{
            role: "user",
            content: "fix this TypeScript error"
          }]
        }
      });

      expect(fetchMock).toHaveBeenCalledOnce();

      const forwarded = JSON.parse(
        String(fetchMock.mock.calls[0]![1]!.body)
      );

      expect(forwarded.model).toBe("ar-code");

      expect(response.statusCode)
        .toBe(status === 429 ? 429 : 502);
    }
  );
  it("forwards vision requests to the 9Router analysis combo", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ choices: [] }),
          {
            status: 200,
            headers: { "content-type": "application/json" }
          }
        )
      );

    const response = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      payload: {
        model: "fast",
        messages: [{
          role: "user",
          content: [{
            type: "image_url",
            image_url: {
              url: "data:image/png;base64,AA=="
            }
          }]
        }]
      }
    });

    expect(response.statusCode).toBe(200);
    expect(fetchMock).toHaveBeenCalledOnce();

    const forwarded = JSON.parse(
      String(fetchMock.mock.calls[0]![1]!.body)
    );

    expect(forwarded.model).toBe("ar-analysis");
  });


  it("does not retry HTTP 400", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            error: { message: "bad request" }
          }),
          {
            status: 400,
            headers: {
              "content-type": "application/json"
            }
          }
        )
      );

    const response = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      payload: {
        model: "auto",
        messages: [{
          role: "user",
          content: "hello"
        }]
      }
    });

    expect(response.statusCode).toBe(400);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("does not retry structured availability error outside combo", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            error: { code: "model_unavailable" }
          }),
          {
            status: 404,
            headers: {
              "content-type": "application/json"
            }
          }
        )
      );

    const response = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      payload: {
        model: "auto",
        messages: [{
          role: "user",
          content: "fix this TypeScript error"
        }]
      }
    });

    expect(response.statusCode).toBe(404);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("rejects malformed body without upstream call", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");

    const response = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      payload: {
        model: "auto"
      }
    });

    expect(response.statusCode).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sanitizes upstream errors", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          error: {
            message:
              "401 http://internal Authorization Bearer secret"
          }
        }),
        {
          status: 400,
          headers: {
            "x-provider": "secret"
          }
        }
      )
    );

    const response = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      payload: {
        model: "auto",
        messages: [{
          role: "user",
          content: "hello"
        }]
      }
    });

    expect(response.body)
      .not.toMatch(/internal|authorization|secret/i);
  });

  it("propagates client cancellation", async () => {
    const cancellation = new Promise<AbortSignal>(
      resolveCancellation => {

        vi.spyOn(globalThis, "fetch")
          .mockImplementation((_url, init) => {
            return new Promise((_resolve, reject) => {

              const signal =
                init?.signal as AbortSignal;

              resolveCancellation(signal);

              signal.addEventListener(
                "abort",
                () => reject(signal.reason),
                { once: true }
              );
            });
          });
      }
    );

    await app.listen({
      host: "127.0.0.1",
      port: 0
    });

    const address = app.server.address();

    if (!address || typeof address === "string") {
      throw new Error("Missing test server address");
    }

    const client = httpRequest({
      host: "127.0.0.1",
      port: address.port,
      path: "/v1/chat/completions",
      method: "POST",
      headers: {
        "content-type": "application/json"
      }
    });

    client.on("error", () => undefined);

    client.end(
      JSON.stringify({
        model: "auto",
        messages: [{
          role: "user",
          content: "hello"
        }]
      })
    );

    const signal = await cancellation;

    client.destroy();

    await vi.waitFor(() =>
      expect(signal.aborted).toBe(true)
    );
  });
});

