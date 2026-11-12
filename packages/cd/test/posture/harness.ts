// Shared WP24 posture harness: a journal, the three posture components wired
// as WP18 composes them, and the doubles behind their frozen ports.
import type { JsonObject } from "@hobo/core";
import { POLICY_IR_SCHEMA_VERSION } from "@hobo/policy";
import { POSTURE_PROFILE } from "@hobo/policy/posture";
import type { RailDeliveryRecord } from "../../src/_generated/cd_pb.js";
import type { Digest } from "../../src/ports.js";
import {
	createCampPolicy,
	createPostureService,
} from "../../src/posture/index.js";
import {
	clock,
	context,
	FakeDesired,
	FakeInventory,
	FakeRails,
	MemoryEventStore,
	RecordingAuthorizer,
	RecordingTelemetry,
	STATION,
	TENANT,
} from "./fakes.js";

export const TLS_PACK: JsonObject = {
	schemaVersion: POLICY_IR_SCHEMA_VERSION,
	profile: POSTURE_PROFILE,
	pack: "tls-baseline",
	observeFields: ["tls.min_version", "public"],
	rules: [
		{
			id: "tls-min-version",
			phase: "observe",
			effect: "mutate",
			match: { kinds: ["http-route"] },
			require: [{ field: "tls.min_version", op: "semver-gte", value: "1.2" }],
			severity: "high",
			controls: ["SC-8"],
			fix: [{ field: "tls.min_version", value: "1.3" }],
		},
		{
			id: "no-public-buckets",
			phase: "observe",
			effect: "warn",
			match: { kinds: ["bucket"] },
			forbid: [{ field: "public", op: "eq", value: "true" }],
			severity: "critical",
			controls: ["AC-3"],
		},
	],
};

export const CANDIDATE_PACK: JsonObject = {
	schemaVersion: POLICY_IR_SCHEMA_VERSION,
	profile: POSTURE_PROFILE,
	pack: "tls-strict",
	observeFields: ["tls.min_version", "hsts"],
	rules: [
		{
			id: "tls-13",
			phase: "observe",
			effect: "warn",
			match: { kinds: ["http-route"] },
			require: [{ field: "tls.min_version", op: "semver-gte", value: "1.3" }],
			severity: "high",
			controls: ["SC-8"],
		},
	],
};

export function postureHarness(
	options: Readonly<{
		packs?: readonly JsonObject[];
		candidateRail?: boolean;
	}> = {},
) {
	const store = new MemoryEventStore();
	const time = clock();
	const authorizer = new RecordingAuthorizer();
	const telemetry = new RecordingTelemetry();
	const desired = new FakeDesired();
	const inventory = new FakeInventory();
	const rails = new FakeRails();
	const packDocs = options.packs ?? [TLS_PACK, CANDIDATE_PACK];
	const packCalls: string[][] = [];
	const campPolicy = createCampPolicy({
		store,
		tenant: TENANT,
		now: time.now,
		authorizer,
	});
	const deps = {
		store,
		tenant: TENANT,
		now: time.now,
		desired,
		campPolicy,
		rails,
		inventory,
		packs: async (names: readonly string[]) => {
			packCalls.push([...names]);
			return packDocs.filter((p) => names.includes(String(p.pack)));
		},
		authorizer,
		telemetry,
		...(options.candidateRail === false
			? {}
			: {
					candidateRail: async (
						railDigest: Digest,
					): Promise<RailDeliveryRecord | undefined> =>
						rails.byDigest.get(railDigest),
				}),
	};
	const service = createPostureService(deps);
	return {
		store,
		time,
		authorizer,
		telemetry,
		desired,
		inventory,
		rails,
		campPolicy,
		service,
		deps,
		packCalls,
		ctx: () => context(time.now, STATION),
	};
}

export type PostureHarness = ReturnType<typeof postureHarness>;
