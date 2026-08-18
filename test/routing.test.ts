import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { inspectRequirements, routeRequest } from "../src/router.js";
import type { ChatCompletionRequest, RoutingConfig } from "../src/types.js";

const config = JSON.parse(await readFile(resolve("config/routes.json"), "utf8")) as RoutingConfig;
const request = (content: unknown, extra: Partial<ChatCompletionRequest> = {}): ChatCompletionRequest => ({ model: "auto", messages: [{ role: "user", content }], ...extra });

describe("deterministic semantic routing", () => {
  it.each([
    ["smart-code", "cx/gpt-5.6-sol"],
    ["smart-analysis", "cx/gpt-5.6-sol"],
    ["smart-main", "cx/gpt-5.6-sol"],
    ["fast-chat", "cx/gpt-5.6-luna"],
    ["web-research", "ag/gemini-3.6-flash-high"]
  ])("maps route %s to selected upstream %s", (route, model) => {
    expect(config.routes[route]!.upstreamModel).toBe(model);
  });

  it.each([
    ["fix this TypeScript error", "smart-code", "cx/gpt-5.6-sol"],
    ["find the latest AI news today", "web-research", "ag/gemini-3.6-flash-high"],
    ["analyze this financial statement", "smart-analysis", "cx/gpt-5.6-sol"],
    ["compare two business strategies deeply", "smart-main", "cx/gpt-5.6-sol"],
    ["explain what EBITDA means", "fast-chat", "cx/gpt-5.6-luna"]
  ])("routes %s through %s to %s", async (prompt, expectedRoute, expectedModel) => {
    const result = await routeRequest(request(prompt), config);
    expect(result.route).toBe(expectedRoute);
    expect(result.upstreamModel).toBe(expectedModel);
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
  ])("routes Indonesian prompt %s to %s", async (prompt, expectedRoute, confidence) => {
    const result = await routeRequest(request(prompt), config);
    expect(result.route).toBe(expectedRoute);
    expect(result.confidence).toBe(confidence);
    expect(result.classifierUsed).toBe(false);
  });

  it("handles Indonesian punctuation and case", async () => {
    const result = await routeRequest(request("BERAPA harga Bitcoin, hari ini?"), config);
    expect(result.route).toBe("web-research");
    expect(result.confidence).toBe("high");
  });

  it("forces image input onto a vision-capable route", async () => {
    const result = await routeRequest(request([{ type: "text", text: "explain this" }, { type: "image_url", image_url: { url: "data:image/png;base64,AA==" } }]), config);
    expect(config.routes[result.route]!.capabilities.vision).toBe(true);
    expect(result.requirements.vision).toBe(true);
    expect(result.route).toBe("vision");
    expect(result.upstreamModel).toBe("gemini/gemini-3.7-flash");
  });

  it("configures the ordered web fallback chain", () => {
    expect(config.routes["web-research"]!.selectionPriority).toEqual([
      "ag/gemini-3.6-flash-high",
      "cx/gpt-5.6-sol",
      "free-coding"
    ]);
  });

  it.each([
    ["code", "smart-code", "cx/gpt-5.6-sol"],
    ["analysis", "smart-analysis", "cx/gpt-5.6-sol"],
    ["fast", "fast-chat", "cx/gpt-5.6-luna"],
    ["explore", "explore", "ag/gemini-3.6-flash-high"],
    ["research", "web-research", "ag/gemini-3.6-flash-high"]
  ])("bypasses semantic routing for alias %s", async (model, route, upstreamModel) => {
    const result = await routeRequest({ ...request("latest news about a TypeScript error"), model }, config, {
      classify: async () => { throw new Error("classifier must not run"); }
    });
    expect(result).toMatchObject({ requestedVirtualModel: model, route, upstreamModel, classifierUsed: false, semanticClassificationBypassed: true });
  });

  it("forces tools onto a tool-capable route", async () => {
    const result = await routeRequest(request("what is the weather?", { tools: [{ type: "function", function: { name: "weather" } }] }), config);
    expect(config.routes[result.route]!.capabilities.tools).toBe(true);
  });

  it.each(["fast"])("moves capability-incompatible alias %s to a compatible route", async (model) => {
    const result = await routeRequest({ ...request([{ type: "image_url", image_url: { url: "data:image/png;base64,AA==" } }], { tools: [{}] }), model }, config);
    expect(result.route).toBe("vision");
    expect(config.routes[result.route]!.capabilities).toEqual({ vision: true, tools: true });
    expect(result.semanticClassificationBypassed).toBe(true);
  });

  it("recognizes legacy functions and image input", () => {
    expect(inspectRequirements(request([]).messages, undefined, [{}])).toEqual({ vision: false, tools: true });
  });
});
