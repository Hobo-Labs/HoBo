import { create } from "@bufbuild/protobuf";
import {
	ArtifactKind,
	ArtifactRefSchema,
	type FreightManifestRecord,
	FreightManifestRecordSchema,
	FreightSubject,
	ProvenanceRefSchema,
	SourceRefSchema,
	VerificationVerdict,
	type VerificationResultRecord,
	VerificationResultRecordSchema,
} from "../../src/_generated/cd_pb.js";
import { FREIGHT_MANIFEST_SCHEMA } from "../../src/events.js";
import { digestOf } from "./fakes.js";

export function artifact(name: string, seed = name, coordinate = `store://${name}`) {
	return create(ArtifactRefSchema, {
		name,
		kind: ArtifactKind.WASM_COMPONENT,
		digest: digestOf(seed),
		coordinate,
		sizeBytes: 1024n,
		mediaType: "application/wasm",
		ecosystem: "store",
	});
}

export function manifest(overrides: Partial<Omit<FreightManifestRecord, "$typeName">> = {}): FreightManifestRecord {
	return create(FreightManifestRecordSchema, {
		schemaVersion: FREIGHT_MANIFEST_SCHEMA,
		bindle: "shop",
		declarationHash: digestOf("shop-declaration-v1"),
		artifacts: [artifact("api"), artifact("web")],
		source: create(SourceRefSchema, {
			repository: "https://git.example.com/acme/shop",
			commit: "4f2a9c1e0b7d3a5f6e8c9d0a1b2c3d4e5f6a7b8c",
			ref: "refs/heads/main",
			ciRunId: "run-42",
			ciSystem: "any-ci",
			builderId: "https://ci.example.com/builders/default",
		}),
		provenance: [
			create(ProvenanceRefSchema, {
				statementDigest: digestOf("statement"),
				predicateType: "https://slsa.dev/provenance/v1",
				builderId: "https://ci.example.com/builders/default",
				verifier: "sigstore",
				verified: true,
				subjectDigests: [digestOf("api"), digestOf("web")],
			}),
		],
		labels: { team: "storefront" },
		subject: FreightSubject.BINDLE,
		...overrides,
	});
}

export function verification(
	freightId: string,
	campId: string,
	verdict: VerificationVerdict = VerificationVerdict.PASS,
	verificationId = `ver-${campId}`,
): VerificationResultRecord {
	return create(VerificationResultRecordSchema, {
		verificationId,
		freightId,
		campId,
		verdict,
		startedAt: "2026-11-12T12:00:00.000Z",
		finishedAt: "2026-11-12T12:10:00.000Z",
	});
}
