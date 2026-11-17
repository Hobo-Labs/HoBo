import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Resource, Stack } from "alchemy";
import { Action } from "alchemy/Action";
import * as Alchemist from "alchemy/Alchemist";
import { decodeFqn, encodeFqn } from "alchemy/FQN";
import * as Provider from "alchemy/Provider";
import { localState, State } from "alchemy/State";
import { type BucketObjects, makeBucketState } from "alchemy/State/BucketState";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { describe, expect, it } from "vitest";
import {
	alchemyTarget,
	createAlchemyIacProvider,
	type FinancialPlan,
} from "../src/index.js";
import {
	alchemyStateScopeKey,
	safeAlchemyFqn,
	safeAlchemyState,
	uniqueAlchemyFqns,
} from "../src/state-identity.js";
import {
	routeFixture,
	testOperation,
	testStateOwnership,
} from "./route-fixture.js";

type Widget = Resource<"Spec.Widget", {}, { id: string }>;
const Widget = Resource<Widget>("Spec.Widget");
const program = {
	programId: "p",
	deploymentId: "d",
	resourceId: "app",
	provider: "test",
	driver: "external",
	action: "apply" as const,
	stackName: "App",
	operationGeneration: "generation-1",
};
const receipt = (requestId: string) => ({
	requestId,
	targetId: "t",
	status: "admitted",
	code: "",
	message: "",
	budget: { evaluation: "allowed", reservation: "held" },
	reservation: { reservationId: `iac:${requestId}` },
	requestDigest: `sha256:${"b".repeat(64)}`,
	inventoryHash: `sha256:${"c".repeat(64)}`,
	modelHash: `sha256:${"d".repeat(64)}`,
	quoteHash: `sha256:${"e".repeat(64)}`,
});
const persisted = (fqn: string) => ({
	resourceType: "Spec.Widget",
	fqn,
	logicalId: fqn,
	instanceId: "old-instance",
	providerVersion: 0,
	status: "created",
	downstream: [],
	bindings: [],
	props: {},
	attr: { id: "old" },
});

function bucket(initial: Record<string, string>): BucketObjects {
	const files = new Map(
		Object.entries(initial).map(([key, text]) => [key, { text, version: "1" }]),
	);
	let version = 1;
	return {
		listKeys: (prefix) =>
			Effect.succeed([...files.keys()].filter((key) => key.startsWith(prefix))),
		listChildren: () => Effect.succeed([]),
		read: (key) => Effect.succeed(files.get(key)),
		write: (key, text, condition) =>
			Effect.sync(() => {
				const prior = files.get(key);
				if (
					(condition && "ifAbsent" in condition && prior !== undefined) ||
					(condition &&
						"ifVersion" in condition &&
						prior?.version !== condition.ifVersion)
				)
					return undefined;
				const next = String(++version);
				files.set(key, { text, version: next });
				return next;
			}),
		delete: (key, ifVersion) =>
			Effect.sync(() => {
				if (ifVersion === undefined || files.get(key)?.version === ifVersion)
					files.delete(key);
			}),
		deleteMany: (keys) =>
			Effect.sync(() => {
				for (const key of keys) files.delete(key);
			}),
	};
}
function fixture(
	directory: string,
	resourceId: string,
	store: "local" | "bucket",
	legacyFqn?: string,
	stackName = "App",
	stage = "test",
	kind: "resource" | "action" = "resource",
	storageKey = "a__b",
) {
	let effects = 0;
	const Task = Action("Spec.Task", (_input: {}) =>
		Effect.sync(() => {
			effects++;
			return {};
		}),
	);
	const oldState =
		legacyFqn === undefined
			? undefined
			: JSON.stringify(
					kind === "resource"
						? persisted(legacyFqn)
						: {
								kind: "action",
								actionType: "Spec.Task",
								fqn: legacyFqn,
								logicalId: legacyFqn,
								status: "ran",
								downstream: [],
								inputHash: "old",
								input: {},
								output: {},
							},
				);
	const objects = bucket(
		oldState === undefined ? {} : { [`App/test/${storageKey}.json`]: oldState },
	);
	if (store === "local" && oldState !== undefined) {
		mkdirSync(join(directory, "state", "App", "test"), { recursive: true });
		writeFileSync(
			join(directory, "state", "App", "test", `${storageKey}.json`),
			oldState,
		);
	}
	const state =
		store === "local"
			? localState()
			: Layer.effect(
					State,
					Effect.map(
						makeBucketState({
							id: "test",
							label: "test",
							objects: Effect.succeed(objects),
						}),
						(service) => Effect.succeed(service),
					),
				);
	const stack = Stack(
		stackName,
		{
			providers: Provider.succeed(Widget, {
				reconcile: () =>
					Effect.sync(() => {
						effects++;
						return { id: "new" };
					}),
				delete: () =>
					Effect.sync(() => {
						effects++;
					}),
			}),
			state,
		},
		Effect.gen(function* () {
			if (kind === "resource") yield* Widget(resourceId, {});
			else yield* Task(resourceId, {});
			return {};
		}),
	);
	const options = {
		stack,
		stateOwnership: testStateOwnership,
		route: routeFixture().port,
		resolveRoute: ({ requestId }: { requestId?: string | undefined }) => ({
			requestId: requestId ?? "logical-attempt",
			operation: testOperation,
		}),
		composite: {
			proofRef: "host",
			environmentDigest: `sha256:${"b".repeat(64)}`,
			sourceRequirements: [],
			verifyEnvironment: () => true,
			verifyPlan: () => true,
		},
		runtimeLayer: Alchemist.layer(),
		runtimeDirectory: directory,
		target: alchemyTarget({
			targetId: "t",
			tenantId: "tenant",
			stackName,
			stage,
			programResourceId: "app",
			sourceDigest: `sha256:${"a".repeat(64)}`,
			inventoryEvidenceRef: "inventory",
			resources: [
				{
					resourceId,
					resourceType:
						kind === "resource" ? "Spec.Widget" : "alchemy:action:Spec.Task",
					providerId: "test",
					providerAccountRef: "account",
					productId: "widget",
				},
			],
		}),
		financial: {
			assess: (plan: FinancialPlan) => ({ plan }),
			admit: async () => {
				throw new Error("unexpected admission");
			},
			revalidate: () => true,
			uncertain: () => {},
		},
	};
	return { options, effects: () => effects };
}

