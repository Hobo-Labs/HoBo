/**
 * Gate-executed identity example for operators-sre-crew.
 * Asserts proof.json matches folder layer/slug — honest, unforgeable via stdout.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import assert from "node:assert/strict";

const root = path.dirname(fileURLToPath(import.meta.url));
// SAFETY: assertion to `ON.parse( readFileSync(path.join(root, "..", "proof.json"), "utf8"), ) as { slug: string; layer: string }; ` is required at this boundary.
const proof = JSON.parse(
  readFileSync(path.join(root, "..", "proof.json"), "utf8"),
) as { slug: string; layer: string };

assert.equal(proof.slug, "operators-sre-crew");
assert.equal(proof.layer, "epic");
console.log(`slug: ${proof.slug}`);
console.log(`layer: ${proof.layer}`);
console.log("proof-identity: ok");
