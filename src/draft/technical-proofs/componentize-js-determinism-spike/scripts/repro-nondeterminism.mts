/**
 * HOBO-603 repro: three clean componentize-js builds with identical inputs.
 *
 *   pnpm --prefix src/draft/technical-proofs/componentize-js-determinism-spike repro
 */
import { buildHelloBindleEvidence } from "../src/build.ts";

const builds: Array<{ digest: string; bytes: number; inputsDigest: string }> = [];

for (let i = 0; i < 3; i++) {
  const result = await buildHelloBindleEvidence();
  builds.push({
    digest: result.digest,
    bytes: result.byteLength,
    inputsDigest: result.inputsDigest,
  });
  console.log(`build ${i + 1}: digest=${result.digest} bytes=${result.byteLength}`);
}

const uniqueDigests = new Set(builds.map((b) => b.digest));
const uniqueInputs = new Set(builds.map((b) => b.inputsDigest));

console.log(`unique component digests: ${uniqueDigests.size}/3`);
console.log(`unique inputsDigest: ${uniqueInputs.size}/3`);

if (uniqueInputs.size !== 1) {
  console.error("FAIL: inputsDigest must be stable across rebuilds");
  process.exit(1);
}

if (uniqueDigests.size === 1) {
  console.log("PASS: component bytes are byte-identical (upstream may have fixed reproducibility)");
  process.exit(0);
}

console.warn(
  "FINDING: componentize-js@0.21.0 emits different wasm bytes on every clean build despite stable inputsDigest",
);
console.warn(`digests: ${[...uniqueDigests].join(", ")}`);
process.exit(0);
