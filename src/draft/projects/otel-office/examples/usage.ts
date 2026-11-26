/**
 * Runnable example for otel-office. The draft-artifact gate EXECUTES this file
 * with `node --import tsx` and diffs stdout against usage.expected.txt.
 *
 * Demonstrates the primary contract offline: deterministic simulator → events →
 * reducer → visible office state, plus one OTLP-mapped span.
 */
import { strict as assert } from "node:assert";
import { applyEvent, visibleCharacters } from "../src/model.js";
import { mapTracePayload } from "../src/otel.js";
import { createSimulation } from "../src/simulator.js";

const sim = createSimulation(7);
let state = sim.state;
for (let i = 0; i < 6; i += 1) {
	for (const event of sim.step()) state = applyEvent(state, event);
}
const characters = visibleCharacters(state, "station-local");
assert.ok(characters.length >= 10);
const busy = characters.filter((c) => c.state !== "idle").length;
console.log(`simulator: ${characters.length} characters, ${busy} busy after 6 ticks`);

const events = mapTracePayload(
	{
		resourceSpans: [
			{
				resource: {
					attributes: [
						{ key: "service.name", value: { stringValue: "demo-svc" } },
						{ key: "hobo.camp", value: { stringValue: "camp-gateway" } },
						{ key: "hobo.station", value: { stringValue: "station-local" } },
					],
				},
				scopeSpans: [
					{
						spans: [
							{
								traceId: "demo",
								spanId: "demo-1",
								name: "GET /demo",
								kind: 2,
								startTimeUnixNano: "1000000000",
							},
						],
					},
				],
			},
		],
	},
	state,
);
for (const event of events) state = applyEvent(state, event);
assert.equal(state.characters["station-local/demo-svc"]?.state, "working");
console.log(`otlp: mapped ${events.length} event(s); demo-svc is working`);
