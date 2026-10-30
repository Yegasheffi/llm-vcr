import type { Server } from "node:http";

export type Mode = "auto" | "record" | "replay" | "passthrough";

export interface RouteConfig {
  /** Local path prefix, e.g. "/openai". "/" is the fallback route. */
  prefix: string;
  /** Upstream base URL, without query or hash. */
  target: string;
  provider?: string;
  label?: string;
  /**
   * Environment variables to inject in `llm-vcr run`. Values are path
   * suffixes appended to the local proxy URL.
   */
  env?: Record<string, string>;
}

export interface ScrubOptions {
  /** Environment variable names whose values must never reach a cassette. */
  envNames?: string[];
  /** Extra regular expressions (or regex source strings) to redact. */
  patterns?: Array<string | RegExp>;
  /** Redact credential-looking environment values automatically. Default true. */
  autoScrubEnv?: boolean;
}

export interface ProxyOptions {
  mode?: Mode;
  cassetteDir: string;
  host?: string;
  port?: number;
  /** Replay speed: 0 = instant (default), 1 = real time, 2 = twice as fast. */
  speed?: number;
  routes?: RouteConfig[];
  target?: string;
  provider?: string;
  matchHeaders?: string[];
  ignoreBodyPaths?: string[];
  scrub?: ScrubOptions;
  cors?: boolean;
  maxBodyBytes?: number;
  quiet?: boolean;
  verbose?: boolean;
  color?: boolean;
  noEnv?: boolean;
  configFile?: string | null;
  cwd?: string;
}

export interface ResolvedConfig extends ProxyOptions {
  command: string;
  cassetteDir: string;
  host: string;
  port: number;
  speed: number;
  routes: RouteConfig[];
  matchHeaders: string[];
  ignoreBodyPaths: string[];
  scrub: ScrubOptions;
  cors: boolean;
  maxBodyBytes: number;
}

export interface Counters {
  requests: number;
  recorded: number;
  replayed: number;
  misses: number;
  passthrough: number;
  errors: number;
}

export interface ProxyStats extends Counters {
  uptimeMs: number;
  cassettes: {
    interactions: number;
    hashes: number;
    bytes: number;
    dir: string;
  };
}

export interface ProxyInstance {
  server: Server;
  port: number;
  /** e.g. http://127.0.0.1:8484 */
  url: string;
  store: CassetteStore;
  config: ResolvedConfig;
  counters: Counters;
  stats(): ProxyStats;
  /** Wait for cassette writes that were scheduled after a response ended. */
  flush(): Promise<void>;
  close(): Promise<void>;
}

export interface StreamChunk {
  /** Milliseconds since the request started. */
  at: number;
  data: string;
  encoding?: "base64";
}

export interface CassetteRequest {
  method: string;
  url: string;
  origin?: string;
  path: string;
  localPath?: string;
  query: Record<string, string | string[]>;
  headers: Record<string, string | string[]>;
  body: unknown;
  bodyType: "json" | "text" | "base64" | "empty";
  size?: number;
}

export interface CassetteResponse {
  status: number;
  statusText?: string;
  headers: Record<string, string | string[]>;
  body: unknown;
  bodyType: "json" | "text" | "base64" | "empty";
  stream?: {
    ttfbMs: number;
    durationMs: number;
    chunks: StreamChunk[];
  };
}

export interface CassetteMeta {
  id: string;
  hash: string;
  seq: number;
  createdAt: string;
  provider?: string;
  route?: string;
  method?: string;
  status?: number;
  model?: string;
  stream?: boolean;
  chunks?: number;
  ttfbMs?: number | null;
  durationMs?: number;
  requestBytes?: number;
  responseBytes?: number;
  upstream?: string;
  clientAborted?: boolean;
  file?: string;
  size?: number;
}

export interface Cassette {
  format: "llm-vcr/1";
  meta: CassetteMeta;
  request: CassetteRequest;
  response: CassetteResponse;
}

export interface Logger {
  quiet?: boolean;
  verbose?: boolean;
  info(message?: string): void;
  debug(message: string): void;
  warn(message: string): void;
  error(message: string): void;
  request(info: Record<string, unknown>): void;
  banner(config: ResolvedConfig, info: Record<string, unknown>): void;
  summary(counters: Counters): void;
}

