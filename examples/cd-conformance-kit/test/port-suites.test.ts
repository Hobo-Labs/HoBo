// The nine @hobo/cd port suites (plan 0024 WP20): each passes its reference
// adapter, and each mutant is caught by the assertion that names its breach.
import {
	ARTIFACT_STORE_ASSERTIONS,
	ARTIFACT_VERIFIER_ASSERTIONS,
	HEALTH_SOURCE_ASSERTIONS,
	PROVENANCE_VERIFIER_ASSERTIONS,
	PUBLISHER_ASSERTIONS,
	REALIZER_ASSERTIONS,
	RECONCILER_TRANSPORT_ASSERTIONS,
	runArtifactStoreConformance,
	runArtifactVerifierConformance,
	runHealthSourceConformance,
	runProvenanceVerifierConformance,
	runPublisherConformance,
	runRealizerConformance,
	runReconcilerTransportConformance,
	runSubscriptionDriverConformance,
	runTrafficShifterConformance,
	SUBSCRIPTION_DRIVER_ASSERTIONS,
	TRAFFIC_SHIFTER_ASSERTIONS,
} from "@hobo/conformance";
import { describe, expect, it } from "vitest";
import {
	type ArtifactVerifierMutant,
	type HealthMutant,
	type ProvenanceMutant,
	type PublisherMutant,
	type RealizerMutant,
	refArtifactVerifierHarness,
	refHealthHarness,
	refProvenanceHarness,
	refPublisherHarness,
	refRealizerHarness,
	refStoreHarness,
	refSubscriptionHarness,
	refTrafficHarness,
	refTransportHarness,
	type StoreMutant,
	type SubscriptionMutant,
	type TrafficMutant,
	type TransportMutant,
} from "../src/index.js";
import { failed, summary } from "./report.js";

describe("Realizer conformance", () => {
	it("passes the reference realizer on every assertion", async () => {
		const report = await runRealizerConformance(refRealizerHarness());
		expect(summary(report)).toBe("");
		expect(Object.keys(report.assertions)).toEqual([...REALIZER_ASSERTIONS]);
	});
	it.each<[RealizerMutant, string]>([
		["trusts-provider", "providerSuccessWithoutEffectIsNotConverged"],
		["reapplies", "convergeIsIdempotent"],
		["ignores-abort", "abortIsHonoured"],
		["untyped-failure", "failureIsTypedBlocked"],
	])("catches a realizer that %s (%s)", async (mutant, assertion) => {
		expect(failed(await runRealizerConformance(refRealizerHarness(mutant)))).toContain(assertion);
	});
	it("fails, never passes, when the harness lacks a probe", async () => {
		const harness = refRealizerHarness();
		const report = await runRealizerConformance({
			...harness,
			create: async () => {
				const world = await harness.create();
				return { realizer: world.realizer, target: { mutations: world.target.mutations } };
			},
		});
		expect(failed(report)).toEqual(["failureIsTypedBlocked", "providerSuccessWithoutEffectIsNotConverged"]);
	});
});

describe("TrafficShifter conformance", () => {
	it("passes the reference shifter on every assertion", async () => {
		const report = await runTrafficShifterConformance(refTrafficHarness());
		expect(summary(report)).toBe("");
		expect(Object.keys(report.assertions)).toEqual([...TRAFFIC_SHIFTER_ASSERTIONS]);
	});
	it.each<[TrafficMutant, string]>([
		["claims-full-without-capability", "noCapabilityIsHonest"],
		["forgets-status", "shiftIsObservable"],
	])("catches a shifter that %s (%s)", async (mutant, assertion) => {
		expect(failed(await runTrafficShifterConformance(refTrafficHarness(mutant)))).toContain(assertion);
	});
});

describe("HealthSource conformance", () => {
	it("passes the reference health source on every assertion", async () => {
		const report = await runHealthSourceConformance(refHealthHarness());
		expect(summary(report)).toBe("");
		expect(Object.keys(report.assertions)).toEqual([...HEALTH_SOURCE_ASSERTIONS]);
	});
	it.each<[HealthMutant, string]>([
		["fabricates-on-empty", "noDataIsNeverFabricated"],
		["ignores-cohort", "cohortsAreSeparated"],
	])("catches a health source that %s (%s)", async (mutant, assertion) => {
		expect(failed(await runHealthSourceConformance(refHealthHarness(mutant)))).toContain(assertion);
	});
});

