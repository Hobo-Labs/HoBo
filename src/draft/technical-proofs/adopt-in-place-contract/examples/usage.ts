/**
 * Runnable example for adopt-in-place-contract. The draft-artifact gate EXECUTES this
 * with `node --import tsx` and diffs stdout against usage.expected.txt.
 *
 * Proves HOBO-369: importing legacy IaC state ADOPTS resources in place — adopted nodes
 * are retained on destroy, reconciled drift-detect-only (never auto-remediated), managed
 * resources bind across the boundary to external outputs, and id collisions fail closed.
 */
import { strict as assert } from "node:assert";

import {
	AdoptInPlaceError,
	createAdoptionGraph,
	createExternalResource,
	createFixtureIacState,
	createManagedResource,
	detectAdoptedDrift,
	importIacState,
	planDestroy,
	planReconcile,
	resolveBindings,
} from "../src/adopt-in-place-contract.ts";
import { type JsonValue } from "../src/json.js";


const source = { kind: "pulumi", ref: "s3://legacy-estate/prod/pulumi-state.json" };

// 1) Import fixture Pulumi state: the legacy DB becomes an ADOPTED node.
const imported = importIacState({
	graph: createAdoptionGraph({
		nodes: [
			createManagedResource({ id: "api", deps: ["legacy-db", "shared-vpc"] }),
			createExternalResource({
				id: "shared-vpc",
				type: "network",
				declaredOutputs: ["vpcId"],
				outputs: { vpcId: "vpc-123" },
			}),
		],
	}),
	state: createFixtureIacState(),
	source,
});
assert.equal(imported.status, "imported");
const adopted = imported.graph.nodes["legacy-db"];
assert.equal(adopted.kind, "adopted");
assert.equal(adopted.lifecycle.destroy, "retain");
assert.equal(adopted.lifecycle.reconcile, "drift-detect-only");
assert.deepEqual(imported.events.map((event: { type: string }) => event.type), ["resource.Adopted"]);
console.log(`import: status=${imported.status} legacy-db kind=${adopted.kind}`);
console.log(
	`lifecycle: destroy=${adopted.lifecycle.destroy} reconcile=${adopted.lifecycle.reconcile}`,
);
console.log(`events: ${imported.events.map((event: { type: string }) => event.type).join(",")}`);

// 2) Reconcile plans only a drift-detect refresh for adopted nodes — never destroy/recreate.
const reconcile = planReconcile({ graph: imported.graph });
const forbidden = ["destroy", "provision", "recreate", "update"];
assert.ok(
	reconcile.actions.every((action: { action: string }) => !forbidden.includes(action.action)),
);
const refresh = reconcile.actions.find(
	(action: { resourceId: string }) => action.resourceId === "legacy-db",
);
assert.equal(refresh.action, "refresh");
assert.equal(refresh.mode, "drift-detect-only");
console.log(`reconcile legacy-db: action=${refresh.action} mode=${refresh.mode}`);

// 3) Destroy plans skip adopted (retained) and external (unmanaged) nodes.
const destroy = planDestroy(imported.graph);
assert.deepEqual(destroy.actions, [{ action: "destroy", resourceId: "api" }]);
assert.deepEqual(
	destroy.skipped.map((entry: { resourceId: string; kind: string }) => `${entry.resourceId}:${entry.kind}`),
	["legacy-db:adopted", "shared-vpc:external"],
);
console.log(
	`destroy: actions=${destroy.actions.map((a: { resourceId: string }) => a.resourceId).join(",")} skipped=${destroy.skipped
		.map((entry: { resourceId: string }) => entry.resourceId)
		.join(",")}`,
);

// 4) Managed resources bind across the boundary to external outputs.
const bindGraph = createAdoptionGraph({
	nodes: [
		createExternalResource({
			id: "legacy-db",
			type: "database",
			declaredOutputs: ["endpoint", "passwordRef"],
			outputs: {
				endpoint: "postgres://legacy-db.internal:5432/shop",
				passwordRef: "secret://legacy-db/password",
			},
		}),
		createManagedResource({
			id: "api",
			binds: [
				{ from: "legacy-db", output: "endpoint", as: "DATABASE_URL" },
				{ from: "legacy-db", output: "passwordRef", as: "DATABASE_PASSWORD_REF" },
			],
		}),
	],
});
const bindings = resolveBindings(bindGraph, "api");
assert.equal(bindings.DATABASE_URL, "postgres://legacy-db.internal:5432/shop");
assert.equal(bindings.DATABASE_PASSWORD_REF, "secret://legacy-db/password");
console.log(`bindings: ${Object.keys(bindings).sort().join(",")}`);

// 5) Adopted drift is detect-only with manual remediation.
const drift = detectAdoptedDrift({
	graph: imported.graph,
	observedOutputs: {
		"legacy-db": {
			endpoint: "postgres://moved-db.internal:5432/shop",
			passwordRef: "secret://legacy-db/password",
		},
	},
});
assert.deepEqual(drift.records, [
	{
		resourceId: "legacy-db",
		mode: "detect-only",
		changedOutputs: ["endpoint"],
		remediation: "manual",
	},
]);
console.log(
	`drift: resource=${drift.records[0].resourceId} changed=${drift.records[0].changedOutputs.join(",")} remediation=${drift.records[0].remediation}`,
);

// 6) Import fails closed on an id collision with an existing managed node.
assert.throws(
	() =>
		importIacState({
			graph: createAdoptionGraph({ nodes: [createManagedResource({ id: "legacy-db" })] }),
			state: createFixtureIacState(),
			source,
		}),
	(error: JsonValue) =>
		// SAFETY: `error instanceof AdoptInPlaceError && (error as { code?: string }).code === "imp` is required at this I/O or test boundary.
		error instanceof AdoptInPlaceError && (error as { code?: string }).code === "import-id-collision",
);
console.log("id collision: AdoptInPlaceError code=import-id-collision");

console.log("CONTRACT HELD: adopt-in-place retains, drift-detects, binds, and fails closed");