export interface SignaturePayload {
  method: string;
  origin: string;
  path: string;
  query: Array<[string, string]>;
  headers: Record<string, string>;
  body: { value: unknown; encoding: "json" | "text" | "base64" | "empty" };
}

export interface Signature {
  hash: string;
  payload: SignaturePayload;
}

export interface Scrubber {
  scrubString(value: string): string;
  scrubDeep<T>(value: T): T;
  rules: Array<{ from: RegExp; to: string }>;
  envNames: string[];
}

export interface Mismatch {
  score: number;
  diffs: Array<{ path: string; expected: string; actual: string }>;
}

export interface ClosestMatch extends Mismatch {
  entry: Cassette;
}

export declare function createProxy(
  config: ProxyOptions | ResolvedConfig,
  options?: { logger?: Logger },
): Promise<ProxyInstance>;

export declare function buildConfig(
  cli?: Record<string, unknown>,
  options?: { cwd?: string; env?: NodeJS.ProcessEnv },
): ResolvedConfig;

export declare function buildRunEnv(
  config: ResolvedConfig,
  proxyUrl: string,
  env?: NodeJS.ProcessEnv,
): { env: Record<string, string>; changed: Record<string, string> };

export declare function routeForPath(
  routes: RouteConfig[],
  pathname: string,
): { route: RouteConfig; rest: string } | null;

export declare function proxyBaseUrl(config: ProxyOptions, port: number): string;

export declare class CassetteStore {
  constructor(options: { dir: string; logger?: Logger | null });
  dir: string;
  warnings: string[];
  init(): Promise<this>;
  readonly size: number;
  readonly hashCount: number;
  stats(): { interactions: number; hashes: number; bytes: number; dir: string };
  all(): Cassette[];
  entriesFor(hash: string): Cassette[];
  take(hash: string): Cassette | null;
  hasUnplayed(hash: string): boolean;
  closest(
    incoming: Signature,
    options?: { matchHeaders?: string[]; ignoreBodyPaths?: string[]; limit?: number },
  ): ClosestMatch | null;
  record(
    hash: string,
    record: {
      request: CassetteRequest;
      response: CassetteResponse;
      meta: Partial<CassetteMeta>;
    },
    options?: { overwrite?: boolean },
  ): Promise<Cassette>;
  explainMiss(
    incoming: Signature,
    options?: { matchHeaders?: string[]; ignoreBodyPaths?: string[]; limit?: number },
  ): ClosestMatch | null;
}

export declare function openStore(dir: string, logger?: Logger | null): Promise<CassetteStore>;

export declare function buildSignature(input: {
  method: string;
  url: string;
  headers?: Record<string, string | string[]>;
  body?: unknown;
  bodyType?: "json" | "text" | "base64" | "empty";
  matchHeaders?: string[];
  ignoreBodyPaths?: string[];
}): Signature;

export declare function explainMismatch(
  entry: Cassette,
  incoming: Signature,
  options?: { matchHeaders?: string[]; ignoreBodyPaths?: string[]; limit?: number },
): Mismatch;

export declare function findClosest(
  entries: Cassette[],
  incoming: Signature,
  options?: { matchHeaders?: string[]; ignoreBodyPaths?: string[]; limit?: number },
): ({ entry: Cassette } & Mismatch) | null;

export declare function omitBodyPaths<T>(body: T, paths: string[]): T;

export declare function createScrubber(options?: {
  envNames?: string[];
  patterns?: Array<string | RegExp>;
  env?: NodeJS.ProcessEnv;
  autoScrubEnv?: boolean;
}): Scrubber;

export declare const REDACTED = "[REDACTED]";

export declare function redactHeaders(
  headers: Record<string, string | string[]>,
  scrubber: Scrubber,
): Record<string, string | string[]>;

export declare function redactQuery(
  entries: Array<[string, string]>,
  scrubber: Scrubber,
): Record<string, string | string[]>;

export declare function redactUrl(url: string, scrubber: Scrubber): string;

export declare function createLogger(options?: {
  quiet?: boolean;
  verbose?: boolean;
  color?: boolean;
  version?: string;
}): Logger;

export declare const nullLogger: Logger;
export declare const VERSION: string;
export declare const ADMIN_PREFIX: string;
export declare const CASSETTE_FORMAT: "llm-vcr/1";
