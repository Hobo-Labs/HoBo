import {
	type MigrationPlan,
	SCHEMA_IR_CONTRACT,
	type SchemaIr,
	type SchemaTable,
} from "@hobo/core";
import { describe, expect, it } from "vitest";
import {
	createDrizzleDiffEngine,
	DEFAULT_DRIZZLE_ENGINE_VERSION,
	DRIZZLE_ENGINE_ID,
	DrizzleAdapterError,
	type EmittedSqlStatement,
	ingestDrizzleSchema,
	stepKey,
} from "../src/index.js";
import { column, representativeSchemaModule, table } from "./fixtures.js";

function ir(tables: readonly SchemaTable[]): SchemaIr {
	return {
		contract: SCHEMA_IR_CONTRACT,
		dialect: "postgres",
		tables,
	};
}

const CURRENT = ir([]);
const DESIRED = ingestDrizzleSchema(representativeSchemaModule()).schema;

function echoEmitter(plan: MigrationPlan): readonly EmittedSqlStatement[] {
	return plan.steps.map((step) => ({
		step,
		sql: `-- ${stepKey(step)}`,
	}));
}

function thrownCode(run: () => void): string {
	try {
		run();
	} catch (error) {
		return error instanceof DrizzleAdapterError
			? error.code
			: `unexpected:${String(error)}`;
	}
	return "no-throw";
}

describe("createDrizzleDiffEngine", () => {
	it("identifies itself as the drizzle-kit engine with a pinned version", () => {
		const engine = createDrizzleDiffEngine();

		expect(engine.id).toBe(DRIZZLE_ENGINE_ID);
		expect(engine.id).toBe("drizzle-kit");
		expect(engine.version).toBe(DEFAULT_DRIZZLE_ENGINE_VERSION);
		expect(Object.isFrozen(engine)).toBe(true);
	});

	it("stamps its engine id and version onto every plan it produces", () => {
		const plan = createDrizzleDiffEngine({ version: "0.99.0" }).diff(
			CURRENT,
			DESIRED,
		);

		expect(plan.engineId).toBe("drizzle-kit");
		expect(plan.engineVersion).toBe("0.99.0");
		expect(plan.steps.length).toBeGreaterThan(0);
	});

	it("puts the engine version in the plan digest so an upgrade is a visible change", () => {
		const pinned = createDrizzleDiffEngine({ version: "0.31.1" }).diff(
			CURRENT,
			DESIRED,
		);
		const upgraded = createDrizzleDiffEngine({ version: "0.32.0" }).diff(
			CURRENT,
			DESIRED,
		);
		const pinnedAgain = createDrizzleDiffEngine({ version: "0.31.1" }).diff(
			CURRENT,
			DESIRED,
		);

		expect(upgraded.steps).toEqual(pinned.steps);
		expect(upgraded.digest).not.toBe(pinned.digest);
		expect(pinnedAgain.digest).toBe(pinned.digest);
	});

	it("produces the same plan for the same inputs", () => {
		const engine = createDrizzleDiffEngine();

		expect(engine.diff(CURRENT, DESIRED)).toEqual(
			engine.diff(CURRENT, DESIRED),
		);
	});

	it("plans nothing when the schemas already agree", () => {
		expect(createDrizzleDiffEngine().diff(DESIRED, DESIRED).steps).toEqual([]);
	});
});

describe("emitSql toolchain gate", () => {
	it("is always present, so an absent toolchain reads as a refusal and not a fallback", () => {
		expect(createDrizzleDiffEngine().emitSql instanceof Function).toBe(true);
	});

	it("refuses with TOOLCHAIN_UNAVAILABLE when the toolchain is absent", () => {
		const engine = createDrizzleDiffEngine();
		const plan = engine.diff(CURRENT, DESIRED);

		expect(thrownCode(() => engine.emitSql?.(plan))).toBe(
			"TOOLCHAIN_UNAVAILABLE",
		);
	});

	it("refuses with TOOLCHAIN_UNAVAILABLE when the toolchain is declared but no emitter is wired", () => {
		const engine = createDrizzleDiffEngine({ toolchainPresent: true });
		const plan = engine.diff(CURRENT, DESIRED);

		expect(thrownCode(() => engine.emitSql?.(plan))).toBe(
			"TOOLCHAIN_UNAVAILABLE",
		);
	});

	const remediationCases: [string, boolean, string][] = [
		["absent toolchain", false, "install drizzle-kit"],
		["declared toolchain, no emitter", true, "does not bundle drizzle-kit"],
	];

	it.each(
		remediationCases,
	)("carries distinguishable remediation text for a %s", (_why, toolchainPresent, expected) => {
		const engine = createDrizzleDiffEngine({ toolchainPresent });
		const plan = engine.diff(CURRENT, DESIRED);

		try {
			engine.emitSql?.(plan);
			expect.unreachable("emitSql must refuse without a wired toolchain");
		} catch (error) {
			expect(error).toBeInstanceOf(DrizzleAdapterError);
			// SAFETY: assertion to `error as DrizzleAdapterError` is required at this boundary.
			const remediation = (error as DrizzleAdapterError).remediation;
			expect(remediation.toLowerCase()).toContain(expected.toLowerCase());
		}
	});

	it("emits through the wired toolchain when it is present", () => {
		const engine = createDrizzleDiffEngine({
			toolchainPresent: true,
			emitSql: echoEmitter,
		});
		const plan = engine.diff(CURRENT, DESIRED);
		const emitted = engine.emitSql?.(plan) ?? [];

		const firstStep = plan.steps[0];
		expect(firstStep).toBeDefined();
		expect(emitted).toHaveLength(plan.steps.length);
		expect(Object.isFrozen(emitted)).toBe(true);
		if (firstStep !== undefined) {
			expect(emitted[0]?.sql).toContain(stepKey(firstStep));
		}
	});

	it("refuses a partial emission rather than applying half a migration", () => {
		const engine = createDrizzleDiffEngine({
			toolchainPresent: true,
			emitSql: (plan) => echoEmitter(plan).slice(1),
		});
		const plan = engine.diff(CURRENT, DESIRED);

		expect(thrownCode(() => engine.emitSql?.(plan))).toBe(
			"SQL_EMISSION_INCOMPLETE",
		);
	});
});

describe("engine + ingestion together", () => {
	it("plans an added nullable column as an expand step from two ingested modules", () => {
		const before = ingestDrizzleSchema({
			users: table("users", {
				id: column("id", { sqlType: "serial", primary: true, notNull: true }),
			}),
		}).schema;
		const after = ingestDrizzleSchema({
			users: table("users", {
				id: column("id", { sqlType: "serial", primary: true, notNull: true }),
				nickname: column("nickname", { sqlType: "text" }),
			}),
		}).schema;

		const plan = createDrizzleDiffEngine().diff(before, after);

		expect(plan.steps).toEqual([
			{
				phase: "expand",
				kind: "add-column",
				table: "users",
				column: "nickname",
				destructive: false,
			},
		]);
	});
});
