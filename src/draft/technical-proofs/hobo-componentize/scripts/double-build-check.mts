import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { runComponentSmoke } from "../src/index.js";
import { buildHelloBindle } from "../test/helpers.ts";

const outDir = "/tmp/hobo-componentize";
await mkdir(outDir, { recursive: true });

const first = await buildHelloBindle();
const second = await buildHelloBindle();

if (first.reproducibility.inputsDigest !== second.reproducibility.inputsDigest) {
  console.error("inputsDigest mismatch");
  process.exit(1);
}

const firstSmoke = await runComponentSmoke(first.component, { exportName: "health" });
const secondSmoke = await runComponentSmoke(second.component, { exportName: "health" });
if (firstSmoke.stdout !== secondSmoke.stdout) {
  console.error("smoke stdout mismatch", firstSmoke.stdout, secondSmoke.stdout);
  process.exit(1);
}

if (first.component.digest !== second.component.digest) {
  console.warn(
    `component digest drift detected (${first.component.digest} vs ${second.component.digest}); inputs/smoke remained stable`,
  );
}

const outPath = join(outDir, "hello-bindle.component.wasm");
await writeFile(outPath, first.component.bytes);
console.log(`wrote ${outPath} digest=${first.component.digest}`);
