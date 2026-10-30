import http from "node:http";
import https from "node:https";
import { performance } from "node:perf_hooks";
import { StringDecoder } from "node:string_decoder";
import { routeForPath, proxyBaseUrl } from "./config.js";
import {
  createScrubber,
  redactHeaders,
  redactQuery,
  redactUrl,
} from "./redact.js";
import { buildSignature } from "./matcher.js";
import { openStore } from "./store.js";
import { defaultRoutes } from "./providers.js";
import { nullLogger } from "./logger.js";
import {
  decompressBuffer,
  decodeBody,
  encodeBody,
  formatBytes,
  headerString,
  isStreamType,
  onceDrainOrClose,
  sleepUntil,
} from "./util.js";

const ADMIN_PREFIX = "/__llm_vcr";
const MODES = new Set(["auto", "record", "replay", "passthrough"]);
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

class PayloadTooLarge extends Error {
  constructor(limit) {
    super(`Request body exceeds the ${formatBytes(limit)} limit.`);
    this.statusCode = 413;
  }
}

function sendJson(res, status, value, extraHeaders = {}) {
  if (res.destroyed || res.writableEnded) return;
  const body = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": String(body.length),
    ...extraHeaders,
  });
  res.end(body);
}

function readRequestBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    if (req.method === "GET" || req.method === "HEAD") {
      req.resume();
      resolve(Buffer.alloc(0));
      return;
    }
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new PayloadTooLarge(maxBytes));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
    req.on("aborted", () => reject(new Error("client aborted request")));
  });
}

function sanitizeRequestHeaders(headers, { recording }) {
  const out = {};
  for (const [name, value] of Object.entries(headers)) {
    const key = name.toLowerCase();
    if (HOP_BY_HOP.has(key) || key === "host" || key === "content-length") continue;
    if (key.startsWith("x-llm-vcr-")) continue;
    if (key === "accept-encoding") {
      if (!recording) out[key] = value;
      continue;
    }
    out[key] = value;
  }
  if (recording) out["accept-encoding"] = "identity";
  return out;
}

function sanitizeResponseHeaders(headers, { stripEncoding = false } = {}) {
  const out = {};
  for (const [name, value] of Object.entries(headers || {})) {
    const key = name.toLowerCase();
    if (HOP_BY_HOP.has(key) || key === "content-length") continue;
    if (stripEncoding && key === "content-encoding") continue;
    out[key] = value;
  }
  return out;
}

function buildUpstreamUrl(route, rest, search = "") {
  const base = new URL(route.target);
  const basePath = base.pathname.replace(/\/+$/, "");
  const pathname = `${basePath}${rest.startsWith("/") ? rest : `/${rest}`}` || "/";
  return new URL(`${base.origin}${pathname}${search}`);
}

function extractModel(bodyInfo, responseInfo) {
  const fromRequest = bodyInfo?.bodyType === "json" ? bodyInfo.body?.model : undefined;
  if (typeof fromRequest === "string" && fromRequest) return fromRequest;
  const fromResponse =
    responseInfo?.bodyType === "json" ? responseInfo.body?.model : undefined;
  return typeof fromResponse === "string" && fromResponse ? fromResponse : undefined;
}

function statusTextFor(statusCode) {
  return http.STATUS_CODES[statusCode] || "";
}

function shortId(id = "") {
  return id.length > 22 ? `${id.slice(0, 22)}…` : id;
}

/**
 * Start the record/replay proxy. The returned object exposes the underlying
 * HTTP server, the resolved URL, the cassette store and live counters.
 */