describe("Alchemy state-key identity", () => {
	it.each([
		"a__b",
		"a_/b",
		"a/_b",
		"__stack_output__",
		"a\\b",
	])("rejects unsafe resource FQN %s before evaluating the stack", (fqn) => {
		const directory = mkdtempSync(join(tmpdir(), "hobo-fqn-"));
		try {
			const f = fixture(directory, fqn, "local");
			expect(() => createAlchemyIacProvider(f.options)).toThrow(
				"STATE_IDENTITY_INVALID",
			);
			expect(f.effects()).toBe(0);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});
	it.each([
		["../other", "test"],
		["App", "../test"],
		["App", "test/sub"],
	])("rejects unsafe stack/stage %s %s", (stack, stage) => {
		const directory = mkdtempSync(join(tmpdir(), "hobo-fqn-"));
		try {
			const f = fixture(directory, "widget", "local", undefined, stack, stage);
			expect(() => createAlchemyIacProvider(f.options)).toThrow(
				"STATE_IDENTITY_INVALID",
			);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});
	it.each([
		"local",
		"bucket",
	] as const)("detects an ambiguous pre-existing resource row in real %s state", async (store) => {
		const directory = mkdtempSync(join(tmpdir(), "hobo-fqn-"));
		const oldHome = process.env.ALCHEMY_HOME;
		process.env.ALCHEMY_HOME = join(directory, "home");
		try {
			const f = fixture(directory, "a/b", store, "a__b");
			const provider = createAlchemyIacProvider(f.options);
			await expect(provider.preview(program)).rejects.toThrow(
				"PLAN_UNAVAILABLE",
			);
			expect(f.effects()).toBe(0);
		} finally {
			if (oldHome === undefined) delete process.env.ALCHEMY_HOME;
			else process.env.ALCHEMY_HOME = oldHome;
			rmSync(directory, { recursive: true, force: true });
		}
	});
	it.each([
		"local",
		"bucket",
	] as const)("accepts a matching nested resource row in real %s state", async (store) => {
		const directory = mkdtempSync(join(tmpdir(), "hobo-fqn-"));
		const oldHome = process.env.ALCHEMY_HOME;
		process.env.ALCHEMY_HOME = join(directory, "home");
		try {
			const f = fixture(directory, "a/b", store, "a/b");
			const provider = createAlchemyIacProvider(f.options);
			await expect(provider.preview(program)).resolves.toBeDefined();
			expect(f.effects()).toBe(0);
		} finally {
			if (oldHome === undefined) delete process.env.ALCHEMY_HOME;
			else process.env.ALCHEMY_HOME = oldHome;
			rmSync(directory, { recursive: true, force: true });
		}
	});
	it("exhaustively accepts only round-tripping distinct storage keys for bounded identities", () => {
		const alphabet = ["a", "b", "_", "/", "."];
		let frontier = [""];
		const accepted = new Map<string, string>();
		for (let size = 1; size <= 5; size++) {
			frontier = frontier.flatMap((prefix) =>
				alphabet.map((letter) => prefix + letter),
			);
			for (const value of frontier) {
				if (!safeAlchemyFqn(value)) continue;
				const encoded = encodeFqn(value).toLowerCase();
				expect(decodeFqn(encodeFqn(value))).toBe(value);
				expect(accepted.get(encoded)).toBeUndefined();
				accepted.set(encoded, value);
			}
		}
		expect(accepted.size).toBeGreaterThan(100);
		expect(uniqueAlchemyFqns(["name", "NAME"])).toBe(false);
		expect(alchemyStateScopeKey("Demo", "Production")).toBe(
			alchemyStateScopeKey("demo", "production"),
		);
		expect(() => alchemyStateScopeKey("../other", "production")).toThrow(
			"STATE_IDENTITY_INVALID",
		);
	});

	it.each([
		"revalidate",
		"verifyPlan",
	] as const)("retains the claimed reservation if %s corrupts state immediately before apply", async (boundary) => {
		const directory = mkdtempSync(join(tmpdir(), "hobo-fqn-"));
		const oldHome = process.env.ALCHEMY_HOME;
		process.env.ALCHEMY_HOME = join(directory, "home");
		try {
			const f = fixture(directory, "a/b", "local", "a/b");
			const uncertain: string[] = [];
			let revalidated = false;
			const corrupt = () =>
				writeFileSync(
					join(directory, "state", "App", "test", "a__b.json"),
					JSON.stringify(persisted("a__b")),
				);
			const provider = createAlchemyIacProvider({
				...f.options,
				composite: {
					...f.options.composite,
					verifyPlan: () => {
						if (boundary === "verifyPlan" && revalidated) corrupt();
						return true;
					},
				},
				financial: {
					...f.options.financial,
					admit: async (id: string) => receipt(id),
					revalidate: () => {
						revalidated = true;
						if (boundary === "revalidate") corrupt();
						return true;
					},
					uncertain: (id: string) => {
						uncertain.push(id);
					},
				},
			});
			await provider.preview(program);
			await expect(
				provider.applyWithAdmission(program, "request"),
			).rejects.toMatchObject({
				code: "STATE_IDENTITY_UNVERIFIED",
				requiresReconciliation: true,
				executionOutcome: "not-started",
				reservationId: "iac:request",
			});
			expect(uncertain).toEqual(["iac:request"]);
			expect(f.effects()).toBe(0);
		} finally {
			if (oldHome === undefined) delete process.env.ALCHEMY_HOME;
			else process.env.ALCHEMY_HOME = oldHome;
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it.each([
		"local",
		"bucket",
	] as const)("rejects an ambiguous row inside the independent %s drift scope", async (store) => {
		const directory = mkdtempSync(join(tmpdir(), "hobo-fqn-"));
		const oldHome = process.env.ALCHEMY_HOME;
		process.env.ALCHEMY_HOME = join(directory, "home");
		try {
			const f = fixture(directory, "a/b", store, "a__b");
			const provider = createAlchemyIacProvider(f.options);
			await expect(provider.refresh(program)).rejects.toThrow(
				"PLAN_UNAVAILABLE",
			);
			expect(f.effects()).toBe(0);
		} finally {
			if (oldHome === undefined) delete process.env.ALCHEMY_HOME;
			else process.env.ALCHEMY_HOME = oldHome;
			rmSync(directory, { recursive: true, force: true });
		}
	});
	it.each([
		"local",
		"bucket",
	] as const)("preserves a real %s store through apply and destroy", async (store) => {
		const directory = mkdtempSync(join(tmpdir(), "hobo-fqn-"));
		const oldHome = process.env.ALCHEMY_HOME;
		process.env.ALCHEMY_HOME = join(directory, "home");
		try {
			const f = fixture(directory, "widget", store);
			const provider = createAlchemyIacProvider({
				...f.options,
				financial: {
					...f.options.financial,
					admit: async (requestId: string) => receipt(requestId),
				},
			});
			await provider.preview(program);
			await provider.applyWithAdmission(program, "create");
			const destroy = { ...program, action: "destroy" as const };
			await provider.preview(destroy);
			await provider.destroyWithAdmission(destroy, "destroy");
			expect(f.effects()).toBe(2);
		} finally {
			if (oldHome === undefined) delete process.env.ALCHEMY_HOME;
			else process.env.ALCHEMY_HOME = oldHome;
			rmSync(directory, { recursive: true, force: true });
		}
	});
	it.each([
		"local",
		"bucket",
	] as const)("rejects a historical action alias in real %s state", async (store) => {
		const directory = mkdtempSync(join(tmpdir(), "hobo-fqn-"));
		const oldHome = process.env.ALCHEMY_HOME;
		process.env.ALCHEMY_HOME = join(directory, "home");
		try {
			const f = fixture(
				directory,
				"a/b",
				store,
				"a__b",
				"App",
				"test",
				"action",
			);
			const provider = createAlchemyIacProvider(f.options);
			await expect(provider.preview(program)).rejects.toThrow(
				"PLAN_UNAVAILABLE",
			);
			expect(f.effects()).toBe(0);
		} finally {
			if (oldHome === undefined) delete process.env.ALCHEMY_HOME;
			else process.env.ALCHEMY_HOME = oldHome;
			rmSync(directory, { recursive: true, force: true });
		}
	});
	it.each([
		"local",
		"bucket",
	] as const)("accepts a matching historical action in real %s state", async (store) => {
		const directory = mkdtempSync(join(tmpdir(), "hobo-fqn-"));
		const oldHome = process.env.ALCHEMY_HOME;
		process.env.ALCHEMY_HOME = join(directory, "home");
		try {
			const f = fixture(
				directory,
				"a/b",
				store,
				"a/b",
				"App",
				"test",
				"action",
			);
			const provider = createAlchemyIacProvider(f.options);
			await expect(provider.preview(program)).resolves.toBeDefined();
			expect(f.effects()).toBe(0);
		} finally {
			if (oldHome === undefined) delete process.env.ALCHEMY_HOME;
			else process.env.ALCHEMY_HOME = oldHome;
			rmSync(directory, { recursive: true, force: true });
		}
	});
	it("rechecks the independently opened drift state after host authorization", async () => {
		const directory = mkdtempSync(join(tmpdir(), "hobo-fqn-"));
		const oldHome = process.env.ALCHEMY_HOME;
		process.env.ALCHEMY_HOME = join(directory, "home");
		try {
			const f = fixture(directory, "a/b", "local", "a/b");
			let checks = 0;
			const provider = createAlchemyIacProvider({
				...f.options,
				composite: {
					...f.options.composite,
					verifyEnvironment: () => {
						checks++;
						if (checks === 2)
							writeFileSync(
								join(directory, "state", "App", "test", "a__b.json"),
								JSON.stringify(persisted("a__b")),
							);
						return true;
					},
				},
			});
			await expect(provider.refresh(program)).rejects.toThrow(
				"DRIFT_CHECK_UNAVAILABLE",
			);
			expect(checks).toBe(2);
			expect(f.effects()).toBe(0);
		} finally {
			if (oldHome === undefined) delete process.env.ALCHEMY_HOME;
			else process.env.ALCHEMY_HOME = oldHome;
			rmSync(directory, { recursive: true, force: true });
		}
	});
	it.each([
		"local",
		"bucket",
	] as const)("does not hide legacy resource state in the %s stack output key", async (store) => {
		const directory = mkdtempSync(join(tmpdir(), "hobo-fqn-"));
		const oldHome = process.env.ALCHEMY_HOME;
		process.env.ALCHEMY_HOME = join(directory, "home");
		try {
			const f = fixture(
				directory,
				"widget",
				store,
				"__stack_output__",
				"App",
				"test",
				"resource",
				"__stack_output__",
			);
			const provider = createAlchemyIacProvider(f.options);
			await expect(provider.preview(program)).rejects.toThrow(
				"PLAN_UNAVAILABLE",
			);
			await expect(provider.refresh(program)).rejects.toThrow(
				"PLAN_UNAVAILABLE",
			);
			expect(f.effects()).toBe(0);
		} finally {
			if (oldHome === undefined) delete process.env.ALCHEMY_HOME;
			else process.env.ALCHEMY_HOME = oldHome;
			rmSync(directory, { recursive: true, force: true });
		}
	});
	it("bounds replacement ancestry, downstream references and cyclic history", () => {
		type Row = { fqn: string; downstream: string[]; old?: Row };
		let row: Row = { fqn: "widget", downstream: Array(1024).fill("other") };
		for (let depth = 1; depth < 64; depth++)
			row = { fqn: "widget", downstream: [], old: row };
		expect(safeAlchemyState(row, "widget")).toBe(true);
		expect(
			safeAlchemyState({ fqn: "widget", downstream: [], old: row }, "widget"),
		).toBe(false);
		expect(
			safeAlchemyState(
				{ fqn: "widget", downstream: Array(1025).fill("other") },
				"widget",
			),
		).toBe(false);
		const cyclic: Row = { fqn: "widget", downstream: [] };
		cyclic.old = cyclic;
		expect(safeAlchemyState(cyclic, "widget")).toBe(false);
	});
});
