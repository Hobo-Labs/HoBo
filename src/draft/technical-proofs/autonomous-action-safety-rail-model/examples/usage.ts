import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import path from "node:path";

const root = path.join(import.meta.dirname, "..");
const read = (rel: string) => readFileSync(path.join(root, rel), "utf8");

const readme = read("README.md");
const classes = ["auto", "canary-with-auto-rollback", "require-approval", "a2h-escalate"];
for (const actionClass of classes) {
	assert.ok(readme.includes(`\`${actionClass}\``), `README must classify ${actionClass}`);
}
console.log(`action classes documented: ${classes.join(", ")}`);

assert.ok(readme.includes("the action class is `a2h-escalate`"));
assert.ok(readme.includes("No autonomous write is"));
console.log("envelope fallback rule: missing evidence -> a2h-escalate, no autonomous write");

const proto = read("architecture/autonomous_action_safety_rail_model.proto");
const cue = read("architecture/autonomous_action_safety_rail_model.cue");
assert.ok(proto.includes("message AutonomousActionSafetyRailModelRecord"));
assert.ok(proto.includes("enum AutonomousActionSafetyRailModelEvidenceKind"));
assert.ok(cue.includes("#AutonomousActionSafetyRailModelRecord"));
assert.ok(cue.includes('"design-record" | "contract-test"'));
console.log("schema pair: proto record+enum mirrored by CUE definitions");

const pact = JSON.parse(read("architecture/pacts/autonomous_action_safety_rail_model.pact.json")) as {
	consumer: { name: string };
	provider: { name: string };
	interactions: Array<{ description: string }>;
};
assert.equal(pact.consumer.name, "AutonomousActionSafetyRailModelConsumer");
assert.equal(pact.provider.name, "AutonomousActionSafetyRailModelBoundary");
assert.equal(pact.interactions.length, 1);
console.log(`pact: ${pact.consumer.name} -> ${pact.provider.name} (${pact.interactions.length} interaction)`);

console.log("CONTRACT HELD: documentation-only rail model evidence is present, consistent, and parseable");
