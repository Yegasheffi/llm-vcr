# Security policy

## Supported versions

`llm-vcr-proxy` is pre-1.0. Security fixes are applied to the latest 0.1.x release.

## Reporting a vulnerability

Please use the repository's **Security** tab and choose **Report a vulnerability**. Do not open a public issue, and do not include real API keys or customer data in a report.

Useful details:

- `llm-vcr` version and Node version
- mode (`auto`, `record`, `replay`, `passthrough`)
- configuration/routes (redact credentials)
- a minimal reproduction, ideally against the fake upstream in `examples/`
- impact: credential exposure, cassette leakage, path traversal, SSRF, denial of service, etc.

We aim to acknowledge reports within 7 days and will coordinate a fix and disclosure timeline with you.

## Scope

The proxy binds to `127.0.0.1` by default and is intended for local development and CI. If you bind it to a public interface, anyone who can reach it can use the upstream credentials sent through it.

Cassette redaction is best-effort. Prompts and completions can contain PII that no regex will catch; review cassettes before sharing them.

## Safe harbor

We will not pursue legal action for good-faith security research that respects this policy and avoids privacy violations, service disruption, or data destruction.
