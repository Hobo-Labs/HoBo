// The body-schema field types beyond string and u32: a flag, a list of
// strings, and a JSON object. They exist so a pinned contract can describe the
// body an emitter really writes — `phases` as a list, `lossless` as a flag, a
// phase checkpoint as an object — instead of a flattened stand-in for it.
import assert from "node:assert/strict";
import { test } from "vitest";
import {
	boolField,
	decodeEventBody,
	type EventJsonValue,
	encodeEventBody,
	eventSchema,
	jsonField,
	stringField,
	stringsField,
	u32Field,
	validateEventBody,
} from "../src/upcaster.js";
import { MIGRATION_EVENT_CONTRACTS } from "../src/upcaster-corpus.js";

const SCHEMA = eventSchema("example.Recorded", 1, [
	stringField("id", 1),
	boolField("flag", 2),
	stringsField("names", 3),
	jsonField("detail", 4, { required: false }),
	boolField("optionalFlag", 5, { required: false }),
	u32Field("count", 6, { required: false }),
]);

test("a body with a flag, a list and an object validates and round-trips through the wire form", () => {
	const body = {
		id: "e-1",
		flag: false,
		names: ["plan", "gate", "prepare"],
		detail: {
			position: "0/16B3748",
			nested: { applied: 12, list: [1, "a", null] },
		},
		optionalFlag: true,
		count: 0,
	};
	assert.deepEqual(validateEventBody(SCHEMA, body), { ok: true, errors: [] });
	assert.deepEqual(
		decodeEventBody(SCHEMA, encodeEventBody(SCHEMA, body)),
		body,
	);
	// A false flag is on the wire: absent and false are different bodies.
	const absent = { id: "e-1", flag: false, names: ["a"] };
	assert.deepEqual(
		decodeEventBody(SCHEMA, encodeEventBody(SCHEMA, absent)),
		absent,
	);
});

test("the wire form of an object does not depend on the order its members were written in", () => {
	const one = {
		id: "e",
		flag: true,
		names: ["a"],
		detail: { a: 1, b: { c: 2, d: 3 } },
	};
	const two = {
		id: "e",
		flag: true,
		names: ["a"],
		detail: { b: { d: 3, c: 2 }, a: 1 },
	};
	assert.deepEqual(encodeEventBody(SCHEMA, one), encodeEventBody(SCHEMA, two));
});

test("each type refuses what it is not", () => {
	const valid = { id: "e", flag: true, names: ["a"] };
	const errorsOf = (override: Record<string, EventJsonValue>) =>
		// SAFETY: deliberately ill-typed bodies, as they would arrive from JSON.
		validateEventBody(SCHEMA, { ...valid, ...override } as never).errors;
	assert.deepEqual(errorsOf({ flag: "true" }), ["flag must be a boolean"]);
	assert.deepEqual(errorsOf({ flag: 1 }), ["flag must be a boolean"]);
	assert.deepEqual(errorsOf({ names: "a,b" }), [
		"names must be a list of strings",
	]);
	assert.deepEqual(errorsOf({ names: ["a", 2] }), [
		"names must be a list of strings",
	]);
	assert.deepEqual(errorsOf({ detail: "{}" }), [
		"detail must be a JSON object",
	]);
	assert.deepEqual(errorsOf({ detail: [1] }), ["detail must be a JSON object"]);
	assert.deepEqual(errorsOf({ detail: null }), [
		"detail must be a JSON object",
	]);
	assert.deepEqual(errorsOf({ undeclared: 1 }), [
		"undeclared is not declared in example.Recorded@v1",
	]);
	assert.throws(
		() => encodeEventBody(SCHEMA, { ...valid, flag: "yes" }),
		/boolean/u,
	);
});

test("the migration contracts that changed are versioned, each with one upcaster per step and a pinned body per version", () => {
	const versions = Object.fromEntries(
		MIGRATION_EVENT_CONTRACTS.map((contract) => [
			contract.type,
			contract.currentVersion,
		]),
	);
	assert.deepEqual(versions, {
		"migration.Planned": 2,
		"migration.SnapshotTaken": 1,
		"migration.PhaseApplied": 2,
		"migration.Verified": 1,
		"migration.CutOver": 2,
		"migration.RolledBack": 2,
		"migration.Failed": 1,
		"migration.Exported": 1,
		"migration.Imported": 1,
		"migration.Held": 1,
		"migration.Resumed": 1,
		"migration.Completed": 1,
		"migration.FenceRequested": 1,
		"migration.RollbackDecided": 1,
	});
	for (const contract of MIGRATION_EVENT_CONTRACTS) {
		assert.equal(contract.upcasters.length, contract.currentVersion - 1);
		for (const schema of contract.schemas) {
			assert.ok(
				contract.goldenCorpus.some((entry) => entry.version === schema.version),
				`${contract.type}@v${schema.version} has no pinned body`,
			);
		}
	}
});

test("migration.Planned v1 lifts to the list the executors emit; RolledBack and PhaseApplied v1 lift unchanged", () => {
	const lift = (type: string, body: Record<string, string | number>) => {
		const contract = MIGRATION_EVENT_CONTRACTS.find(
			(entry) => entry.type === type,
		);
		assert.ok(contract);
		const upcaster = contract.upcasters[0];
		assert.ok(upcaster);
		const lifted = upcaster.upcast(body);
		const target = contract.schemas.find((schema) => schema.version === 2);
		assert.ok(target);
		assert.deepEqual(validateEventBody(target, lifted).errors, []);
		return lifted;
	};
	assert.deepEqual(
		lift("migration.Planned", {
			migrationId: "m",
			phases: "expand,backfill,contract",
			plannedAt: "t",
		}),
		{
			migrationId: "m",
			plannedAt: "t",
			phases: ["expand", "backfill", "contract"],
		},
	);
	const rolled = {
		migrationId: "m",
		reason: "r",
		snapshotRef: "snap-1",
		rolledBackAt: "t",
	};
	assert.deepEqual(lift("migration.RolledBack", rolled), rolled);
	const applied = {
		migrationId: "m",
		phase: "expand",
		statements: 2,
		appliedAt: "t",
	};
	assert.deepEqual(lift("migration.PhaseApplied", applied), applied);
});
