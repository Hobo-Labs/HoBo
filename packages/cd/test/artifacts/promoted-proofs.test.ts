// Promoted draft proofs. The semantics of the frozen
// proofs are restated here against the production store and verifiers; the
// proofs themselves stay untouched under src/draft/technical-proofs/.
//
// - artifact-repo-port-contract: registered ecosystems only; digest-pinned
//   pulls (a mutable tag never resolves into Freight); provenance is required
//   before anything is trusted; unregistered mirrors are never consulted.
// - registry-artifact-descriptor-contract: artifact references are
//   sha256-digest-only, never a tag, never an inlined payload; OCI references
//   are digest references.
import { create, fromJson } from "@bufbuild/protobuf";
import { describe, expect, it } from "vitest";
import {
	ArtifactKind,
	ArtifactRefSchema,
	FreightManifestRecordSchema,
} from "../../src/_generated/cd_pb.js";
import {
	ARTIFACT_REASON,
	createArtifactStore,
	createArtifactVerifier,
	parseOciReference,
	REGISTRY_ECOSYSTEMS,
} from "../../src/artifacts/index.js";
import {
	createProvenanceVerifier,
	PROVENANCE_REASON,
} from "../../src/provenance/index.js";
import {
	context,
	MemoryEventStore,
	ScriptedTransport,
	T0,
	TENANT,
} from "./fakes.js";

const DIGEST = `sha256:${"a".repeat(64)}`;

function setup() {
	const transport = new ScriptedTransport();
	const deps = { store: new MemoryEventStore(), tenant: TENANT, now: () => T0 };
	const artifacts = createArtifactStore({ backend: "memory" }, deps);
	return {
		transport,
		verifier: createArtifactVerifier({
			...deps,
			artifacts,
			http: transport.http,
		}),
		deps,
	};
}

async function verifyOne(
	ecosystem: string,
	coordinate: string,
	digest = DIGEST,
) {
	const h = setup();
	const outcome = await h.verifier.verify(
		create(FreightManifestRecordSchema, {
			artifacts: [
				create(ArtifactRefSchema, {
					name: "x",
					kind: ArtifactKind.PACKAGE,
					digest,
					coordinate,
					ecosystem,
				}),
			],
		}),
		context(),
	);
	return {
		codes: outcome.ok ? [] : outcome.reasons.map((reason) => reason.code),
		requests: h.transport.requests,
	};
}

describe("artifact-repo-port-contract (promoted)", () => {
	it("registers exactly the npm, NuGet, PyPI, OCI, Maven, Cargo and RubyGems adapters", () => {
		expect([...REGISTRY_ECOSYSTEMS].sort()).toEqual([
			"cargo",
			"maven",
			"npm",
			"nuget",
			"oci",
			"pypi",
			"rubygems",
		]);
	});

	it("pulls fail closed when the coordinate is a mutable tag without a resolved digest", async () => {
		const oci = await verifyOne("oci", "registry.example/acme/app:latest");
		expect(oci.codes).toEqual([ARTIFACT_REASON.coordinateMutable]);
		const npm = await verifyOne("npm", "pkg:npm/%40acme/leftpad");
		expect(npm.codes).toEqual([ARTIFACT_REASON.coordinateMutable]);
		expect([...oci.requests, ...npm.requests]).toEqual([]);
	});

	it("publish requires provenance before anything downstream is consulted", async () => {
		const transport = new ScriptedTransport();
		const verifier = createProvenanceVerifier({
			store: new MemoryEventStore(),
			tenant: TENANT,
			now: () => T0,
			http: transport.http,
			trustPolicy: {},
		});
		const outcome = await verifier.verify(
			{
				statement: new TextEncoder().encode("{}"),
				subjects: [],
				trustedBuilderIds: ["b"],
				trustedSignerIdentities: ["s"],
			},
			context(),
		);
		expect(outcome.ok ? "ok" : outcome.reasons[0]?.code).toBe(
			PROVENANCE_REASON.unsigned,
		);
		expect(transport.requests).toEqual([]);
	});

	it("never consults an unregistered mirror or ecosystem", async () => {
		const unregistered = await verifyOne(
			"nuget-shadow",
			"pkg:nuget/Acme.Api@1.0.0",
		);
		expect(unregistered.codes).toEqual([ARTIFACT_REASON.ecosystemUnsupported]);
		expect(unregistered.requests).toEqual([]);
	});
});

describe("registry-artifact-descriptor-contract (promoted)", () => {
	it("artifact references are sha256-digest-only", async () => {
		expect(
			(await verifyOne("store", "store://memory/x", "sha512:abc")).codes,
		).toEqual([ARTIFACT_REASON.digestInvalid]);
		expect(
			(await verifyOne("store", "store://memory/x", `sha256:${"A".repeat(64)}`))
				.codes,
		).toEqual([ARTIFACT_REASON.digestInvalid]);
	});

	it("artifact references reject inlined payloads and stay digest-only", () => {
		expect(() =>
			fromJson(ArtifactRefSchema, {
				name: "x",
				digest: DIGEST,
				coordinate: "store://memory/x",
				payload: { builder: "inline-material" },
			}),
		).toThrow(/payload/);
	});

	it("OCI references must be digest references; tags alone are refused", () => {
		expect(
			parseOciReference(`oci://registry.example/acme/app@${DIGEST}`),
		).toEqual({
			registry: "registry.example",
			repository: "acme/app",
			tag: "",
			digest: DIGEST,
		});
		expect(
			parseOciReference(`registry.example/acme/app:1.0.0@${DIGEST}`)?.tag,
		).toBe("1.0.0");
		expect(parseOciReference("registry.example/acme/app:latest")?.digest).toBe(
			"",
		);
		expect(
			parseOciReference(`registry.example/acme/app@sha256:${"A".repeat(64)}`),
		).toBeUndefined();
		expect(
			parseOciReference("https://registry.example/acme/app"),
		).toBeUndefined();
	});
});
