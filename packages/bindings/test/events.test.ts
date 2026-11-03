import { describe, expect, it } from "vitest";

import {
	BINDING_EVENT_SCHEMA_VERSION,
	BINDING_EVENTS,
	BINDING_PROJECTIONS,
	BINDING_RESOLUTION_CONTRACT,
	BINDING_UNAVAILABLE_CODES,
	BINDING_UNAVAILABLE_REMEDIATION,
	type BindingProjectionKind,
	BindingRecordError,
	type BindingResolution,
	type BindingUnavailableCode,
	bindingProjected,
	bindingResolved,
	bindingUnavailable,
} from "../src/index.js";

const resolution: BindingResolution = {
	contract: BINDING_RESOLUTION_CONTRACT,
	yardId: "yard:prod-eu",
	profile: "data.postgres/v1",
	productId: "neon.serverless-postgres",
	connectivityId: "cloudflare.postgres.hyperdrive/v1",
	realization: "native",
	appliedRows: [
		"kv.cache/v1|upstash.redis|",
		"data.postgres/v1|neon.serverless-postgres|",
	],
	consideredCount: 4,
};

const projected = {
	yardId: "yard:prod-eu",
	alias: "db",
	bindingProfileRef: "binding.postgresql/v1",
	connectivityId: "cloudflare.postgres.hyperdrive/v1",
	// SAFETY: this fixture uses a member of the closed projection vocabulary.
	projection: "provider-binding" as BindingProjectionKind,
};

function codeOf(run: () => void): string {
	try {
		run();
	} catch (error) {
		if (error instanceof BindingRecordError) return error.code;
		throw error;
	}
	throw new Error("expected a BindingRecordError");
}

describe("the binding.* event family", () => {
	it("is exactly three events", () => {
		expect(BINDING_EVENTS).toStrictEqual([
			"binding.Resolved",
			"binding.Projected",
			"binding.Unavailable",
		]);
		expect(Object.isFrozen(BINDING_EVENTS)).toBe(true);
	});

	it("has no binding.Declared — row state rides yard.Registered instead", () => {
		expect(BINDING_EVENTS).not.toContain("binding.Declared");
	});

	it("stamps every fact with the family schema version", () => {
		for (const event of [
			bindingResolved(resolution),
			bindingProjected(projected),
			bindingUnavailable({
				yardId: "yard:prod-eu",
				profile: "data.postgres/v1",
				code: "NO_COMPATIBLE_BINDING",
				remediation: BINDING_UNAVAILABLE_REMEDIATION.NO_COMPATIBLE_BINDING,
				consideredCount: 0,
			}),
		]) {
			expect(event.schemaVersion).toBe(BINDING_EVENT_SCHEMA_VERSION);
			expect(BINDING_EVENTS).toContain(event.type);
			expect(Object.isFrozen(event)).toBe(true);
			expect(Object.isFrozen(event.data)).toBe(true);
		}
	});
});

describe("bindingResolved", () => {
	it("names itself and carries the parsed resolution", () => {
		const event = bindingResolved(resolution);
		expect(event.type).toBe("binding.Resolved");
		expect(event.data.productId).toBe("neon.serverless-postgres");
		expect(event.data.consideredCount).toBe(4);
	});

	it("carries appliedRows as sorted canonical row keys", () => {
		expect(bindingResolved(resolution).data.appliedRows).toStrictEqual([
			"data.postgres/v1|neon.serverless-postgres|",
			"kv.cache/v1|upstash.redis|",
		]);
	});

	it("is deterministic and does not alias the caller's array", () => {
		const rows = ["data.postgres/v1|neon.serverless-postgres|"];
		const event = bindingResolved({ ...resolution, appliedRows: rows });
		rows.length = 0;
		expect(event.data.appliedRows).toStrictEqual([
			"data.postgres/v1|neon.serverless-postgres|",
		]);
		expect(bindingResolved(resolution)).toStrictEqual(
			bindingResolved(resolution),
		);
	});

	it("refuses a resolution carrying a secret-shaped value", () => {
		expect(
			codeOf(() =>
				bindingResolved({
					...resolution,
					connectivityId: "postgresql://user:hunter2@db.example.com/app",
				}),
			),
		).toBe("BINDING_RECORD_CREDENTIAL_VALUE");
	});
});

