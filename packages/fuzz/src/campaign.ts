import {
	createDecision,
	createDecisionRequest,
	POLICY_IR_SCHEMA_VERSION,
} from "@hobo/policy";
import fc from "fast-check";
import {
	fuzzBindleManifest,
	fuzzEventEnvelope,
	fuzzPolicyDocument,
} from "./harness.js";
import {
	ALL_VERBS,
	attenuationOk,
	ControlModel,
	checkInvariants,
	type ModelCommand,
	tenantIsolationOk,
} from "./model.js";

export type NightlyCampaignOptions = Readonly<{ seed: number; runs: number }>;
export type NightlyCampaignReport = Readonly<{
	seed: number;
	modelTraces: number;
	eventDocuments: number;
	policyDocuments: number;
	serializedInputs: number;
}>;

const tenant = fc.constantFrom("tenant-a", "tenant-b");
const bindle = fc.constantFrom("bindle-a", "bindle-b", "bindle-c");
const capability = fc.constantFrom("cap-a", "cap-b");
const key = fc.constantFrom("key-a", "key-b", "key-c");
const verbs = fc.uniqueArray(fc.constantFrom(...ALL_VERBS), {
	minLength: 1,
	maxLength: 4,
});
const command: fc.Arbitrary<ModelCommand> = fc.oneof(
	fc.record({
		kind: fc.constant("createBindle" as const),
		tenantId: tenant,
		bindleId: bindle,
		manifestHash: fc.constant("manifest"),
	}),
	fc.record({
		kind: fc.constant("addCapability" as const),
		tenantId: tenant,
		capabilityId: capability,
		verbs,
	}),
	fc.record({
		kind: fc.constant("attenuate" as const),
		tenantId: tenant,
		capabilityId: capability,
		keep: verbs,
	}),
	fc.record({
		kind: fc.constant("resolveProvider" as const),
		tenantId: tenant,
		bindleId: bindle,
		provider: fc.constantFrom("memory", "lakebed"),
	}),
	fc.record({
		kind: fc.constant("plan" as const),
		tenantId: tenant,
		bindleId: bindle,
	}),
	fc.record({
		kind: fc.constant("apply" as const),
		tenantId: tenant,
		bindleId: bindle,
		idempotencyKey: key,
		fail: fc.boolean(),
	}),
	fc.record({
		kind: fc.constant("retryApply" as const),
		tenantId: tenant,
		bindleId: bindle,
		idempotencyKey: key,
	}),
	fc.record({
		kind: fc.constant("interruptApply" as const),
		tenantId: tenant,
		idempotencyKey: key,
	}),
	fc.record({
		kind: fc.constant("reconcile" as const),
		tenantId: tenant,
		bindleId: bindle,
	}),
	fc.record({
		kind: fc.constant("migrateProvider" as const),
		tenantId: tenant,
		bindleId: bindle,
		provider: fc.constantFrom("memory", "lakebed"),
	}),
	fc.record({
		kind: fc.constant("changeTenant" as const),
		bindleId: bindle,
		toTenantId: tenant,
	}),
	fc.record({
		kind: fc.constant("rotateSecretRef" as const),
		tenantId: tenant,
		bindleId: bindle,
	}),
	fc.constant({ kind: "snapshot" as const }),
	fc.record({
		kind: fc.constant("rollback" as const),
		tenantId: tenant,
		targetClock: fc.constant(0),
	}),
	fc.record({
		kind: fc.constant("destroy" as const),
		tenantId: tenant,
		bindleId: bindle,
	}),
);

function checkTrace(commands: readonly ModelCommand[]): void {
	const world = new ControlModel();
	world.snapshot();
	world.createBindle("tenant-b", "protected-bindle", "protected");
	world.apply("tenant-b", "protected-bindle", "protected-key");
	world.snapshot();
	for (const item of commands) {
		const protectedBefore = world.fingerprint("tenant-b");
		const previousVerbs =
			item.kind === "attenuate"
				? world.capabilities.get(item.capabilityId)?.verbs
				: undefined;
		const result = world.applyCommand(item);
		if (result && !result.ok) throw new Error(result.message);
		if ("tenantId" in item && item.tenantId === "tenant-a") {
			const isolation = tenantIsolationOk(
				protectedBefore,
				world.fingerprint("tenant-b"),
			);
			if (!isolation.ok) throw new Error(isolation.message);
		}
		if (item.kind === "attenuate" && previousVerbs) {
			const remaining = world.capabilities.get(item.capabilityId)?.verbs ?? [];
			const verdict = attenuationOk(previousVerbs, remaining);
			if (!verdict.ok) throw new Error(verdict.message);
		}
		for (const verdict of checkInvariants(world))
			if (!verdict.ok) throw new Error(verdict.message);
	}
}

export function runNightlyCampaign(
	options: NightlyCampaignOptions,
): NightlyCampaignReport {
	const { seed, runs } = options;
	if (!Number.isInteger(seed) || seed < -(2 ** 31) || seed > 2 ** 31 - 1)
		throw new RangeError("seed must be a signed 32-bit integer");
	if (!Number.isInteger(runs) || runs < 1 || runs > 100_000)
		throw new RangeError("runs must be between 1 and 100000");
	const parameters = {
		seed,
		numRuns: runs,
		interruptAfterTimeLimit: 60_000,
		markInterruptAsFailure: true,
		endOnFailure: true,
	};
	fc.assert(
		fc.property(fc.array(command, { minLength: 1, maxLength: 32 }), checkTrace),
		parameters,
	);
	fc.assert(
		fc.property(fc.jsonValue({ maxDepth: 3 }), (data) => {
			const event = {
				id: "event-1",
				type: "demo.Created",
				v: 1,
				streamId: "demo:1",
				seq: 1,
				ts: "2026-01-01T00:00:00.000Z",
				actor: { kind: "agent", id: "agent-a" },
				tenant: "tenant-a",
				data,
			};
			if (fuzzEventEnvelope(Buffer.from(JSON.stringify(event))) !== "accepted")
				throw new Error("generated event was rejected");
		}),
		parameters,
	);
	fc.assert(
		fc.property(fc.jsonValue({ maxDepth: 3 }), (context) => {
			const request = createDecisionRequest({
				schemaVersion: POLICY_IR_SCHEMA_VERSION,
				subject: { kind: "agent", id: "a" },
				action: "deploy",
				resource: { kind: "service", id: "api" },
				phase: "apply",
				context,
			});
			const decision = createDecision(request, {
				effect: "allow",
				reason: "scoped",
				evidence: { policyIds: [], engine: "fuzz" },
			});
			if (
				fuzzPolicyDocument(
					Buffer.from(JSON.stringify({ request, decision })),
				) !== "accepted"
			)
				throw new Error("generated policy was rejected");
		}),
		parameters,
	);
	const serialized = fc.oneof(
		fc.uint8Array({ maxLength: 4096 }),
		fc.json({ maxDepth: 3 }).map((text) => Buffer.from(text)),
	);
	fc.assert(
		fc.property(serialized, (input) => {
			fuzzBindleManifest(input);
			fuzzEventEnvelope(input);
			fuzzPolicyDocument(input);
		}),
		parameters,
	);
	return {
		seed,
		modelTraces: runs,
		eventDocuments: runs,
		policyDocuments: runs,
		serializedInputs: runs,
	};
}
