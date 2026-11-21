import { create } from "@bufbuild/protobuf";
import { describe, expect, it } from "vitest";
import { alchemyTarget, ResourceScopeSchema } from "../src/index.js";
import {
	type AlchemyCompositeGuard,
	digestData,
	hashAlchemyPriorState,
	inspectAlchemyPlan,
	verifyCompositeEnvironment,
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
	// oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- SAFETY: this fixture deliberately constructs incomplete native plans to test the inspection boundary.
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
	// oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- SAFETY: constructed plan isolates action-graph invariants at the boundary.
	const inspect = () => inspectAlchemyPlan(f.plan as never, f.target, guard);
	return { ...f, action, guard, inspect };
}

describe("native Alchemy plan inspection", () => {
	it("refuses and observes rejected composite and source verifiers", async () => {
		const f = compositeFixture();
		const reject = () => Promise.reject(new Error("host rejected"));
		expect(() =>
			verifyCompositeEnvironment(
				// oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- SAFETY: this deliberately supplies an asynchronous host verifier.
				{ ...f.guard, verifyEnvironment: reject as never },
				f.target,
				"plan",
				"deploy",
			),
		).toThrow("COMPOSITE_ENVIRONMENT_UNVERIFIED");
		expect(() =>
			// oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- SAFETY: this intentionally supplies incomplete native data and an asynchronous verifier.
			inspectAlchemyPlan(f.plan as never, f.target, {
				...f.guard,
				verifyPlan: reject as never,
			}),
		).toThrow("COMPOSITE_PLAN_UNVERIFIED");
		registerAlchemySource(f.node.resource, {
			claim: {
				resourceId: "store",
				resourceType: "Spec.Store",
				bindleName: "app",
				applicationName: "store",
				sourceKind: "test",
				sourcePath: "/source/store",
				sourceDigest: f.target.sourceDigest,
				environmentDigest: f.guard.environmentDigest,
				proofRef: f.guard.proofRef,
			},
			// oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- SAFETY: this intentionally supplies an asynchronous source verifier.
			verify: reject as never,
		});
		expect(() =>
			// oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- SAFETY: this fixture deliberately builds an incomplete native plan.
			inspectAlchemyPlan(f.plan as never, f.target, f.guard),
		).toThrow("SOURCE_FENCE_UNVERIFIED");
		await new Promise<void>((resolve) => setImmediate(resolve));
	});

	it("fingerprints actual runner code without consulting mutable intrinsic call properties", () => {
		const f = compositeFixture();
		const first = f.inspect().digest;
		const intrinsic = Function.prototype.toString;
		const original = Object.getOwnPropertyDescriptor(intrinsic, "call");
		let traps = 0;
		Object.defineProperty(intrinsic, "call", {
			configurable: true,
			get() {
				traps++;
				return () => "forged source";
			},
		});
		try {
			expect(f.inspect().digest).toBe(first);
			f.action.def.Run = () => "changed build";
			expect(f.inspect().digest).not.toBe(first);
			expect(traps).toBe(0);
		} finally {
			if (original === undefined) Reflect.deleteProperty(intrinsic, "call");
			else Object.defineProperty(intrinsic, "call", original);
		}
	});

	it("detects an action change when the verifier replaces function reflection", () => {
		const f = compositeFixture();
		const original = Function.prototype.toString;
		const stale = original.call(f.action.def.Run);
		const replacement = () => "different";
		let substitutions = 0;
		Object.assign(f.guard, {
			verifyPlan: () => {
				Object.assign(f.action.def, { Run: replacement });
				Function.prototype.toString = function () {
					if (this === replacement) {
						substitutions++;
						return stale;
					}
					return original.call(this);
				};
				return true;
			},
		});
		let rejected = false;
		try {
			f.inspect();
		} catch {
			rejected = true;
		} finally {
			Function.prototype.toString = original;
		}
		expect(rejected).toBe(true);
		expect(substitutions).toBe(0);
	});

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
		// oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- SAFETY: this deliberately minimal plan exercises the source attestation boundary.
		const inspect = (authority?: AlchemyCompositeGuard) =>
			inspectAlchemyPlan(f.plan as never, f.target, authority);
		expect(() => inspect()).toThrow("COMPOSITE_ENVIRONMENT_UNVERIFIED");
		const unclassified = { ...guard };
		Reflect.deleteProperty(unclassified, "sourceRequirements");
		expect(() => inspect(unclassified)).toThrow(
			"COMPOSITE_ENVIRONMENT_UNVERIFIED",
		);
		expect(() => inspect({ ...guard, sourceRequirements: [] })).toThrow(
			"SOURCE_FENCE_INCOMPLETE",
		);
		const before = inspect(guard).digest;
		const other = fixture();
		registerAlchemySource(other.node.resource, {
			claim: { ...claim, sourcePath: "/source/other" },
			verify: () => true,
		});
		// oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- SAFETY: this deliberately minimal plan exercises source-fingerprint coverage.
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

	/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-reflect-apply -- SAFETY: these regressions replace collection methods and delegate unrelated calls to captured intrinsics. */
	it("retains source claims and rechecks after a verifier replaces Array.every", () => {
		const f = fixture();
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
		let allowed = true;
		const nativeEvery = Array.prototype.every;
		registerAlchemySource(f.node.resource, {
			claim,
			verify: () => {
				Reflect.set(Array.prototype, "every", function (predicate: unknown) {
					if (this.length === 1 && this[0]?.claim?.resourceId === "store")
						return true;
					return Reflect.apply(nativeEvery, this, [predicate]);
				});
				return allowed;
			},
		});
		let claims: readonly unknown[] = [];
		const guard: AlchemyCompositeGuard = {
			proofRef: claim.proofRef,
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
			verifyPlan: (observation) => {
				claims = observation.sourceClaims;
				return true;
			},
		};
		let revalidated = true;
		try {
			// oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- SAFETY: the incomplete fixture isolates source-claim revalidation.
			const inspection = inspectAlchemyPlan(f.plan as never, f.target, guard);
			allowed = false;
			revalidated = inspection.revalidateSources();
		} finally {
			Reflect.set(Array.prototype, "every", nativeEvery);
		}
		expect(claims).toEqual([claim]);
		expect(revalidated).toBe(false);
	});

	it("preserves source observations when a verifier replaces Array.map", () => {
		const f = fixture();
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
		const nativeMap = Array.prototype.map;
		registerAlchemySource(f.node.resource, {
			claim,
			verify: () => {
				Reflect.set(Array.prototype, "map", function (callback: unknown) {
					if (this.length === 1 && this[0]?.sourceDigest === claim.sourceDigest)
						return [];
					return Reflect.apply(nativeMap, this, [callback]);
				});
				return true;
			},
		});
		let seen: readonly unknown[] = [];
		const guard: AlchemyCompositeGuard = {
			proofRef: claim.proofRef,
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
			verifyPlan: (observation) => {
				seen = observation.sourceClaims;
				return true;
			},
		};
		try {
			// oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- SAFETY: this fixture isolates the source-observation boundary.
			inspectAlchemyPlan(f.plan as never, f.target, guard);
		} finally {
			Reflect.set(Array.prototype, "map", nativeMap);
		}
		expect(seen).toEqual([claim]);
	});

	/* oxlint-enable anti-slop/no-unknown-parameters, anti-slop/no-reflect-apply */
	it("preserves source claims when a verifier installs an inherited index setter", () => {
		const f = fixture();
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
		const previous = Object.getOwnPropertyDescriptor(Array.prototype, "0");
		let installed = false;
		let seen: readonly unknown[] = [];
		let failure: unknown;
		const restore = () => {
			if (previous) Object.defineProperty(Array.prototype, "0", previous);
			else Reflect.deleteProperty(Array.prototype, "0");
		};
		registerAlchemySource(f.node.resource, {
			claim,
			verify: () => {
				if (!installed) {
					installed = true;
					Object.defineProperty(Array.prototype, "0", {
						configurable: true,
						set() {},
					});
				}
				return true;
			},
		});
		const guard: AlchemyCompositeGuard = {
			proofRef: claim.proofRef,
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
			verifyPlan: (observation) => {
				restore();
				seen = observation.sourceClaims;
				return true;
			},
		};
		try {
			try {
				// oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- SAFETY: this fixture isolates the source-claim collection boundary.
				inspectAlchemyPlan(f.plan as never, f.target, guard);
			} catch (error) {
				failure = error;
			}
		} finally {
			restore();
		}
		expect(seen).toEqual([claim]);
		expect(Object.getOwnPropertyDescriptor(seen, "0")).toMatchObject({
			value: claim,
			enumerable: true,
		});

		expect(failure).toMatchObject({ code: "PLAN_UNINSPECTABLE" });
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
		// oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- SAFETY: this deliberately minimal plan exercises the missing-source boundary.
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
		// oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- SAFETY: deliberately constructed plans isolate observation semantics.
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
		// oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- SAFETY: deliberately constructed plans isolate host authorization.
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
		// oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- SAFETY: deliberately constructed plans isolate prior-state observations.
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
			// oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- SAFETY: deliberately malformed plans must fail before host authorization.
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
				// oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- SAFETY: the finite matrix deliberately constructs native plan variants.
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
		// oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- SAFETY: a deliberately constructed native plan tests provider alias authorization.
		const inspect = () => inspectAlchemyPlan(f.plan as never, f.target, guard);
		expect(inspect).toThrow("STATE_IDENTITY_UNVERIFIED");
		Object.assign(f.node.provider, { aliases: ["Spec.LegacyStore"] });
		expect(inspect).not.toThrow();
		const refusing = { ...guard, verifyPlan: () => false };
		// oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- SAFETY: the same alias is rejected when the host independently refuses it.
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
		// oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- SAFETY: this plan isolates source-verifier mutation during inspection.
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
		// oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- SAFETY: this deliberately minimal plan exercises the reconstructed deletion boundary.
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
		// oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- SAFETY: constructed plan exercises the untrusted-action boundary.
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
		// oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- SAFETY: this constructed plan exercises the missing host guard boundary.
		expect(() => inspectAlchemyPlan(f.plan as never, f.target)).toThrow(
			"COMPOSITE_ENVIRONMENT_UNVERIFIED",
		);
	});
});