describe("PublisherPort conformance", () => {
	it("passes the reference publisher on every assertion", async () => {
		const report = await runPublisherConformance(refPublisherHarness());
		expect(summary(report)).toBe("");
		expect(Object.keys(report.assertions)).toEqual([...PUBLISHER_ASSERTIONS]);
	});
	it.each<[PublisherMutant, string]>([
		["converged-on-publish", "notConvergedBeforeEngineSync"],
		["writes-every-time", "publishIsIdempotent"],
	])("catches a publisher that %s (%s)", async (mutant, assertion) => {
		expect(failed(await runPublisherConformance(refPublisherHarness(mutant)))).toContain(assertion);
	});
});

describe("ReconcilerTransport conformance", () => {
	it("passes the reference transport on every assertion", async () => {
		const report = await runReconcilerTransportConformance(refTransportHarness());
		expect(summary(report)).toBe("");
		expect(Object.keys(report.assertions)).toEqual([...RECONCILER_TRANSPORT_ASSERTIONS]);
	});
	it.each<[TransportMutant, string]>([
		["no-fencing", "staleFenceIsRefused"],
		["replays-checkpointed", "feedResumesAfterCheckpoint"],
	])("catches a transport with %s (%s)", async (mutant, assertion) => {
		expect(failed(await runReconcilerTransportConformance(refTransportHarness(mutant)))).toContain(assertion);
	});
});

describe("ArtifactStore conformance", () => {
	it("passes the reference store on every assertion", async () => {
		const report = await runArtifactStoreConformance(refStoreHarness());
		expect(summary(report)).toBe("");
		expect(Object.keys(report.assertions)).toEqual([...ARTIFACT_STORE_ASSERTIONS]);
	});
	it.each<[StoreMutant, string]>([
		["no-verify-on-read", "corruptionIsDetected"],
		["duplicate-listing", "putIsIdempotent"],
	])("catches a store with %s (%s)", async (mutant, assertion) => {
		expect(failed(await runArtifactStoreConformance(refStoreHarness(mutant)))).toContain(assertion);
	});
});

describe("ArtifactVerifier conformance", () => {
	it("passes the reference verifier on every assertion", async () => {
		const report = await runArtifactVerifierConformance(refArtifactVerifierHarness());
		expect(summary(report)).toBe("");
		expect(Object.keys(report.assertions)).toEqual([...ARTIFACT_VERIFIER_ASSERTIONS]);
	});
	it.each<[ArtifactVerifierMutant, string]>([
		["passes-unreachable", "unreachableCoordinateIsRefused"],
		["rewrites-digest", "digestsAreUnchanged"],
	])("catches a verifier that %s (%s)", async (mutant, assertion) => {
		expect(failed(await runArtifactVerifierConformance(refArtifactVerifierHarness(mutant)))).toContain(assertion);
	});
});

describe("ProvenanceVerifier conformance", () => {
	it("passes the reference verifier on every assertion", async () => {
		const report = await runProvenanceVerifierConformance(refProvenanceHarness());
		expect(summary(report)).toBe("");
		expect(Object.keys(report.assertions)).toEqual([...PROVENANCE_VERIFIER_ASSERTIONS]);
	});
	it.each<[ProvenanceMutant, string]>([
		["skips-signer-pin", "untrustedSignerIsRefused"],
		["skips-subject-binding", "tamperedSubjectIsRefused"],
		["throws-on-garbage", "malformedStatementIsRefusedNotThrown"],
	])("catches a verifier that %s (%s)", async (mutant, assertion) => {
		expect(failed(await runProvenanceVerifierConformance(refProvenanceHarness(mutant)))).toContain(assertion);
	});
});

describe("SubscriptionDriver conformance", () => {
	it("passes the reference OCI driver on every assertion", async () => {
		const report = await runSubscriptionDriverConformance(refSubscriptionHarness());
		expect(summary(report)).toBe("");
		expect(Object.keys(report.assertions)).toEqual([...SUBSCRIPTION_DRIVER_ASSERTIONS]);
	});
	it.each<[SubscriptionMutant, string]>([
		["ignores-cursor", "discoveryIsForwardOnly"],
		["ignores-limit", "discoveryLimitIsRespected"],
		["unpinned", "discoveredArtifactsAreDigestPinned"],
	])("catches a driver that %s (%s)", async (mutant, assertion) => {
		expect(failed(await runSubscriptionDriverConformance(refSubscriptionHarness(mutant)))).toContain(assertion);
	});
});
