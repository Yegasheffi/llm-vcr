import { buildConfig } from "../../src/config.js";
import { createProxy } from "../../src/proxy.js";
import { nullLogger } from "../../src/logger.js";

/**
 * Build a proxy against a temporary cassette dir. `routes` are prefix=url
 * strings, matching the --route CLI flag.
 */
export async function makeProxy({
  dir,
  upstream,
  mode = "record",
  speed = 0,
  route = null,
  routes = null,
  matchHeaders = [],
  ignoreBodyPaths = [],
  env = {},
  host = "127.0.0.1",
  configFile = null,
} = {}) {
  const routeList = routes || route || (upstream ? [`/up=${upstream}`] : []);
  const config = buildConfig(
    {
      command: "serve",
      cassette: dir,
      mode,
      port: "0",
      host,
      speed: String(speed),
      matchHeaders: matchHeaders.join(","),
      ignoreBody: ignoreBodyPaths.join(","),
      route: routeList,
      config: configFile,
    },
    { cwd: dir, env: { ...process.env, ...env } },
  );
  return createProxy(config, { logger: nullLogger });
}
