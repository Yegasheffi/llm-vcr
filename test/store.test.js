import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { CassetteStore } from "../src/store.js";
import { tempDir, readCassettes } from "./helpers/temp.js";

function fakeRecord(label = "hello", status = 200) {
  return {
    request: {
      method: "POST",
      url: "https://api.example.com/v1/chat",
      path: "/v1/chat",
      query: {},
      headers: { "content-type": "application/json" },
      body: { model: "m1", messages: [{ role: "user", content: label }] },
      bodyType: "json",
    },
    response: {
      status,
      statusText: "OK",
      headers: { "content-type": "application/json" },
      body: { id: "x", content: label },
      bodyType: "json",
    },
    meta: {
      provider: "test",
      route: "/test",
      method: "POST",
      status,
      model: "m1",
      stream: false,
      durationMs: 12,
    },
  };
}

test("store persists readable cassettes and replays them in order", async () => {
  const { dir, cleanup } = await tempDir();
  try {
    const store = await new CassetteStore({ dir }).init();
    const a = await store.record("hash-a", fakeRecord("one"));
    const b = await store.record("hash-a", fakeRecord("two"));

    assert.equal(store.size, 2);
    assert.equal(store.hashCount, 1);
    assert.equal(a.meta.seq, 1);
    assert.equal(b.meta.seq, 2);
    assert.notEqual(a.meta.file, b.meta.file);

    assert.equal(store.take("hash-a").response.body.content, "one");
    assert.equal(store.take("hash-a").response.body.content, "two");
    assert.equal(store.take("hash-a"), null);

    const cassettes = await readCassettes(dir);
    assert.equal(cassettes.length, 2);
    assert.equal(cassettes[0].format, "llm-vcr/1");
    assert.equal(cassettes[0].meta.hash, "hash-a");

    const reloaded = await new CassetteStore({ dir }).init();
    assert.equal(reloaded.size, 2);
    assert.equal(reloaded.take("hash-a").response.body.content, "one");
  } finally {
    await cleanup();
  }
});

test("record mode overwrites the nth interaction on a later recording run", async () => {
  const { dir, cleanup } = await tempDir();
  try {
    const firstStore = await new CassetteStore({ dir }).init();
    const first = await firstStore.record("hash-b", fakeRecord("first"), {
      overwrite: true,
    });

    const secondStore = await new CassetteStore({ dir }).init();
    const second = await secondStore.record("hash-b", fakeRecord("second"), {
      overwrite: true,
    });

    assert.equal(secondStore.size, 1);
    assert.equal(first.meta.file, second.meta.file);
    assert.equal(first.meta.createdAt, second.meta.createdAt);
    assert.equal(second.response.body.content, "second");
    assert.equal(secondStore.take("hash-b").response.body.content, "second");

    const files = await fs.readdir(dir);
    assert.equal(files.filter((file) => file.endsWith(".json")).length, 1);
  } finally {
    await cleanup();
  }
});

test("store skips invalid files and keeps the directory writable", async () => {
  const { dir, cleanup } = await tempDir();
  try {
    await fs.writeFile(path.join(dir, "broken.json"), "{ not json");
    await fs.writeFile(path.join(dir, "other.json"), JSON.stringify({ hello: "world" }));
    const store = await new CassetteStore({ dir }).init();
    assert.equal(store.size, 0);
    assert.equal(store.warnings.length, 2);
    await store.record("hash-c", fakeRecord("ok"));
    assert.equal(store.size, 1);
  } finally {
    await cleanup();
  }
});