export async function createProxy(rawConfig = {}, { logger = nullLogger } = {}) {
  const config = {
    command: "serve",
    mode: "auto",
    host: "127.0.0.1",
    port: 8484,
    speed: 0,
    matchHeaders: [],
    ignoreBodyPaths: [],
    scrub: {},
    cors: false,
    maxBodyBytes: 100 * 1024 * 1024,
    ...rawConfig,
    routes:
      rawConfig.routes && rawConfig.routes.length > 0
        ? rawConfig.routes
        : [
            ...defaultRoutes(),
            {
              prefix: "/",
              target: rawConfig.target || "https://api.openai.com",
              provider: rawConfig.provider || "openai",
              label: "Default",
            },
          ],
  };
  const scrubber = createScrubber(config.scrub);
  const store = await openStore(config.cassetteDir, logger);
  const counters = {
    requests: 0,
    recorded: 0,
    replayed: 0,
    misses: 0,
    passthrough: 0,
    errors: 0,
  };
  const startedAt = Date.now();
  const pendingSaves = new Set();

  function trackSave(promise) {
    pendingSaves.add(promise);
    promise.finally(() => pendingSaves.delete(promise));
    return promise;
  }

  function applyCors(req, res) {
    if (!config.cors) return;
    res.setHeader("access-control-allow-origin", req.headers.origin || "*");
    res.setHeader(
      "access-control-allow-methods",
      "GET, POST, PUT, PATCH, DELETE, OPTIONS",
    );
    res.setHeader(
      "access-control-allow-headers",
      req.headers["access-control-request-headers"] || "*",
    );
    res.setHeader(
      "access-control-expose-headers",
      "x-llm-vcr-mode, x-llm-vcr-cassette, x-llm-vcr-error",
    );
    res.setHeader("access-control-max-age", "86400");
  }

  function handleAdmin(req, res, url) {
    if (req.method !== "GET" && req.method !== "HEAD") {
      sendJson(res, 405, { error: { message: "Method not allowed" } });
      return;
    }
    if (url.pathname === `${ADMIN_PREFIX}/health`) {
      sendJson(res, 200, {
        ok: true,
        mode: config.mode,
        cassettes: store.size,
        uptimeMs: Date.now() - startedAt,
      });
      return;
    }
    if (url.pathname === `${ADMIN_PREFIX}/stats`) {
      sendJson(res, 200, {
        ok: true,
        mode: config.mode,
        speed: config.speed,
        uptimeMs: Date.now() - startedAt,
        counters: { ...counters },
        cassettes: store.stats(),
      });
      return;
    }
    if (url.pathname === `${ADMIN_PREFIX}/routes`) {
      sendJson(res, 200, {
        routes: config.routes.map((route) => ({
          prefix: route.prefix,
          target: route.target,
          provider: route.provider,
        })),
      });
      return;
    }
    if (url.pathname === `${ADMIN_PREFIX}/cassettes`) {
      sendJson(res, 200, {
        cassettes: store.all().map((entry) => ({
          id: entry.meta.id,
          hash: entry.meta.hash,
          createdAt: entry.meta.createdAt,
          method: entry.request?.method,
          path: entry.request?.path,
          status: entry.response?.status,
          model: entry.meta.model,
          stream: Boolean(entry.response?.stream),
          chunks: entry.response?.stream?.chunks?.length || 0,
        })),
      });
      return;
    }
    sendJson(res, 200, {
      name: "llm-vcr",
      endpoints: [
        `${ADMIN_PREFIX}/health`,
        `${ADMIN_PREFIX}/stats`,
        `${ADMIN_PREFIX}/routes`,
        `${ADMIN_PREFIX}/cassettes`,
      ],
    });
  }

  function sendNoMatch(req, res, ctx) {
    const closest = store.closest(ctx.signature, {
      matchHeaders: config.matchHeaders,
      ignoreBodyPaths: config.ignoreBodyPaths,
    });

    const lines = [
      "llm-vcr: no recorded response matches this request.",
      "",
      `  ${ctx.method} ${ctx.redactedUpstream}`,
      `  cassette dir: ${config.cassetteDir} (${store.size} interaction${store.size === 1 ? "" : "s"})`,
    ];
    if (closest) {
      lines.push("");
      lines.push(
        `  closest match: ${shortId(closest.entry.meta.id)} (${Math.round(closest.score * 100)}% similar)`,
      );
      for (const diff of closest.diffs.slice(0, 4)) {
        lines.push(`    ${diff.path}`);
        lines.push(`      recorded: ${diff.expected}`);
        lines.push(`      request:  ${diff.actual}`);
      }
    } else {
      lines.push("");
      lines.push("  No cassettes exist yet.");
    }
    lines.push("");
    lines.push("  Fix: run with `--mode auto` to record this request, or re-record");
    lines.push("       with `llm-vcr record` and commit the updated cassettes.");
    const message = lines.join("\n");

    counters.misses += 1;
    logger.request({
      method: ctx.method,
      path: ctx.localPath,
      status: 502,
      mode: "miss",
      durationMs: performance.now() - ctx.started,
      error: "no matching cassette",
      route: ctx.upstreamUrl.origin,
    });
    sendJson(
      res,
      502,
      {
        error: {
          message,
          type: "llm_vcr_no_match",
          param: null,
          code: "no_match",
        },
      },
      { "x-should-retry": "false", "x-llm-vcr-error": "no_match" },
    );
  }

  async function replay(entry, req, res, ctx, speed) {
    if (res.destroyed) return;
    const response = entry.response || {};
    const status = response.status || 200;
    const headers = sanitizeResponseHeaders(response.headers, { stripEncoding: true });
    headers["x-llm-vcr-mode"] = "replay";
    headers["x-llm-vcr-cassette"] = entry.meta.id;
    if (entry.meta.createdAt) headers["x-llm-vcr-recorded-at"] = entry.meta.createdAt;

    if (req.method === "HEAD") {
      res.writeHead(status, headers);
      res.end();
    } else if (response.stream) {
      res.writeHead(status, headers);
      res.flushHeaders?.();
      const chunks = response.stream.chunks || [];
      const replayStarted = Date.now();
      let lastAt = 0;
      let aborted = false;
      res.on("close", () => {
        if (!res.writableFinished) aborted = true;
      });
      for (const chunk of chunks) {
        if (aborted || res.destroyed) return;
        const at = Math.max(lastAt, Number(chunk.at) || 0);
        lastAt = at;
        if (speed > 0) {
          await sleepUntil(replayStarted + at / speed);
        }
        if (aborted || res.destroyed || res.writableEnded) return;
        const buffer =
          chunk.encoding === "base64"
            ? Buffer.from(chunk.data, "base64")
            : Buffer.from(String(chunk.data), "utf8");
        if (!res.write(buffer)) await onceDrainOrClose(res);
      }
      if (!res.destroyed && !res.writableEnded) res.end();
    } else {
      const body = decodeBody(response);
      if (status !== 204 && status !== 304) headers["content-length"] = String(body.length);
      res.writeHead(status, headers);
      res.end(status === 204 || status === 304 ? undefined : body);
    }

    counters.replayed += 1;
    logger.request({
      method: ctx.method,
      path: ctx.localPath,
      status,
      mode: "replay",
      chunks: response.stream?.chunks?.length || 0,
      durationMs: performance.now() - ctx.started,
      id: entry.meta.id,
      route: entry.meta.upstream,
    });
  }

  function persist(record, overwrite, ctx, status) {
    return trackSave(
      store
        .record(ctx.signature.hash, record, { overwrite })
        .then((entry) => {
          counters.recorded += 1;
          logger.request({
            method: ctx.method,
            path: ctx.localPath,
            status,
            mode: "record",
            chunks: record.response?.stream?.chunks?.length || 0,
            durationMs: record.meta.durationMs,
            id: entry.meta.id,
            route: ctx.upstreamUrl.origin,
          });
          return entry;
        })
        .catch((error) => {
          counters.errors += 1;
          logger.error(`could not write cassette: ${error.message}`);
          return null;
        }),
    );
  }

  function requestRecord(ctx, { status, responseHeaders, bodyInfo, stream, ttfbMs, durationMs, responseBytes }) {
    const request = {
      method: ctx.method,
      url: ctx.redactedUpstream,
      origin: ctx.upstreamUrl.origin,
      path: ctx.upstreamUrl.pathname,
      localPath: ctx.localPath,
      query: ctx.redactedQuery,
      headers: ctx.redactedHeaders,
      body: ctx.scrubbedBody,
      bodyType: ctx.bodyType,
      size: ctx.bodyBuffer.length,
    };
    let responseBody = bodyInfo?.body ?? null;
    if (bodyInfo?.bodyType === "json") {
      responseBody = scrubber.scrubDeep(responseBody);
    } else if (bodyInfo?.bodyType === "text") {
      responseBody = scrubber.scrubString(responseBody);
    }
    const response = {
      status,
      statusText: statusTextFor(status),
      headers: redactHeaders(responseHeaders, scrubber),
      body: responseBody,
      bodyType: bodyInfo?.bodyType || "empty",
    };
    if (stream) {
      response.stream = {
        ttfbMs: ttfbMs ?? 0,
        durationMs,
        chunks: stream.chunks.map((chunk) =>
          chunk.encoding === "base64"
            ? chunk
            : { ...chunk, data: scrubber.scrubString(chunk.data) },
        ),
      };
    }
    const model = extractModel({ body: ctx.scrubbedBody, bodyType: ctx.bodyType }, bodyInfo);
    const meta = {
      provider: ctx.route.provider,
      route: ctx.route.prefix,
      method: ctx.method,
      status,
      model,
      stream: Boolean(stream),
      chunks: stream?.chunks?.length || 0,
      ttfbMs: ttfbMs ?? null,
      durationMs,
      requestBytes: ctx.bodyBuffer.length,
      responseBytes,
      upstream: ctx.redactedUpstream,
    };
    if (ctx.clientAborted) meta.clientAborted = true;
    return { request, response, meta };
  }

  function recordInteraction(ctx, req, res, { overwrite }) {
    return new Promise((resolve) => {
      const transport = ctx.upstreamUrl.protocol === "https:" ? https : http;
      const headers = sanitizeRequestHeaders(req.headers, { recording: true });
      if (ctx.bodyBuffer.length > 0) {
        headers["content-length"] = String(ctx.bodyBuffer.length);
      }

      let finished = false;
      let saved = false;
      const save = async (record, status) => {
        if (saved) return;
        saved = true;
        await persist(record, overwrite, ctx, status);
        resolve();
      };

      const upstreamReq = transport.request(
        ctx.upstreamUrl,
        { method: ctx.method, headers },
        (upstreamRes) => {
          if (res.destroyed) {
            upstreamRes.resume();
            resolve();
            return;
          }
          const status = upstreamRes.statusCode || 502;
          const contentType = headerString(upstreamRes.headers["content-type"]);
          const encoding = headerString(upstreamRes.headers["content-encoding"]).toLowerCase();
          const wantsStream = isStreamType(contentType);
          const canStream = wantsStream && (!encoding || encoding === "identity");
          const responseHeaders = sanitizeResponseHeaders(upstreamRes.headers, {
            stripEncoding: true,
          });

          if (canStream) {
            const chunks = [];
            const decoder = new StringDecoder("utf8");
            let ttfbMs = null;
            let responseBytes = 0;
            let clientGone = false;

            const push = (text) => {
              if (!text) return;
              const at = Math.round(performance.now() - ctx.started);
              if (ttfbMs === null) ttfbMs = at;
              chunks.push({ at, data: text });
              responseBytes += Buffer.byteLength(text, "utf8");
            };

            try {
              res.writeHead(status, responseHeaders);
              res.flushHeaders?.();
            } catch (error) {
              upstreamReq.destroy();
              fail(error);
              return;
            }

            upstreamRes.on("data", (buffer) => {
              if (clientGone) return;
              const text = decoder.write(buffer);
              if (!text) return;
              push(text);
              if (!res.write(text)) {
                upstreamRes.pause();
                res.once("drain", () => {
                  if (!res.destroyed && !clientGone) upstreamRes.resume();
                });
              }
            });

            upstreamRes.on("error", fail);
            upstreamRes.on("end", async () => {
              if (clientGone) return;
              finished = true;
              const tail = decoder.end();
              if (tail) {
                push(tail);
                if (!res.destroyed) res.write(tail);
              }
              const durationMs = Math.round(performance.now() - ctx.started);
              const record = requestRecord(ctx, {
                status,
                responseHeaders,
                bodyInfo: null,
                stream: { chunks },
                ttfbMs: ttfbMs ?? durationMs,
                durationMs,
                responseBytes,
              });
              // Persist before ending the response: a completed request must
              // be visible to the next request (and to tests that read disk).
              await save(record, status);
              if (!res.destroyed && !res.writableEnded) res.end();
            });

            res.on("close", () => {
              if (finished || res.writableFinished) return;
              clientGone = true;
              ctx.clientAborted = true;
              upstreamReq.destroy();
              if (chunks.length > 0) {
                const durationMs = Math.round(performance.now() - ctx.started);
                const record = requestRecord(ctx, {
                  status,
                  responseHeaders,
                  bodyInfo: null,
                  stream: { chunks },
                  ttfbMs: ttfbMs ?? durationMs,
                  durationMs,
                  responseBytes,
                });
                void save(record, status);
              } else {
                resolve();
              }
            });
            return;
          }

          // Buffered responses (JSON, binary, or a compressed SSE fallback).
          const buffers = [];
          upstreamRes.on("data", (buffer) => buffers.push(buffer));
          upstreamRes.on("error", (error) => fail(error));
          upstreamRes.on("end", async () => {
            let decoded = Buffer.concat(buffers);
            if (encoding && encoding !== "identity") {
              try {
                decoded = decompressBuffer(decoded, encoding);
              } catch (error) {
                fail(
                  new Error(
                    `could not decode ${encoding} response: ${error.message}`,
                  ),
                );
                return;
              }
            }
            finished = true;
            const bodyInfo = encodeBody(decoded, contentType);
            const durationMs = Math.round(performance.now() - ctx.started);
            const record = requestRecord(ctx, {
              status,
              responseHeaders,
              bodyInfo,
              stream: null,
              ttfbMs: null,
              durationMs,
              responseBytes: decoded.length,
            });
            await save(record, status);
            const outHeaders = { ...responseHeaders };
            if (ctx.method !== "HEAD") outHeaders["content-length"] = String(decoded.length);
            if (!res.destroyed && !res.writableEnded) {
              try {
                res.writeHead(status, outHeaders);
                res.end(ctx.method === "HEAD" ? undefined : decoded);
              } catch (error) {
                logger.warn(`could not send response: ${error.message}`);
                if (!res.destroyed) res.destroy();
              }
            }
          });
        },
      );

      function fail(error) {
        if (finished || saved) return;
        finished = true;
        if (error?.code === "ERR_STREAM_PREMATURE_CLOSE" || ctx.clientAborted) {
          resolve();
          return;
        }
        counters.errors += 1;
        logger.error(`upstream request failed: ${error.message}`);
        logger.request({
          method: ctx.method,
          path: ctx.localPath,
          status: 502,
          mode: "error",
          durationMs: performance.now() - ctx.started,
          error: error.code || error.message,
        });
        if (!res.headersSent) {
          sendJson(res, 502, {
            error: {
              message: `llm-vcr: upstream request failed: ${error.message}`,
              type: "llm_vcr_upstream_error",
              code: "upstream_error",
            },
          });
        } else if (!res.destroyed) {
          res.destroy();
        }
        resolve();
      }

      upstreamReq.on("error", fail);
      upstreamReq.on("timeout", () => upstreamReq.destroy(new Error("upstream timeout")));
      res.on("close", () => {
        if (finished || res.writableFinished) return;
        ctx.clientAborted = true;
        upstreamReq.destroy();
      });
      if (res.destroyed) {
        upstreamReq.destroy();
        return;
      }
      upstreamReq.end(ctx.bodyBuffer.length > 0 ? ctx.bodyBuffer : undefined);
    });
  }

  function passthrough(ctx, req, res) {
    return new Promise((resolve) => {
      const transport = ctx.upstreamUrl.protocol === "https:" ? https : http;
      const headers = sanitizeRequestHeaders(req.headers, { recording: false });
      if (ctx.bodyBuffer.length > 0) {
        headers["content-length"] = String(ctx.bodyBuffer.length);
      }
      const upstreamReq = transport.request(
        ctx.upstreamUrl,
        { method: ctx.method, headers },
        (upstreamRes) => {
          counters.passthrough += 1;
          upstreamRes.on("error", (error) => {
            if (!res.destroyed) res.destroy(error);
          });
          const headersOut = sanitizeResponseHeaders(upstreamRes.headers);
          if (upstreamRes.headers["content-length"]) {
            headersOut["content-length"] = upstreamRes.headers["content-length"];
          }
          res.writeHead(upstreamRes.statusCode || 502, headersOut);
          upstreamRes.pipe(res);
          upstreamRes.on("end", () => {
            logger.request({
              method: ctx.method,
              path: ctx.localPath,
              status: upstreamRes.statusCode,
              mode: "passthrough",
              durationMs: performance.now() - ctx.started,
              route: ctx.upstreamUrl.origin,
            });
            resolve();
          });
        },
      );
      upstreamReq.on("error", (error) => {
        counters.errors += 1;
        logger.error(`upstream request failed: ${error.message}`);
        if (!res.headersSent) {
          sendJson(res, 502, {
            error: {
              message: `llm-vcr: upstream request failed: ${error.message}`,
              type: "llm_vcr_upstream_error",
              code: "upstream_error",
            },
          });
        } else if (!res.destroyed) {
          res.destroy();
        }
        resolve();
      });
      res.on("close", () => {
        if (!res.writableFinished) {
          upstreamReq.destroy();
          resolve();
        }
      });
      upstreamReq.end(ctx.bodyBuffer.length > 0 ? ctx.bodyBuffer : undefined);
    });
  }

  async function handleRequest(req, res) {
    const started = performance.now();
    const url = new URL(req.url, "http://llm-vcr.local");
    applyCors(req, res);

    if (config.cors && req.method === "OPTIONS" && req.headers["access-control-request-method"]) {
      res.writeHead(204);
      res.end();
      return;
    }

    if (url.pathname === ADMIN_PREFIX || url.pathname.startsWith(`${ADMIN_PREFIX}/`)) {
      handleAdmin(req, res, url);
      return;
    }

    counters.requests += 1;
    const matched = routeForPath(config.routes, url.pathname);
    if (!matched) {
      sendJson(res, 404, {
        error: {
          message: `llm-vcr: no route for ${url.pathname}`,
          type: "llm_vcr_no_route",
          code: "no_route",
        },
      });
      return;
    }

    const forcedMode = req.headers["x-llm-vcr-mode"];
    if (forcedMode && !MODES.has(String(forcedMode))) {
      sendJson(res, 400, {
        error: {
          message: `llm-vcr: invalid x-llm-vcr-mode "${forcedMode}".`,
          type: "llm_vcr_bad_request",
        },
      });
      return;
    }
    const mode = String(forcedMode || config.mode);
    let speed = config.speed;
    if (req.headers["x-llm-vcr-speed"] !== undefined) {
      const parsed = Number(req.headers["x-llm-vcr-speed"]);
      if (Number.isFinite(parsed) && parsed >= 0) speed = parsed;
    }

    const bodyBuffer = await readRequestBody(req, config.maxBodyBytes);
    const bodyInfo = encodeBody(bodyBuffer, req.headers["content-type"]);
    let scrubbedBody = bodyInfo.body;
    if (bodyInfo.bodyType === "json") scrubbedBody = scrubber.scrubDeep(bodyInfo.body);
    else if (bodyInfo.bodyType === "text") scrubbedBody = scrubber.scrubString(bodyInfo.body);

    const upstreamUrl = buildUpstreamUrl(matched.route, matched.rest, url.search);
    const rawHeaders = sanitizeRequestHeaders(req.headers, { recording: mode !== "passthrough" });
    const redactedHeaders = redactHeaders(rawHeaders, scrubber);
    const queryEntries = [...upstreamUrl.searchParams.entries()];
    const redactedQuery = redactQuery(queryEntries, scrubber);
    const redactedUpstream = redactUrl(upstreamUrl.toString(), scrubber);
    const signature = buildSignature({
      method: req.method,
      url: redactedUpstream,
      headers: redactedHeaders,
      body: scrubbedBody,
      bodyType: bodyInfo.bodyType,
      matchHeaders: config.matchHeaders,
      ignoreBodyPaths: config.ignoreBodyPaths,
    });

    const ctx = {
      started,
      method: req.method,
      localPath: url.pathname,
      upstreamUrl,
      redactedUpstream,
      redactedQuery,
      redactedHeaders,
      bodyBuffer,
      bodyType: bodyInfo.bodyType,
      scrubbedBody,
      signature,
      route: matched.route,
    };

    if (mode === "passthrough") {
      await passthrough(ctx, req, res);
      return;
    }

    if (mode === "record") {
      await recordInteraction(ctx, req, res, { overwrite: true });
      return;
    }

    const entry = store.take(signature.hash);
    if (entry) {
      await replay(entry, req, res, ctx, speed);
      return;
    }

    if (mode === "auto") {
      await recordInteraction(ctx, req, res, { overwrite: false });
      return;
    }

    sendNoMatch(req, res, ctx);
  }

  const server = http.createServer((req, res) => {
    handleRequest(req, res).catch((error) => {
      counters.errors += 1;
      if (error instanceof PayloadTooLarge) {
        sendJson(res, 413, {
          error: {
            message: `llm-vcr: ${error.message}`,
            type: "llm_vcr_payload_too_large",
            code: "payload_too_large",
          },
        });
        return;
      }
      if (error?.message === "client aborted request") return;
      logger.error(error?.stack || String(error));
      if (!res.headersSent) {
        sendJson(res, 500, {
          error: {
            message: `llm-vcr: ${error.message}`,
            type: "llm_vcr_internal_error",
          },
        });
      } else if (!res.destroyed) {
        res.destroy();
      }
    });
  });

  server.requestTimeout = 0;
  server.timeout = 0;
  server.headersTimeout = 120_000;
  server.keepAliveTimeout = 72_000;

  server.on("upgrade", (_req, socket) => {
    socket.end(
      "HTTP/1.1 426 Upgrade Required\r\nconnection: close\r\ncontent-type: text/plain\r\n\r\nllm-vcr does not proxy websocket upgrades.\n",
    );
  });
  server.on("clientError", (_error, socket) => {
    if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\nconnection: close\r\n\r\n");
  });

  await new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(config.port, config.host);
  });

  const address = server.address();
  const port = typeof address === "object" && address ? address.port : config.port;
  const url = proxyBaseUrl(config, port);

  return {
    server,
    port,
    url,
    store,
    config,
    counters,
    stats() {
      return {
        ...counters,
        uptimeMs: Date.now() - startedAt,
        cassettes: store.stats(),
      };
    },
    /** Wait for cassette writes that were kicked off after a response ended. */
    async flush() {
      while (pendingSaves.size > 0) {
        await Promise.allSettled([...pendingSaves]);
      }
    },
    async close() {
      if (server.listening) {
        await new Promise((resolve) => {
          server.close(() => resolve());
          server.closeIdleConnections?.();
          const timer = setTimeout(() => server.closeAllConnections?.(), 500);
          timer.unref?.();
        });
      }
      await this.flush();
    },
  };
}

export { buildUpstreamUrl, extractModel, ADMIN_PREFIX };
