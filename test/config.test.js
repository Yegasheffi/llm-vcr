import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { buildConfig, buildRunEnv, proxyBaseUrl, ConfigError } from "../src/config.js";
import { tempDir } from "./helpers/temp.js";

test("config file is discovered upward and cassetteDir resolves next to it", async (t) => {
  const { dir, cleanup } = await tempDir();
  t.after(async () => cleanup());
  const nested = path.join(dir, "packages", "app");
  await fs.mkdir(nested, { recursive: true });
  await fs.writeFile(
    path.join(dir, "llm-vcr.config.json"),
    JSON.stringify({
      cassetteDir: "./shared-cassettes",
      routes: [{ prefix: "/", target: "https://custom.example.com" }],
    }),
  );

  const config = buildConfig({ command: "serve" }, { cwd: nested, env: {} });
  assert.equal(config.configFile, path.join(dir, "llm-vcr.config.json"));
  assert.equal(config.cassetteDir, path.join(dir, "shared-cassettes"));
  assert.equal(
    config.routes.find((route) => route.prefix === "/").target,
    "https://custom.example.com",
  );

  const overridden = buildConfig(
    { command: "serve", cassette: "./local-cassettes" },
    { cwd: nested, env: {} },
  );
  assert.equal(overridden.cassetteDir, path.join(nested, "local-cassettes"));
});

test("provider presets and run env injection", async () => {
  const { dir, cleanup } = await tempDir();
  try {
    const config = buildConfig({ command: "run", provider: "ollama" }, { cwd: dir, env: {} });
    assert.equal(config.port, 0);
    assert.equal(
      config.routes.find((route) => route.prefix === "/").target,
      "http://127.0.0.1:11434",
    );
    const { env } = buildRunEnv(config, "http://127.0.0.1:1234", {});
    assert.equal(env.OLLAMA_HOST, "http://127.0.0.1:1234/ollama");
    assert.equal(env.OPENAI_BASE_URL, "http://127.0.0.1:1234/openai/v1");
    assert.equal(env.ANTHROPIC_BASE_URL, "http://127.0.0.1:1234/anthropic");
  } finally {
    await cleanup();
  }
});

test("routes can be added from flags and validation is explicit", async () => {
  const { dir, cleanup } = await tempDir();
  try {
    const config = buildConfig(
      {
        command: "serve",
        route: ["/local=http://127.0.0.1:9999/v1"],
        matchHeaders: "anthropic-version,openai-beta",
        ignoreBody: "metadata.trace,timestamp",
      },
      { cwd: dir, env: {} },
    );
    const local = config.routes.find((route) => route.prefix === "/local");
    assert.equal(local.target, "http://127.0.0.1:9999/v1");
    assert.deepEqual(config.matchHeaders, ["anthropic-version", "openai-beta"]);
    assert.deepEqual(config.ignoreBodyPaths, ["metadata.trace", "timestamp"]);

    assert.throws(
      () => buildConfig({ command: "serve", mode: "wrong" }, { cwd: dir, env: {} }),
      ConfigError,
    );
    assert.throws(
      () => buildConfig({ command: "serve", route: ["no-equals"] }, { cwd: dir, env: {} }),
      ConfigError,
    );
    assert.throws(
      () => buildConfig({ command: "serve", route: ["/x=ftp://x.test"] }, { cwd: dir, env: {} }),
      ConfigError,
    );
  } finally {
    await cleanup();
  }
});

test("proxyBaseUrl brackets IPv6 addresses", () => {
  assert.equal(proxyBaseUrl({ host: "::1" }, 8484), "http://[::1]:8484");
  assert.equal(proxyBaseUrl({ host: "0.0.0.0" }, 8484), "http://127.0.0.1:8484");
});
