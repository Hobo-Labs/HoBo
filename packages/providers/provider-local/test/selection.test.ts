/**
 * Composed selection over the local definitions, with no cloud in reach.
 *
 * The candidates here carry station-local evidence injected through the
 * overrides a composition root uses after verifying it — the shipped
 * constants do not attest themselves, and the last block proves selection
 * refuses them until that evidence exists.
 */
import {
	createCapabilityProfileRegistry,
	DEFAULT_TRUST_POLICY,
	parseCapabilityRequirement,
	STANDARD_CAPABILITY_PROFILES,
	selectCapabilityImplementation,
	type TrustPolicy,
} from "@hobo/capability-profiles";
import { capability } from "@hobo/core";
import { LOCALHOST_YARD_NAME } from "@hobo/yards";
import { describe, expect, it } from "vitest";

import {
	createLocalDefinitions,
	LOCAL_CANDIDATES,
	LOCAL_DEFINITIONS,
	localCandidates,
} from "../src/index.js";

const profiles = createCapabilityProfileRegistry(STANDARD_CAPABILITY_PROFILES);
/** Cloud credential families the repo's providers actually read. */
const CLOUD_ENV_PREFIXES =
	/^(CLOUDFLARE|AWS|VERCEL|NETLIFY|UPSTASH|PRISMA|AZURE|GOOGLE|GCP)_/u;
const NOW = Date.UTC(2026, 10, 8);

/** Local products are experimental until an L2 live run says otherwise. */
const localPolicy: TrustPolicy = {
	...DEFAULT_TRUST_POLICY,
	minimumProviderClass: "experimental",
	creatorAuthorityAfterClaim: "must-be-absent",
};

/** What a station that traced the engines today would inject. */
const STATION_EVIDENCE = {
	evidenceSignatureValid: true,
	evidenceExpiresAtMs: NOW + 30 * 24 * 60 * 60 * 1000,
	conformance: "pass",
} as const;

function selectFor(profileId: string, candidates = stationCandidates()) {
	return selectCapabilityImplementation({
		requirement: parseCapabilityRequirement({
			requiredProfiles: [{ profileId, versionRange: ">=1" }],
		}),
		registry: profiles,
		candidates,
		policy: localPolicy,
		nowMs: NOW,
	});
}

function stationCandidates() {
	return localCandidates(STATION_EVIDENCE);
}

describe("composed selection on yard:local", () => {
	it("resolves the engine-backed bindle slots to local definitions", () => {
		// The composed-local ask, with every cloud credential absent. Env is
		// restored afterwards so no other test sees a mutated process.
		const saved: Record<string, string | undefined> = {};
		for (const key of Object.keys(process.env)) {
			if (CLOUD_ENV_PREFIXES.test(key)) {
				saved[key] = process.env[key];
				delete process.env[key];
			}
		}
		try {
			expectLocalWinners();
		} finally {
			Object.assign(process.env, saved);
		}
	});

	function expectLocalWinners() {
		expect(LOCALHOST_YARD_NAME).toBe("yard:local");

		const api = selectFor(capability.api.http);
		expect(api.winner?.definitionId).toBe("local.node-http-server/v1");
		expect(api.winner?.providerId).toBe("local");

		const data = selectFor(capability.data.sqlite);
		expect(data.winner?.definitionId).toBe("local.sqlite-file/v1");

		const queue = selectFor(capability.queue.atLeastOnce);
		expect(queue.winner?.definitionId).toBe("local.in-memory-queue/v1");

		const worker = selectFor(capability.service.worker);
		expect(worker.winner?.definitionId).toBe("local.in-process-worker/v1");
	}

	it("refuses the seed products that have no local engine", () => {
		// kv, bucket, topic, secret locator and static web have seed rows but
		// no @hobo/runtime-local engine; selection must find no winner rather
		// than a silently claimed substitute.
		for (const profileId of [
			capability.kv.keyValue,
			capability.bucket.filesystem,
			capability.topic.ephemeralPubsub,
			capability.secretRef.locator,
			capability.web.static,
		]) {
			const result = selectFor(profileId);
			expect(result.winner).toBeUndefined();
			expect(
				result.rejections.every(
					(rejection) => rejection.code === "PROFILE_INCOMPATIBLE",
				),
			).toBe(true);
		}
	});

	it("refuses the shipped constants until station evidence is injected", () => {
		const result = selectFor(capability.queue.atLeastOnce, LOCAL_CANDIDATES);
		expect(result.winner).toBeUndefined();
		expect(
			result.rejections.some(
				(rejection) =>
					rejection.definitionId === "local.in-memory-queue/v1" &&
					rejection.code === "CONFORMANCE_FAILED",
			),
		).toBe(true);
	});

	it("keeps candidate ids identical to definition ids", () => {
		expect(LOCAL_CANDIDATES.map((candidate) => candidate.definitionId)).toEqual(
			LOCAL_DEFINITIONS.map((definition) => definition.id),
		);
		expect(createLocalDefinitions(STATION_EVIDENCE)).toHaveLength(
			LOCAL_DEFINITIONS.length,
		);
	});
});
