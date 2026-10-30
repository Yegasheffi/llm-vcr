# llm-vcr

[English](README.md) · [简体中文](README.zh-CN.md)

[![license: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
[![node >= 18.17](https://img.shields.io/badge/node-%3E%3D18.17-green.svg)](package.json)
[![runtime dependencies: 0](https://img.shields.io/badge/runtime%20dependencies-0-green.svg)](package.json)

**Record & replay any LLM API — in any language, with streaming chunk timing.**

`llm-vcr` is a local HTTP proxy. Point your SDK's base URL at it once. The first run records real model responses into readable JSON cassettes; once a call is recorded, every replay is offline, deterministic, and free — including the timing between SSE chunks.

```text
┌──────────────┐   HTTP    ┌───────────────┐   HTTPS   ┌──────────────────┐
│ your tests   │ ────────▶ │   llm-vcr     │ ────────▶ │  OpenAI / Claude │
│ any language │           │  127.0.0.1    │           │  Gemini / Ollama │
└──────────────┘           └───────┬───────┘           └──────────────────┘
                                   │ record once
                                   ▼
                         cassettes/*.json
                    request + response + timeline
                                   │ replay forever
                                   ▼
                         no network, same bytes,
                         same chunk timing
```

---

## Why

Testing AI features is hard for one reason: **the model returns something different every time.** That makes assertions flaky, CI expensive, and streaming UIs impossible to regression-test.

Existing record/replay tools are usually language-specific libraries. They intercept `fetch` or `requests`, which means they only work in one ecosystem, and most throw away the time between streamed chunks. `llm-vcr` sits at the HTTP boundary instead:

- **Any language, any SDK.** OpenAI, Anthropic, Gemini, Ollama, LangChain, Vercel AI SDK, raw `curl` — if it speaks HTTP, it works.
- **Streaming is first-class.** Every SSE chunk is stored with its millisecond offset. Replay can be instant or real-time.
- **No code changes.** Change one base URL (or let `llm-vcr run` inject it).
- **Cassettes are just JSON.** Review them in a PR, edit them by hand, commit them next to your tests.
- **Fail loudly.** A missing interaction returns a 502 with the closest match and the exact body path that differs.

---

## Quick start

Record your suite once, with a real API key:

```bash
npx llm-vcr-proxy run --mode record -- npm test
```

CI, forever after — no key, no network:

```bash
npx llm-vcr-proxy run --mode replay -- npm test
```

That's it. `run` starts the proxy on a free port, injects `OPENAI_BASE_URL`, `ANTHROPIC_BASE_URL`, `GOOGLE_GEMINI_BASE_URL` and `OLLAMA_HOST`, runs your command, then shuts the proxy down and waits for cassette writes to finish.

### Install

```bash
npm install -D llm-vcr-proxy
npx llm-vcr --version
```

Node 18.17+ is required. There are no runtime dependencies.

Working from a checkout instead? `npm install && npm link` gives you a local `llm-vcr` command, or run `node bin/llm-vcr.js` directly.

> **Name note:** the npm name `llm-vcr` is already used by an independent, Node-only fetch-interceptor library. This project uses the package name **`llm-vcr-proxy`**; the command is still `llm-vcr`, and `npx llm-vcr-proxy` runs it because the package has a single binary.

### Run the proxy yourself

```bash
# terminal 1
npx llm-vcr-proxy --mode record

# terminal 2
OPENAI_BASE_URL=http://127.0.0.1:8484/openai/v1 npm test
```

Once cassettes exist:

```bash
npx llm-vcr-proxy --mode replay
OPENAI_BASE_URL=http://127.0.0.1:8484/openai/v1 npm test
```

### Try it with no API key

```bash
# from the repository root
npm install
npm run demo
```

The demo starts a fake OpenAI endpoint, records a streaming completion, kills the upstream, and replays the same request at 1× speed from `examples/.cassettes`.

### Demo video

An 18.8-second terminal demo rendered from a real run — record a streaming completion, stop the fake upstream, then replay the cassette offline at 1×.

[![llm-vcr demo](demo/llm-vcr-demo-poster.png)](demo/llm-vcr-demo.mp4)

---

## Connect your SDK

Every provider gets a route prefix. The upstream API key in the request is used while recording and is never needed for replay (and is redacted from cassettes).

| Provider | Base URL to use |
|---|---|
| OpenAI | `http://127.0.0.1:8484/openai/v1` |
| Anthropic | `http://127.0.0.1:8484/anthropic` |
| Google Gemini | `http://127.0.0.1:8484/google` |
| Ollama | `http://127.0.0.1:8484/ollama` |
| Groq | `http://127.0.0.1:8484/groq/v1` |
| Mistral | `http://127.0.0.1:8484/mistral/v1` |
| DeepSeek | `http://127.0.0.1:8484/deepseek` |
| OpenRouter | `http://127.0.0.1:8484/openrouter/v1` |
| Together | `http://127.0.0.1:8484/together/v1` |
| xAI | `http://127.0.0.1:8484/xai/v1` |
| Fireworks | `http://127.0.0.1:8484/fireworks/v1` |
| Perplexity | `http://127.0.0.1:8484/perplexity` |
| Cohere | `http://127.0.0.1:8484/cohere` |

The route is stripped before forwarding. For example, `POST /openai/v1/chat/completions` goes to `POST https://api.openai.com/v1/chat/completions`. Paths without a known prefix fall through to the default target (`https://api.openai.com`, or whatever you pass with `--target`).

<details>
<summary>TypeScript / JavaScript</summary>

```ts
import OpenAI from "openai";

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
  baseURL: "http://127.0.0.1:8484/openai/v1",
});

const stream = await client.chat.completions.create({
  model: "gpt-4o-mini",
  stream: true,
  messages: [{ role: "user", content: "Hello" }],
});
```
</details>

<details>
<summary>Python</summary>

```python
from openai import OpenAI

client = OpenAI(
    api_key="sk-...",  # only needed while recording
    base_url="http://127.0.0.1:8484/openai/v1",
)

stream = client.chat.completions.create(
    model="gpt-4o-mini",
    stream=True,
    messages=[{"role": "user", "content": "Hello"}],
)
for chunk in stream:
    print(chunk.choices[0].delta.content or "", end="")
```

No SDK? The standard-library example in [`examples/python_client.py`](examples/python_client.py) streams through the proxy with `http.client`.
</details>

<details>
<summary>curl</summary>

```bash
curl -N http://127.0.0.1:8484/openai/v1/chat/completions \
  -H "authorization: Bearer $OPENAI_API_KEY" \
  -H "content-type: application/json" \
  -d '{"model":"gpt-4o-mini","stream":true,"messages":[{"role":"user","content":"Hello"}]}'
```
</details>

<details>
<summary>Azure OpenAI (custom route)</summary>

```json
{
  "routes": [
    { "prefix": "/azure", "target": "https://my-resource.openai.azure.com" }
  ]
}
```

Point the Azure SDK at `http://127.0.0.1:8484/azure`; deployment paths pass through unchanged.
</details>

---

## Modes

| Mode | What it does | Use it for |
|---|---|---|
| `auto` | Replay if a match exists, record if it doesn't. | Day-to-day development. |
| `record` | Always call upstream; overwrite the Nth existing interaction in place. | Refreshing cassettes. |
| `replay` | Never call upstream. Missing interaction ⇒ HTTP 502. | CI, offline development. |
| `passthrough` | Plain proxy, no recording. | Debugging the proxy itself. |

`record` is an **upsert by occurrence**, not a delete-everything operation. If a test makes three identical requests and you recorded three, re-recording overwrites those three files; it does not create six. Stale interactions are left alone, so delete the cassette (or the directory) when a request disappears from the suite.

Modes can be overridden per request:

```bash
curl ... -H "x-llm-vcr-mode: replay"
curl ... -H "x-llm-vcr-speed: 1"     # 1× timing for this request
```

---

## Streaming, timing, and `--speed`

While recording, each chunk that arrives from upstream is appended to the cassette with `at`: milliseconds since the request began.

```json
"stream": {
  "ttfbMs": 412,
  "durationMs": 2140,
  "chunks": [
    { "at": 412, "data": "data: {\"choices\":[{\"delta\":{\"content\":\"Hel\"}}]}\n\n" },
    { "at": 433, "data": "data: {\"choices\":[{\"delta\":{\"content\":\"lo\"}}]}\n\n" },
    { "at": 2140, "data": "data: [DONE]\n\n" }
  ]
}
```

On replay, the same strings are written back in the same order:

- `--speed 0` (default) writes them as fast as possible. Chunk boundaries are preserved, so stream consumers still see multiple chunks.
- `--speed 1` waits the original `ttfbMs` and inter-chunk delays. Use this to test typing indicators, timeouts, and streaming UIs.
- `--speed 2` replays twice as fast; `0.5` twice as slow.

The recorded timing is wall-clock from the proxy's point of view, including DNS, TLS, and time to first byte. It is not model-internal latency.

> TCP may coalesce chunks on the wire. A client is never guaranteed one read per cassette chunk; that is true of the real API too. The bytes and their timeline are faithful.

---

## Matching

A cassette matches on:

1. HTTP method
2. Upstream origin
3. Path (after the route prefix is stripped)
4. Query string (order-insensitive, duplicate keys preserved)
5. JSON body, with object key order normalized
6. Any headers you opt into with `--match-headers`

**Credentials are always excluded.** `authorization`, `x-api-key`, `api-key`, cookies, and common token headers are replaced with `[REDACTED]` before hashing, so rotating an API key does not invalidate your cassettes.

Multiple identical requests replay in recorded order. A fourth identical call against three recorded interactions is an error in `replay` mode and a new recording in `auto` mode.

### When a request doesn't match

Replay fails with a 502 (and `x-should-retry: false`, so SDKs don't retry) containing the closest match and a body diff:

```text
llm-vcr: no recorded response matches this request.

  POST https://api.openai.com/v1/chat/completions
  cassette dir: ./cassettes (3 interactions)

  closest match: 3f2a1c9b0d-001-post-chat-completions (86% similar)
    body.messages[0].content
      recorded: "Summarize this in one line."
      request:  "Summarize this in two lines."

  Fix: run with `--mode auto` to record this request, or re-record
       with `llm-vcr record` and commit the updated cassettes.
```

### Volatile fields

Some SDKs add request metadata that changes every run. Ignore it in matching (the cassette still stores it):

```bash
llm-vcr --ignore-body metadata.request_id,timestamp
```

Or in config:

```json
{ "ignoreBodyPaths": ["metadata.request_id", "timestamp"] }
```

Paths use dots, `*` wildcards, and array indexes: `messages.*.cache_control`, `messages[0].content`.

Some headers affect the response (for example `anthropic-version` or `openai-beta`). Include them explicitly:

```bash
llm-vcr --match-headers anthropic-version,openai-beta
```

---

## Secrets and privacy

`llm-vcr` is designed for cassettes that live in git:

- Credential headers are always replaced with `[REDACTED]`.
- Secret query parameters (`key`, `api_key`, `token`, `signature`, …) are redacted.
- Values of credential-looking environment variables (`*_API_KEY`, `*_TOKEN`, `*_SECRET`, `*_PASSWORD`) are scrubbed from bodies and headers automatically.
- Add your own:

```bash
llm-vcr --scrub-env MY_CUSTOM_SECRET --scrub-pattern 'sk-[a-zA-Z0-9]{20,}'
```

> Redaction is best-effort. Prompts and completions can contain personal data that no regex will catch. Review cassettes before committing them to a shared repository, and use a private cassette directory when needed.

---

## CI

No provider key is needed in CI. The proxy never opens a socket to the model in `replay` mode.

```yaml
name: test
on: [push, pull_request]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: npm
      - run: npm ci
      - run: npx llm-vcr-proxy run --mode replay -- npm test
```

Some SDKs refuse to initialize without a key; give them a dummy one (`OPENAI_API_KEY=sk-test`). It is never sent anywhere.

A missing cassette fails the suite:

```text
llm-vcr: no recorded response matches this request.
```

To refresh cassettes locally, run the same command with `--mode record` and commit the changed JSON.

### Recommended workflow

1. `llm-vcr run --mode record -- npm test` against the real API.
2. Review `git diff cassettes/`.
3. Commit the cassettes.
4. CI runs `--mode replay`.
5. When a prompt legitimately changes, the test fails with the exact diff; re-record that cassette and commit it.

---

## CLI

```text
llm-vcr [serve] [options]             start the proxy
llm-vcr run -- <command> [args...]    start proxy, inject SDK env, run command
llm-vcr record [options]              start proxy in record mode
llm-vcr replay [options]              start proxy in replay mode
llm-vcr ls [--json]                   list cassettes
llm-vcr rm <id...> | --all --yes      delete cassettes
llm-vcr routes                        show routes
llm-vcr init                          write llm-vcr.config.json
```

| Option | Description |
|---|---|
| `-c, --cassette <dir>` | Cassette directory (default `./cassettes`). |
| `--config <file>` | Config file (default: nearest `llm-vcr.config.json`). |
| `--mode <mode>` | `auto`, `record`, `replay`, `passthrough`. |
| `--port <port>` | Default `8484`; `run` uses a free port unless set. |
| `--host <host>` | Default `127.0.0.1`. |
| `--target <url>` | Upstream for paths without a named route. |
| `--provider <name>` | Make a known provider the default target. |
| `--route <prefix=url>` | Add/override a route; repeatable. |
| `--speed <n>` | Replay speed: `0` instant, `1` real time. |
| `--match-headers <a,b>` | Headers that participate in matching. |
| `--ignore-body <a,b>` | JSON body paths ignored when matching. |
| `--scrub-env <VAR>` | Extra env var to scrub; repeatable. |
| `--scrub-pattern <re>` | Extra regex to scrub; repeatable. |
| `--cors` | Add CORS headers (browser clients). |
| `--no-env` | Don't inject SDK env vars in `run`. |
| `--json` | JSON output for `ls`. |
| `--all --yes` | Delete every cassette with `rm`. |
| `--force` | Overwrite an existing config with `init`. |
| `-q, --quiet` | Only warnings and errors. |
| `-v, --verbose` | More detail. |
| `--no-color` | Disable ANSI colors. |
| `-h, --help` | Show help. |
| `-V, --version` | Show version. |

`llm-vcr ls` prints a table with the id, method, path, status, stream chunk count, model, size, and age. `--json` gives the same data for scripts.

`llm-vcr rm` accepts exact ids (copy from `ls`), unique id prefixes, or hash prefixes. Deleting every cassette requires `--all --yes`.

---

## Configuration

Create `llm-vcr.config.json` in your repo (or run `llm-vcr init`). Relative `cassetteDir` paths resolve from the config file's directory, which makes monorepos work.

```json
{
  "cassetteDir": "./cassettes",
  "mode": "auto",
  "port": 8484,
  "speed": 0,
  "matchHeaders": ["anthropic-version"],
  "ignoreBodyPaths": ["metadata.request_id"],
  "maxBodyBytes": 104857600,
  "cors": false,
  "scrub": {
    "env": ["MY_CUSTOM_SECRET"],
    "patterns": ["sk-[a-zA-Z0-9]{20,}"],
    "autoScrubEnv": true
  },
  "routes": [
    { "prefix": "/openai", "target": "https://api.openai.com" },
    {
      "prefix": "/local",
      "target": "http://127.0.0.1:11434",
      "env": { "MY_LOCAL_BASE_URL": "/v1" }
    }
  ]
}
```

Routes are matched by longest prefix. `/` is the fallback. The built-in provider routes are always available; config entries with the same prefix override them.

`env` on a route is used by `llm-vcr run` to inject environment variables. The value is appended to the local proxy URL, so `{ "OPENAI_BASE_URL": "/v1" }` becomes `http://127.0.0.1:<port>/openai/v1`.

Environment variables: `LLM_VCR_MODE`, `LLM_VCR_CASSETTE_DIR`, `LLM_VCR_PORT`, `LLM_VCR_HOST`, `LLM_VCR_SPEED`, `LLM_VCR_TARGET`, `LLM_VCR_CONFIG`, `NO_COLOR`.

---

## Cassette format

One JSON file per interaction, named `<hash12>-<seq>-<slug>.json`.

```json
{
  "format": "llm-vcr/1",
  "meta": {
    "id": "3f2a1c9b0d-001-post-chat-completions",
    "hash": "3f2a1c9b0d…",
    "seq": 1,
    "createdAt": "2026-01-14T09:31:02.118Z",
    "provider": "openai",
    "route": "/openai",
    "status": 200,
    "model": "gpt-4o-mini",
    "stream": true,
    "chunks": 42,
    "ttfbMs": 412,
    "durationMs": 2140,
    "upstream": "https://api.openai.com/v1/chat/completions"
  },
  "request": {
    "method": "POST",
    "path": "/v1/chat/completions",
    "headers": { "authorization": "[REDACTED]", "content-type": "application/json" },
    "body": { "model": "gpt-4o-mini", "stream": true, "messages": [] },
    "bodyType": "json"
  },
  "response": {
    "status": 200,
    "headers": { "content-type": "text/event-stream" },
    "body": null,
    "bodyType": "empty",
    "stream": {
      "ttfbMs": 412,
      "durationMs": 2140,
      "chunks": [{ "at": 412, "data": "data: {...}\n\n" }]
    }
  }
}
```

JSON bodies are stored parsed so diffs are readable and are re-serialized on replay. SSE chunks are stored as raw strings and replayed byte-for-byte (after secret redaction). Non-JSON text is stored as UTF-8; binary responses are base64.

See [docs/cassette-format.md](docs/cassette-format.md) for the full schema and matching algorithm.

---

## Library API

The CLI is a thin wrapper over the same primitives.

```js
import { createProxy, buildConfig } from "llm-vcr-proxy";

const config = buildConfig({
  command: "serve",
  cassette: "./cassettes",
  mode: "replay",
  port: "0",
  route: ["/openai=https://api.openai.com"],
});

const proxy = await createProxy(config);
console.log(proxy.url); // http://127.0.0.1:54321

// ... point your SDK at `${proxy.url}/openai/v1` ...

await proxy.close();
```

```ts
import {
  buildConfig,
  buildSignature,
  createProxy,
  CassetteStore,
  createScrubber,
} from "llm-vcr-proxy";
```

`createProxy` returns `{ server, port, url, store, config, counters, stats(), flush(), close() }`. `flush()` waits for cassette writes that were scheduled after a response completed.

---

## How it compares

| | Language-agnostic | Streaming timing | Reads cassettes in git | No SDK patch |
|---|---|---|---|---|
| **llm-vcr** | ✅ HTTP proxy | ✅ chunk timeline | ✅ JSON | ✅ |
| vcrpy / pytest-recording | ❌ Python | partial | ✅ | ❌ |
| Polly.js | ❌ JS | partial | ✅ | ❌ |
| `llm-vcr` (npm fetch interceptor) | ❌ Node | ❌ | ✅ | ✅ |
| WireMock / MockServer | ✅ | request-level only | ✅ | ✅ but you write stubs |

`llm-vcr` is deliberately not a mock server. You don't describe what the model should say; you record what it actually said once, then replay it.

---

## Limitations

- **It is a reverse proxy, not an HTTPS MITM proxy.** Point SDK base URLs at it; `HTTPS_PROXY` alone won't work because that would require a trusted certificate. This is the tradeoff that keeps setup to one line.
- HTTP/1.1 upstream only. All major LLM APIs support it.
- JSON response bodies are normalized (parsed and re-serialized). SSE bytes are exact after secret redaction. If you need byte-identical JSON formatting, store it as text via a custom route or assert on parsed JSON.
- WebSocket upgrades are rejected with 426.
- Cassettes can be large for image/audio payloads (base64). `maxBodyBytes` defaults to 100 MB.
- Redaction is best-effort; prompts can contain PII.
- Identical concurrent requests are recorded with a per-hash write lock, but replay cursors are intentionally sequential.

---

## Roadmap

- **Team cassette registry** — shared library, pull/push cassettes from CI, review diffs in a UI.
- Per-test cassette scoping for parallel test runners.
- `llm-vcr inspect` — local HTML timeline viewer.
- OpenTelemetry spans for every replayed interaction.
- Request/response transforms for scrubbing complex payloads.

The core is MIT-licensed and dependency-free. The hosted registry is how the project can stay funded.

---

## Development

```bash
npm install       # or pnpm install
npm test          # node:test, no network
npm run typecheck
npm run demo      # fake upstream, record + replay
```

Node 18.17+ is required. Runtime dependencies: none.

---

## Contributing

Contributions are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for setup, tests, cassette rules, and the PR checklist. Please report security issues privately according to [SECURITY.md](SECURITY.md).

## License

MIT
