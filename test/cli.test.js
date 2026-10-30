import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { startUpstream } from "./helpers/upstream.js";
import { tempDir, readCassettes } from "./helpers/temp.js";

const BIN = fileURLToPath(new URL("../bin/llm-vcr.js", import.meta.url));

function runCli(args, { cwd, env = {}, timeout = 20_000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BIN, ...args], {
      cwd,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve({ code: null, signal: "TIMEOUT", stdout, stderr });
    }, timeout);
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr });
    });
  });
}

const SCRIPT = `
const base = process.env.OPENAI_BASE_URL;
if (!base) {
  console.error("OPENAI_BASE_URL was not injected");
  process.exit(2);
}
const res = await fetch(base + "/chat/completions", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    model: "fake-model",
    stream: true,
    messages: [{ role: "user", content: "from the cli" }],
  }),
});
if (!res.ok) {
  console.error(await res.text());
  process.exit(3);
}
const text = await res.text();
if (!text.includes("[DONE]")) {
  console.error("stream was incomplete");
  process.exit(4);
}
console.log("SCRIPT_OK", text.length);
`;

test("llm-vcr run injects env, records, then replays offline", async (t) => {
  const { dir, cleanup } = await tempDir();
  const upstream = await startUpstream();
  t.after(async () => {
    await upstream.close();
    await cleanup();
  });

  await fs.writeFile(
    path.join(dir, "llm-vcr.config.json"),
    JSON.stringify(
      {
        cassetteDir: "./cassettes",
        mode: "record",
        routes: [{ prefix: "/openai", target: upstream.url }],
      },
      null,
      2,
    ),
  );
  const script = path.join(dir, "agent.mjs");
  await fs.writeFile(script, SCRIPT);

  const recorded = await runCli(
    ["run", "--mode", "record", "--", process.execPath, script],
    { cwd: dir },
  );
  assert.equal(recorded.code, 0, recorded.stderr);
  assert.match(recorded.stdout, /SCRIPT_OK/);
  assert.match(recorded.stdout, /OPENAI_BASE_URL=/);
  assert.equal((await readCassettes(path.join(dir, "cassettes"))).length, 1);

  await upstream.close();

  const replayed = await runCli(
    ["run", "--mode", "replay", "--", process.execPath, script],
    { cwd: dir },
  );
  assert.equal(replayed.code, 0, replayed.stderr);
  assert.match(replayed.stdout, /SCRIPT_OK/);

  const listing = await runCli(["ls", "--json"], { cwd: dir });
  assert.equal(listing.code, 0, listing.stderr);
  const entries = JSON.parse(listing.stdout);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].stream, true);
  assert.equal(entries[0].model, "fake-model");
  assert.equal(entries[0].path, "/v1/chat/completions");

  const removed = await runCli(["rm", "--all", "--yes"], { cwd: dir });
  assert.equal(removed.code, 0, removed.stderr);
  assert.equal((await readCassettes(path.join(dir, "cassettes"))).length, 0);
});

test("replay mode surfaces a missing cassette as a test failure", async (t) => {
  const { dir, cleanup } = await tempDir();
  const upstream = await startUpstream();
  t.after(async () => {
    await upstream.close();
    await cleanup();
  });

  await fs.writeFile(
    path.join(dir, "llm-vcr.config.json"),
    JSON.stringify({
      cassetteDir: "./cassettes",
      routes: [{ prefix: "/openai", target: upstream.url }],
    }),
  );
  const script = path.join(dir, "agent.mjs");
  await fs.writeFile(
    script,
    `
const res = await fetch(process.env.OPENAI_BASE_URL + "/chat/completions", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ model: "fake-model", messages: [{ role: "user", content: "never recorded" }] }),
});
if (!res.ok) {
  console.error(await res.text());
  process.exit(9);
}
`,
  );

  const result = await runCli(
    ["run", "--mode", "replay", "--", process.execPath, script],
    { cwd: dir },
  );
  assert.equal(result.code, 9);
  assert.match(result.stderr, /no recorded response matches this request/);
  assert.equal(upstream.hits.length, 0);
});

test("init writes a config file and refuses to overwrite without --force", async (t) => {
  const { dir, cleanup } = await tempDir();
  t.after(async () => cleanup());

  const first = await runCli(["init"], { cwd: dir });
  assert.equal(first.code, 0, first.stderr);
  const configPath = path.join(dir, "llm-vcr.config.json");
  const config = JSON.parse(await fs.readFile(configPath, "utf8"));
  assert.equal(config.cassetteDir, "./cassettes");

  const second = await runCli(["init"], { cwd: dir });
  assert.equal(second.code, 1);

  const forced = await runCli(["init", "--force"], { cwd: dir });
  assert.equal(forced.code, 0, forced.stderr);

  const custom = await runCli(["init", "--config", "custom.json"], { cwd: dir });
  assert.equal(custom.code, 0, custom.stderr);
  assert.ok(await fs.stat(path.join(dir, "custom.json")));
});

test("run --no-env does not inject SDK variables", async (t) => {
  const { dir, cleanup } = await tempDir();
  t.after(async () => cleanup());
  const script = path.join(dir, "check-env.mjs");
  await fs.writeFile(
    script,
    `
if (process.env.OPENAI_BASE_URL) {
  console.error("OPENAI_BASE_URL was injected");
  process.exit(5);
}
if (process.env.LLM_VCR) {
  console.error("LLM_VCR was injected");
  process.exit(5);
}
console.log("NO_ENV_OK");
`,
  );

  const result = await runCli(
    ["run", "--no-env", "--", process.execPath, script],
    { cwd: dir },
  );
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /NO_ENV_OK/);
});

test("CLI help, version and routes work", async () => {
  const version = await runCli(["--version"]);
  assert.equal(version.code, 0);
  assert.match(version.stdout, /^llm-vcr \d+\.\d+\.\d+/);

  const help = await runCli(["--help"]);
  assert.equal(help.code, 0);
  assert.match(help.stdout, /record & replay/);
  assert.match(help.stdout, /llm-vcr run --/);

  const routes = await runCli(["routes"]);
  assert.equal(routes.code, 0);
  assert.match(routes.stdout, /\/openai/);
  assert.match(routes.stdout, /api\.openai\.com/);
});
