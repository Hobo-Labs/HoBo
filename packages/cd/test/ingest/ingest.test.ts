import { describe, expect, it } from "vitest";
import { ArtifactKind, FreightOrigin } from "../../src/_generated/cd_pb.js";
import { UNVERIFIED_TRIGGER } from "../../src/events.js";
import { freightIdentity, parseFreightManifest } from "../../src/freight/index.js";
import { INGEST_METRIC, INGEST_REASON, parsePurl } from "../../src/ingest/index.js";
import { manifest } from "../freight/builders.js";
import { AGENT, context, digestOf, fid, hex64 } from "../freight/fakes.js";
import { githubClaims, signJwt } from "./oidc.js";
import { API_PURL, BUILDER, bundleFor, githubKey, ingestHarness, statement, WEB_PURL } from "./support.js";

const SUBJECTS = [
	{ name: API_PURL, seed: "api" },
	{ name: WEB_PURL, seed: "web" },
];

type CarriedAttestationData = Readonly<{
	"hobo.cd/attestation": Readonly<{ bindle: string; statement: string; bundle?: string }>;
}>;

function cdevent(type: string, subjectId: string, customData?: CarriedAttestationData): Uint8Array {
	const event = {
		context: {
			specversion: "0.4.1",
			id: "271069a8-fc18-44f1-b38f-9d70a1695819",
			source: "/ci/acme/shop",
			type,
			timestamp: "2026-11-12T12:00:00Z",
		},
		subject: { id: subjectId, source: "/ci/acme/shop", type: "artifact", content: {} },
	};
	const body = customData === undefined ? event : { ...event, customData, customDataContentType: "application/json" };
	return new TextEncoder().encode(JSON.stringify(body));
}

function attestationData(bytes: Uint8Array, bundle?: Uint8Array): CarriedAttestationData {
	const carried = { bindle: "shop", statement: Buffer.from(bytes).toString("base64") };
	return { "hobo.cd/attestation": bundle ? { ...carried, bundle: Buffer.from(bundle).toString("base64") } : carried };
}

function code(outcome: { ok: boolean; reasons?: readonly { code: string }[] }): string | undefined {
	return outcome.ok ? undefined : outcome.reasons?.[0]?.code;
}

describe("FreightIngest.manifest", () => {
	it("records Freight for a HoBo principal through freight.record", async () => {
		const h = await ingestHarness();
		const outcome = await h.ingest.manifest({ manifest: manifest() }, h.ctx);
		expect(outcome.ok).toBe(true);
		if (!outcome.ok) return;
		expect(outcome.value.origin).toBe(FreightOrigin.MANIFEST);
		expect(outcome.value.recordedBy).toBe("user:ops@acme");
		expect(h.authorizer.calls.map((call) => call.action)).toEqual(["freight.record"]);
		expect(h.telemetry.count(INGEST_METRIC.accepted)).toBe(1);
	});

	it("records Freight for a trusted publisher token scoped to the Bindle", async () => {
		const h = await ingestHarness();
		const token = signJwt(githubKey, githubClaims(h.ctx.now()));
		const outcome = await h.ingest.manifest({ manifest: manifest(), publisherToken: token }, h.ctx);
		expect(outcome.ok && outcome.value.recordedBy).toBe("service:workload:github-shop:repo:acme/shop:environment:release");
		expect(h.authorizer.calls[0]?.principal.kind).toBe("service");
	});

	it("refuses a publisher token for a Bindle the publisher is not trusted for", async () => {
		const h = await ingestHarness();
		const token = signJwt(githubKey, githubClaims(h.ctx.now()));
		const outcome = await h.ingest.manifest({ manifest: manifest({ bindle: "billing" }), publisherToken: token }, h.ctx);
		expect(code(outcome)).toBe(INGEST_REASON.publisherScope);
		expect(await h.ledger.list()).toEqual([]);
	});

	it("refuses an invalid publisher token without recording", async () => {
		const h = await ingestHarness();
		const outcome = await h.ingest.manifest({ manifest: manifest(), publisherToken: "nope" }, h.ctx);
		expect(code(outcome)).toBe(INGEST_REASON.publisherToken);
		expect(await h.ledger.list()).toEqual([]);
	});

	it("never trusts provenance a pushed manifest claims was verified", async () => {
		const h = await ingestHarness();
		const outcome = await h.ingest.manifest({ manifest: manifest() }, h.ctx);
		expect(outcome.ok && outcome.value.manifest?.provenance.every((ref) => ref.verified === false)).toBe(true);
	});

	it("unverified or mismatched digests are refused with typed reasons", async () => {
		const h = await ingestHarness();
		h.artifacts.register("store://api", digestOf("tampered"));
		const outcome = await h.ingest.manifest({ manifest: manifest() }, h.ctx);
		expect(!outcome.ok && outcome.reasons.map((reason) => reason.code)).toEqual(["freight-artifacts-unverified", "artifact-digest-mismatch"]);
	});

	it("an agent principal can only propose, and a denied decision refuses", async () => {
		const h = await ingestHarness();
		expect(code(await h.ingest.manifest({ manifest: manifest() }, context(h.time.now, AGENT)))).toBe(INGEST_REASON.proposalOnly);
		h.authorizer.denied.add("freight.record");
		expect(code(await h.ingest.manifest({ manifest: manifest() }, h.ctx))).toBe(INGEST_REASON.unauthorized);
	});
});

