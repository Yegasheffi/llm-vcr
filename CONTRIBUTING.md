# Contributing

Thanks for helping make `llm-vcr` better. This project is a small, dependency-free HTTP proxy, so the most useful contributions are focused bug fixes, new provider routes, compatibility tests, and documentation improvements.

## Development setup

Use Node 20 (the version in `.nvmrc` and CI) and pnpm 11:

```bash
pnpm install
pnpm test          # node:test, no external network
pnpm typecheck
pnpm demo          # fake upstream, record + replay
```

The package itself supports Node 18.17+ at runtime and has no runtime dependencies. Keep it that way.

## Repository layout

```text
bin/                CLI entrypoint
src/proxy.js        HTTP proxy, recording, replay and diagnostics
src/store.js        cassette discovery, matching cursors and atomic writes
src/matcher.js      request canonicalization, hashes and diffs
src/redact.js       credential and environment scrubbing
src/config.js       config discovery, routes and env injection
src/cli.js          commands: serve, run, ls, rm, routes, init
test/               node:test unit, integration, CLI and SDK tests
docs/               cassette format and reference material
examples/           fake OpenAI server, demo and Python client
scripts/            reproducible demo-video renderer
```

## Tests

Every change should pass:

```bash
pnpm test
pnpm typecheck
```

The test suite uses a local fake upstream. Do not make tests depend on a real provider or an API key.

For a new provider route, add the preset to `src/providers.js`, make sure the target/base-path combination is correct, and add a route test in `test/proxy.test.js` if it has unusual path behavior.

For proxy behavior, prefer a test that exercises the real HTTP server (`createProxy`) over mocking internal functions.

## Cassettes and secrets

- Never commit real API keys, bearer tokens, cookies, or private prompts.
- Use `--scrub-env` / `--scrub-pattern` for project-specific secrets.
- Review `git diff cassettes/` before opening a PR.
- The test suite writes only temporary cassettes. The demo writes to `examples/.cassettes/`, which is gitignored.

## Demo video

The demo video is generated from a real `examples/demo.mjs` run:

```bash
NODE_BIN=/path/to/node python3 scripts/render_demo_video.py
```

This requires macOS with Swift/AVFoundation for H.264 encoding, plus Pillow. It is optional for normal contributions.

## Pull requests

- Keep the change focused; split unrelated refactors.
- Add or update tests.
- Update both `README.md` and `README.zh-CN.md` when changing user-facing behavior.
- Run `pnpm test`, `pnpm typecheck`, and `pnpm demo`.
- Describe the behavior change and how you verified it.
- Do not include generated cassettes, `node_modules/`, tarballs, or recordings unless they are intentional fixtures.

## Commit style

Short imperative subjects are preferred:

```text
add anthropic streaming replay test
fix cassette cursor after concurrent recording
docs: clarify --speed semantics
```

## Security

Please do not open a public issue for a vulnerability. See [SECURITY.md](SECURITY.md).
