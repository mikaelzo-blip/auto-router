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

describe("Responses API", () => {

  it("routes coding input to ar-code", async () => {

    const fetchMock =
      vi.spyOn(globalThis, "fetch")
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              id: "resp_test",
              object: "response",
              status: "completed",
              output: []
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
        url: "/v1/responses",
        payload: {
          model: "auto",
          input:
            "Fix this TypeScript error",
          stream: false
        }
      });

    expect(response.statusCode).toBe(200);

    expect(
      response.headers[
        "x-auto-router-route"
      ]
    ).toBe("smart-code");

    expect(
      response.headers[
        "x-auto-router-model"
      ]
    ).toBe("ar-code");

    const [url, init] =
      fetchMock.mock.calls[0]!;

    expect(String(url))
      .toContain("/responses");

    const forwarded =
      JSON.parse(
        String(init!.body)
      );

    expect(forwarded.model)
      .toBe("ar-code");

    expect(forwarded.input)
      .toBe(
        "Fix this TypeScript error"
      );

    await app.close();
  });

  it("routes image input to vision", async () => {

    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: "resp_vision",
            object: "response",
            status: "completed",
            output: []
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
        url: "/v1/responses",
        payload: {
          model: "auto",
          input: [{
            type: "message",
            role: "user",
            content: [
              {
                type: "input_text",
                text:
                  "Jelaskan gambar ini"
              },
              {
                type: "input_image",
                image_url:
                  "data:image/png;base64,AA=="
              }
            ]
          }]
        }
      });

    expect(response.statusCode).toBe(200);

    expect(
      response.headers[
        "x-auto-router-route"
      ]
    ).toBe("vision");

    expect(
      response.headers[
        "x-auto-router-model"
      ]
    ).toBe("ar-analysis");

    await app.close();
  });

  it("supports explicit code alias", async () => {

    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            object: "response",
            output: []
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
        url: "/v1/responses",
        payload: {
          model: "code",
          input: "hello"
        }
      });

    expect(
      response.headers[
        "x-auto-router-route"
      ]
    ).toBe("smart-code");

    expect(
      response.headers[
        "x-auto-router-model"
      ]
    ).toBe("ar-code");

    await app.close();
  });

  it("rejects unknown virtual model", async () => {

    const fetchMock =
      vi.spyOn(globalThis, "fetch");

    const app = buildApp(config);

    const response =
      await app.inject({
        method: "POST",
        url: "/v1/responses",
        payload: {
          model: "does-not-exist",
          input: "hello"
        }
      });

    expect(response.statusCode).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();

    await app.close();
  });
});
