import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { parseArgs } from "node:util";
import { buildConfig, buildRunEnv } from "./config.js";
import { createProxy } from "./proxy.js";
import { createLogger, VERSION } from "./logger.js";
import { openStore } from "./store.js";
import { formatBytes, timeAgo, truncate } from "./util.js";

class UsageError extends Error {}

const COMMANDS = new Map([
  ["serve", "serve"],
  ["run", "run"],
  ["record", "record"],
  ["replay", "replay"],
  ["ls", "ls"],
  ["list", "ls"],
  ["rm", "rm"],
  ["remove", "rm"],
  ["init", "init"],
  ["routes", "routes"],
  ["help", "help"],
]);

const OPTIONS = {
  mode: { type: "string" },
  cassette: { type: "string", short: "c" },
  cassettes: { type: "string" },
  config: { type: "string" },
  port: { type: "string" },
  host: { type: "string" },
  target: { type: "string" },
  provider: { type: "string" },
  route: { type: "string", multiple: true },
  speed: { type: "string" },
  "match-headers": { type: "string" },
  "ignore-body": { type: "string" },
  "scrub-env": { type: "string", multiple: true },
  "scrub-pattern": { type: "string", multiple: true },
  cors: { type: "boolean" },
  "no-color": { type: "boolean" },
  quiet: { type: "boolean", short: "q" },
  verbose: { type: "boolean", short: "v" },
  help: { type: "boolean", short: "h" },
  version: { type: "boolean", short: "V" },
  all: { type: "boolean" },
  yes: { type: "boolean", short: "y" },
  force: { type: "boolean" },
  json: { type: "boolean" },
  "no-env": { type: "boolean" },
};

function parseCli(argv) {
  const args = [...argv];
  let command = "serve";

  if (args[0] && !args[0].startsWith("-")) {
    const mapped = COMMANDS.get(args[0].toLowerCase());
    if (!mapped) {
      throw new UsageError(`Unknown command "${args[0]}". Run llm-vcr --help.`);
    }
    command = mapped;
    args.shift();
  }

  const separator = args.indexOf("--");
  const ownArgs = separator === -1 ? args : args.slice(0, separator);
  const trailing = separator === -1 ? [] : args.slice(separator + 1);

  let values;
  let positionals;
  try {
    ({ values, positionals } = parseArgs({
      args: ownArgs,
      options: OPTIONS,
      allowPositionals: true,
      strict: true,
    }));
  } catch (error) {
    throw new UsageError(error.message);
  }

  const commandArgs =
    command === "run" ? (trailing.length > 0 ? trailing : positionals) : positionals;

  return {
    command,
    values,
    positionals,
    commandArgs,
    cli: {
      command,
      mode:
        values.mode ||
        (command === "record" ? "record" : command === "replay" ? "replay" : undefined),
      cassette: values.cassette || values.cassettes,
      config: values.config,
      port: values.port,
      host: values.host,
      target: values.target,
      provider: values.provider,
      route: values.route || [],
      speed: values.speed,
      matchHeaders: values["match-headers"],
      ignoreBody: values["ignore-body"],
      scrubEnv: values["scrub-env"] || [],
      scrubPattern: values["scrub-pattern"] || [],
      cors: values.cors,
      quiet: values.quiet,
      verbose: values.verbose,
      color: values["no-color"] ? false : true,
      noEnv: values["no-env"],
    },
  };
}

