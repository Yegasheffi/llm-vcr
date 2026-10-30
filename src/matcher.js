import { canonicalize, deepClone, sha256, stableStringify, truncate } from "./util.js";
import { isSecretHeader } from "./redact.js";

export function queryEntriesToObject(entries) {
  const out = {};
  for (const [key, value] of entries) {
    if (out[key] === undefined) {
      out[key] = value;
    } else if (Array.isArray(out[key])) {
      out[key].push(value);
    } else {
      out[key] = [out[key], value];
    }
  }
  return out;
}

function compareStrings(a, b) {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

export function queryObjectToEntries(query) {
  if (!query || typeof query !== "object") return [];
  const entries = [];
  for (const [key, value] of Object.entries(query)) {
    if (Array.isArray(value)) {
      for (const item of value) entries.push([key, String(item)]);
    } else {
      entries.push([key, String(value)]);
    }
  }
  return entries.sort(
    (a, b) => compareStrings(a[0], b[0]) || compareStrings(a[1], b[1]),
  );
}

function splitPath(pathValue) {
  return String(pathValue)
    .split(".")
    .map((part) => part.trim())
    .filter((part) => part !== "");
}

function omitAt(node, segments) {
  if (!node || typeof node !== "object" || segments.length === 0) return;
  const [head, ...rest] = segments;
  const isLast = rest.length === 0;

  if (head === "*") {
    if (Array.isArray(node)) {
      for (let index = node.length - 1; index >= 0; index -= 1) {
        if (isLast) node.splice(index, 1);
        else omitAt(node[index], rest);
      }
    } else {
      for (const key of Object.keys(node)) {
        if (isLast) delete node[key];
        else omitAt(node[key], rest);
      }
    }
    return;
  }

  if (Array.isArray(node)) {
    const index = Number(head);
    if (!Number.isInteger(index) || index < 0 || index >= node.length) return;
    if (isLast) node.splice(index, 1);
    else omitAt(node[index], rest);
    return;
  }

  if (!(head in node)) return;
  if (isLast) delete node[head];
  else omitAt(node[head], rest);
}

export function omitBodyPaths(body, paths) {
  if (!paths || paths.length === 0) return body;
  const copy = deepClone(body);
  for (const pathValue of paths) {
    omitAt(copy, splitPath(pathValue));
  }
  return copy;
}

function normalizeBodyForSignature(body, bodyType, ignoreBodyPaths) {
  if (bodyType === "json") {
    return { value: omitBodyPaths(body, ignoreBodyPaths), encoding: "json" };
  }
  if (bodyType === "base64") {
    return { value: `sha256:${sha256(String(body || ""))}`, encoding: "base64" };
  }
  if (bodyType === "text") {
    return { value: String(body ?? ""), encoding: "text" };
  }
  return { value: null, encoding: "empty" };
}

/**
 * Build the stable request identity used to find a cassette.
 * Credential headers are excluded by default; anything passed in `headers`
 * must already be scrubbed.
 */
export function buildSignature({
  method,
  url,
  headers = {},
  body = null,
  bodyType = "empty",
  matchHeaders = [],
  ignoreBodyPaths = [],
}) {
  const parsed = new URL(url);
  const query = [...parsed.searchParams.entries()].sort(
    (a, b) => compareStrings(a[0], b[0]) || compareStrings(a[1], b[1]),
  );

  const selectedHeaders = {};
  for (const name of matchHeaders) {
    const key = String(name).toLowerCase();
    if (isSecretHeader(key)) continue;
    const value = headers[key];
    if (value === undefined) continue;
    selectedHeaders[key] = Array.isArray(value) ? value.join(", ") : String(value);
  }

  const normalizedBody = normalizeBodyForSignature(body, bodyType, ignoreBodyPaths);
  const payload = {
    method: String(method || "GET").toUpperCase(),
    origin: parsed.origin,
    path: parsed.pathname,
    query,
    headers: selectedHeaders,
    body: normalizedBody,
  };
  return {
    hash: sha256(stableStringify(payload)),
    payload: canonicalize(payload),
  };
}

function valueLabel(value) {
  if (typeof value === "string") return JSON.stringify(truncate(value, 90));
  return truncate(JSON.stringify(value), 90);
}

function diffValues(expected, actual, pathLabel, out, limit) {
  if (out.length >= limit) return;
  if (stableStringify(expected) === stableStringify(actual)) return;

  const expectedIsObject = expected && typeof expected === "object";
  const actualIsObject = actual && typeof actual === "object";

  if (expectedIsObject && actualIsObject) {
    const expectedArray = Array.isArray(expected);
    const actualArray = Array.isArray(actual);
    if (expectedArray && actualArray) {
      const length = Math.max(expected.length, actual.length);
      for (let index = 0; index < length && out.length < limit; index += 1) {
        const label = `${pathLabel}[${index}]`;
        if (index >= expected.length) {
          out.push({ path: label, expected: "(missing)", actual: valueLabel(actual[index]) });
        } else if (index >= actual.length) {
          out.push({ path: label, expected: valueLabel(expected[index]), actual: "(missing)" });
        } else {
          diffValues(expected[index], actual[index], label, out, limit);
        }
      }
      return;
    }
    if (!expectedArray && !actualArray) {
      const keys = [...new Set([...Object.keys(expected), ...Object.keys(actual)])].sort();
      for (const key of keys) {
        if (out.length >= limit) return;
        const label = pathLabel ? `${pathLabel}.${key}` : key;
        if (!(key in expected)) {
          out.push({ path: label, expected: "(missing)", actual: valueLabel(actual[key]) });
        } else if (!(key in actual)) {
          out.push({ path: label, expected: valueLabel(expected[key]), actual: "(missing)" });
        } else {
          diffValues(expected[key], actual[key], label, out, limit);
        }
      }
      return;
    }
  }

  out.push({
    path: pathLabel || "(body)",
    expected: valueLabel(expected),
    actual: valueLabel(actual),
  });
}

/** Human-readable differences between a stored request and a new request. */
export function explainMismatch(
  entry,
  incoming,
  { matchHeaders = [], ignoreBodyPaths = [], limit = 6 } = {},
) {
  const request = entry.request || {};
  const payload = incoming.payload || {};
  const diffs = [];

  if (String(request.method).toUpperCase() !== payload.method) {
    diffs.push({
      path: "method",
      expected: request.method,
      actual: payload.method,
    });
  }
  let storedOrigin = request.origin || "";
  if (!storedOrigin && request.url) {
    try {
      storedOrigin = new URL(request.url).origin;
    } catch {
      storedOrigin = "";
    }
  }
  if (storedOrigin !== payload.origin) {
    diffs.push({
      path: "origin",
      expected: storedOrigin || "(unknown)",
      actual: payload.origin,
    });
  }
  if (request.path !== payload.path) {
    diffs.push({
      path: "path",
      expected: request.path,
      actual: payload.path,
    });
  }

  const storedQuery = queryObjectToEntries(request.query);
  const incomingQuery = payload.query || [];
  if (stableStringify(storedQuery) !== stableStringify(incomingQuery)) {
    diffs.push({
      path: "query",
      expected: truncate(JSON.stringify(request.query), 100),
      actual: truncate(JSON.stringify(queryEntriesToObject(incomingQuery)), 100),
    });
  }

  for (const name of matchHeaders) {
    const key = name.toLowerCase();
    if (isSecretHeader(key)) continue;
    const rawStored = request.headers?.[key];
    const stored = Array.isArray(rawStored) ? rawStored.join(", ") : rawStored;
    const next = payload.headers?.[key];
    if (stableStringify(stored) !== stableStringify(next)) {
      diffs.push({
        path: `headers.${key}`,
        expected: valueLabel(stored),
        actual: valueLabel(next),
      });
    }
  }

  const storedBody = omitBodyPaths(request.body, ignoreBodyPaths);
  const incomingBody = payload.body?.value;
  diffValues(storedBody, incomingBody, "", diffs, limit);

  let score = 0;
  if (String(request.method).toUpperCase() === payload.method) score += 0.1;
  if (request.path === payload.path) score += 0.45;
  if (stableStringify(storedQuery) === stableStringify(incomingQuery)) score += 0.1;
  if (diffs.length === 0) score = 1;
  else {
    const bodyDiffs = diffs.filter(
      (item) => !/^(method|origin|path|query|headers\.)/.test(item.path),
    );
    if (bodyDiffs.length === 0) score += 0.25;
    else score += 0.25 * Math.max(0, 1 - bodyDiffs.length / 12);
  }
  return { score: Math.min(1, score), diffs: diffs.slice(0, limit) };
}

export function findClosest(entries, incoming, options = {}) {
  let best = null;
  for (const entry of entries) {
    const result = explainMismatch(entry, incoming, options);
    if (!best || result.score > best.score) {
      best = { entry, ...result };
    }
  }
  return best;
}
