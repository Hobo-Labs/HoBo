/**
 * Gate-executed identity example for shared-cost-attribution-contract.
 * Asserts proof.json matches folder layer/slug — honest, unforgeable via stdout.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import assert from "node:assert/strict";
import { parseJsonObject } from "../src/json.js";

const root = path.dirname(fileURLToPath(import.meta.url));
const proof = parseJsonObject(
  readFileSync(path.join(root, "..", "proof.json"), "utf8"),
);

assert.equal(proof.slug, "shared-cost-attribution-contract");
assert.equal(proof.layer, "technical");
console.log(`slug: ${proof.slug}`);
console.log(`layer: ${proof.layer}`);
console.log("proof-identity: ok");
