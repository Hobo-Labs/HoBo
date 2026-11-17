import { create } from "@bufbuild/protobuf";
import { describe, expect, it } from "vitest";
import { alchemyTarget, ResourceScopeSchema } from "../src/index.js";
import { type AlchemyCompositeGuard, inspectAlchemyPlan } from "../src/plan.js";

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
	// SAFETY: this fixture deliberately constructs incomplete native plans to test the inspection boundary.
	const inspect = () => inspectAlchemyPlan(plan as never, target);
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
		verifyEnvironment: () => true,
		verifyPlan: () => true,
	};
	// SAFETY: constructed plan isolates action-graph invariants at the boundary.
	const inspect = () => inspectAlchemyPlan(f.plan as never, f.target, guard);
	return { ...f, action, guard, inspect };
}

describe("native Alchemy plan inspection", () => {
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
		expect(inspect).toThrow("PLAN_UNSUPPORTED_EFFECTS");
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
			"PLAN_UNSUPPORTED_EFFECTS",
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
		Object.assign(f.plan.resources[0], { resourceType: "Command.Build" });
		Object.assign(f.target.resources[0], { resourceType: "Command.Build" });
		expect(() => f.inspect()).toThrow("PLAN_UNSUPPORTED_EFFECTS");
	});
});
