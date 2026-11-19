import { fromBinary, fromJsonString, toBinary } from "@bufbuild/protobuf";
import { describe, expect, it } from "vitest";
import { SloDefinitionRecordSchema } from "../src/_generated/slo_pb.js";
import {
	hashSloDefinition,
	parseSloDefinition,
	serializeSloDefinition,
	sloDurationMs,
} from "../src/ports/slo.js";
import { sloFixture } from "./slo-fixture.js";

function document() {
	return sloFixture();
}

describe("SLO definitions", () => {
	it("normalizes and freezes valid definitions, and hashes labels independently of their order", () => {
		const value = document();
		const first = parseSloDefinition(value);
		const second = parseSloDefinition({
			...value,
			metadata: {
				name: "availability",
				labels: { team: "shop", service: "checkout" },
			},
		});
		expect(hashSloDefinition(first)).toBe(hashSloDefinition(second));
		expect(
			parseSloDefinition(JSON.parse(serializeSloDefinition(first))),
		).toEqual(first);
		expect(Object.isFrozen(first.spec.objectives[0])).toBe(true);
		expect(Object.isFrozen(first.metadata.labels)).toBe(true);
	});

	it("round trips the authored definition through the generated protobuf", () => {
		const message = fromJsonString(
			SloDefinitionRecordSchema,
			JSON.stringify(sloFixture()),
		);
		const decoded = fromBinary(
			SloDefinitionRecordSchema,
			toBinary(SloDefinitionRecordSchema, message),
		);
		expect(decoded.spec?.objectives[0]?.target).toBe(0.99);
		expect(decoded.spec?.indicator?.ratioMetric?.counter).toBe(true);
	});

	it("supports explicitly anchored calendar and slice definitions", () => {
		const value = document();
		const parsed = parseSloDefinition({
			...value,
			spec: {
				...value.spec,
				timeWindow: {
					duration: "1M",
					isRolling: false,
					calendar: {
						startTime: "2026-01-01T00:00:00",
						timeZone: "America/Chicago",
					},
				},
				budgetingMethod: "Timeslices",
				objectives: [
					{
						displayName: "latency",
						target: 0.99,
						timeSliceWindow: "5m",
						timeSliceTarget: 0.95,
					},
				],
			},
		});
		expect(parsed.spec.objectives[0]?.timeSliceTarget).toBe(0.95);
		expect(parsed.spec.timeWindow.calendar?.timeZone).toBe("America/Chicago");
	});

	it.each([
		{ timeWindow: { duration: "1M", isRolling: true } },
		{ timeWindow: { duration: "1d", isRolling: false } },
		{
			timeWindow: {
				duration: "1d",
				isRolling: false,
				calendar: {
					startTime: "2026-03-08T02:30:00",
					timeZone: "America/Chicago",
				},
			},
		},
		{
			budgetingMethod: "Timeslices",
			objectives: [{ displayName: "latency", target: 0.99 }],
		},
		{
			budgetingMethod: "RatioTimeslices",
			objectives: [
				{
					displayName: "latency",
					target: 0.99,
					timeSliceWindow: "5m",
					timeSliceTarget: 0.9,
				},
			],
		},
		{
			objectives: [
				{ displayName: "same", target: 0.99 },
				{ displayName: "same", target: 0.9 },
			],
		},
		{
			burnRateThresholds: [
				{
					name: "bad",
					threshold: 2,
					lookbackWindow: "5m",
					samplingInterval: "1h",
				},
			],
		},
	])("rejects incomplete or inconsistent settings %#", (spec) => {
		const value = document();
		expect(() =>
			parseSloDefinition({ ...value, spec: { ...value.spec, ...spec } }),
		).toThrow();
	});

	it("rejects unknown fields and unsafe durations", () => {
		const value = document();
		expect(() => parseSloDefinition({ ...value, extra: true })).toThrow();
		expect(() => sloDurationMs("9999999999999999d")).toThrow();
	});
});
