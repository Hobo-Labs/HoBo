import assert from "node:assert/strict";
import { runCli } from "../packages/schema-tools/src/cli.js";
import { parseJsonObject } from "../src/json.js";

const result = await runCli(["--check", "--json"], process.cwd());
assert.equal(result.exitCode, 0, result.stderr || result.stdout);
const report = parseJsonObject(result.stdout);
assert.equal(report.status, "CLEAN");
assert.ok(Array.isArray(report.drift));
assert.ok(Array.isArray(report.cueViolations));
assert.deepEqual(report.drift, []);
assert.deepEqual(report.cueViolations, []);
console.log(`status: ${report.status}`);
console.log(`drift: ${report.drift.length}`);
console.log(`cue violations: ${report.cueViolations.length}`);
