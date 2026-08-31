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

function config(): AppConfig {
  return {
    host: "127.0.0.1",
    port: 20200,
    upstreamBaseUrl:
      "http://127.0.0.1:20128/v1",
    classifierTimeoutMs: 100,
    upstreamTimeoutMs: 1000,
    logLevel: "silent",
    routing
  };
}

function requiredModels(): string[] {

  return [
    ...new Set(
      Object.values(routing.routes)
        .flatMap((route) =>
          route.selectionPriority?.length
            ? route.selectionPriority
            : [
                route.upstreamModel,
                routing.globalFallbackModel
              ]
        )
    )
  ];
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("health and metrics", () => {

  it("reports liveness", async () => {

    const app = buildApp(config());

    const response =
      await app.inject({
        method: "GET",
        url: "/health"
      });

    expect(response.statusCode).toBe(200);

    expect(response.json()).toMatchObject({
      status: "ok",
      service: "auto-router"
    });

    await app.close();
  });

  it("reports ready when all configured upstreams exist", async () => {

    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            object: "list",
            data: requiredModels().map(
              (id) => ({ id })
            )
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

    const app = buildApp(config());

    const response =
      await app.inject({
        method: "GET",
        url: "/health/ready"
      });

    expect(response.statusCode).toBe(200);

    expect(response.json()).toMatchObject({
      status: "ready",
      upstream: "ok",
      missingModels: []
    });

    await app.close();
  });

  it("reports not-ready when an upstream disappears", async () => {

    const all = requiredModels();

    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            object: "list",
            data: all
              .slice(1)
              .map((id) => ({ id }))
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

    const app = buildApp(config());

    const response =
      await app.inject({
        method: "GET",
        url: "/health/ready"
      });

    expect(response.statusCode).toBe(503);

    expect(
      response.json().missingModels.length
    ).toBeGreaterThan(0);

    await app.close();
  });

  it("exposes local metrics without upstream request", async () => {

    const fetchMock =
      vi.spyOn(globalThis, "fetch");

    const app = buildApp(config());

    const response =
      await app.inject({
        method: "GET",
        url: "/metrics"
      });

    expect(response.statusCode).toBe(200);

    expect(response.json()).toMatchObject({
      service: "auto-router",
      mode: "production",
      requests: {
        total: 0
      }
    });

    expect(fetchMock).not.toHaveBeenCalled();

    await app.close();
  });
});
