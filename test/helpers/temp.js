import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export async function tempDir(prefix = "llm-vcr-test-") {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  return {
    dir,
    async cleanup() {
      await fs.rm(dir, { recursive: true, force: true });
    },
  };
}

export async function readCassettes(dir) {
  const files = (await fs.readdir(dir)).filter(
    (file) => file.endsWith(".json") && !file.includes(".tmp-"),
  );
  const cassettes = [];
  for (const file of files) {
    cassettes.push(JSON.parse(await fs.readFile(path.join(dir, file), "utf8")));
  }
  return cassettes;
}