function printHelp() {
  process.stdout.write(`
  llm-vcr — record & replay for any LLM SDK, streaming included

  Usage
    llm-vcr [serve] [options]             start the proxy
    llm-vcr run -- <command> [args...]    start proxy, inject SDK env, run command
    llm-vcr record [options]              force re-record (upstream required)
    llm-vcr replay [options]              start proxy in replay mode
    llm-vcr ls [--json]                   list cassettes
    llm-vcr rm <id...> | --all --yes      delete cassettes
    llm-vcr routes                        show routes
    llm-vcr init                          write llm-vcr.config.json

  Options
    -c, --cassette <dir>       cassette directory (default: ./cassettes)
        --config <file>        config file (default: llm-vcr.config.json)
        --mode <mode>          auto | record | replay | passthrough
        --port <port>          port (default: 8484; run uses a free port)
        --host <host>          bind address (default: 127.0.0.1)
        --target <url>         upstream for paths without a route prefix
        --provider <name>      openai | anthropic | google | ollama | groq | ...
        --route <prefix=url>   add or override a route (repeatable)
        --speed <n>            replay speed: 0 = instant (default), 1 = realtime
        --match-headers <a,b>  extra headers that participate in matching
        --ignore-body <a,b>    JSON body paths ignored when matching
        --scrub-env <VAR>      extra env values to redact (repeatable)
        --scrub-pattern <re>   extra regex to redact (repeatable)
        --cors                 enable CORS for browser-based clients
        --no-env               do not inject SDK env vars in "run"
    -q, --quiet                only warnings and errors
    -v, --verbose              more detail in logs
        --no-color             disable ANSI colors
        --json                 JSON output for "ls"
        --all --yes            delete every cassette with "rm"
        --force                overwrite an existing config with "init"
    -h, --help                 show help
    -V, --version              show version

  Modes
    auto          replay when a cassette matches, record otherwise (default)
    record        always call upstream; overwrite cassettes in place
    replay        never call upstream; fail loudly on a missing interaction
    passthrough   plain proxy, no recording

  Examples
    # 1. record once (proxy in record mode; point any SDK at it)
    OPENAI_BASE_URL=http://127.0.0.1:8484/openai/v1 npx llm-vcr-proxy --mode record

    # 2. run tests with env injection, recording missing calls
    npx llm-vcr-proxy run -- npm test

    # 3. CI: fail if the code makes a request that was not recorded
    npx llm-vcr-proxy run --mode replay -- npm test

    # 4. any language, any SDK: just change the base URL
    OPENAI_BASE_URL=http://127.0.0.1:8484/openai/v1 python app.py

  Docs: https://www.npmjs.com/package/llm-vcr-proxy
`);
}

async function serve(config, logger) {
  let proxy;
  try {
    proxy = await createProxy(config, { logger });
  } catch (error) {
    logger.error(`could not start proxy: ${error.message}`);
    return 1;
  }

  const { env } = buildRunEnv(config, proxy.url, process.env);
  logger.banner(config, { url: proxy.url, store: proxy.store, env });
  if (config.host !== "127.0.0.1" && config.host !== "localhost") {
    logger.warn(
      `proxy is bound to ${config.host}, not loopback — anyone who can reach this port can use your API credentials while recording.`,
    );
  }

  let closing = false;
  const shutdown = async (signal, code) => {
    if (closing) {
      logger.warn("forcing exit");
      process.exit(code);
    }
    closing = true;
    logger.info(`\n  ${signal} received — closing proxy`);
    await proxy.close();
    logger.summary(proxy.counters);
    process.exit(code);
  };

  process.once("SIGINT", () => void shutdown("SIGINT", 0));
  process.once("SIGTERM", () => void shutdown("SIGTERM", 0));

  await new Promise(() => {});
  return 0;
}

async function run(config, logger, command) {
  let proxy;
  try {
    proxy = await createProxy(config, { logger });
  } catch (error) {
    logger.error(`could not start proxy: ${error.message}`);
    return 1;
  }

  const { env: injected, changed } = config.noEnv
    ? { env: {}, changed: {} }
    : buildRunEnv(config, proxy.url, process.env);
  logger.banner(config, {
    url: proxy.url,
    store: proxy.store,
    command,
    env: injected,
  });
  for (const [name, previous] of Object.entries(changed)) {
    logger.debug(`overriding ${name} (was ${truncate(previous, 60)})`);
  }

  let settled = false;
  const exit = await new Promise((resolve) => {
    let child;
    try {
      child = spawn(command[0], command.slice(1), {
        stdio: "inherit",
        env: { ...process.env, ...injected },
        shell: process.platform === "win32",
      });
    } catch (error) {
      resolve({ code: 127, error });
      return;
    }

    let interrupts = 0;
    const forward = (signal) => {
      try {
        child.kill(signal);
      } catch {
        // The child may already be gone.
      }
    };
    const onSigint = () => {
      interrupts += 1;
      forward(interrupts > 1 ? "SIGKILL" : "SIGINT");
    };
    const onSigterm = () => forward("SIGTERM");
    process.on("SIGINT", onSigint);
    process.on("SIGTERM", onSigterm);

    const finish = (result) => {
      if (settled) return;
      settled = true;
      process.off("SIGINT", onSigint);
      process.off("SIGTERM", onSigterm);
      resolve(result);
    };

    child.on("error", (error) => finish({ code: 127, error }));
    child.on("exit", (code, signal) => finish({ code, signal }));
  });

  await proxy.close();
  logger.summary(proxy.counters);

  if (exit.error) {
    if (exit.error.code === "ENOENT") {
      logger.error(`command not found: ${command[0]}`);
    } else {
      logger.error(exit.error.message);
    }
    return 127;
  }
  if (exit.signal) {
    logger.warn(`command exited via ${exit.signal}`);
    return 128 + (osSignalNumber(exit.signal) || 0);
  }
  if (config.verbose) logger.debug(`child exited with code ${exit.code}`);
  return exit.code ?? 1;
}

