import { createHash } from "node:crypto";
import { create } from "@bufbuild/protobuf";
import {
	type ArtifactRef,
	FreightSourceRecordSchema,
	type ProvenanceRef,
	ProvenanceRefSchema,
	ReasonRecordSchema,
	SubscriptionKind,
	SubscriptionRecordSchema,
} from "../../src/_generated/cd_pb.js";
import { createFreightLedger } from "../../src/freight/index.js";
import {
	isJsonArray,
	isJsonObject,
	objectAt,
	parseJsonText,
	stringAt,
} from "../../src/freight/json.js";
import {
	createFreightIngest,
	createTrustedPublisherVerifier,
} from "../../src/ingest/index.js";
import type {
	CdContext,
	Outcome,
	ProvenanceVerifier,
} from "../../src/ports.js";
import { manifest } from "../freight/builders.js";
import {
	clock,
	context,
	digestOf,
	FakeAuthorizer,
	FakeSources,
	hex64,
	MapArtifactVerifier,
	MemoryEventStore,
	RecordingTelemetry,
	TENANT,
} from "../freight/fakes.js";
import {
	GITHUB_ISSUER,
	githubPublisher,
	OidcTransport,
	rsaKey,
} from "./oidc.js";

export const BUILDER = "https://github.com/actions/runner/github-hosted";
export const SIGNER =
	"https://github.com/acme/shop/.github/workflows/release.yml@refs/heads/main";
export const API_PURL = `pkg:oci/shop-api@sha256:${hex64("api")}?repository_url=ghcr.io/acme/shop-api`;
export const WEB_PURL = "pkg:npm/%40acme/shop-web@1.4.0";

export function statement(
	subjects: readonly Readonly<{ name: string; seed: string }>[],
	options: { declarationHash?: string | null; predicateType?: string } = {},
): Uint8Array {
	const workflow = {
		ref: "refs/heads/main",
		path: ".github/workflows/release.yml",
	};
	const externalParameters =
		options.declarationHash === null
			? { workflow }
			: {
					workflow,
					"hobo.cd/declaration-hash":
						options.declarationHash ?? digestOf("shop-declaration-v1"),
				};
	return new TextEncoder().encode(
		JSON.stringify({
			_type: "https://in-toto.io/Statement/v1",
			subject: subjects.map((subject) => ({
				name: subject.name,
				digest: { sha256: hex64(subject.seed) },
			})),
			predicateType: options.predicateType ?? "https://slsa.dev/provenance/v1",
			predicate: {
				buildDefinition: {
					buildType: "https://actions.github.io/buildtypes/workflow/v1",
					externalParameters,
				},
				runDetails: {
					builder: { id: BUILDER },
					metadata: { invocationId: "run-42" },
				},
			},
		}),
	);
}

export function bundleFor(bytes: Uint8Array): Uint8Array {
	return new TextEncoder().encode(
		`sigstore-bundle:${createHash("sha256").update(bytes).digest("hex")}`,
	);
}

/**
 * Stand-in for the WP3 Sigstore/HoBo verifier: the "bundle" must sign the
 * exact statement bytes and the statement's subjects must equal the subjects
 * the caller derived. `mode` makes it misbehave so ingest's own checks show.
 */
