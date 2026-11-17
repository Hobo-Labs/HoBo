import { create } from "@bufbuild/protobuf";
import { describe, expect, it } from "vitest";
import { alchemyTarget, ResourceScopeSchema } from "../src/index.js";
import {
	type AlchemyCompositeGuard,
	digestData,
	hashAlchemyPriorState,
	inspectAlchemyPlan,
} from "../src/plan.js";
import { registerAlchemySource } from "../src/source-fence.js";

function fixture() {
	const node = {
		resource: {
			FQN: "store",
			Type: "Spec.Store",
			LogicalId: "store",
			Props: {},
			RemovalPolicy: "destroy",
		},
		action: "create",
		provider: { version: "1" },
		state: undefined,
		bindings: [],
		downstream: [],
		props: {},
	};
	const native = {
		resources: { store: node },
		deletions: {},
		actions: {},
		actionDeletions: {},
		cycleMembers: new Set<string>(),
		output: {},
		destroy: false,
	};
	const plan = {
		stack: { name: "App", stage: "test" },
		resources: [{ fqn: "store", resourceType: "Spec.Store", action: "create" }],
		actions: [],
		native,
	};
	const target = alchemyTarget({
		targetId: "yard",
		tenantId: "tenant",
		stackName: "App",
		stage: "test",
		programResourceId: "app",
		sourceDigest: `sha256:${"a".repeat(64)}`,
		inventoryEvidenceRef: "inventory:1",
		resources: [
			{
				resourceId: "store",
				resourceType: "Spec.Store",
				providerId: "test",
				providerAccountRef: "account",
				productId: "storage",
			},
		],
	});
	const guard: AlchemyCompositeGuard = {
		proofRef: "host:proof",
		environmentDigest: `sha256:${"b".repeat(64)}`,
		sourceRequirements: [],
		verifyEnvironment: () => true,
		verifyPlan: () => true,
	};
	// SAFETY: this fixture deliberately constructs incomplete native plans to test the inspection boundary.
	const inspect = () => inspectAlchemyPlan(plan as never, target, guard);
	return { native, node, plan, target, inspect };
}

function compositeFixture() {
	const f = fixture();
	const action = {
		kind: "action",
		action: "run",
		def: {
			Kind: "action",
			FQN: "build",
			LogicalId: "build",
			Type: "Spec.Build",
			Input: {},
			Captures: {},
			Run: () => "build",
		},
		input: {},
		downstream: [],
		state: undefined,
	};
	Object.assign(f.native.actions, { build: action });
	Object.assign(f.plan, {
		actions: [
			{
				fqn: "build",
				logicalId: "build",
				actionType: "Spec.Build",
				action: "run",
			},
		],
	});
	f.target.resources.push(
		create(ResourceScopeSchema, {
			resourceId: "build",
			resourceType: "alchemy:action:Spec.Build",
			providerId: "sandbox",
			providerAccountRef: "build-account",
			productId: "build",
		}),
	);
	const guard: AlchemyCompositeGuard = {
		proofRef: "host:proof",
		environmentDigest: `sha256:${"b".repeat(64)}`,
		sourceRequirements: [],
		verifyEnvironment: () => true,
		verifyPlan: () => true,
	};
	// SAFETY: constructed plan isolates action-graph invariants at the boundary.
	const inspect = () => inspectAlchemyPlan(f.plan as never, f.target, guard);
	return { ...f, action, guard, inspect };
}

