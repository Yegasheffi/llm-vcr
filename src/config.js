import fs from "node:fs";
import path from "node:path";
import { defaultRoutes, getProvider } from "./providers.js";

export class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = "ConfigError";
  }
}

const CONFIG_NAMES = ["llm-vcr.config.json", ".llm-vcr.json", ".llm-vcrrc"];

const DEFAULTS = {
  mode: "auto",
  cassetteDir: "cassettes",
  host: "127.0.0.1",
  speed: 0,
  cors: false,
  matchHeaders: [],
  ignoreBodyPaths: [],
  maxBodyBytes: 100 * 1024 * 1024,
};

const MODES = new Set(["auto", "record", "replay", "passthrough"]);

function splitList(value) {
  if (value === undefined || value === null) return [];
  const items = Array.isArray(value) ? value : String(value).split(",");
  return items.map((item) => String(item).trim()).filter(Boolean);
}

function normalizePrefix(prefix) {
  let value = String(prefix || "").trim();
  if (!value) throw new ConfigError("Route prefix cannot be empty.");
  if (!value.startsWith("/")) value = `/${value}`;
  if (value.length > 1) value = value.replace(/\/+$/, "");
  return value;
}

function normalizeTarget(target, context = "target") {
  let url;
  try {
    url = new URL(String(target));
  } catch {
    throw new ConfigError(`Invalid ${context} URL: ${target}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ConfigError(`Invalid ${context} URL (must be http/https): ${target}`);
  }
  if (url.search || url.hash) {
    throw new ConfigError(`Invalid ${context} URL (query/hash not allowed): ${target}`);
  }
  const pathname = url.pathname.replace(/\/+$/, "");
  return `${url.origin}${pathname === "/" ? "" : pathname}`;
}

function findConfigFile(startDir) {
  let dir = path.resolve(startDir);
  for (let depth = 0; depth < 25; depth += 1) {
    for (const name of CONFIG_NAMES) {
      const candidate = path.join(dir, name);
      if (fs.existsSync(candidate)) return candidate;
    }
    const pkg = path.join(dir, "package.json");
    if (fs.existsSync(pkg)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(pkg, "utf8"));
        if (parsed["llm-vcr"]) return { packageJson: pkg, data: parsed["llm-vcr"] };
      } catch {
        // Ignore malformed package.json; another config may still exist.
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function loadConfigFile(explicitPath, cwd) {
  if (explicitPath) {
    const resolved = path.resolve(cwd, explicitPath);
    if (!fs.existsSync(resolved)) {
      throw new ConfigError(`Config file not found: ${resolved}`);
    }
    try {
      const text = fs.readFileSync(resolved, "utf8").replace(/^\uFEFF/, "");
      return { file: resolved, data: JSON.parse(text), baseDir: path.dirname(resolved) };
    } catch (error) {
      throw new ConfigError(`Could not read config ${resolved}: ${error.message}`);
    }
  }

  const found = findConfigFile(cwd);
  if (!found) return { file: null, data: {}, baseDir: cwd };
  if (typeof found === "string") {
    try {
      const text = fs.readFileSync(found, "utf8").replace(/^\uFEFF/, "");
      return { file: found, data: JSON.parse(text), baseDir: path.dirname(found) };
    } catch (error) {
      throw new ConfigError(`Could not read config ${found}: ${error.message}`);
    }
  }
  if (found.data && typeof found.data === "object") {
    return {
      file: found.packageJson,
      data: found.data,
      baseDir: path.dirname(found.packageJson),
    };
  }
  return { file: found.packageJson, data: {}, baseDir: path.dirname(found.packageJson) };
}

function mergeRoute(map, route, origin) {
  const prefix = normalizePrefix(route.prefix);
  const previous = map.get(prefix);
  const target = route.target ? normalizeTarget(route.target, `route ${prefix} target`) : previous?.target;
  if (!target) throw new ConfigError(`Route ${prefix} is missing a target URL.`);

  let env = route.env !== undefined ? route.env : previous?.env;
  if (env !== undefined && (env === null || typeof env !== "object" || Array.isArray(env))) {
    throw new ConfigError(`Route ${prefix} env must be an object of ENV_VAR: path-suffix.`);
  }

  map.set(prefix, {
    prefix,
    target,
    provider: route.provider || previous?.provider || prefix.slice(1) || "custom",
    label: route.label || previous?.label || route.provider || prefix.slice(1) || "Custom",
    env: env || undefined,
    origin,
  });
}

function parseRouteFlag(value) {
  const text = String(value);
  const index = text.indexOf("=");
  if (index <= 0) {
    throw new ConfigError(`--route expects prefix=url, received: ${value}`);
  }
  return { prefix: text.slice(0, index), target: text.slice(index + 1) };
}

function parsePort(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new ConfigError(`Invalid port: ${value}`);
  }
  return port;
}

function parseSpeed(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  const speed = Number(value);
  if (!Number.isFinite(speed) || speed < 0) {
    throw new ConfigError(`Invalid --speed value: ${value} (use 0 for instant, 1 for real time)`);
  }
  return speed;
}

function parseMode(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  const mode = String(value).toLowerCase();
  if (!MODES.has(mode)) {
    throw new ConfigError(`Invalid mode "${value}". Use one of: ${[...MODES].join(", ")}`);
  }
  return mode;
}

function normalizeIgnorePath(value) {
  return String(value)
    .trim()
    .replace(/^\$\.?/, "")
    .replace(/\[(\*|\d+)\]/g, ".$1")
    .replace(/^\./, "");
}

/**
 * Merge defaults, the config file, environment variables and CLI flags into a
 * single immutable-ish options object consumed by the proxy and CLI.
 */
export function buildConfig(cli = {}, { cwd = process.cwd(), env = process.env } = {}) {
  const command = cli.command || "serve";
  const loaded = loadConfigFile(cli.config || env.LLM_VCR_CONFIG, cwd);
  const file = loaded.data || {};
  const baseDir = loaded.baseDir;

  const routes = new Map();
  for (const route of defaultRoutes()) mergeRoute(routes, route, "preset");
  for (const route of Array.isArray(file.routes) ? file.routes : []) {
    mergeRoute(routes, route, "config");
  }
  for (const raw of Array.isArray(cli.route) ? cli.route : []) {
    mergeRoute(routes, parseRouteFlag(raw), "cli");
  }

  let providerPreset = null;
  if (cli.provider) {
    providerPreset = getProvider(cli.provider);
    if (!cli.target) {
      mergeRoute(
        routes,
        {
          prefix: "/",
          target: providerPreset.target,
          provider: providerPreset.name,
          label: providerPreset.label,
          env: providerPreset.env,
        },
        "cli",
      );
    }
  }

  const existingDefault = routes.get("/");
  const defaultTarget =
    cli.target ||
    file.target ||
    env.LLM_VCR_TARGET ||
    providerPreset?.target ||
    existingDefault?.target ||
    "https://api.openai.com";

  mergeRoute(
    routes,
    {
      prefix: "/",
      target: defaultTarget,
      provider:
        providerPreset?.name ||
        existingDefault?.provider ||
        file.provider ||
        (defaultTarget.includes("api.openai.com") ? "openai" : "custom"),
      label:
        providerPreset?.label ||
        existingDefault?.label ||
        file.provider ||
        (defaultTarget.includes("api.openai.com") ? "OpenAI" : "Default"),
      env: providerPreset?.env,
    },
    "default",
  );

  const mode = parseMode(cli.mode ?? env.LLM_VCR_MODE ?? file.mode, DEFAULTS.mode);
  const cassetteFromCli = cli.cassette || cli.cassettes || env.LLM_VCR_CASSETTE_DIR;
  const cassetteDir = cassetteFromCli
    ? path.resolve(cwd, cassetteFromCli)
    : path.resolve(baseDir, file.cassetteDir || DEFAULTS.cassetteDir);
  const port = parsePort(cli.port ?? env.LLM_VCR_PORT ?? file.port, command === "run" ? 0 : 8484);
  const speed = parseSpeed(cli.speed ?? env.LLM_VCR_SPEED ?? file.speed, DEFAULTS.speed);
  const host = cli.host || env.LLM_VCR_HOST || file.host || DEFAULTS.host;

  const matchHeaders = [
    ...splitList(file.matchHeaders),
    ...splitList(cli.matchHeaders),
  ].map((name) => name.toLowerCase());
  const ignoreBodyPaths = [
    ...splitList(file.ignoreBodyPaths),
    ...splitList(cli.ignoreBody),
  ].map(normalizeIgnorePath);

  const fileScrub = file.scrub || {};
  const scrub = {
    envNames: [
      ...splitList(fileScrub.env || file.scrubEnv),
      ...splitList(cli.scrubEnv),
    ].filter(Boolean),
    patterns: [
      ...splitList(fileScrub.patterns || file.scrubPatterns),
      ...splitList(cli.scrubPattern),
    ],
    autoScrubEnv:
      cli.autoScrubEnv === false
        ? false
        : fileScrub.autoScrubEnv !== false,
  };

  const quiet = Boolean(cli.quiet);
  const verbose = Boolean(cli.verbose) && !quiet;
  const color =
    cli.color !== false &&
    !env.NO_COLOR &&
    Boolean(process.stdout.isTTY) &&
    env.TERM !== "dumb";

  return {
    command,
    cwd,
    configFile: loaded.file,
    mode,
    cassetteDir,
    port,
    host,
    speed,
    routes: [...routes.values()].sort((a, b) => {
      if (a.prefix === "/") return 1;
      if (b.prefix === "/") return -1;
      return b.prefix.length - a.prefix.length;
    }),
    matchHeaders: [...new Set(matchHeaders)],
    ignoreBodyPaths,
    scrub,
    cors: Boolean(cli.cors || file.cors),
    maxBodyBytes:
      Number(file.maxBodyBytes) > 0 ? Number(file.maxBodyBytes) : DEFAULTS.maxBodyBytes,
    quiet,
    verbose,
    color,
    noEnv: Boolean(cli.noEnv),
  };
}

export function routeForPath(routes, pathname) {
  for (const route of routes) {
    if (route.prefix === "/") return { route, rest: pathname || "/" };
    if (pathname === route.prefix) return { route, rest: "/" };
    if (pathname.startsWith(`${route.prefix}/`)) {
      return { route, rest: pathname.slice(route.prefix.length) };
    }
  }
  return null;
}

export function proxyBaseUrl(config, port) {
  let host = config.host;
  if (host === "0.0.0.0" || host === "::") host = "127.0.0.1";
  if (host.includes(":") && !host.startsWith("[")) host = `[${host}]`;
  return `http://${host}:${port}`;
}

/** Environment variables that point official SDKs at the running proxy. */
export function buildRunEnv(config, proxyUrl, env = process.env) {
  const injected = {};
  const assigned = new Set();
  for (const route of config.routes) {
    if (!route.env) continue;
    for (const [name, suffix] of Object.entries(route.env)) {
      // Routes are ordered most-specific first; the first route to define a
      // variable wins, so the fallback "/" route cannot clobber a named one.
      if (assigned.has(name)) continue;
      assigned.add(name);
      const base = route.prefix === "/" ? proxyUrl : `${proxyUrl}${route.prefix}`;
      const pathSuffix = suffix
        ? suffix.startsWith("/")
          ? suffix
          : `/${suffix}`
        : "";
      injected[name] = `${base}${pathSuffix}`;
    }
  }
  injected.LLM_VCR = "1";
  injected.LLM_VCR_URL = proxyUrl;
  injected.LLM_VCR_PROXY_URL = proxyUrl;

  const changed = {};
  for (const [name, value] of Object.entries(injected)) {
    if (env[name] !== undefined && env[name] !== value) changed[name] = env[name];
  }
  return { env: injected, changed };
}