describe("FreightIngest.attestation (in-toto v1 + SLSA v1)", () => {
	it("turns verified subjects into artifacts and records ATTESTATION Freight", async () => {
		const h = await ingestHarness();
		const bytes = statement(SUBJECTS);
		const outcome = await h.ingest.attestation({ bindle: "shop", statement: bytes, bundle: bundleFor(bytes) }, h.ctx);
		expect(outcome.ok).toBe(true);
		if (!outcome.ok) return;
		const recorded = outcome.value.manifest;
		expect(outcome.value.origin).toBe(FreightOrigin.ATTESTATION);
		expect(recorded?.declarationHash).toBe(digestOf("shop-declaration-v1"));
		expect(recorded?.artifacts.map((item) => [item.name, ArtifactKind[item.kind], item.ecosystem, item.digest])).toEqual([
			[WEB_PURL, "PACKAGE", "npm", digestOf("web")],
			[API_PURL, "OCI_IMAGE", "oci", digestOf("api")],
		].sort((a, b) => String(a[0]).localeCompare(String(b[0]))));
		expect(recorded?.provenance).toHaveLength(1);
		expect(recorded?.provenance[0]?.verified).toBe(true);
		expect(recorded?.source?.builderId).toBe(BUILDER);
		expect(h.provenance.calls[0]?.trustedBuilderIds).toEqual([BUILDER]);
	});

	it("the same attestation gives the same Freight id as the equivalent manifest", async () => {
		const h = await ingestHarness();
		const bytes = statement(SUBJECTS);
		const viaAttestation = await h.ingest.attestation({ bindle: "shop", statement: bytes, bundle: bundleFor(bytes) }, h.ctx);
		if (!viaAttestation.ok || !viaAttestation.value.manifest) throw new Error("attestation refused");
		const reparsed = parseFreightManifest(viaAttestation.value.manifest);
		expect(reparsed.ok && freightIdentity(reparsed.value).freightId).toBe(viaAttestation.value.freightId);
		const again = await h.ingest.manifest({ manifest: viaAttestation.value.manifest }, h.ctx);
		expect(again.ok && again.value.freightId).toBe(viaAttestation.value.freightId);
	});

	it("a tampered subject digest is refused (slsa-provenance-certification)", async () => {
		const h = await ingestHarness();
		const signedBytes = statement(SUBJECTS);
		const tampered = statement([{ name: API_PURL, seed: "evil" }, SUBJECTS[1] ?? { name: WEB_PURL, seed: "web" }]);
		const outcome = await h.ingest.attestation({ bindle: "shop", statement: tampered, bundle: bundleFor(signedBytes) }, h.ctx);
		expect(!outcome.ok && outcome.reasons.map((reason) => reason.code)).toEqual([INGEST_REASON.provenanceUnverified, "provenance-signature-invalid"]);
		expect(await h.ledger.list()).toEqual([]);
	});

	it("an unsigned statement is refused", async () => {
		const h = await ingestHarness();
		const outcome = await h.ingest.attestation({ bindle: "shop", statement: statement(SUBJECTS) }, h.ctx);
		expect(code(outcome)).toBe(INGEST_REASON.provenanceUnverified);
	});

	it("does not trust a verifier result that is unverified or leaves a subject uncovered", async () => {
		const h = await ingestHarness();
		const bytes = statement(SUBJECTS);
		h.provenance.mode = "unverified-ref";
		expect(code(await h.ingest.attestation({ bindle: "shop", statement: bytes, bundle: bundleFor(bytes) }, h.ctx))).toBe(
			INGEST_REASON.provenanceUnverified,
		);
		h.provenance.mode = "partial-subjects";
		expect(code(await h.ingest.attestation({ bindle: "shop", statement: bytes, bundle: bundleFor(bytes) }, h.ctx))).toBe(
			INGEST_REASON.provenanceUnverified,
		);
	});

	it.each([
		["a non-SLSA predicate", statement(SUBJECTS, { predicateType: "https://example.com/other" }), INGEST_REASON.attestationInvalid],
		["no declaration hash", statement(SUBJECTS, { declarationHash: null }), INGEST_REASON.declarationMissing],
		["a malformed declaration hash", statement(SUBJECTS, { declarationHash: "sha256:nope" }), INGEST_REASON.declarationMissing],
		["bytes that are not JSON", new TextEncoder().encode("{"), INGEST_REASON.attestationInvalid],
	])("refuses %s", async (_name, bytes, expected) => {
		const h = await ingestHarness();
		expect(code(await h.ingest.attestation({ bindle: "shop", statement: bytes, bundle: bundleFor(bytes) }, h.ctx))).toBe(expected);
	});
});

