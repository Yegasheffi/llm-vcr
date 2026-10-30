import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { startUpstream } from "./helpers/upstream.js";
import { makeProxy } from "./helpers/proxy.js";
import { tempDir, readCassettes } from "./helpers/temp.js";

const CHAT = "/up/v1/chat/completions";

function request(url, body, headers = {}) {
  return fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

function chatBody(content = "hello", extra = {}) {
  return {
    model: "fake-model",
    stream: true,
    messages: [{ role: "user", content }],
    ...extra,
  };
}

async function settle(proxy) {
  await proxy.flush();
}

test("records streaming SSE with timing and replays identical bytes", async (t) => {
  const { dir, cleanup } = await tempDir();
  const upstream = await startUpstream({ delays: [5, 40, 40, 5, 5] });
  let proxy = await makeProxy({ dir, upstream: upstream.url, mode: "record" });
  t.after(async () => {
    await proxy.close();
    await upstream.close();
    await cleanup();
  });

  const body = chatBody();
  const res = await request(`${proxy.url}${CHAT}`, body);
  const recordedText = await res.text();
  await settle(proxy);

  assert.equal(res.status, 200);
  assert.match(recordedText, /data: \[DONE\]\n\n$/);
  assert.match(recordedText, /世界 👋/);
  assert.equal(upstream.hits.length, 1);
  assert.equal(upstream.hits[0].headers["accept-encoding"], "identity");

  const [cassette] = await readCassettes(dir);
  assert.ok(cassette, "cassette was written");
  assert.equal(cassette.meta.model, "fake-model");
  assert.equal(cassette.meta.stream, true);
  assert.equal(cassette.response.bodyType, "empty");
  assert.ok(cassette.response.stream.chunks.length >= 5);
  const times = cassette.response.stream.chunks.map((chunk) => chunk.at);
  assert.deepEqual(times, [...times].sort((a, b) => a - b));
  assert.ok(cassette.response.stream.ttfbMs >= 0);
  assert.ok(cassette.response.stream.durationMs >= 50);

  await proxy.close();
  await upstream.close();

  proxy = await makeProxy({ dir, upstream: upstream.url, mode: "replay", speed: 0 });
  const replayStart = Date.now();
  const replayRes = await request(`${proxy.url}${CHAT}`, body, {
    authorization: "Bearer rotated-key",
  });
  const replayedText = await replayRes.text();
  const instantMs = Date.now() - replayStart;

  assert.equal(replayRes.status, 200);
  assert.equal(replayRes.headers.get("x-llm-vcr-mode"), "replay");
  assert.ok(replayRes.headers.get("x-llm-vcr-cassette"));
  assert.equal(replayedText, recordedText);
  assert.ok(instantMs < 300, `instant replay took ${instantMs}ms`);
  await proxy.close();

  proxy = await makeProxy({ dir, upstream: upstream.url, mode: "replay", speed: 1 });
  const realtimeStart = Date.now();
  const realtimeRes = await request(`${proxy.url}${CHAT}`, body);
  const realtimeText = await realtimeRes.text();
  const realtimeMs = Date.now() - realtimeStart;
  assert.equal(realtimeText, recordedText);
  assert.ok(realtimeMs >= 60, `realtime replay took ${realtimeMs}ms`);
  await proxy.close();
});

test("records and replays JSON, binary and decompressed responses", async (t) => {
  const { dir, cleanup } = await tempDir();
  const upstream = await startUpstream();
  let proxy = await makeProxy({ dir, upstream: upstream.url, mode: "record" });
  t.after(async () => {
    await proxy.close();
    await upstream.close();
    await cleanup();
  });

  const jsonBody = {
    model: "fake-model",
    messages: [{ role: "user", content: "json please" }],
  };
  const jsonRes = await request(`${proxy.url}${CHAT}`, jsonBody);
  const json = await jsonRes.json();
  assert.equal(json.choices[0].message.content, "Hello from the fake upstream.");

  const binaryRes = await request(`${proxy.url}/up/v1/audio/speech`, {
    model: "tts-1",
    input: "hi",
  });
  const binary = Buffer.from(await binaryRes.arrayBuffer());
  assert.deepEqual([...binary], [0x49, 0x44, 0x33, 0x04, 0x00, 0x00, 0x00, 0x00]);

  const compressedRes = await fetch(`${proxy.url}/up/v1/compressed`);
  const compressed = await compressedRes.json();
  assert.deepEqual(compressed, { compressed: true, ok: true });
  assert.equal(compressedRes.headers.get("content-encoding"), null);

  await settle(proxy);
  const cassettes = await readCassettes(dir);
  assert.equal(cassettes.length, 3);
  const byPath = Object.fromEntries(cassettes.map((item) => [item.request.path, item]));
  assert.equal(byPath["/v1/chat/completions"].response.bodyType, "json");
  assert.equal(byPath["/v1/audio/speech"].response.bodyType, "base64");
  assert.equal(byPath["/v1/compressed"].response.bodyType, "json");
  assert.equal(byPath["/v1/compressed"].response.headers["content-encoding"], undefined);

  await proxy.close();
  await upstream.close();

  proxy = await makeProxy({ dir, upstream: upstream.url, mode: "replay" });
  const replayJson = await (await request(`${proxy.url}${CHAT}`, jsonBody)).json();
  assert.deepEqual(replayJson, json);

  const replayBinary = Buffer.from(
    await (await request(`${proxy.url}/up/v1/audio/speech`, { model: "tts-1", input: "hi" })).arrayBuffer(),
  );
  assert.deepEqual(replayBinary, binary);

  const replayCompressed = await (await fetch(`${proxy.url}/up/v1/compressed`)).json();
  assert.deepEqual(replayCompressed, compressed);
});

test("auto mode records misses and replays hits; replay mode fails loudly", async (t) => {
  const { dir, cleanup } = await tempDir();
  const upstream = await startUpstream();
  let proxy = await makeProxy({ dir, upstream: upstream.url, mode: "auto" });
  t.after(async () => {
    await proxy.close();
    await upstream.close();
    await cleanup();
  });

  const first = await (await request(`${proxy.url}${CHAT}`, chatBody("one"))).text();
  assert.match(first, /\[DONE\]/);
  const second = await (await request(`${proxy.url}${CHAT}`, chatBody("one"))).text();
  assert.equal(second, first);
  assert.equal(upstream.hits.length, 1, "second request was replayed");

  const third = await (await request(`${proxy.url}${CHAT}`, chatBody("two"))).text();
  assert.match(third, /\[DONE\]/);
  assert.equal(upstream.hits.length, 2, "new request was recorded");

  await settle(proxy);
  assert.equal((await readCassettes(dir)).length, 2);
  await proxy.close();

  proxy = await makeProxy({ dir, upstream: upstream.url, mode: "replay" });
  const miss = await request(`${proxy.url}${CHAT}`, chatBody("three"));
  const missText = await miss.text();
  assert.equal(miss.status, 502);
  assert.equal(miss.headers.get("x-should-retry"), "false");
  assert.equal(miss.headers.get("x-llm-vcr-error"), "no_match");
  assert.match(missText, /no recorded response matches/);
  assert.match(missText, /closest match/i);
  assert.match(missText, /messages\[0\]\.content/);

  const forced = await request(`${proxy.url}${CHAT}`, chatBody("one"), {
    "x-llm-vcr-mode": "replay",
  });
  assert.equal(forced.status, 200);
});

test("x-llm-vcr-mode overrides the server mode per request", async (t) => {
  const { dir, cleanup } = await tempDir();
  const upstream = await startUpstream();
  const proxy = await makeProxy({ dir, upstream: upstream.url, mode: "record" });
  t.after(async () => {
    await proxy.close();
    await upstream.close();
    await cleanup();
  });

  const res = await request(`${proxy.url}${CHAT}`, chatBody("never-recorded"), {
    "x-llm-vcr-mode": "replay",
  });
  assert.equal(res.status, 502);
  assert.equal(upstream.hits.length, 0);

  const bad = await request(`${proxy.url}${CHAT}`, chatBody("x"), {
    "x-llm-vcr-mode": "nonsense",
  });
  assert.equal(bad.status, 400);
});

test("routes strip prefixes, preserve query strings and target base paths", async (t) => {
  const { dir, cleanup } = await tempDir();
  const upstream = await startUpstream();
  const proxy = await makeProxy({
    dir,
    upstream: upstream.url,
    mode: "record",
    routes: [
      `/up=${upstream.url}`,
      `/groq=${upstream.url}/openai`,
      `/anthropic=${upstream.url}`,
    ],
  });
  t.after(async () => {
    await proxy.close();
    await upstream.close();
    await cleanup();
  });

  const anthropic = await request(
    `${proxy.url}/anthropic/v1/messages?beta=true`,
    { model: "claude-fake", messages: [{ role: "user", content: "hi" }] },
    { "x-api-key": "secret" },
  );
  assert.equal(anthropic.status, 200);
  assert.match(await anthropic.text(), /message_stop/);

  const models = await fetch(`${proxy.url}/up/v1/models`);
  assert.equal(models.status, 200);
  assert.equal((await models.json()).data[0].id, "fake-model");

  const groq = await request(`${proxy.url}/groq/v1/chat/completions`, {
    model: "fake-model",
    messages: [{ role: "user", content: "hi" }],
  });
  assert.equal(groq.status, 200);

  assert.equal(upstream.hits[0].url, "/v1/messages?beta=true");
  assert.equal(upstream.hits[0].headers["x-api-key"], "secret");
  assert.ok(upstream.hits.some((hit) => hit.url === "/v1/models"));
  assert.ok(upstream.hits.some((hit) => hit.url === "/openai/v1/chat/completions"));
});

test("credentials and env values are scrubbed and rotation still matches", async (t) => {
  const { dir, cleanup } = await tempDir();
  const secret = "sk-test-very-secret-value";
  const rotated = "sk-test-rotated-secret-value";
  process.env.LLM_VCR_TEST_API_KEY = secret;
  const upstream = await startUpstream();
  let proxy = await makeProxy({
    dir,
    upstream: upstream.url,
    mode: "record",
    env: { LLM_VCR_TEST_API_KEY: secret },
  });
  t.after(async () => {
    await proxy.close();
    await upstream.close();
    await cleanup();
    delete process.env.LLM_VCR_TEST_API_KEY;
  });

  const body = {
    model: "fake-model",
    stream: true,
    messages: [{ role: "user", content: `please use ${secret}` }],
  };
  const res = await request(`${proxy.url}${CHAT}?key=${secret}`, body, {
    authorization: `Bearer ${secret}`,
    "x-api-key": secret,
  });
  assert.equal(res.status, 200);
  assert.match(await res.text(), /\[DONE\]/);
  await settle(proxy);

  const raw = await fs.readFile(
    path.join(dir, (await fs.readdir(dir)).find((file) => file.endsWith(".json"))),
    "utf8",
  );
  assert.ok(!raw.includes(secret), "cassette does not contain the secret");
  assert.match(raw, /\[REDACTED/);
  const [cassette] = await readCassettes(dir);
  assert.equal(cassette.request.headers.authorization, "[REDACTED]");
  assert.equal(cassette.request.headers["x-api-key"], "[REDACTED]");

  await proxy.close();
  await upstream.close();

  process.env.LLM_VCR_TEST_API_KEY = rotated;
  proxy = await makeProxy({ dir, upstream: upstream.url, mode: "replay" });
  const rotatedBody = {
    model: "fake-model",
    stream: true,
    messages: [{ role: "user", content: `please use ${rotated}` }],
  };
  const replay = await request(`${proxy.url}${CHAT}?key=${rotated}`, rotatedBody, {
    authorization: `Bearer ${rotated}`,
    "x-api-key": rotated,
  });
  assert.equal(replay.status, 200);
  assert.match(await replay.text(), /\[DONE\]/);
});

test("record mode updates cassettes in place on a re-record run", async (t) => {
  const { dir, cleanup } = await tempDir();
  const upstream = await startUpstream();
  let proxy = await makeProxy({ dir, upstream: upstream.url, mode: "record" });
  t.after(async () => {
    await proxy.close();
    await upstream.close();
    await cleanup();
  });

  const body = chatBody("same request");
  await (await request(`${proxy.url}${CHAT}`, body)).text();
  await (await request(`${proxy.url}${CHAT}`, body)).text();
  await settle(proxy);
  assert.equal(upstream.hits.length, 2);
  assert.equal((await readCassettes(dir)).length, 2);

  await proxy.close();
  proxy = await makeProxy({ dir, upstream: upstream.url, mode: "record" });
  await (await request(`${proxy.url}${CHAT}`, body)).text();
  await (await request(`${proxy.url}${CHAT}`, body)).text();
  await settle(proxy);

  assert.equal(upstream.hits.length, 4);
  assert.equal((await readCassettes(dir)).length, 2);
});

test("admin endpoints expose health, stats and routes", async (t) => {
  const { dir, cleanup } = await tempDir();
  const upstream = await startUpstream();
  const proxy = await makeProxy({ dir, upstream: upstream.url, mode: "auto" });
  t.after(async () => {
    await proxy.close();
    await upstream.close();
    await cleanup();
  });

  const health = await (await fetch(`${proxy.url}/__llm_vcr/health`)).json();
  assert.equal(health.ok, true);
  assert.equal(health.mode, "auto");

  await (await request(`${proxy.url}${CHAT}`, chatBody("stats"))).text();
  await settle(proxy);
  const stats = await (await fetch(`${proxy.url}/__llm_vcr/stats`)).json();
  assert.equal(stats.counters.recorded, 1);
  assert.equal(stats.cassettes.interactions, 1);

  const routes = await (await fetch(`${proxy.url}/__llm_vcr/routes`)).json();
  assert.ok(routes.routes.some((route) => route.prefix === "/up"));
  assert.ok(routes.routes.some((route) => route.prefix === "/"));
});

test("concurrent identical recordings get distinct sequence numbers", async (t) => {
  const { dir, cleanup } = await tempDir();
  const upstream = await startUpstream();
  let proxy = await makeProxy({ dir, upstream: upstream.url, mode: "auto" });
  t.after(async () => {
    await proxy.close();
    await upstream.close();
    await cleanup();
  });

  const body = chatBody("concurrent");
  const texts = await Promise.all(
    Array.from({ length: 4 }, () =>
      request(`${proxy.url}${CHAT}`, body).then((res) => res.text()),
    ),
  );
  assert.equal(texts.length, 4);
  assert.ok(texts.every((text) => text.includes("[DONE]")));
  assert.equal(upstream.hits.length, 4);
  await settle(proxy);

  const cassettes = await readCassettes(dir);
  assert.equal(cassettes.length, 4);
  assert.deepEqual(
    cassettes.map((item) => item.meta.seq).sort((a, b) => a - b),
    [1, 2, 3, 4],
  );

  await proxy.close();
  proxy = await makeProxy({ dir, upstream: upstream.url, mode: "replay" });
  for (let index = 0; index < 4; index += 1) {
    const res = await request(`${proxy.url}${CHAT}`, body);
    assert.equal(res.status, 200);
    assert.match(await res.text(), /\[DONE\]/);
  }
});

test("ignoreBodyPaths makes volatile request fields irrelevant", async (t) => {
  const { dir, cleanup } = await tempDir();
  const upstream = await startUpstream();
  const proxy = await makeProxy({
    dir,
    upstream: upstream.url,
    mode: "auto",
    ignoreBodyPaths: ["metadata.trace_id"],
  });
  t.after(async () => {
    await proxy.close();
    await upstream.close();
    await cleanup();
  });

  const makeBody = (trace) => ({
    model: "fake-model",
    stream: true,
    metadata: { trace_id: trace },
    messages: [{ role: "user", content: "stable" }],
  });

  const first = await (await request(`${proxy.url}${CHAT}`, makeBody("trace-a"))).text();
  const second = await (await request(`${proxy.url}${CHAT}`, makeBody("trace-b"))).text();
  assert.equal(second, first);
  assert.equal(upstream.hits.length, 1, "second request matched despite trace_id change");
});

test("error responses are recorded and replayed", async (t) => {
  const { dir, cleanup } = await tempDir();
  const upstream = await startUpstream();
  let proxy = await makeProxy({ dir, upstream: upstream.url, mode: "record" });
  t.after(async () => {
    await proxy.close();
    await upstream.close();
    await cleanup();
  });

  const res = await request(`${proxy.url}/up/v1/fail`, { model: "fake-model" });
  assert.equal(res.status, 500);
  assert.deepEqual((await res.json()).error.code, "boom");
  await settle(proxy);

  const [cassette] = await readCassettes(dir);
  assert.equal(cassette.response.status, 500);
  assert.equal(cassette.response.body.error.code, "boom");

  await proxy.close();
  await upstream.close();
  proxy = await makeProxy({ dir, upstream: upstream.url, mode: "replay" });
  const replay = await request(`${proxy.url}/up/v1/fail`, { model: "fake-model" });
  assert.equal(replay.status, 500);
  assert.deepEqual((await replay.json()).error.code, "boom");
});

test("response bodies and stream chunks are scrubbed too", async (t) => {
  const { dir, cleanup } = await tempDir();
  const secret = "sk-response-echo-secret";
  process.env.LLM_VCR_ECHO_API_KEY = secret;
  const upstream = await startUpstream();
  const proxy = await makeProxy({ dir, upstream: upstream.url, mode: "record" });
  t.after(async () => {
    await proxy.close();
    await upstream.close();
    await cleanup();
    delete process.env.LLM_VCR_ECHO_API_KEY;
  });

  const res = await request(
    `${proxy.url}/up/v1/echo`,
    { model: "fake-model", messages: [{ role: "user", content: `use ${secret}` }] },
    { authorization: `Bearer ${secret}` },
  );
  assert.equal(res.status, 200);
  const echoed = await res.json();
  assert.equal(echoed.echoedAuthorization, `Bearer ${secret}`);
  await settle(proxy);

  const [cassette] = await readCassettes(dir);
  const serialized = JSON.stringify(cassette);
  assert.ok(!serialized.includes(secret), "no secret in the cassette");
  assert.match(serialized, /\[REDACTED/);
  assert.match(cassette.response.body.echoedAuthorization, /\[REDACTED/);
});