function osSignalNumber(signal) {
  return { SIGINT: 2, SIGTERM: 15, SIGHUP: 1, SIGKILL: 9 }[signal] || 0;
}

async function listCassettes(config, logger, { json }) {
  const store = await openStore(config.cassetteDir, logger);
  const entries = store.all();

  if (json) {
    process.stdout.write(
      `${JSON.stringify(
        entries.map((entry) => ({
          id: entry.meta.id,
          hash: entry.meta.hash,
          createdAt: entry.meta.createdAt,
          method: entry.request?.method,
          path: entry.request?.path,
          url: entry.request?.url,
          status: entry.response?.status,
          model: entry.meta.model,
          stream: Boolean(entry.response?.stream),
          chunks: entry.response?.stream?.chunks?.length || 0,
          durationMs: entry.meta.durationMs,
          size: entry.meta.size,
        })),
        null,
        2,
      )}\n`,
    );
    return 0;
  }

  if (entries.length === 0) {
    process.stdout.write(`\n  No cassettes in ${config.cassetteDir}\n\n`);
    return 0;
  }

  const rows = entries.map((entry) => {
    const stream = entry.response?.stream;
    return {
      id: truncate(entry.meta.id, 34),
      method: entry.request?.method || "?",
      path: truncate(entry.request?.path || "?", 38),
      status: String(entry.response?.status || "?"),
      kind: stream ? `sse ${stream.chunks?.length || 0}` : entry.response?.bodyType || "?",
      model: truncate(entry.meta.model || "-", 20),
      size: formatBytes(entry.meta.size || 0),
      age: timeAgo(entry.meta.createdAt),
    };
  });

  const headers = {
    id: "ID",
    method: "METHOD",
    path: "PATH",
    status: "STATUS",
    kind: "KIND",
    model: "MODEL",
    size: "SIZE",
    age: "AGE",
  };
  const width = {};
  for (const key of Object.keys(headers)) {
    width[key] = Math.max(
      headers[key].length,
      ...rows.map((row) => String(row[key]).length),
    );
  }
  const line = (row) =>
    [
      String(row.id).padEnd(width.id),
      String(row.method).padEnd(width.method),
      String(row.path).padEnd(width.path),
      String(row.status).padEnd(width.status),
      String(row.kind).padEnd(width.kind),
      String(row.model).padEnd(width.model),
      String(row.size).padStart(width.size),
      String(row.age).padEnd(width.age),
    ].join("  ");

  process.stdout.write(`\n  ${line(headers)}\n`);
  process.stdout.write(`  ${Object.keys(headers).map((key) => "─".repeat(width[key])).join("  ")}\n`);
  for (const row of rows) process.stdout.write(`  ${line(row)}\n`);
  process.stdout.write(
    `\n  ${entries.length} interaction${entries.length === 1 ? "" : "s"} · ${store.hashCount} unique request${store.hashCount === 1 ? "" : "s"} · ${formatBytes(store.bytes)} · ${config.cassetteDir}\n\n`,
  );
  return 0;
}

async function removeCassettes(config, logger, ids, { all, yes }) {
  if (!all && ids.length === 0) {
    logger.error("specify cassette ids, or pass --all --yes");
    return 1;
  }
  if (all && !yes) {
    logger.error(`refusing to delete every cassette in ${config.cassetteDir} without --yes`);
    return 1;
  }

  const store = await openStore(config.cassetteDir, logger);
  const entries = store.all();
  const targets = new Map();

  if (all) {
    for (const entry of entries) targets.set(entry.meta.file, entry);
  } else {
    for (const id of ids) {
      const exact = entries.filter(
        (entry) => entry.meta.id === id || entry.meta.file === id,
      );
      if (exact.length > 0) {
        for (const entry of exact) targets.set(entry.meta.file, entry);
        continue;
      }
      const prefixMatches = entries.filter(
        (entry) => entry.meta.id.startsWith(id) || entry.meta.hash.startsWith(id),
      );
      if (prefixMatches.length === 0) {
        logger.error(`no cassette matches "${id}"`);
        return 1;
      }
      if (prefixMatches.length > 1) {
        logger.error(
          `"${id}" is ambiguous (${prefixMatches.length} matches); use a longer id`,
        );
        return 1;
      }
      targets.set(prefixMatches[0].meta.file, prefixMatches[0]);
    }
  }

  const base = path.resolve(config.cassetteDir);
  let removed = 0;
  for (const file of targets.keys()) {
    const resolved = path.resolve(base, file);
    if (
      path.dirname(resolved) !== base ||
      path.basename(resolved) !== file ||
      !resolved.endsWith(".json")
    ) {
      logger.error(`refusing to remove unexpected path: ${resolved}`);
      continue;
    }
    await fs.unlink(resolved);
    removed += 1;
  }
  process.stdout.write(
    `\n  removed ${removed} cassette${removed === 1 ? "" : "s"} from ${config.cassetteDir}\n\n`,
  );
  return 0;
}