describe("FreightIngest.cdevent (webhooks only nudge, I15)", () => {
	it("CDEvent artifact.published without attestation schedules polls and creates no Freight (§10)", async () => {
		const h = await ingestHarness();
		const outcome = await h.ingest.cdevent({ body: cdevent("dev.cdevents.artifact.published.0.2.0", API_PURL) }, h.ctx);
		expect(outcome).toEqual({ ok: true, value: { scheduledPolls: ["shop-images"] } });
		expect(h.sources.scheduled).toEqual([["shop-images"]]);
		expect(await h.ledger.list()).toEqual([]);
		expect(h.telemetry.count(INGEST_METRIC.pollsScheduled)).toBe(1);
	});

	it("maps npm, git and packaged events to their sources and ignores unrelated ones", async () => {
		const h = await ingestHarness();
		const npm = await h.ingest.cdevent({ body: cdevent("dev.cdevents.artifact.packaged.0.2.0", WEB_PURL) }, h.ctx);
		expect(npm.ok && npm.value.scheduledPolls).toEqual(["shop-packages"]);
		const git = await h.ingest.cdevent({ body: cdevent("dev.cdevents.artifact.published.0.1.1", "pkg:github/acme/shop@4f2a9c1") }, h.ctx);
		expect(git.ok && git.value.scheduledPolls).toEqual(["shop-git"]);
		const none = await h.ingest.cdevent({ body: cdevent("dev.cdevents.artifact.published.0.2.0", "pkg:oci/unknown") }, h.ctx);
		expect(none.ok && none.value.scheduledPolls).toEqual([]);
		expect(h.sources.scheduled).toEqual([["shop-packages"], ["shop-git"]]);
	});

	it("accepts the CDEvent as the data of a CloudEvent", async () => {
		const h = await ingestHarness();
		const inner = JSON.parse(new TextDecoder().decode(cdevent("dev.cdevents.artifact.published.0.2.0", API_PURL)));
		const wrapped = new TextEncoder().encode(
			JSON.stringify({ specversion: "1.0", id: "1", source: "/ci", type: inner.context.type, datacontenttype: "application/json", data: inner }),
		);
		const outcome = await h.ingest.cdevent({ body: wrapped }, h.ctx);
		expect(outcome.ok && outcome.value.scheduledPolls).toEqual(["shop-images"]);
	});

	it("creates Freight only from a verifiable attestation carried in customData", async () => {
		const h = await ingestHarness();
		const bytes = statement(SUBJECTS);
		const outcome = await h.ingest.cdevent(
			{ body: cdevent("dev.cdevents.artifact.published.0.2.0", API_PURL, attestationData(bytes, bundleFor(bytes))) },
			h.ctx,
		);
		expect(outcome.ok).toBe(true);
		if (!outcome.ok) return;
		expect(outcome.value.scheduledPolls).toEqual(["shop-images"]);
		expect(outcome.value.freight?.origin).toBe(FreightOrigin.CDEVENT);
		expect(await h.ledger.isUsable(fid(outcome.value.freight?.freightId ?? ""))).toBe(true);
	});

	it("an unverifiable attestation still nudges but is refused as an unverified trigger", async () => {
		const h = await ingestHarness();
		const bytes = statement(SUBJECTS);
		const outcome = await h.ingest.cdevent(
			{ body: cdevent("dev.cdevents.artifact.published.0.2.0", API_PURL, attestationData(bytes)) },
			h.ctx,
		);
		expect(!outcome.ok && outcome.reasons.map((reason) => reason.code).slice(0, 2)).toEqual([UNVERIFIED_TRIGGER, INGEST_REASON.provenanceUnverified]);
		expect(h.sources.scheduled).toEqual([["shop-images"]]);
		expect(await h.ledger.list()).toEqual([]);
	});

	it.each([
		["not JSON", new TextEncoder().encode("<xml/>"), INGEST_REASON.cdeventInvalid],
		["a non-artifact event", cdevent("dev.cdevents.pipelinerun.finished.0.2.0", API_PURL), INGEST_REASON.cdeventUnsupported],
		["no purl subject", cdevent("dev.cdevents.artifact.published.0.2.0", "not a purl"), INGEST_REASON.cdeventInvalid],
		["an oversized body", new Uint8Array(2_000_000), INGEST_REASON.cdeventInvalid],
	])("refuses %s and schedules nothing", async (_name, body, expected) => {
		const h = await ingestHarness();
		expect(code(await h.ingest.cdevent({ body }, h.ctx))).toBe(expected);
		expect(h.sources.scheduled).toEqual([]);
	});
});

describe("parsePurl", () => {
	it("parses type, namespace, name, version and qualifiers with percent-decoding", () => {
		expect(parsePurl(API_PURL)).toEqual({
			type: "oci",
			namespace: "",
			name: "shop-api",
			version: `sha256:${hex64("api")}`,
			qualifiers: { repository_url: "ghcr.io/acme/shop-api" },
		});
		expect(parsePurl(WEB_PURL)).toMatchObject({ type: "npm", namespace: "@acme", name: "shop-web", version: "1.4.0" });
		expect(parsePurl("https://example.com")).toBeUndefined();
	});
});
