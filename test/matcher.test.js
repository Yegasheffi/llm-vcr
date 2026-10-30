import test from "node:test";
import assert from "node:assert/strict";
import { buildSignature, explainMismatch, omitBodyPaths } from "../src/matcher.js";
import { createScrubber, redactHeaders, redactQuery, redactUrl, REDACTED } from "../src/redact.js";

const base = {
  method: "POST",
  url: "https://api.example.com/v1/chat?b=2&a=1",
  headers: {
    "content-type": "application/json",
    authorization: "Bearer super-secret",
    "anthropic-version": "2023-06-01",
  },
  body: { model: "m1", messages: [{ role: "user", content: "hi" }], metadata: { trace: "x" } },
  bodyType: "json",
  matchHeaders: ["anthropic-version"],
  ignoreBodyPaths: ["metadata"],
};

test("signature is stable across key order and ignores credentials", () => {
  const first = buildSignature(base);
  const second = buildSignature({
    ...base,
    headers: { ...base.headers, authorization: "Bearer rotated", "x-api-key": "nope" },
    body: {
      messages: [{ content: "hi", role: "user" }],
      metadata: { trace: "changed-anyway" },
      model: "m1",
    },
  });
  assert.equal(first.hash, second.hash);
  assert.equal(first.payload.headers["anthropic-version"], "2023-06-01");
  assert.equal(first.payload.headers.authorization, undefined);
});

test("signature changes when a matched header or body changes", () => {
  const first = buildSignature(base);
  const headerChange = buildSignature({
    ...base,
    headers: { ...base.headers, "anthropic-version": "2024-01-01" },
  });
  const bodyChange = buildSignature({
    ...base,
    body: { ...base.body, model: "m2" },
  });
  assert.notEqual(first.hash, headerChange.hash);
  assert.notEqual(first.hash, bodyChange.hash);
});

test("ignoreBodyPaths supports wildcards and arrays", () => {
  const body = {
    metadata: { trace: "1" },
    messages: [{ role: "user", content: "a" }, { role: "assistant", content: "b" }],
    keep: true,
  };
  const result = omitBodyPaths(body, ["metadata", "messages.*.content"]);
  assert.deepEqual(result, {
    messages: [{ role: "user" }, { role: "assistant" }],
    keep: true,
  });
  assert.equal(body.messages[0].content, "a", "input is not mutated");
});

test("explainMismatch points at the first differing body path", () => {
  const incoming = buildSignature({
    ...base,
    body: { ...base.body, messages: [{ role: "user", content: "hello" }] },
  });
  const entry = {
    request: {
      ...base,
      origin: "https://api.example.com",
      path: "/v1/chat",
      query: { a: "1", b: "2" },
    },
  };
  const result = explainMismatch(entry, incoming, {
    matchHeaders: ["anthropic-version"],
    ignoreBodyPaths: ["metadata"],
  });
  assert.ok(result.score > 0.5);
  assert.ok(result.diffs.some((diff) => diff.path.includes("messages[0].content")));
});

test("scrubber redacts env values, secret headers, query keys and URLs", () => {
  const scrubber = createScrubber({
    env: { MY_API_KEY: "sk-very-secret-value" },
    envNames: ["MY_API_KEY"],
    autoScrubEnv: false,
  });
  const headers = redactHeaders(
    {
      authorization: "Bearer sk-very-secret-value",
      "x-api-key": "secret",
      "anthropic-version": "2023-06-01",
      "x-trace": "uses sk-very-secret-value",
    },
    scrubber,
  );
  assert.equal(headers.authorization, REDACTED);
  assert.equal(headers["x-api-key"], REDACTED);
  assert.equal(headers["anthropic-version"], "2023-06-01");
  assert.equal(headers["x-trace"], "uses [REDACTED:MY_API_KEY]");

  const query = redactQuery(
    [
      ["key", "sk-very-secret-value"],
      ["model", "gpt"],
      ["key", "second"],
    ],
    scrubber,
  );
  assert.deepEqual(query, { key: [REDACTED, REDACTED], model: "gpt" });

  const url = redactUrl("https://x.test/v1?key=abc&model=gpt", scrubber);
  assert.equal(url, "https://x.test/v1?key=%5BREDACTED%5D&model=gpt");
});

test("redacting credentials makes the signature survive key rotation", () => {
  const scrubber = createScrubber({ env: {}, autoScrubEnv: false });
  const request = {
    method: "POST",
    url: redactUrl("https://api.example.com/v1/chat?key=old-key", scrubber),
    headers: redactHeaders({ authorization: "Bearer old" }, scrubber),
    body: { model: "m1" },
    bodyType: "json",
  };
  const rotated = {
    ...request,
    url: redactUrl("https://api.example.com/v1/chat?key=new-key", scrubber),
    headers: redactHeaders({ authorization: "Bearer new" }, scrubber),
  };
  assert.equal(buildSignature(request).hash, buildSignature(rotated).hash);
});
