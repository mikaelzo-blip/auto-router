# AutoRouter

AutoRouter is a localhost-only, OpenAI-compatible semantic router. Clients send requests to the virtual model `auto`; deterministic rules select a configured 9Router model. For upstream 429, 502, 503, and 504 responses, AutoRouter retries once with the configured global fallback model.

> 🇮🇩 **Panduan penggunaan Bahasa Indonesia:** lihat [`TUTORIAL-ID.md`](TUTORIAL-ID.md) untuk tutorial lengkap Open WebUI, OpenCode, n8n, routing, troubleshooting, dan keamanan.

## Requirements and setup

- Ubuntu 24.04 / WSL2
- Node.js 24+
- 9Router at `http://127.0.0.1:20128/v1`

```bash
./scripts/setup.sh
cp .env.example .env        # optional; never put secrets in source control
# Edit .env and set UPSTREAM_API_KEY only if 9Router requires it.
./scripts/start.sh
```

The server listens only on `127.0.0.1:20200`. Stop a foreground server with `Ctrl+C`.

For a background process:

```bash
npm start > auto-router.log 2>&1 & echo $! > auto-router.pid
kill "$(cat auto-router.pid)" && rm auto-router.pid
```

## Endpoints

- `GET /health`
- `GET /v1/models`
- `POST /v1/chat/completions`
- `POST /debug/route` (same body as chat completions; performs no model call)

Example:

```bash
curl -s http://127.0.0.1:20200/debug/route \
  -H 'content-type: application/json' \
  -d '{"model":"auto","messages":[{"role":"user","content":"fix this TypeScript error"}]}'
```

Configure Open WebUI, n8n, or OpenCode with base URL `http://127.0.0.1:20200/v1` and model `auto`. If the client requires a key, any placeholder can be supplied; AutoRouter does not authenticate local callers. The real upstream key is read only from `UPSTREAM_API_KEY`.

## Routing configuration

Edit [`config/routes.json`](config/routes.json) to change keywords, upstream model mappings, route order, fallbacks, or vision/tool capabilities. Restart after changes. Deterministic unique keyword matches win. If signals tie or no signal exists, `CLASSIFIER_MODEL` may resolve the ambiguity; when unset or unavailable, routing uses the configured deterministic fallback.

Each route records its verified `upstreamModel` and the probe order in `selectionPriority`. `globalFallbackModel` is the emergency upstream used for configured transient statuses, network failures, and configured structured model/provider availability errors. HTTP 400 responses are never retried.

Image content is restricted to routes marked `vision: true`. Requests with `tools` or legacy `functions` are restricted to routes marked `tools: true`. All OpenAI request fields are forwarded unchanged except `model`, which becomes the selected upstream model. Streaming responses are passed through as SSE where practical.

## Development

```bash
npm test
npm run build
npm run dev
./scripts/health-check.sh
```

Prompt bodies, tools, functions, and authorization headers are redacted from logs. Upstream errors are bounded and credential-like values are redacted before returning them to clients.