describe("native Alchemy plan inspection", () => {
	it("rejects a native action whose captured state was substituted", () => {
		const f = compositeFixture();
		const state = { fqn: "build", downstream: [] };
		Object.assign(f.action, { state });
		expect(f.inspect).not.toThrow();
		state.fqn = "other";
		expect(f.inspect).toThrow("STATE_IDENTITY_UNVERIFIED");
	});

	it("binds source claims to the exact resource, target digest and host authority", () => {
		const f = fixture();
		let permitted = true;
		const claim = {
			resourceId: "store",
			resourceType: "Spec.Store",
			bindleName: "app",
			applicationName: "store",
			sourceKind: "test",
			sourcePath: "/source/store",
			sourceDigest: f.target.sourceDigest,
			environmentDigest: `sha256:${"b".repeat(64)}`,
			proofRef: "host:proof",
		};
		registerAlchemySource(f.node.resource, { claim, verify: () => permitted });
		const guard: AlchemyCompositeGuard = {
			proofRef: "host:proof",
			environmentDigest: claim.environmentDigest,
			sourceRequirements: [
				{
					resourceId: claim.resourceId,
					resourceType: claim.resourceType,
					bindleName: claim.bindleName,
					applicationName: claim.applicationName,
					sourceKind: claim.sourceKind,
					sourcePath: claim.sourcePath,
				},
			],
			verifyEnvironment: () => true,
			verifyPlan: ({ sourceClaims }) => {
				expect(sourceClaims).toEqual([claim]);
				expect(Object.isFrozen(sourceClaims[0])).toBe(true);
				return true;
			},
		};
		// SAFETY: this deliberately minimal plan exercises the source attestation boundary.
		const inspect = (authority?: AlchemyCompositeGuard) =>
			inspectAlchemyPlan(f.plan as never, f.target, authority);
		expect(() => inspect()).toThrow("COMPOSITE_ENVIRONMENT_UNVERIFIED");
		const unclassified = { ...guard };
		Reflect.deleteProperty(unclassified, "sourceRequirements");
		expect(() => inspect(unclassified)).toThrow(
			"COMPOSITE_ENVIRONMENT_UNVERIFIED",
		);
		const before = inspect(guard).digest;
		const other = fixture();
		registerAlchemySource(other.node.resource, {
			claim: { ...claim, sourcePath: "/source/other" },
			verify: () => true,
		});
		// SAFETY: this deliberately minimal plan exercises source-fingerprint coverage.
		const changed = inspectAlchemyPlan(other.plan as never, other.target, {
			...guard,
			sourceRequirements: [
				{
					resourceId: claim.resourceId,
					resourceType: claim.resourceType,
					bindleName: claim.bindleName,
					applicationName: claim.applicationName,
					sourceKind: claim.sourceKind,
					sourcePath: "/source/other",
				},
			],
			verifyPlan: () => true,
		}).digest;
		expect(changed).not.toBe(before);
		f.target.sourceDigest = `sha256:${"c".repeat(64)}`;
		expect(() => inspect(guard)).toThrow("SOURCE_FENCE_MISMATCH");
		f.target.sourceDigest = claim.sourceDigest;
		expect(() => inspect({ ...guard, proofRef: "host:other" })).toThrow(
			"SOURCE_FENCE_MISMATCH",
		);
		permitted = false;
		expect(() => inspect(guard)).toThrow("SOURCE_FENCE_UNVERIFIED");
	});

	it("lets the host reject a plan missing an expected executable source", () => {
		const f = fixture();
		const guard: AlchemyCompositeGuard = {
			proofRef: "host:proof",
			environmentDigest: `sha256:${"b".repeat(64)}`,
			sourceRequirements: [
				{
					resourceId: "store",
					resourceType: "Spec.Store",
					bindleName: "app",
					applicationName: "store",
					sourceKind: "test",
					sourcePath: "/source/store",
				},
			],
			verifyEnvironment: () => true,
			verifyPlan: ({ sourceClaims }) => sourceClaims.length === 1,
		};
		// SAFETY: this deliberately minimal plan exercises the missing-source boundary.
		expect(() => inspectAlchemyPlan(f.plan as never, f.target, guard)).toThrow(
			"SOURCE_FENCE_INCOMPLETE",
		);
	});

	it.each([
		"delete",
		"replace",
		"update",
		"noop",
	] as const)("exposes the exact prior non-source resource state for %s", (action) => {
		const f = fixture();
		const state = {
			fqn: "store",
			resourceType: "Spec.Store",
			logicalId: "store",
			instanceId: "instance-1",
			status: "created",
			downstream: [],
			bindings: [],
			props: {},
			attr: { physicalId: "bucket-a" },
		};
		const digest = hashAlchemyPriorState(state);
		Object.assign(f.node, { action, state });
		if (action === "replace") Object.assign(f.node, { deleteFirst: false });
		Object.assign(f.plan.resources[0] ?? {}, { action });
		if (action === "delete")
			Object.assign(f.native, {
				resources: {},
				deletions: { store: f.node },
				destroy: true,
			});
		let observations = 0;
		const guard: AlchemyCompositeGuard = {
			proofRef: "host:proof",
			environmentDigest: `sha256:${"b".repeat(64)}`,
			sourceRequirements: [],
			verifyEnvironment: () => true,
			verifyPlan: ({ historicalResources, historicalSources }) => {
				observations++;
				expect(Object.isFrozen(historicalResources)).toBe(true);
				expect(Object.isFrozen(historicalResources[0])).toBe(true);
				expect(historicalSources).toEqual([]);
				expect(historicalResources).toEqual([
					{
						resourceId: "store",
						resourceType: "Spec.Store",
						priorResourceType: "Spec.Store",
						action,
						priorStateDigest: digest,
						renamedFrom: [],
					},
				]);
				return true;
			},
		};
		// SAFETY: deliberately constructed plans isolate observation semantics.
		expect(() =>
			inspectAlchemyPlan(f.plan as never, f.target, guard),
		).not.toThrow();
		expect(observations).toBe(1);
	});

	it("lets the host reject a bucket whose exact prior state differs from its trusted record", () => {
		const f = fixture();
		const state = {
			fqn: "store",
			resourceType: "Spec.Store",
			logicalId: "store",
			instanceId: "instance-1",
			status: "created",
			downstream: [],
			bindings: [],
			props: {},
			attr: { physicalId: "bucket-a" },
		};
		const trustedDigest = hashAlchemyPriorState(state);
		Object.assign(f.node, { action: "delete", state });
		Object.assign(f.plan.resources[0] ?? {}, { action: "delete" });
		Object.assign(f.native, {
			resources: {},
			deletions: { store: f.node },
			destroy: true,
		});
		const guard: AlchemyCompositeGuard = {
			proofRef: "host:proof",
			environmentDigest: `sha256:${"b".repeat(64)}`,
			sourceRequirements: [],
			verifyEnvironment: () => true,
			verifyPlan: ({ historicalResources }) =>
				historicalResources.length === 1 &&
				historicalResources[0]?.priorStateDigest === trustedDigest,
		};
		// SAFETY: deliberately constructed plans isolate host authorization.
		const inspect = () => inspectAlchemyPlan(f.plan as never, f.target, guard);
		expect(inspect).not.toThrow();
		state.attr.physicalId = "bucket-b";
		expect(inspect).toThrow("COMPOSITE_PLAN_UNVERIFIED");
	});

	it("reports an empty prior inventory for a fresh resource and exposes explicit rename provenance", () => {
		const f = fixture();
		let expected: object[] = [];
		const guard: AlchemyCompositeGuard = {
			proofRef: "host:proof",
			environmentDigest: `sha256:${"b".repeat(64)}`,
			sourceRequirements: [],
			verifyEnvironment: () => true,
			verifyPlan: ({ historicalResources }) => {
				expect(historicalResources).toEqual(expected);
				return true;
			},
		};
		// SAFETY: deliberately constructed plans isolate prior-state observations.
		const inspect = () => inspectAlchemyPlan(f.plan as never, f.target, guard);
		expect(inspect).not.toThrow();
		const state = {
			fqn: "store",
			resourceType: "Spec.Store",
			logicalId: "store",
			instanceId: "instance-1",
			status: "created",
			downstream: [],
			bindings: [],
			props: {},
			attr: {},
		};
		Object.assign(f.node, {
			action: "update",
			state,
			renamedFrom: ["old-store"],
		});
		Object.assign(f.plan.resources[0] ?? {}, { action: "update" });
		expected = [
			{
				resourceId: "store",
				resourceType: "Spec.Store",
				priorResourceType: "Spec.Store",
				action: "update",
				priorStateDigest: hashAlchemyPriorState(state),
				renamedFrom: ["old-store"],
			},
		];
		expect(inspect).not.toThrow();
	});

	it("rejects malformed, mismatched, or unhashable prior state before asking the host", () => {
		for (const invalid of [
			{
				fqn: "store",
				resourceType: "",
				logicalId: "store",
				instanceId: "id",
				status: "created",
				downstream: [],
			},
			{
				fqn: "store",
				resourceType: "Spec.Store",
				logicalId: "wrong",
				instanceId: "id",
				status: "created",
				downstream: [],
			},
			{
				fqn: "store",
				resourceType: "Spec.Store",
				logicalId: "store",
				instanceId: "id",
				status: "invalid",
				downstream: [],
			},
			{
				fqn: "store",
				resourceType: "Spec.Store",
				logicalId: "store",
				instanceId: "id",
				status: "created",
				downstream: [],
				attr: {
					get value() {
						throw new Error("not data");
					},
				},
			},
		]) {
			const f = fixture();
			Object.assign(f.node, { action: "replace", state: invalid });
			Object.assign(f.plan.resources[0] ?? {}, { action: "replace" });
			let invoked = false;
			const guard: AlchemyCompositeGuard = {
				proofRef: "host:proof",
				environmentDigest: `sha256:${"b".repeat(64)}`,
				sourceRequirements: [],
				verifyEnvironment: () => true,
				verifyPlan: () => {
					invoked = true;
					return true;
				},
			};
			// SAFETY: deliberately malformed plans must fail before host authorization.
			expect(() =>
				inspectAlchemyPlan(f.plan as never, f.target, guard),
			).toThrow();
			expect(invoked).toBe(false);
		}
	});

	it("exhaustively accepts only Alchemy's bounded resource action and prior-status combinations", () => {
		const actions = [
			"create",
			"update",
			"adopted",
			"replace",
			"noop",
			"delete",
			"orphaned",
		] as const;
		const statuses = [
			"creating",
			"created",
			"updating",
			"updated",
			"deleting",
			"replacing",
			"replaced",
		] as const;
		const allowed = {
			create: ["creating"],
			update: ["created", "updated", "updating", "replaced"],
			adopted: ["created", "updated", "updating", "replaced"],
			replace: [
				"creating",
				"created",
				"updating",
				"updated",
				"replacing",
				"replaced",
			],
			noop: ["created", "updated"],
			delete: statuses,
			orphaned: statuses,
		} satisfies Readonly<Record<string, readonly string[]>>;
		for (const action of actions)
			for (const status of statuses) {
				const f = fixture();
				const state = {
					fqn: "store",
					resourceType: "Spec.Store",
					logicalId: "store",
					instanceId: "instance",
					status,
					downstream: [],
					bindings: [],
					props: {},
					attr: {},
				};
				Object.assign(f.node, { action, state });
				Object.assign(f.plan.resources[0] ?? {}, { action });
				if (action === "delete" || action === "orphaned")
					Object.assign(f.native, {
						resources: {},
						deletions: { store: f.node },
						destroy: true,
					});
				const guard: AlchemyCompositeGuard = {
					proofRef: "host:proof",
					environmentDigest: `sha256:${"b".repeat(64)}`,
					sourceRequirements: [],
					verifyEnvironment: () => true,
					verifyPlan: () => true,
				};
				// SAFETY: the finite matrix deliberately constructs native plan variants.
				const inspect = () =>
					inspectAlchemyPlan(f.plan as never, f.target, guard);
				if (allowed[action]?.includes(status)) expect(inspect).not.toThrow();
				else expect(inspect).toThrow("STATE_IDENTITY_UNVERIFIED");
			}
	});

	it("exposes and requires independent approval of a provider-declared prior type alias", () => {
		const f = fixture();
		const state = {
			fqn: "store",
			resourceType: "Spec.LegacyStore",
			logicalId: "store",
			instanceId: "instance",
			status: "created",
			downstream: [],
			bindings: [],
			props: {},
			attr: {},
		};
		Object.assign(f.node, { action: "update", state });
		Object.assign(f.plan.resources[0] ?? {}, { action: "update" });
		const guard: AlchemyCompositeGuard = {
			proofRef: "host:proof",
			environmentDigest: `sha256:${"b".repeat(64)}`,
			sourceRequirements: [],
			verifyEnvironment: () => true,
			verifyPlan: ({ historicalResources }) =>
				historicalResources[0]?.priorResourceType === "Spec.LegacyStore",
		};
		// SAFETY: a deliberately constructed native plan tests provider alias authorization.
		const inspect = () => inspectAlchemyPlan(f.plan as never, f.target, guard);
		expect(inspect).toThrow("STATE_IDENTITY_UNVERIFIED");
		Object.assign(f.node.provider, { aliases: ["Spec.LegacyStore"] });
		expect(inspect).not.toThrow();
		const refusing = { ...guard, verifyPlan: () => false };
		// SAFETY: the same alias is rejected when the host independently refuses it.
		expect(() =>
			inspectAlchemyPlan(f.plan as never, f.target, refusing),
		).toThrow("COMPOSITE_PLAN_UNVERIFIED");
	});

	it("rejects state or rename accessors without invoking them", () => {
		for (const key of ["state", "renamedFrom"] as const) {
			const f = fixture();
			let invoked = 0;
			Object.defineProperty(f.node, key, {
				configurable: true,
				get() {
					invoked++;
					throw new Error("must not read");
				},
			});
			expect(f.inspect).toThrow("PLAN_UNINSPECTABLE");
			expect(invoked).toBe(0);
		}
	});

	it("rejects prior state changed by a source verifier during inspection", () => {
		const f = fixture();
		const state = {
			fqn: "store",
			resourceType: "Spec.Store",
			logicalId: "store",
			instanceId: "id",
			status: "created",
			downstream: [],
			bindings: [],
			props: {},
			attr: { physicalId: "bucket-a" },
		};
		Object.assign(f.node, { action: "update", state });
		Object.assign(f.plan.resources[0] ?? {}, { action: "update" });
		const requirement = {
			resourceId: "store",
			resourceType: "Spec.Store",
			bindleName: "app",
			applicationName: "store",
			sourceKind: "test",
			sourcePath: "/source/store",
		};
		registerAlchemySource(f.node.resource, {
			claim: {
				...requirement,
				sourceDigest: `sha256:${"a".repeat(64)}`,
				environmentDigest: `sha256:${"b".repeat(64)}`,
				proofRef: "host:proof",
			},
			verify: () => {
				state.attr.physicalId = "bucket-b";
				return true;
			},
		});
		let invoked = false;
		const guard: AlchemyCompositeGuard = {
			proofRef: "host:proof",
			environmentDigest: `sha256:${"b".repeat(64)}`,
			sourceRequirements: [requirement],
			verifyEnvironment: () => true,
			verifyPlan: () => {
				invoked = true;
				return true;
			},
		};
		// SAFETY: this plan isolates source-verifier mutation during inspection.
		expect(() => inspectAlchemyPlan(f.plan as never, f.target, guard)).toThrow(
			"PLAN_UNINSPECTABLE",
		);
		expect(invoked).toBe(false);
	});

	it("requires an independently authorized exact prior state for reconstructed source deletion", () => {
		const f = fixture();
		const state = {
			status: "created",
			fqn: "store",
			resourceType: "Spec.Store",
			logicalId: "store",
			instanceId: "instance-1",
			downstream: [],
			props: { main: "/source/store" },
			attr: { endpoint: "first" },
		};
		Object.assign(f.node, { action: "delete", state });
		Object.assign(f.node.resource, { Props: state.props });
		Object.assign(f.native, {
			resources: {},
			deletions: { store: f.node },
			destroy: true,
		});
		const summary = f.plan.resources[0];
		if (summary === undefined) throw new Error("fixture resource missing");
		Object.assign(summary, { action: "delete" });
		let observed = "";
		let approvedState = digestData(state);
		const guard: AlchemyCompositeGuard = {
			proofRef: "host:proof",
			environmentDigest: `sha256:${"b".repeat(64)}`,
			sourceRequirements: [
				{
					resourceId: "store",
					resourceType: "Spec.Store",
					bindleName: "app",
					applicationName: "store",
					sourceKind: "test",
					sourcePath: "/source/store",
				},
			],
			verifyEnvironment: () => true,
			verifyPlan: ({
				historicalSources,
				historicalResources,
				sourceClaims,
			}) => {
				expect(sourceClaims).toHaveLength(1);
				expect(historicalResources[0]?.priorStateDigest).toBe(
					historicalSources[0]?.priorStateDigest,
				);
				observed = historicalSources[0]?.priorStateDigest ?? "";
				return historicalSources.length === 1 && observed === approvedState;
			},
		};
		// SAFETY: this deliberately minimal plan exercises the reconstructed deletion boundary.
		const inspect = () => inspectAlchemyPlan(f.plan as never, f.target, guard);
		const first = inspect().digest;
		const firstState = observed;
		state.attr.endpoint = "second";
		expect(inspect).toThrow("COMPOSITE_PLAN_UNVERIFIED");
		approvedState = digestData(state);
		expect(inspect().digest).not.toBe(first);
		expect(observed).not.toBe(firstState);
		Object.assign(f.node.resource, { Props: { main: "/source/other" } });
		expect(inspect).toThrow("SOURCE_FENCE_MISMATCH");
		Object.assign(f.node.resource, { Props: state.props });
		state.status = "updating";
		expect(inspect).toThrow("SOURCE_FENCE_INCOMPLETE");
		state.status = "created";
		state.fqn = "other";
		expect(inspect).toThrow("STATE_IDENTITY_UNVERIFIED");
	});
	it.each([
		"resources",
		"deletions",
	] as const)("rejects an unsummarized native %s node", (kind) => {
		const { native, node, inspect } = fixture();
		Object.assign(native[kind], {
			extra: { ...node, resource: { ...node.resource, FQN: "extra" } },
		});
		expect(inspect).toThrow("PLAN_UNINSPECTABLE");
	});

	it.each([
		"actions",
		"actionDeletions",
	] as const)("rejects an unsummarized native %s node", (kind) => {
		const { native, inspect } = fixture();
		Object.assign(native[kind], { extra: { kind: "action" } });
		expect(inspect).toThrow("PLAN_UNINSPECTABLE");
	});

	it.each([
		"deleteFirst",
		"restart",
		"adopting",
		"drift",
	] as const)("fingerprints the native %s field", (field) => {
		const { node, inspect } = fixture();
		const before = inspect().digest;
		Object.assign(node, {
			[field]: field === "drift" ? { missing: true } : true,
		});
		expect(inspect().digest).not.toBe(before);
	});

	it("fingerprints the native default provider mode", () => {
		const { native, inspect } = fixture();
		const before = inspect().digest;
		Object.assign(native, { defaultMode: "live" });
		expect(inspect().digest).not.toBe(before);
	});

	it("recognizes a direct reference to a financially scoped native resource", () => {
		const { node, inspect } = fixture();
		Object.assign(node.props, { dependency: node.resource });
		expect(() => inspect()).not.toThrow();
	});

	it("does not accept executable action plans without a host guard", () => {
		const { plan, target } = compositeFixture();
		// SAFETY: constructed plan exercises the untrusted-action boundary.
		expect(() => inspectAlchemyPlan(plan as never, target)).toThrow(
			"COMPOSITE_ENVIRONMENT_UNVERIFIED",
		);
	});

	it("requires actions to match their exact financial scope and summary", () => {
		const f = compositeFixture();
		expect(() => f.inspect()).not.toThrow();
		const scope = f.target.resources.find((row) => row.resourceId === "build");
		if (scope === undefined) throw new Error("fixture action scope missing");
		scope.resourceType = "Spec.Build";
		expect(() => f.inspect()).toThrow("TARGET_INVENTORY_INCOMPLETE");
	});

	it("rejects native action nodes absent from their approved description", () => {
		const f = compositeFixture();
		Object.assign(f.native.actions, { hidden: f.action });
		expect(() => f.inspect()).toThrow("PLAN_UNINSPECTABLE");
	});

	it("fingerprints action input and runner code", () => {
		const f = compositeFixture();
		const before = f.inspect().digest;
		Object.assign(f.action.input, { path: "one" });
		const changedInput = f.inspect().digest;
		expect(changedInput).not.toBe(before);
		Object.assign(f.action.def, { Run: () => "other" });
		expect(f.inspect().digest).not.toBe(changedInput);
	});

	it("detects native mutation by a verifier before approving the plan", () => {
		const f = compositeFixture();
		Object.assign(f.guard, {
			verifyPlan: () => {
				Object.assign(f.action.input, { changed: true });
				return true;
			},
		});
		expect(() => f.inspect()).toThrow("PLAN_UNINSPECTABLE");
	});

	it("requires independent authorization for a Command.Build resource", () => {
		const f = fixture();
		Object.assign(f.node.resource, { Type: "Command.Build" });
		const summary = f.plan.resources[0];
		const scope = f.target.resources[0];
		if (summary === undefined || scope === undefined)
			throw new Error("fixture resource missing");
		Object.assign(summary, { resourceType: "Command.Build" });
		Object.assign(scope, { resourceType: "Command.Build" });
		// SAFETY: this constructed plan exercises the missing host guard boundary.
		expect(() => inspectAlchemyPlan(f.plan as never, f.target)).toThrow(
			"COMPOSITE_ENVIRONMENT_UNVERIFIED",
		);
	});
});
