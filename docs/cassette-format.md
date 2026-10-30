# Cassette format (`llm-vcr/1`)

A cassette directory contains one JSON file per interaction. There is no index file: `llm-vcr` scans the directory at startup, groups files by `meta.hash`, and orders each group by `meta.seq`.

```text
cassettes/
  3f2a1c9b0d-001-post-chat-completions.json
  3f2a1c9b0d-002-post-chat-completions.json
  a81c02fe44-001-post-messages.json
```

Filenames are `<first 12 chars of hash>-<seq>-<slug>.json`. The slug is derived from the method and the last two path segments and is only for humans; matching never uses filenames.

## Top-level shape

```json
{
  "format": "llm-vcr/1",
  "meta": {},
  "request": {},
  "response": {}
}
```

`format` is required. Files with a different format are ignored with a warning, so a future format can coexist in the same directory.

## `meta`

| Field | Type | Description |
|---|---|---|
| `id` | string | Stable id: hash prefix + sequence + slug. Used by `llm-vcr ls` and `rm`. |
| `hash` | string | Full SHA-256 of the canonical request signature. |
| `seq` | number | 1-based occurrence number for this hash. Replay order is ascending. |
| `createdAt` | ISO string | When this interaction was first recorded. Preserved on re-record so diffs stay small, so it is not an "updated at" timestamp. |
| `provider` | string | Route provider label (`openai`, `anthropic`, or a custom prefix). |
| `route` | string | Local route prefix (`/openai`). |
| `method` | string | HTTP method. |
| `status` | number | Upstream status code. |
| `model` | string? | Best-effort model from the request body, then the response body. |
| `stream` | boolean | Whether the response was recorded as an SSE-like stream. |
| `chunks` | number | Number of recorded chunks. |
| `ttfbMs` | number? | Time to first byte, in milliseconds from request start. |
| `durationMs` | number | Total request duration. |
| `requestBytes` | number | Raw request body size. |
| `responseBytes` | number | Decoded response body size. |
| `upstream` | string | Redacted upstream URL, including query. |
| `clientAborted` | boolean? | Present if the client disconnected mid-stream. The cassette is partial. |
| `file` | string | Filename. Added on load; not authoritative. |
| `size` | number | File size in bytes. Added on load. |

## `request`

```json
{
  "method": "POST",
  "url": "https://api.openai.com/v1/chat/completions?key=%5BREDACTED%5D",
  "origin": "https://api.openai.com",
  "path": "/v1/chat/completions",
  "localPath": "/openai/v1/chat/completions",
  "query": { "key": "[REDACTED]" },
  "headers": {
    "authorization": "[REDACTED]",
    "content-type": "application/json",
    "accept-encoding": "identity"
  },
  "body": { "model": "gpt-4o-mini", "stream": true, "messages": [] },
  "bodyType": "json",
  "size": 127
}
```

`url`, `query`, and `headers` are redacted. `path` is the upstream path after the local route prefix has been stripped (including any base path in the route target). `localPath` is what the client requested.

`bodyType` is one of:

- `json` — `body` is the parsed JSON value.
- `text` — `body` is a UTF-8 string.
- `base64` — `body` is a base64 string (binary request bodies).
- `empty` — `body` is `null`.

## `response`

```json
{
  "status": 200,
  "statusText": "OK",
  "headers": { "content-type": "text/event-stream" },
  "body": null,
  "bodyType": "empty",
  "stream": {
    "ttfbMs": 412,
    "durationMs": 2140,
    "chunks": [
      { "at": 412, "data": "data: {\"choices\":[...]}\n\n" },
      { "at": 2140, "data": "data: [DONE]\n\n" }
    ]
  }
}
```

For non-stream responses, `body` and `bodyType` use the same encoding as requests and `stream` is absent.

For streaming responses, `body` is `null`, `bodyType` is `empty`, and `stream` is present:

- `at` is the integer millisecond offset from the start of the request (before DNS/TLS finished).
- `data` is the decoded UTF-8 text of the network chunk. A chunk may split an SSE event or a multi-byte character; that is faithful to what the socket delivered.
- `encoding: "base64"` appears for binary stream chunks.

On replay, chunks are written in array order. With `--speed 1`, the first chunk is delayed by `ttfbMs` and each subsequent chunk by the delta between `at` values; with `--speed 0` all delays are skipped.

## Matching algorithm

At request time, `llm-vcr` builds a signature:

```json
{
  "method": "POST",
  "origin": "https://api.openai.com",
  "path": "/v1/chat/completions",
  "query": [["beta", "true"]],
  "headers": { "anthropic-version": "2023-06-01" },
  "body": { "value": { "model": "gpt-4o-mini" }, "encoding": "json" }
}
```

The signature is canonicalized (object keys sorted recursively), serialized, and hashed with SHA-256. Matching is an exact hash lookup.

Rules:

- Query parameters are sorted and duplicates are preserved. Parameter order does not matter.
- Only headers listed in `matchHeaders` are included. Credential headers are never included even if listed.
- JSON bodies are normalized by key order. Paths listed in `ignoreBodyPaths` are removed before hashing.
- Base64 (binary) bodies are hashed rather than embedded in the signature.
- All values are scrubbed before hashing, so a rotated API key still matches.
- The upstream origin is part of the signature. If you change a route's target to a different host, existing cassettes will not match.
- `seq` determines replay order for identical signatures. The replay cursor advances each time a cassette is used; it is per-process and resets when the proxy restarts.

On a miss, the proxy computes a similarity score for every loaded cassette and returns the best one (path, query, selected headers, and a deep body diff) in the 502 message. This is diagnostic only; it never falls back to a fuzzy match.

## Recording semantics

- `auto`: try `take(hash)`; if a cassette exists, replay it. Otherwise record a new interaction and append a new sequence number.
- `record`: always call upstream. The Nth request with a given hash overwrites the Nth existing cassette file; extra requests append. This keeps re-recording idempotent for a fixed test suite.
- `replay`: `take(hash)` only. No upstream connection is opened.
- `passthrough`: no cassette reads or writes.

Writes use a temp file + atomic rename, and writes for the same hash are serialized, so concurrent identical requests get distinct sequence numbers.

## Redaction

Before serialization:

1. Credential headers (`authorization`, `x-api-key`, `api-key`, cookies, token-like headers) become `[REDACTED]`.
2. Secret query keys (`key`, `api_key`, `token`, `signature`, …) become `[REDACTED]`.
3. Values of credential-looking environment variables are replaced with `[REDACTED:VAR_NAME]` in headers, query values, and string bodies.
4. Extra `scrub.patterns` regexes are applied.

Response headers are redacted too. Request and response bodies are scrubbed string-wise for JSON/text, including recorded stream chunks. Binary bodies are stored as-is.

## Hand editing

Cassettes are plain JSON. You can change a response body, remove a chunk, or adjust `meta.model` as long as you keep the schema. Matching uses `request` and the stored `meta.hash` (the proxy trusts the hash; it does not recompute it on load), so if you edit the request body you must also update `meta.hash` — or simply delete the file and re-record.

To replace a single interaction:

```bash
llm-vcr ls
llm-vcr rm 3f2a1c9b0d-001
llm-vcr run --mode record -- npm test
```

To refresh a whole suite:

```bash
rm -rf cassettes
llm-vcr run --mode record -- npm test
```

## Versioning

`format` is `llm-vcr/1`. New optional fields may be added within this version; readers ignore unknown fields. A breaking change will use `llm-vcr/2` and will be documented here.
