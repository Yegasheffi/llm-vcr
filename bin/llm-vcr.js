#!/usr/bin/env node
import { main } from "../src/cli.js";

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code ?? 0;
  })
  .catch((error) => {
    process.stderr.write(`llm-vcr: error: ${error?.message || String(error)}\n`);
    if (process.env.LLM_VCR_DEBUG) process.stderr.write(`${error?.stack}\n`);
    process.exitCode = 1;
  });
