// PACT consumer verification for the push-ingress boundaries
// (contracts/ingest.pact.json) and the OIDC issuer HTTP boundary
// (contracts/ingest.oidc.pact.json).
import type { TransportRequest, TransportResponse } from "@hobo/core";
import { describe, expect, it } from "vitest";
import { ArtifactKind, FreightOrigin } from "../src/_generated/cd_pb.js";
import { createTrustedPublisherVerifier } from "../src/ingest/index.js";
import { manifest } from "../test/freight/builders.js";
import { clock, context, FakeAuthorizer, MemoryEventStore, TENANT } from "../test/freight/fakes.js";
import { githubClaims, githubPublisher, gitlabClaims, gitlabPublisher, rsaKey, signJwt } from "../test/ingest/oidc.js";
import { bundleFor, githubKey, ingestHarness } from "../test/ingest/support.js";
import oidcPact from "./ingest.oidc.pact.json" with { type: "json" };
import pact from "./ingest.pact.json" with { type: "json" };

function message(description: string) {
	const found = pact.interactions.find((item) => item.description === description);
	if (!found) throw new Error(`ingest Pact interaction missing: ${description}`);
	return found;
}

function issuerOf(item: (typeof oidcPact.interactions)[number]): string {
	return (item.providerStates[0]?.name ?? "").replace(/^issuer /, "");
}

describe("OIDC issuer HTTP contract", () => {
	it("requests exactly the contracted discovery and JWKS resources and accepts their shape", async () => {
		const keys = { "https://token.actions.githubusercontent.com": rsaKey("gh-contract"), "https://gitlab.com": rsaKey("gl-contract") };
		const seen = new Set<string>();
		const http = async (request: TransportRequest): Promise<TransportResponse> => {
			const item = oidcPact.interactions.find((candidate) => `${issuerOf(candidate)}${candidate.request.path}` === request.url);
			if (!item) return { status: 404, headers: {}, body: "" };
			expect(request.method).toBe(item.request.method);
			expect(request.headers).toEqual(item.request.headers);
			seen.add(item.description);
			const issuer = issuerOf(item);
			const body: Record<string, unknown> = { ...item.response.body };
			if ("keys" in item.response.body) {
				const key = keys[issuer as keyof typeof keys];
				const contracted = item.response.body.keys[0] ?? {};
				expect(Object.keys(key.jwk).sort()).toEqual(Object.keys(contracted).sort());
				body.keys = [key.jwk];
			}
			return { status: item.response.status, headers: item.response.headers, body: JSON.stringify(body) };
		};
		const time = clock();
		const ctx = context(time.now);
		const publishers = createTrustedPublisherVerifier({ store: new MemoryEventStore(), tenant: TENANT, now: time.now, http, authorizer: new FakeAuthorizer() });
		for (const record of [githubPublisher(), gitlabPublisher()]) expect((await publishers.trust(record, ctx)).ok).toBe(true);
		const github = await publishers.verify(signJwt(keys["https://token.actions.githubusercontent.com"], githubClaims(ctx.now())), ctx);
		const gitlab = await publishers.verify(signJwt(keys["https://gitlab.com"], gitlabClaims(ctx.now())), ctx);
		expect(github.ok && gitlab.ok).toBe(true);
		expect([...seen].sort()).toEqual(oidcPact.interactions.map((item) => item.description).sort());
	});
});

describe("push ingress contract", () => {
	it("records Freight from the contracted attestation", async () => {
		const item = message("record Freight from a signed in-toto v1 statement with an SLSA v1 predicate");
		const h = await ingestHarness();
		const bytes = new TextEncoder().encode(JSON.stringify(item.request.contents.statement));
		const outcome = await h.ingest.attestation({ bindle: item.request.contents.bindle ?? "", statement: bytes, bundle: bundleFor(bytes) }, h.ctx);
		if (!outcome.ok) throw new Error(JSON.stringify(outcome.reasons));
		const recorded = outcome.value.manifest;
		expect({
			ok: true,
			origin: `FREIGHT_ORIGIN_${FreightOrigin[outcome.value.origin]}`,
			bindle: recorded?.bindle,
			declarationHash: recorded?.declarationHash,
			builderId: recorded?.source?.builderId,
			provenanceVerified: recorded?.provenance.every((ref) => ref.verified),
			artifacts: recorded?.artifacts.map((artifact) => ({
				name: artifact.name,
				kind: `ARTIFACT_KIND_${ArtifactKind[artifact.kind]}`,
				ecosystem: artifact.ecosystem,
				digest: artifact.digest,
			})),
		}).toEqual(item.response[0]?.contents);
	});

	it.each([
		"record a manifest pushed with a GitHub Actions OIDC token for a trusted publisher",
		"refuse a publisher token from an unconfigured issuer",
	])("%s", async (description) => {
		const item = message(description);
		const h = await ingestHarness();
		const token = signJwt(githubKey, githubClaims(h.ctx.now(), item.request.contents.claims));
		const outcome = await h.ingest.manifest({ manifest: manifest(), publisherToken: token }, h.ctx);
		const expected = item.response[0]?.contents;
		if (outcome.ok) {
			expect({ ok: true, origin: `FREIGHT_ORIGIN_${FreightOrigin[outcome.value.origin]}`, recordedBy: outcome.value.recordedBy }).toEqual(expected);
		} else {
			expect({ ok: false, codes: outcome.reasons.map((reason) => reason.code) }).toEqual(expected);
		}
	});

	it("an artifact CDEvent without an attestation only schedules the contracted polls", async () => {
		const item = message("an artifact.published CDEvent without an attestation only schedules polls");
		const h = await ingestHarness();
		const outcome = await h.ingest.cdevent({ body: new TextEncoder().encode(JSON.stringify(item.request.contents.body)) }, h.ctx);
		if (!outcome.ok) throw new Error(JSON.stringify(outcome.reasons));
		expect({ ok: true, scheduledPolls: outcome.value.scheduledPolls, freightCreated: outcome.value.freight !== undefined }).toEqual(
			item.response[0]?.contents,
		);
	});
});
