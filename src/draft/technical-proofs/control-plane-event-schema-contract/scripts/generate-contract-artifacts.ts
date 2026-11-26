import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isJsonObject } from "../src/json.js";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const checkOnly = process.argv.includes("--check");
const schema = JSON.parse(
  await readFile(path.join(packageRoot, "schema", "control-plane-events.v1.schema.json"), "utf8")
);

const eventTypes = schema.properties.type.enum;
const requiredBodyFields = schema["x-hobo-requiredBodyFields"];

assert.ok(Array.isArray(eventTypes) && eventTypes.length > 0, "schema must declare event type enum");
assert.equal(isJsonObject(requiredBodyFields), true, "schema must declare x-hobo-requiredBodyFields");
for (const eventType of eventTypes) {
  assert.ok(Array.isArray(requiredBodyFields[eventType]), `missing required body fields for ${eventType}`);
}

const generated = `export const GENERATED_CONTROL_PLANE_EVENT_TYPES = ${JSON.stringify(eventTypes, null, 2)};

export const GENERATED_REQUIRED_EVENT_BODY_FIELDS = ${JSON.stringify(requiredBodyFields, null, 2)};
`;
const target = path.join(packageRoot, "src", "generated", "control-plane-event-types.ts");

if (checkOnly) {
  const current = await readFile(target, "utf8");
  assert.equal(current, generated, "generated control-plane contract artifacts are stale");
  console.log(`control-plane event codegen check ok: ${eventTypes.length} event types`);
} else {
  await writeFile(target, generated);
  console.log(`generated control-plane event artifacts: ${eventTypes.length} event types`);
}
