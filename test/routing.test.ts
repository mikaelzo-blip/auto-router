import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { inspectRequirements, routeRequest } from "../src/router.js";
import type { ChatCompletionRequest, RoutingConfig } from "../src/types.js";

const config = JSON.parse(
  await readFile(resolve("config/routes.json"), "utf8")
) as RoutingConfig;

const request = (
  content: unknown,
  extra: Partial<ChatCompletionRequest> = {}
): ChatCompletionRequest => ({
  model: "auto",
  messages: [{ role: "user", content }],
  ...extra
});

describe("deterministic semantic routing", () => {

  it.each([
    ["smart-code", "ar-code"],
    ["smart-analysis", "ar-analysis"],
    ["smart-main", "ar-analysis"],
    ["fast-chat", "ar-fast"],
    ["web-research", "ar-research"],
    ["explore", "ar-research"]
  ])("maps route %s to 9Router combo %s", (route, combo) => {
    expect(config.routes[route]!.upstreamModel).toBe(combo);
    expect(config.routes[route]!.selectionPriority).toEqual([combo]);
  });

  it.each([
    ["fix this TypeScript error", "smart-code"],
    ["find the latest AI news today", "web-research"],
    ["analyze this financial statement", "smart-analysis"],
    ["compare two business strategies deeply", "smart-main"],
    ["explain what EBITDA means", "fast-chat"]
  ])("routes %s through %s", async (prompt, expectedRoute) => {
    const result = await routeRequest(request(prompt), config);

    expect(result.route).toBe(expectedRoute);
    expect(result.upstreamModel)
      .toBe(config.routes[expectedRoute]!.upstreamModel);
  });

  it.each([
    ["cari berita AI paling penting hari ini", "web-research", "high"],
    ["berapa harga bitcoin hari ini", "web-research", "high"],
    ["versi node.js terbaru apa", "web-research", "high"],
    ["jelaskan apa itu berita", "fast-chat", "high"],
    ["apa itu harga pokok penjualan", "fast-chat", "medium"],
    ["analisis laporan keuangan perusahaan ini", "smart-analysis", "high"],
    ["cek rekening koran dan rekonsiliasi transaksi", "smart-analysis", "high"],
    ["tolong perbaiki error typescript ini", "smart-code", "high"],
    ["bandingkan dua strategi bisnis ini secara mendalam", "smart-main", "high"],
    ["buat analisis risiko proyek ini secara mendalam", "smart-main", "high"],
    ["apa bedanya omzet dan laba", "fast-chat", "medium"],
    ["terjemahkan kalimat ini ke bahasa inggris", "fast-chat", "medium"]
  ])("routes Indonesian prompt %s to %s", async (
    prompt,
    expectedRoute,
    confidence
  ) => {
    const result = await routeRequest(request(prompt), config);

    expect(result.route).toBe(expectedRoute);
    expect(result.confidence).toBe(confidence);
    expect(result.classifierUsed).toBe(false);
  });

  it("handles Indonesian punctuation and case", async () => {
    const result = await routeRequest(
      request("BERAPA harga Bitcoin, hari ini?"),
      config
    );

    expect(result.route).toBe("web-research");
    expect(result.confidence).toBe("high");
  });

  it("forces image input onto vision route", async () => {
    const result = await routeRequest(
      request([
        { type: "text", text: "explain this" },
        {
          type: "image_url",
          image_url: { url: "data:image/png;base64,AA==" }
        }
      ]),
      config
    );

    expect(result.route).toBe("vision");
    expect(result.requirements.vision).toBe(true);
    expect(config.routes[result.route]!.capabilities.vision).toBe(true);
  });

  it("delegates research fallback to one 9Router combo", () => {
    expect(
      config.routes["web-research"]!.selectionPriority
    ).toEqual(["ar-research"]);
  });

  it.each([
    ["code", "smart-code"],
    ["analysis", "smart-analysis"],
    ["fast", "fast-chat"],
    ["explore", "explore"],
    ["research", "web-research"]
  ])("bypasses semantic routing for alias %s", async (
    model,
    route
  ) => {
    const result = await routeRequest(
      {
        ...request("latest news about a TypeScript error"),
        model
      },
      config,
      {
        classify: async () => {
          throw new Error("classifier must not run");
        }
      }
    );

    expect(result).toMatchObject({
      requestedVirtualModel: model,
      route,
      upstreamModel: config.routes[route]!.upstreamModel,
      classifierUsed: false,
      semanticClassificationBypassed: true
    });
  });

  it("forces tools onto a tool-capable route", async () => {
    const result = await routeRequest(
      request("what is the weather?", {
        tools: [
          {
            type: "function",
            function: { name: "weather" }
          }
        ]
      }),
      config
    );

    expect(config.routes[result.route]!.capabilities.tools)
      .toBe(true);
  });

  it("moves capability-incompatible fast alias to vision", async () => {
    const result = await routeRequest(
      {
        ...request(
          [{
            type: "image_url",
            image_url: { url: "data:image/png;base64,AA==" }
          }],
          { tools: [{}] }
        ),
        model: "fast"
      },
      config
    );

    expect(result.route).toBe("vision");
    expect(result.semanticClassificationBypassed).toBe(true);
  });

  it("recognizes legacy functions", () => {
    expect(
      inspectRequirements(request([]).messages, undefined, [{}])
    ).toEqual({
      vision: false,
      tools: true
    });
  });
});
