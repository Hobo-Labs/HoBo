import { describe, expect, it } from "vitest";
import { alchemyTarget } from "../src/index.js";
import { inspectAlchemyPlan } from "../src/plan.js";

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
	return { native, node, inspect };
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
});
