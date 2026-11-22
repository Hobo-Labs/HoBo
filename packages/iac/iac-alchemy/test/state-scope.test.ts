import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inMemoryState, Resource, Stack } from "alchemy";
import * as Alchemist from "alchemy/Alchemist";
import * as Provider from "alchemy/Provider";
import {
	InMemoryService,
	type ResourceState,
	State,
	type StateService,
} from "alchemy/State";
import * as Effect from "effect/Effect";
import { describe, expect, it } from "vitest";
import { alchemyTarget, createAlchemyIacProvider } from "../src/index.js";
import { guardAlchemyState } from "../src/state-identity.js";
import {
	routeFixture,
	testOperation,
	testStateOwnership,
} from "./route-fixture.js";

const scope = { stack: "App", stage: "test" };
const foreignScopes = [
	{ stack: "Other", stage: "test" },
	{ stack: "App", stage: "other" },
	{ stack: "app", stage: "test" },
	{ stack: "App", stage: "Test" },
];

async function fixture() {
	const outputs = {
		App: { test: { value: "own" }, other: { value: "other stage" } },
		Other: { test: { value: "other stack" } },
	};
	let migrations = 0;
	const raw = await Effect.runPromise(InMemoryService({}, outputs));
	const service: StateService = {
		...raw,
		migrate: () => {
			migrations++;
			return Effect.succeed([]);
		},
	};
	return {
		state: guardAlchemyState(service, scope),
		raw,
		outputs,
		migrations: () => migrations,
	};
}

