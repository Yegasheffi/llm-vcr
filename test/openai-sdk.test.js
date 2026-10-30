import test from "node:test";
import assert from "node:assert/strict";
import OpenAI from "openai";
import { startUpstream } from "./helpers/upstream.js";
import { makeProxy } from "./helpers/proxy.js";
import { tempDir } from "./helpers/temp.js";

test("works with the official OpenAI SDK, including streaming", async (t) => {
  const { dir, cleanup } = await tempDir();
  const upstream = await startUpstream();
  let proxy = await makeProxy({
    dir,
    upstream: upstream.url,
    mode: "record",
    routes: [`/openai=${upstream.url}`],
  });
  t.after(async () => {
    await proxy.close();
    await upstream.close();
    await cleanup();
  });

  const client = new OpenAI({
    apiKey: "sk-test-key",
    baseURL: `${proxy.url}/openai/v1`,
  });
  const stream = await client.chat.completions.create({
    model: "fake-model",
    stream: true,
    messages: [{ role: "user", content: "hello from the sdk" }],
  });
  let text = "";
  for await (const chunk of stream) {
    text += chunk.choices[0]?.delta?.content || "";
  }
  assert.equal(text, "Hello 世界 👋");
  await proxy.flush();

  const plain = await client.chat.completions.create({
    model: "fake-model",
    messages: [{ role: "user", content: "non streaming" }],
  });
  assert.equal(plain.choices[0].message.content, "Hello from the fake upstream.");
  await proxy.flush();

  await proxy.close();
  await upstream.close();

  proxy = await makeProxy({
    dir,
    upstream: upstream.url,
    mode: "replay",
    routes: [`/openai=${upstream.url}`],
  });
  const replayClient = new OpenAI({
    apiKey: "sk-rotated-key",
    baseURL: `${proxy.url}/openai/v1`,
  });
  const replayStream = await replayClient.chat.completions.create({
    model: "fake-model",
    stream: true,
    messages: [{ role: "user", content: "hello from the sdk" }],
  });
  let replayText = "";
  for await (const chunk of replayStream) {
    replayText += chunk.choices[0]?.delta?.content || "";
  }
  assert.equal(replayText, text);

  const replayPlain = await replayClient.chat.completions.create({
    model: "fake-model",
    messages: [{ role: "user", content: "non streaming" }],
  });
  assert.equal(replayPlain.choices[0].message.content, "Hello from the fake upstream.");
});
