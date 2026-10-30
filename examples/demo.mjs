import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import OpenAI from "openai";
import { buildConfig } from "../src/config.js";
import { createProxy } from "../src/proxy.js";
import { nullLogger } from "../src/logger.js";
import { startFakeOpenAI } from "./fake-openai.mjs";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const cassetteDir = path.join(root, "examples", ".cassettes");
const useColor = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
const paint = (code, text) => (useColor ? `\u001b[${code}m${text}\u001b[0m` : text);
const bold = (text) => paint("1", text);
const dim = (text) => paint("2", text);
const green = (text) => paint("32", text);
const cyan = (text) => paint("36", text);

function tokenLine(ms, token) {
  return `  ${dim(String(Math.round(ms)).padStart(4))}ms  ${JSON.stringify(token)}`;
}

function proxyFor(mode, upstream, speed) {
  const config = buildConfig(
    {
      command: "serve",
      cassette: cassetteDir,
      mode,
      speed: String(speed),
      port: "0",
      route: [`/openai=${upstream.url}`],
    },
    { cwd: root, env: process.env },
  );
  return createProxy(config, { logger: nullLogger });
}

async function stream(client, messages, { onToken } = {}) {
  const started = performance.now();
  const stream = await client.chat.completions.create({
    model: "fake-model",
    stream: true,
    messages,
  });
  let text = "";
  let chunks = 0;
  for await (const chunk of stream) {
    chunks += 1;
    const token = chunk.choices[0]?.delta?.content;
    if (!token) continue;
    text += token;
    onToken?.(performance.now() - started, token);
  }
  return { text, chunks, ms: performance.now() - started };
}

async function main() {
  await fs.rm(cassetteDir, { recursive: true, force: true });
  await fs.mkdir(cassetteDir, { recursive: true });

  process.stdout.write(`\n${bold("llm-vcr demo")} ${dim("— no API key, no network")}\n\n`);
  const upstream = await startFakeOpenAI({ port: 0 });
  process.stdout.write(
    `${cyan("●")} fake upstream ${dim(upstream.url)} is running\n\n`,
  );

  let proxy = await proxyFor("record", upstream, 0);
  const client = new OpenAI({
    apiKey: "sk-demo",
    baseURL: `${proxy.url}/openai/v1`,
  });
  const messages = [{ role: "user", content: "Say hello in six tokens." }];

  process.stdout.write(`${green("● REC")} calling the model for real…\n`);
  const recorded = await stream(client, messages, {
    onToken: (ms, token) => process.stdout.write(`${tokenLine(ms, token)}\n`),
  });
  await proxy.flush();
  await proxy.close();

  const files = (await fs.readdir(cassetteDir)).filter((file) => file.endsWith(".json"));
  const cassettePath = path.join(cassetteDir, files[0]);
  const cassette = JSON.parse(await fs.readFile(cassettePath, "utf8"));
  const s = cassette.response.stream;

  process.stdout.write(
    `\n  ${dim("cassette")}  ${path.relative(root, cassettePath)}\n` +
      `  ${dim("request")}   ${cassette.request.method} ${cassette.request.path} ${dim(`(model ${cassette.meta.model})`)}\n` +
      `  ${dim("response")}  ${cassette.response.status} · ${s.chunks.length} chunks · ` +
      `ttfb ${s.ttfbMs}ms · total ${s.durationMs}ms\n`,
  );

  await upstream.close();
  process.stdout.write(
    `\n${cyan("○ PLAY")} upstream is now down. Replaying the same call offline at 1×…\n`,
  );

  proxy = await proxyFor("replay", upstream, 1);
  const replayClient = new OpenAI({
    apiKey: "sk-demo",
    baseURL: `${proxy.url}/openai/v1`,
  });
  const replayed = await stream(replayClient, messages, {
    onToken: (ms, token) => process.stdout.write(`${tokenLine(ms, token)}\n`),
  });
  await proxy.close();

  const same = replayed.text === recorded.text;
  process.stdout.write(
    `\n  ${same ? green("✓") : paint("31", "✗")} stream ${same ? "matched" : "DID NOT match"} · ` +
      `${replayed.chunks} chunks in ${Math.round(replayed.ms)}ms\n` +
      `  ${dim("text")}      ${JSON.stringify(replayed.text)}\n\n` +
      `  ${dim("Next:")} point your own SDK at the proxy, then run:\n` +
      `    ${bold("npx llm-vcr-proxy run --mode replay -- npm test")}\n\n`,
  );

  if (!same) process.exitCode = 1;
}

try {
  await main();
} catch (error) {
  process.stderr.write(`\nllm-vcr demo failed: ${error.stack || error.message}\n`);
  process.exitCode = 1;
}