export class FakeProvenanceVerifier implements ProvenanceVerifier {
	mode: "honest" | "unverified-ref" | "partial-subjects" = "honest";
	readonly calls: Readonly<{
		subjects: readonly ArtifactRef[];
		trustedBuilderIds: readonly string[];
	}>[] = [];
	async verify(
		input: Parameters<ProvenanceVerifier["verify"]>[0],
		_ctx: CdContext,
	): Promise<Outcome<readonly ProvenanceRef[]>> {
		this.calls.push({
			subjects: input.subjects,
			trustedBuilderIds: input.trustedBuilderIds,
		});
		const expected = new TextDecoder().decode(bundleFor(input.statement));
		if (!input.bundle || new TextDecoder().decode(input.bundle) !== expected) {
			return {
				ok: false,
				reasons: [
					create(ReasonRecordSchema, {
						code: "provenance-signature-invalid",
						message: "bundle does not sign the statement",
						remediation: "re-sign",
					}),
				],
			};
		}
		const parsed = parseJsonText(new TextDecoder().decode(input.statement));
		const subjects =
			isJsonObject(parsed) && isJsonArray(parsed.subject) ? parsed.subject : [];
		const signed = subjects
			.map(
				(subject) =>
					`sha256:${stringAt(objectAt(isJsonObject(subject) ? subject : undefined, "digest"), "sha256")}`,
			)
			.sort();
		const claimed = input.subjects.map((subject) => subject.digest).sort();
		if (JSON.stringify(signed) !== JSON.stringify(claimed)) {
			return {
				ok: false,
				reasons: [
					create(ReasonRecordSchema, {
						code: "provenance-subject-mismatch",
						message: "subjects differ",
						remediation: "rebuild",
					}),
				],
			};
		}
		const statementDigest = `sha256:${createHash("sha256").update(input.statement).digest("hex")}`;
		return {
			ok: true,
			value: [
				create(ProvenanceRefSchema, {
					statementDigest,
					predicateType: "https://slsa.dev/provenance/v1",
					builderId: BUILDER,
					signerIdentity: SIGNER,
					issuer: GITHUB_ISSUER,
					verified: this.mode !== "unverified-ref",
					verifier: "sigstore",
					subjectDigests:
						this.mode === "partial-subjects" ? signed.slice(0, 1) : signed,
				}),
			],
		};
	}
}

export const SOURCES = [
	create(FreightSourceRecordSchema, {
		name: "shop-images",
		bindle: "shop",
		subscriptions: [
			create(SubscriptionRecordSchema, {
				name: "api",
				kind: SubscriptionKind.OCI_REPOSITORY,
				locator: "ghcr.io/acme/shop-api",
				ecosystem: "oci",
				requireProvenance: true,
				trustedBuilderIds: [BUILDER],
				trustedSignerIdentities: [SIGNER],
			}),
		],
	}),
	create(FreightSourceRecordSchema, {
		name: "shop-packages",
		bindle: "shop",
		subscriptions: [
			create(SubscriptionRecordSchema, {
				name: "web",
				kind: SubscriptionKind.PACKAGE_REGISTRY,
				ecosystem: "npm",
				locator: "@acme/shop-web",
			}),
		],
	}),
	create(FreightSourceRecordSchema, {
		name: "shop-git",
		bindle: "shop",
		subscriptions: [
			create(SubscriptionRecordSchema, {
				name: "src",
				kind: SubscriptionKind.GIT_REPOSITORY,
				locator: "https://github.com/acme/shop.git",
			}),
		],
	}),
	create(FreightSourceRecordSchema, {
		name: "other-images",
		bindle: "other",
		subscriptions: [
			create(SubscriptionRecordSchema, {
				name: "x",
				kind: SubscriptionKind.OCI_REPOSITORY,
				locator: "ghcr.io/acme/other",
			}),
		],
	}),
];

export const githubKey = rsaKey("gh-ingest");

export async function ingestHarness() {
	const store = new MemoryEventStore();
	const time = clock();
	const telemetry = new RecordingTelemetry();
	const artifacts = new MapArtifactVerifier();
	for (const item of manifest().artifacts)
		artifacts.register(item.coordinate, item.digest);
	artifacts.register(API_PURL, digestOf("api"));
	artifacts.register(WEB_PURL, digestOf("web"));
	const authorizer = new FakeAuthorizer();
	const ledger = createFreightLedger({
		store,
		tenant: TENANT,
		now: time.now,
		artifacts,
		telemetry,
		authorizer,
	});
	const oidc = new OidcTransport();
	oidc.issuer(GITHUB_ISSUER, [githubKey], "/.well-known/jwks");
	const publishers = createTrustedPublisherVerifier({
		store,
		tenant: TENANT,
		now: time.now,
		http: oidc.transport,
		authorizer,
		telemetry,
	});
	const ctx = context(time.now);
	const trusted = await publishers.trust(githubPublisher(), ctx);
	if (!trusted.ok) throw new Error(JSON.stringify(trusted.reasons));
	const provenance = new FakeProvenanceVerifier();
	const sources = new FakeSources(SOURCES);
	const ingest = createFreightIngest({
		store,
		tenant: TENANT,
		now: time.now,
		ledger,
		publishers,
		provenance,
		sources,
		authorizer,
		telemetry,
	});
	authorizer.calls.length = 0;
	return {
		store,
		time,
		telemetry,
		artifacts,
		authorizer,
		ledger,
		publishers,
		provenance,
		sources,
		ingest,
		ctx,
	};
}
