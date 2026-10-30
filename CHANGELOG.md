# Changelog

All notable changes to this project are documented here. The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project follows [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.1.0] - 2026-10-30

### Added

- Local HTTP proxy with `auto`, `record`, `replay`, and `passthrough` modes.
- Streaming SSE recording with per-chunk millisecond timing and replay at `0`/`1`/`n×` speed.
- Provider routes for OpenAI, Anthropic, Gemini, Ollama, Groq, Mistral, DeepSeek, OpenRouter, Together, xAI, Fireworks, Perplexity, and Cohere.
- `llm-vcr run -- <command>` with automatic SDK environment injection.
- Stable request signatures: method, origin, path, query, JSON body, and optional headers.
- Multiple identical interactions replay in recorded order; writes are serialized per hash.
- 502 diagnostics with the closest cassette, similarity score, and a body diff.
- Credential, query-secret, environment, response-body, and stream-chunk scrubbing.
- CLI commands: `serve`, `run`, `record`, `replay`, `ls`, `rm`, `routes`, `init`.
- Admin endpoints: `/__llm_vcr/health`, `/stats`, `/routes`, `/cassettes`.
- Configuration file discovery, custom routes, CORS, and library API.
- TypeScript declarations and a dependency-free runtime.
- English and Chinese README, cassette format documentation, fake upstream, Python client, and demo video.

### Security

- Authorization headers, API keys, cookies, secret query parameters, and credential-looking environment variables are redacted before cassette writes.

### Known limitations

- Reverse proxy only; it is not an HTTPS MITM proxy.
- JSON response bodies are normalized; SSE bytes are preserved after redaction.
- Replay cursors are sequential, not per test worker.
- Redaction is best-effort; prompts can contain PII.
