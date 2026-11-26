import { create, toJson } from "@bufbuild/protobuf";
import { describe, expect, it } from "vitest";
import { ReadinessSchema } from "../src/_generated/readiness_pb.js";
import { getReadiness, parseReadiness } from "../src/index.js";
import pact from "./readiness.pact.json" with { type: "json" };

const interaction = pact.interactions[0];
if (!interaction) throw new Error("readiness Pact interaction missing");
const response = interaction.response[0];
if (!response) throw new Error("readiness Pact response missing");
const expected = response.contents;

describe("in-process readiness SDK consumer contract", () => {
	it("serves the hand-authored synchronous-message expectation", () => {
		expect(pact.metadata.pactSpecification.version).toBe("4.0.0");
		expect(interaction.type).toBe("Synchronous/Messages");
		expect(interaction.request.contents.operation).toBe("getReadiness");
		const view = getReadiness();
		const message = create(ReadinessSchema, {
			...view,
			pendingGates: [...view.pendingGates],
		});
		expect(
			toJson(ReadinessSchema, message, { alwaysEmitImplicit: true }),
		).toEqual(expected);
	});

	it("parses the approved protobuf JSON into an immutable implemented view", () => {
		const parsed = parseReadiness(JSON.stringify(expected));
		expect(parsed.status).toBe("implemented");
		expect(parsed.executionAvailable).toBe(true);
		expect(parsed.pendingGates).toEqual(expected.pendingGates);
		expect(Object.isFrozen(parsed)).toBe(true);
		expect(Object.isFrozen(parsed.pendingGates)).toBe(true);
	});

	it.each([
		["execution", { ...expected, executionAvailable: false }],
		["status", { ...expected, status: "ready" }],
		["integration", { ...expected, integration: "another-integration" }],
		["SDK", { ...expected, targetSdk: "another-sdk" }],
		[
			"documentation",
			{ ...expected, targetDocumentation: "https://other.invalid/" },
		],
		["empty gates", { ...expected, pendingGates: [] }],
		["blank gates", { ...expected, pendingGates: ["   "] }],
	])("rejects invalid %s instead of granting execution readiness", (_name, invalid) => {
		expect(() => parseReadiness(JSON.stringify(invalid))).toThrow(
			/invalid implemented/,
		);
	});

	it("rejects malformed JSON and unknown protobuf fields", () => {
		expect(() => parseReadiness("{")).toThrow();
		expect(() =>
			parseReadiness(JSON.stringify({ ...expected, execute: true })),
		).toThrow();
	});
});