describe("bindingProjected", () => {
	it.each(BINDING_PROJECTIONS)("accepts the %s projection", (projection) => {
		const event = bindingProjected({ ...projected, projection });
		expect(event.type).toBe("binding.Projected");
		expect(event.data.projection).toBe(projection);
	});

	it("records deploy-time wiring, not per-activation client construction", () => {
		// There is no per-activation constructor by design: a control-plane write
		// per activation is a hot-path cost with no audit value.
		const event = bindingProjected(projected);
		expect(event.data.alias).toBe("db");
		expect(Object.keys(event.data).sort()).toStrictEqual([
			"alias",
			"bindingProfileRef",
			"connectivityId",
			"projection",
			"yardId",
		]);
	});

	it.each([
		[{ projection: "sidecar-proxy" }, "a projection outside the vocabulary"],
		[{ alias: "" }, "an empty alias"],
		[{ bindingProfileRef: "  " }, "a whitespace-only binding profile ref"],
	])("rejects %j — %s", (overrides) => {
		expect(() =>
			// SAFETY: each table row deliberately overrides one known fixture field.
			bindingProjected({ ...projected, ...overrides } as typeof projected),
		).toThrow(BindingRecordError);
	});

	it("refuses a secret-shaped connectivity id", () => {
		expect(
			codeOf(() =>
				bindingProjected({
					...projected,
					connectivityId: "postgresql://user:hunter2@db.example.com/app",
				}),
			),
		).toBe("BINDING_RECORD_CREDENTIAL_VALUE");
	});
});

describe("bindingUnavailable", () => {
	it.each(
		BINDING_UNAVAILABLE_CODES,
	)("carries non-empty, human-actionable remediation for %s", (code: BindingUnavailableCode) => {
		const remediation = BINDING_UNAVAILABLE_REMEDIATION[code];
		expect(remediation.trim().length).toBeGreaterThan(0);
		// Actionable means it names something to change, not just restates the code.
		expect(remediation).not.toBe(code);
		expect(remediation).toMatch(/\s/u);

		const event = bindingUnavailable({
			yardId: "yard:prod-eu",
			profile: "data.postgres/v1",
			code,
			remediation,
			consideredCount: 3,
		});
		expect(event.type).toBe("binding.Unavailable");
		expect(event.data.code).toBe(code);
		expect(event.data.remediation).toBe(remediation);
	});

	it.each([
		[""],
		["   "],
		[undefined],
	])("refuses to construct a refusal with the remediation %j", (remediation) => {
		expect(
			codeOf(() =>
				bindingUnavailable({
					yardId: "yard:prod-eu",
					profile: "data.postgres/v1",
					code: "NO_COMPATIBLE_BINDING",
					// SAFETY: the test deliberately passes invalid table values to the runtime parser.
					remediation: remediation as string,
					consideredCount: 0,
				}),
			),
		).toBe("BINDING_RECORD_REMEDIATION_MISSING");
	});

	it("rejects a refusal code outside the vocabulary", () => {
		expect(
			codeOf(() =>
				bindingUnavailable({
					yardId: "yard:prod-eu",
					profile: "data.postgres/v1",
					// SAFETY: the test deliberately passes an out-of-vocabulary code.
					code: "YARD_BINDING_UNSUPPORTED" as BindingUnavailableCode,
					remediation: "pick a supported code",
					consideredCount: 1,
				}),
			),
		).toBe("BINDING_RECORD_INVALID");
	});

	it("allows a zero considered count for a catalog with no candidate at all", () => {
		expect(
			bindingUnavailable({
				yardId: "yard:local",
				profile: "queue.fifo/v1",
				code: "YARD_BINDING_PRODUCT_UNKNOWN",
				remediation:
					BINDING_UNAVAILABLE_REMEDIATION.YARD_BINDING_PRODUCT_UNKNOWN,
				consideredCount: 0,
			}).data.consideredCount,
		).toBe(0);
	});

	it("refuses YARD_BINDING_EXCLUDED_ALL with nothing to have excluded", () => {
		expect(
			codeOf(() =>
				bindingUnavailable({
					yardId: "yard:prod-eu",
					profile: "data.postgres/v1",
					code: "YARD_BINDING_EXCLUDED_ALL",
					remediation:
						BINDING_UNAVAILABLE_REMEDIATION.YARD_BINDING_EXCLUDED_ALL,
					consideredCount: 0,
				}),
			),
		).toBe("BINDING_RECORD_INVALID");
	});

	it("keeps credential material out of the serialized fact", () => {
		const serialized = JSON.stringify(
			bindingUnavailable({
				yardId: "yard:prod-eu",
				profile: "data.postgres/v1",
				code: "NO_COMPATIBLE_BINDING",
				remediation: BINDING_UNAVAILABLE_REMEDIATION.NO_COMPATIBLE_BINDING,
				consideredCount: 2,
			}),
		);
		expect(serialized).not.toMatch(/postgresql:\/\//u);
		expect(serialized).not.toContain("password");
	});
});