describe("compiled Alchemy state scope", () => {
	it("rejects every resource and output operation in a foreign stack or stage", async () => {
		const { state, outputs } = await fixture();
		for (const foreign of foreignScopes) {
			// oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- SAFETY: the invalid test value must be rejected before storage sees it.
			const attempts = [
				state.list(foreign),
				state.get({ ...foreign, fqn: "item" }),
				state.set({ ...foreign, fqn: "item", value: {} as never }),
				state.delete({ ...foreign, fqn: "item" }),
				state.getReplacedResources(foreign),
				state.getOutput(foreign),
				state.setOutput({ ...foreign, value: "tampered" }),
				state.deleteStack(foreign),
			];
			for (const attempt of attempts)
				await expect(Effect.runPromise(attempt)).rejects.toThrow(
					"STATE_IDENTITY_UNVERIFIED",
				);
		}
		expect(outputs.Other.test).toEqual({ value: "other stack" });
		expect(outputs.App.other).toEqual({ value: "other stage" });
	});

	it("permits the exact stage's outputs and stage deletion, never a whole-stack deletion", async () => {
		const { state, outputs } = await fixture();
		await expect(Effect.runPromise(state.getOutput(scope))).resolves.toEqual({
			value: "own",
		});
		await Effect.runPromise(
			state.setOutput({ ...scope, value: { value: "new" } }),
		);
		expect(outputs.App.test).toEqual({ value: "new" });
		await expect(
			Effect.runPromise(state.deleteStack({ stack: scope.stack })),
		).rejects.toThrow("STATE_IDENTITY_UNVERIFIED");
		await Effect.runPromise(state.deleteStack(scope));
		expect(outputs.App.test).toBeUndefined();
		expect(outputs.App.other).toEqual({ value: "other stage" });
	});

	it("refuses unscoped discovery and migrations", async () => {
		const { state, migrations } = await fixture();
		await expect(Effect.runPromise(state.listStacks())).rejects.toThrow(
			"STATE_IDENTITY_UNVERIFIED",
		);
		await expect(
			Effect.runPromise(state.listStages(scope.stack)),
		).rejects.toThrow("STATE_IDENTITY_UNVERIFIED");
		await expect(Effect.runPromise(state.listStages("Other"))).rejects.toThrow(
			"STATE_IDENTITY_UNVERIFIED",
		);
		const migrate = state.migrate;
		expect(migrate).toBeDefined();
		if (migrate === undefined) throw new Error("expected a refused migration");
		await expect(Effect.runPromise(migrate(scope))).rejects.toThrow(
			"STATE_IDENTITY_UNVERIFIED",
		);
		expect(migrations()).toBe(0);
	});

	it("does not expose the unrestricted backing service as its prototype", async () => {
		const { state } = await fixture();
		expect(Object.getPrototypeOf(state)).toBe(Object.prototype);
		expect(Object.isFrozen(state)).toBe(true);
	});

	it("snapshots checked request data before the returned effect runs", async () => {
		const { state, outputs } = await fixture();
		const request = { ...scope, value: { value: "changed" } };
		const pending = state.setOutput(request);
		request.stack = "Other";
		await Effect.runPromise(pending);
		expect(outputs.App.test).toEqual({ value: "changed" });
		expect(outputs.Other.test).toEqual({ value: "other stack" });
	});

	it("snapshots a replacement row's identity before a deferred write", async () => {
		const { state, raw } = await fixture();
		const prior = {
			status: "created" as const,
			resourceType: "Spec.Widget",
			fqn: "widget",
			logicalId: "widget",
			instanceId: "prior",
			providerVersion: 0,
			namespace: undefined,
			downstream: ["upstream"],
			bindings: [],
			props: {},
			attr: {},
		};
		const row = {
			...prior,
			status: "replaced" as const,
			downstream: ["dependent"],
			old: prior,
			deleteFirst: false,
		};
		const pending = state.set({ ...scope, fqn: "widget", value: row });
		row.fqn = "other";
		row.downstream.push("../escape");
		prior.fqn = "other";
		prior.downstream[0] = "../escape";
		await Effect.runPromise(pending);
		const stored = await Effect.runPromise(
			raw.get({ ...scope, fqn: "widget" }),
		);
		expect(stored).toMatchObject({
			fqn: "widget",
			downstream: ["dependent"],
			old: { fqn: "widget", downstream: ["upstream"] },
		});
	});

	it("keeps the validated identity stable while a backend write is in flight", async () => {
		const { raw } = await fixture();
		let started = () => {};
		let release = () => {};
		const writing = new Promise<void>((resolve) => {
			started = resolve;
		});
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const delayed: StateService = {
			...raw,
			set: (request) =>
				Effect.gen(function* () {
					started();
					yield* Effect.promise(() => gate);
					return yield* raw.set(request);
				}),
		};
		const state = guardAlchemyState(delayed, scope);
		const row = {
			status: "created" as const,
			resourceType: "Spec.Widget",
			fqn: "widget",
			logicalId: "widget",
			instanceId: "one",
			providerVersion: 0,
			namespace: undefined,
			downstream: ["dependent"],
			bindings: [],
			props: {},
			attr: {},
		};
		const pending = Effect.runPromise(
			state.set({ ...scope, fqn: "widget", value: row }),
		);
		await writing;
		row.fqn = "other";
		row.downstream[0] = "../escape";
		release();
		await pending;
		const stored = await Effect.runPromise(
			raw.get({ ...scope, fqn: "widget" }),
		);
		expect(stored).toMatchObject({ fqn: "widget", downstream: ["dependent"] });
	});

	it("accepts an interrupted update whose previous values have no resource identity", async () => {
		const { state } = await fixture();
		const row = {
			status: "updating" as const,
			resourceType: "Spec.Widget",
			fqn: "widget",
			logicalId: "widget",
			instanceId: "one",
			providerVersion: 0,
			namespace: undefined,
			downstream: [],
			bindings: [],
			props: {},
			old: { props: {}, bindings: [], attr: { id: "old" } },
		};
		await expect(
			Effect.runPromise(state.set({ ...scope, fqn: "widget", value: row })),
		).resolves.toMatchObject({ fqn: "widget", status: "updating" });
	});

	it("does not execute scope accessors or proxy traps", async () => {
		const { state } = await fixture();
		let calls = 0;
		const accessor = {
			get stack() {
				calls++;
				return "App";
			},
			stage: "test",
		};
		const proxy = new Proxy(
			{ ...scope },
			{
				getOwnPropertyDescriptor() {
					calls++;
					throw new Error("proxy trap");
				},
			},
		);
		const fqnAccessor = {
			...scope,
			get fqn() {
				calls++;
				return "widget";
			},
		};
		await expect(
			Effect.runPromise(state.getOutput(accessor)),
		).rejects.toThrow();
		await expect(Effect.runPromise(state.getOutput(proxy))).rejects.toThrow();
		await expect(Effect.runPromise(state.get(fqnAccessor))).rejects.toThrow();
		expect(calls).toBe(0);
	});

	it("rejects proxy-backed replacement rows without executing their traps", async () => {
		const { raw } = await fixture();
		let calls = 0;
		const row = new Proxy(
			{ fqn: "widget", downstream: [] },
			{
				getOwnPropertyDescriptor() {
					calls++;
					throw new Error("proxy trap");
				},
			},
		);
		const backend: StateService = {
			...raw,
			// oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- SAFETY: this deliberately malformed storage row tests the input boundary.
			getReplacedResources: () => Effect.succeed([row as never]),
		};
		const state = guardAlchemyState(backend, scope);
		await expect(
			Effect.runPromise(state.getReplacedResources(scope)),
		).rejects.toThrow();
		expect(calls).toBe(0);
	});

	it("rejects proxy-backed stack output without executing its traps", async () => {
		const { raw } = await fixture();
		let calls = 0;
		const output = new Proxy(
			{},
			{
				getOwnPropertyDescriptor() {
					calls++;
					throw new Error("proxy trap");
				},
			},
		);
		const state = guardAlchemyState(
			{ ...raw, getOutput: () => Effect.succeed(output) },
			scope,
		);
		await expect(Effect.runPromise(state.getOutput(scope))).rejects.toThrow();
		await expect(Effect.runPromise(state.list(scope))).rejects.toThrow();
		expect(calls).toBe(0);
	});

	it("returns independent row identities when a backend changes its stored rows later", async () => {
		const { raw, state } = await fixture();
		const old = {
			status: "created" as const,
			resourceType: "Spec.Widget",
			fqn: "widget",
			logicalId: "widget",
			instanceId: "old",
			providerVersion: 0,
			namespace: undefined,
			downstream: ["upstream"],
			bindings: [],
			props: {},
			attr: {},
		};
		const row = {
			...old,
			status: "replaced" as const,
			downstream: ["dependent"],
			old,
			deleteFirst: false,
		};
		await Effect.runPromise(raw.set({ ...scope, fqn: "widget", value: row }));
		const one = await Effect.runPromise(state.get({ ...scope, fqn: "widget" }));
		const replacements = await Effect.runPromise(
			state.getReplacedResources(scope),
		);
		row.fqn = "other";
		row.downstream.push("../escape");
		old.fqn = "other";
		old.downstream[0] = "../escape";
		const expected = {
			fqn: "widget",
			downstream: ["dependent"],
			old: { fqn: "widget", downstream: ["upstream"] },
		};
		expect(one).toMatchObject(expected);
		expect(replacements).toMatchObject([expected]);
		expect(Object.isFrozen(one)).toBe(true);
		expect(Object.isFrozen(replacements[0])).toBe(true);
	});

	it("supports a real deploy and update while preventing a provider from deleting another stack", async () => {
		const directory = mkdtempSync(join(tmpdir(), "hobo-state-scope-"));
		const previous = process.env.ALCHEMY_HOME;
		process.env.ALCHEMY_HOME = join(directory, "auth");
		const outputs = { Other: { test: { value: "retained" } } };
		const records: Record<
			string,
			Record<string, Record<string, ResourceState>>
		> = {};
		let providerCalls = 0;
		let requested = "first";
		let attack = false;
		type Widget = Resource<"Spec.Widget", { value: string }, { id: string }>;
		const Widget = Resource<Widget>("Spec.Widget");
		const stack = Stack(
			"App",
			{
				state: inMemoryState(records, outputs),
				providers: Provider.succeed(Widget, {
					reconcile: ({ news }) =>
						Effect.gen(function* () {
							providerCalls++;
							if (attack) {
								const state = yield* yield* State;
								yield* state.deleteStack({ stack: "Other", stage: "test" });
							}
							return { id: news.value };
						}),
					delete: () => Effect.void,
				}),
			},
			Effect.gen(function* () {
				yield* Widget("widget", { value: requested });
				return {};
			}),
		);
		const provider = createAlchemyIacProvider({
			stack,
			target: alchemyTarget({
				targetId: "target",
				tenantId: "tenant",
				stackName: "App",
				stage: "test",
				programResourceId: "app",
				sourceDigest: `sha256:${"a".repeat(64)}`,
				inventoryEvidenceRef: "inventory",
				resources: [
					{
						resourceId: "widget",
						resourceType: "Spec.Widget",
						providerId: "sandbox",
						providerAccountRef: "account",
						productId: "widget",
					},
				],
			}),
			stateOwnership: testStateOwnership,
			composite: {
				proofRef: "host",
				environmentDigest: `sha256:${"b".repeat(64)}`,
				sourceRequirements: [],
				verifyEnvironment: () => true,
				verifyPlan: () => true,
			},
			runtimeLayer: Alchemist.layer(),
			runtimeDirectory: join(directory, "runtime"),
			route: routeFixture().port,
			resolveRoute: ({ requestId }) => ({
				requestId: requestId ?? "attempt",
				operation: testOperation,
			}),
			financial: {
				assess: (plan) => ({ plan }),
				admit: async (requestId) => ({
					requestId,
					targetId: "target",
					status: "admitted",
					code: "",
					message: "",
					budget: { evaluation: "allowed", reservation: "held" },
					reservation: { reservationId: `iac:${requestId}` },
					requestDigest: `sha256:${"b".repeat(64)}`,
					inventoryHash: `sha256:${"c".repeat(64)}`,
					modelHash: `sha256:${"d".repeat(64)}`,
					quoteHash: `sha256:${"e".repeat(64)}`,
				}),
				revalidate: () => true,
				uncertain: () => {},
			},
		});
		const program = {
			programId: "p",
			deploymentId: "deployment",
			resourceId: "app",
			provider: "sandbox",
			driver: "external",
			action: "apply" as const,
			stackName: "logical",
			operationGeneration: "generation",
		};
		try {
			await provider.preview(program);
			await expect(
				provider.applyWithAdmission(program, "create"),
			).resolves.toBeDefined();
			requested = "second";
			const update = { ...program, operationGeneration: "update" };
			await provider.preview(update);
			await expect(
				provider.applyWithAdmission(update, "update"),
			).resolves.toBeDefined();
			const stage = records.App?.test;
			const stable = stage?.widget;
			if (
				stage === undefined ||
				stable === undefined ||
				stable.attr === undefined ||
				stable.props === undefined
			)
				throw new Error("completed update did not persist its baseline");
			stage.widget = {
				...stable,
				status: "updating",
				props: { value: "third" },
				old: {
					props: stable.props,
					bindings: stable.bindings,
					attr: stable.attr,
				},
			};
			requested = "third";
			const resumed = { ...program, operationGeneration: "resume" };
			await provider.preview(resumed);
			await expect(
				provider.applyWithAdmission(resumed, "resume"),
			).resolves.toBeDefined();
			requested = "fourth";
			attack = true;
			const foreignAttempt = { ...program, operationGeneration: "foreign" };
			await provider.preview(foreignAttempt);
			await expect(
				provider.applyWithAdmission(foreignAttempt, "foreign"),
			).rejects.toMatchObject({
				requiresReconciliation: true,
			});
			expect(providerCalls).toBe(4);
			expect(outputs.Other.test).toEqual({ value: "retained" });
		} finally {
			if (previous === undefined) delete process.env.ALCHEMY_HOME;
			else process.env.ALCHEMY_HOME = previous;
			rmSync(directory, { recursive: true, force: true });
		}
	});
});