async function initConfig(_config, { force, cassette, configPath }) {
  const file = configPath
    ? path.resolve(process.cwd(), configPath)
    : path.join(process.cwd(), "llm-vcr.config.json");
  const exists = await fs
    .access(file)
    .then(() => true)
    .catch(() => false);
  if (exists && !force) {
    process.stderr.write(
      `llm-vcr: ${file} already exists (use --force to overwrite)\n`,
    );
    return 1;
  }

  const body = {
    cassetteDir: cassette || "./cassettes",
    mode: "auto",
    port: 8484,
    speed: 0,
  };
  await fs.writeFile(file, `${JSON.stringify(body, null, 2)}\n`, "utf8");
  await fs.mkdir(path.resolve(process.cwd(), body.cassetteDir), { recursive: true });
  const keep = path.resolve(process.cwd(), body.cassetteDir, ".gitkeep");
  await fs.writeFile(keep, "", { flag: "a" });

  process.stdout.write(`
  Created ${file}
  Created ${path.relative(process.cwd(), path.dirname(keep))}/

  Next:
    npx llm-vcr-proxy run -- <your test command>
    git add ${body.cassetteDir} && git commit -m "add LLM cassettes"
`);
  return 0;
}

function showRoutes(config) {
  process.stdout.write("\n");
  const priority = ["/openai", "/anthropic", "/google", "/ollama"];
  const routes = [...config.routes].sort((a, b) => {
    if (a.prefix === "/") return 1;
    if (b.prefix === "/") return -1;
    const ai = priority.indexOf(a.prefix);
    const bi = priority.indexOf(b.prefix);
    if (ai !== -1 || bi !== -1) {
      return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
    }
    return a.prefix.localeCompare(b.prefix);
  });
  for (const route of routes) {
    const env = route.env
      ? Object.keys(route.env)
          .map((name) => `  ${name}`)
          .join("")
      : "";
    process.stdout.write(
      `  ${route.prefix.padEnd(14)} → ${route.target}${env ? `\n  ${" ".repeat(14)}   ${env.trim()}` : ""}\n`,
    );
  }
  process.stdout.write("\n");
  return 0;
}

export async function main(argv) {
  let parsed;
  try {
    parsed = parseCli(argv);
  } catch (error) {
    process.stderr.write(`llm-vcr: ${error.message}\n`);
    return 1;
  }

  const { command, values, positionals, commandArgs, cli } = parsed;

  if (values.version) {
    process.stdout.write(`llm-vcr ${VERSION}\n`);
    return 0;
  }
  if (values.help || command === "help") {
    printHelp();
    return 0;
  }
  if (command === "run" && commandArgs.length === 0) {
    process.stderr.write(
      "llm-vcr: `run` needs a command, e.g. llm-vcr run -- npm test\n",
    );
    return 1;
  }

  if (command === "init") {
    return initConfig(null, {
      force: values.force,
      cassette: values.cassette || values.cassettes,
      configPath: values.config,
    });
  }

  let config;
  try {
    config = buildConfig(cli, { cwd: process.cwd() });
  } catch (error) {
    process.stderr.write(`llm-vcr: ${error.message}\n`);
    return 1;
  }

  const logger = createLogger({
    quiet: config.quiet,
    verbose: config.verbose,
    color: config.color,
  });

  if (command === "serve" || command === "record" || command === "replay") {
    return serve(config, logger);
  }
  if (command === "run") {
    return run(config, logger, commandArgs);
  }
  if (command === "ls") {
    return listCassettes(config, logger, values);
  }
  if (command === "rm") {
    return removeCassettes(config, logger, positionals, values);
  }
  if (command === "routes") {
    return showRoutes(config);
  }

  logger.error(`unhandled command: ${command}`);
  return 1;
}
