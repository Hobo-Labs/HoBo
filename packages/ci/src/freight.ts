// HoBo's own builds as Freight. When HoBo CI builds main, each deliverable
// (the relay bundle, the runner image, the CLI and SDK tarballs, the site
// bundle) leaves the run as three CI outputs: its bytes, its
// `hobo.freight-manifest/v1` document, and the run's in-toto/SLSA provenance
// statement. A `HOBO_CI` Freight source in @hobo/cd reads them through its
// CiEventReader: the CI event only triggers, the source re-reads the bytes and
// checks the digest (I15).
//
// The manifest is the wire form @hobo/cd's `writeFreightManifest` writes,
// byte for byte (test/freight.test.ts checks a fixture @hobo/cd produced).
// @hobo/ci cannot import @hobo/cd: @hobo/cd depends on @hobo/stations, which
// depends on @hobo/ci, so the edge would close a cycle. The schema is the
// contract between them, not a shared module. Parse, don't validate: nothing
// leaves this module as a manifest without passing `writeCiFreightManifest`.
import { createHash } from "node:crypto";
import type { PipelineArtifact } from "./_generated/ci_pb.js";
import { createArtifact } from "./execution.js";

// public-contract: the Freight manifest schema (@hobo/cd FREIGHT_MANIFEST_SCHEMA).
export const CI_FREIGHT_MANIFEST_SCHEMA = "hobo.freight-manifest/v1" as const;
// public-contract: in-toto Statement v1 and the SLSA provenance v1 predicate.
export const IN_TOTO_STATEMENT_TYPE = "https://in-toto.io/Statement/v1";
export const SLSA_PROVENANCE_PREDICATE = "https://slsa.dev/provenance/v1";
// public-contract: the SLSA buildType of a HoBo CI build.
export const HOBO_CI_BUILD_TYPE = "https://hobo.dev/ci/build/v1";
/** CI output path of the run's provenance statement. */
export const CI_PROVENANCE_OUTPUT = "freight/provenance.intoto.json";
/** Suffix of a deliverable's Freight manifest output, next to its bytes. */
export const CI_FREIGHT_MANIFEST_SUFFIX = ".freight.json";

// public-contract: refusal codes, the same strings @hobo/cd's FREIGHT_REASON uses.
export const CI_FREIGHT_REASON = Object.freeze({
	manifestInvalid: "freight-manifest-invalid",
	secretInRecord: "freight-secret-in-record",
} as const);

/** cd.proto ArtifactKind, as its protobuf JSON name. */
export type CiFreightArtifactKind =
	| "ARTIFACT_KIND_WASM_COMPONENT"
	| "ARTIFACT_KIND_FUNCTION_BUNDLE"
	| "ARTIFACT_KIND_STATIC_ASSETS"
	| "ARTIFACT_KIND_OCI_IMAGE"
	| "ARTIFACT_KIND_VM_IMAGE"
	| "ARTIFACT_KIND_PACKAGE"
	| "ARTIFACT_KIND_SOURCE_TREE";
const KINDS: ReadonlySet<string> = new Set<CiFreightArtifactKind>([
	"ARTIFACT_KIND_WASM_COMPONENT",
	"ARTIFACT_KIND_FUNCTION_BUNDLE",
	"ARTIFACT_KIND_STATIC_ASSETS",
	"ARTIFACT_KIND_OCI_IMAGE",
	"ARTIFACT_KIND_VM_IMAGE",
	"ARTIFACT_KIND_PACKAGE",
	"ARTIFACT_KIND_SOURCE_TREE",
]);
const ECOSYSTEMS: ReadonlySet<string> = new Set([
	"oci",
	"npm",
	"nuget",
	"pypi",
	"maven",
	"cargo",
	"rubygems",
	"git",
	"http",
	"store",
]);

export type HoboDeliverable = Readonly<{
	id: string;
	/** The Bindle the Freight is for. */
	bindle: string;
	/** CI output path; a HOBO_CI subscription names it as `artifactName`. */
	output: string;
	kind: CiFreightArtifactKind;
	ecosystem: string;
	mediaType: string;
}>;

/**
 * What HoBo CI delivers of HoBo itself. The relay and runner-fleet entries are
 * the Bindles and output paths `hoboCiDogfoodSources` in @hobo/cd subscribes
 * to (HOBO_CI_COMPONENTS). The runner image's output is its OCI image
 * manifest, whose sha256 is the image digest.
 */
// public-contract: HoBo's own deliverables, their Bindles and CI output paths.
export const HOBO_DELIVERABLES = Object.freeze({
	relay: Object.freeze({
		id: "relay",
		bindle: "hobo-ci-relay",
		output: "relay/bundle",
		kind: "ARTIFACT_KIND_FUNCTION_BUNDLE",
		ecosystem: "store",
		mediaType: "application/octet-stream",
	}),
	runnerImage: Object.freeze({
		id: "runnerImage",
		bindle: "hobo-ci-runner-fleet",
		output: "runner-fleet/image",
		kind: "ARTIFACT_KIND_OCI_IMAGE",
		ecosystem: "oci",
		mediaType: "application/vnd.oci.image.manifest.v1+json",
	}),
	cli: Object.freeze({
		id: "cli",
		bindle: "hobo-cli",
		output: "cli/tarball",
		kind: "ARTIFACT_KIND_PACKAGE",
		ecosystem: "npm",
		mediaType: "application/gzip",
	}),
	sdk: Object.freeze({
		id: "sdk",
		bindle: "hobo-sdk",
		output: "sdk/tarball",
		kind: "ARTIFACT_KIND_PACKAGE",
		ecosystem: "npm",
		mediaType: "application/gzip",
	}),
	site: Object.freeze({
		id: "site",
		bindle: "hobo-site",
		output: "site/bundle",
		kind: "ARTIFACT_KIND_STATIC_ASSETS",
		ecosystem: "store",
		mediaType: "application/gzip",
	}),
} satisfies Record<string, HoboDeliverable>);

export type HoboDeliverableId = keyof typeof HOBO_DELIVERABLES;

/** The run that built the deliverables. Every field is observed from the CI. */
export type CiBuild = Readonly<{
	repository: string;
	/** The built commit, 7-64 lowercase hex. */
	commit: string;
	ref: string;
	/** The CI pipeline (or repository) a HOBO_CI subscription names as its locator. */
	pipeline: string;
	runId: string;
	ciSystem: string;
	builderId: string;
}>;

export type CiFreightReason = Readonly<{
	code: string;
	message: string;
	remediation: string;
	subject: string;
}>;

/** Thrown for a manifest or build the Freight boundary would refuse. */
export class CiFreightError extends Error {
	readonly reasons: readonly CiFreightReason[];
	constructor(reasons: readonly CiFreightReason[]) {
		super(
			`invalid ${CI_FREIGHT_MANIFEST_SCHEMA}: ${reasons.map((item) => `${item.subject}: ${item.message}`).join("; ")}`,
		);
		this.name = "CiFreightError";
		this.reasons = reasons;
	}
}

/** cd.proto ProvenanceRef in protobuf JSON; empty fields are omitted, as toJson does. */
export type CiProvenanceRef = Readonly<{
	statementDigest: string;
	predicateType?: string;
	builderId?: string;
	signerIdentity?: string;
	issuer?: string;
	verified?: boolean;
	verifier?: string;
	subjectDigests?: readonly string[];
}>;

// domain-view: the protobuf-JSON wire form of @hobo/cd's FreightManifestRecord;
// @hobo/ci has no cd.proto codegen and cannot import @hobo/cd (cycle).
export type CiFreightManifest = Readonly<{
	schemaVersion: string;
	bindle: string;
	declarationHash: string;
	artifacts: readonly Readonly<{
		name: string;
		kind: string;
		digest: string;
		coordinate: string;
		sizeBytes?: string;
		mediaType?: string;
		ecosystem?: string;
	}>[];
	source?: Readonly<Partial<Record<keyof typeof SOURCE_FIELDS, string>>>;
	provenance?: readonly CiProvenanceRef[];
	labels?: Readonly<Record<string, string>>;
	subject?: string;
}>;

const SOURCE_FIELDS = {
	repository: "repository",
	commit: "commit",
	ref: "ref",
	ciRunId: "runId",
	ciSystem: "ciSystem",
	builderId: "builderId",
} as const satisfies Record<string, keyof CiBuild>;

const DIGEST = /^sha256:[0-9a-f]{64}$/;
const BINDLE = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/;
const LABEL_KEY = /^[a-z0-9]([a-z0-9._/-]{0,62}[a-z0-9])?$/;
const COMMIT = /^[0-9a-f]{7,64}$/;
const CONTROL = /\p{Cc}/u;
const MAX_TEXT = 1024;
// The credential shapes @hobo/cd refuses (I9). Matching refuses; nothing is redacted.
const SECRET_PATTERNS: readonly RegExp[] = [
	/[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^/\s@]+@/i,
	/\bgh[pousr]_[A-Za-z0-9]{30,}\b/,
	/\bgithub_pat_[A-Za-z0-9_]{30,}\b/,
	/\bglpat-[A-Za-z0-9_-]{20,}\b/,
	/\bxox[abposr]-[A-Za-z0-9-]{10,}\b/,
	/\bAKIA[0-9A-Z]{16}\b/,
	/-----BEGIN [A-Z ]*PRIVATE KEY-----/,
	/\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/,
];

type Json =
	| string
	| number
	| boolean
	| null
	| readonly Json[]
	| { readonly [key: string]: Json | undefined };

/** Object keys sorted by code unit, no whitespace: the canonical JSON @hobo/cd ids hash. */
function canonicalJson(value: Json | undefined): string {
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	if (value !== null && typeof value === "object") {
		const record = value as { readonly [key: string]: Json | undefined };
		const keys = Object.keys(record)
			.filter((key) => record[key] !== undefined)
			.sort();
		return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
	}
	return JSON.stringify(value ?? null);
}

function sha256(bytes: Uint8Array | string): string {
	return createHash("sha256").update(bytes).digest("hex");
}

function invalid(subject: string, message: string): CiFreightReason {
	return {
		code: CI_FREIGHT_REASON.manifestInvalid,
		message,
		remediation: `emit the manifest with writeCiFreightManifest (${CI_FREIGHT_MANIFEST_SCHEMA}) from the build's own observations`,
		subject,
	};
}

function checkText(subject: string, value: string, out: CiFreightReason[]) {
	if (value.length > MAX_TEXT)
		out.push(invalid(subject, `${subject} exceeds ${MAX_TEXT} characters`));
	else if (CONTROL.test(value))
		out.push(invalid(subject, `${subject} contains control characters`));
	else if (SECRET_PATTERNS.some((pattern) => pattern.test(value)))
		out.push({
			code: CI_FREIGHT_REASON.secretInRecord,
			message: `${subject} carries credential material; Freight records are secret-free`,
			remediation:
				"rotate the credential and pass the CI value without it; credentials stay in the CI's credential flow",
			subject,
		});
}

function check(manifest: CiFreightManifest): CiFreightReason[] {
	const out: CiFreightReason[] = [];
	if (manifest.schemaVersion !== CI_FREIGHT_MANIFEST_SCHEMA)
		out.push(
			invalid(
				"schemaVersion",
				`schemaVersion must be ${CI_FREIGHT_MANIFEST_SCHEMA}`,
			),
		);
	if (!BINDLE.test(manifest.bindle))
		out.push(
			invalid("bindle", "bindle must be 1-128 characters of [A-Za-z0-9._:@/-]"),
		);
	if (!DIGEST.test(manifest.declarationHash))
		out.push(
			invalid(
				"declarationHash",
				"declarationHash must be sha256:<64 lowercase hex>",
			),
		);
	const seen = new Set<string>();
	manifest.artifacts.forEach((item, index) => {
		const at = `artifacts[${index}]`;
		if (item.name.trim() === "")
			out.push(invalid(`${at}.name`, "artifact name is required"));
		else if (seen.has(item.name))
			out.push(invalid(`${at}.name`, `duplicate artifact name ${item.name}`));
		else if (!DIGEST.test(item.digest))
			out.push(
				invalid(`${at}.digest`, "digest must be sha256:<64 lowercase hex>"),
			);
		else if (!KINDS.has(item.kind))
			out.push(invalid(`${at}.kind`, "artifact kind must be specified"));
		else if (item.coordinate.trim() === "")
			out.push(invalid(`${at}.coordinate`, "artifact coordinate is required"));
		else if (item.ecosystem && !ECOSYSTEMS.has(item.ecosystem))
			out.push(invalid(`${at}.ecosystem`, "unknown artifact ecosystem"));
		else {
			checkText(`${at}.name`, item.name, out);
			checkText(`${at}.coordinate`, item.coordinate, out);
			checkText(`${at}.mediaType`, item.mediaType ?? "", out);
		}
		seen.add(item.name);
	});
	const source = manifest.source ?? {};
	if (source.commit && !COMMIT.test(source.commit))
		out.push(invalid("source.commit", "commit must be 7-64 lowercase hex"));
	for (const key of Object.keys(
		SOURCE_FIELDS,
	) as (keyof typeof SOURCE_FIELDS)[])
		if (key !== "commit") checkText(`source.${key}`, source[key] ?? "", out);
	(manifest.provenance ?? []).forEach((ref, index) => {
		const at = `provenance[${index}]`;
		if (!DIGEST.test(ref.statementDigest))
			out.push(
				invalid(`${at}.statementDigest`, "statementDigest must be sha256"),
			);
		if ((ref.subjectDigests ?? []).some((digest) => !DIGEST.test(digest)))
			out.push(
				invalid(`${at}.subjectDigests`, "subject digests must be sha256"),
			);
		if (!["", "sigstore", "hobo-jwt"].includes(ref.verifier ?? ""))
			out.push(invalid(`${at}.verifier`, "verifier is sigstore or hobo-jwt"));
		checkText(`${at}.builderId`, ref.builderId ?? "", out);
		checkText(`${at}.signerIdentity`, ref.signerIdentity ?? "", out);
	});
	for (const [key, value] of Object.entries(manifest.labels ?? {})) {
		if (!LABEL_KEY.test(key))
			out.push(
				invalid(`labels.${key}`, "label keys are lowercase [a-z0-9._/-]"),
			);
		else checkText(`labels.${key}`, value, out);
	}
	return out;
}

const byText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** Drop the fields protobuf JSON omits (empty strings, false, empty lists and maps). */
function omitDefaults(value: Json | undefined): Json | undefined {
	if (Array.isArray(value)) {
		const list = value.map(omitDefaults).filter((item) => item !== undefined);
		return list.length === 0 ? undefined : (list as Json[]);
	}
	if (value !== null && typeof value === "object") {
		const record: Record<string, Json> = {};
		for (const [key, item] of Object.entries(value)) {
			const kept = omitDefaults(item);
			if (kept !== undefined) record[key] = kept;
		}
		return Object.keys(record).length === 0 ? undefined : record;
	}
	return value === "" || value === false ? undefined : value;
}

/** The canonical `hobo.freight-manifest/v1` document @hobo/cd parses, or a CiFreightError. */
export function writeCiFreightManifest(
	manifest: CiFreightManifest,
): Uint8Array {
	const reasons = check(manifest);
	if (reasons.length > 0) throw new CiFreightError(reasons);
	const normalized = {
		...manifest,
		subject: manifest.subject || "FREIGHT_SUBJECT_BINDLE",
		artifacts: [...manifest.artifacts].sort((a, b) => byText(a.name, b.name)),
		provenance: [...(manifest.provenance ?? [])]
			.map((ref) => ({
				...ref,
				subjectDigests: [...(ref.subjectDigests ?? [])].sort(byText),
			}))
			.sort((a, b) =>
				byText(
					`${a.statementDigest}|${a.builderId ?? ""}|${a.verifier ?? ""}`,
					`${b.statementDigest}|${b.builderId ?? ""}|${b.verifier ?? ""}`,
				),
			),
	};
	const json = omitDefaults(normalized as unknown as Json) ?? {};
	// A source message that was set stays present, even when all its fields are empty.
	const withSource =
		manifest.source !== undefined &&
		typeof json === "object" &&
		json !== null &&
		!Array.isArray(json) &&
		!("source" in json)
			? { ...json, source: {} }
			: json;
	return new TextEncoder().encode(canonicalJson(withSource));
}

/** Where a HOBO_CI subscription finds an output: @hobo/cd's `ciCoordinate`. */
export function ciFreightCoordinate(build: CiBuild, path: string): string {
	return `hobo-ci://${encodeURIComponent(build.pipeline)}/${encodeURIComponent(build.runId)}/${path.split("/").map(encodeURIComponent).join("/")}`;
}

/**
 * The deliverable's declaration hash: sha256 over its canonical declaration.
 * A change to the declaration with the same bytes is new Freight, as in @hobo/cd.
 */
export function ciDeclarationHash(deliverable: HoboDeliverable): string {
	const declaration = {
		schema: "hobo.ci.deliverable/v1",
		bindle: deliverable.bindle,
		output: deliverable.output,
		kind: deliverable.kind,
		ecosystem: deliverable.ecosystem,
		mediaType: deliverable.mediaType,
	};
	return `sha256:${sha256(canonicalJson(declaration))}`;
}

export type CiProvenance = Readonly<{
	bytes: Uint8Array;
	digest: string;
	ref: CiProvenanceRef;
}>;

function refuseBuild(build: CiBuild): void {
	if (!COMMIT.test(build.commit))
		throw new CiFreightError([
			invalid("source.commit", "a build's commit must be 7-64 lowercase hex"),
		]);
}

/**
 * The run's in-toto Statement v1 with an SLSA provenance v1 predicate over
 * every subject it built. It is unsigned: the reference CD records says
 * `verified: false` with no verifier, so a source with `requireProvenance`
 * refuses it until a sigstore or hobo-jwt signer signs it.
 */
export function ciProvenanceStatement(
	build: CiBuild,
	subjects: readonly Readonly<{ name: string; digest: string }>[],
): CiProvenance {
	refuseBuild(build);
	const sorted = [...subjects].sort((a, b) => byText(a.name, b.name));
	const statement = {
		_type: IN_TOTO_STATEMENT_TYPE,
		subject: sorted.map((item) => ({
			name: item.name,
			digest: { sha256: item.digest.replace(/^sha256:/, "") },
		})),
		predicateType: SLSA_PROVENANCE_PREDICATE,
		predicate: {
			buildDefinition: {
				buildType: HOBO_CI_BUILD_TYPE,
				externalParameters: {
					repository: build.repository,
					ref: build.ref,
					pipeline: build.pipeline,
				},
				internalParameters: { ciSystem: build.ciSystem },
				resolvedDependencies: [
					{
						uri: `git+${build.repository}@${build.ref}`,
						digest: { gitCommit: build.commit },
					},
				],
			},
			runDetails: {
				builder: { id: build.builderId },
				metadata: { invocationId: build.runId },
			},
		},
	};
	const bytes = new TextEncoder().encode(canonicalJson(statement));
	const digest = `sha256:${sha256(bytes)}`;
	return {
		bytes,
		digest,
		ref: {
			statementDigest: digest,
			predicateType: SLSA_PROVENANCE_PREDICATE,
			builderId: build.builderId,
			verified: false,
			verifier: "",
			subjectDigests: sorted.map((item) => item.digest),
		},
	};
}

/** One deliverable's Freight manifest (not yet checked: write it with writeCiFreightManifest). */
export function ciFreightManifest(
	input: Readonly<{
		deliverable: HoboDeliverable;
		digest: string;
		sizeBytes: number;
		build: CiBuild;
		provenance?: CiProvenance;
	}>,
): CiFreightManifest {
	const { deliverable, build } = input;
	return {
		schemaVersion: CI_FREIGHT_MANIFEST_SCHEMA,
		bindle: deliverable.bindle,
		declarationHash: ciDeclarationHash(deliverable),
		subject: "FREIGHT_SUBJECT_BINDLE",
		artifacts: [
			{
				name: deliverable.output,
				kind: deliverable.kind,
				digest: input.digest,
				coordinate: ciFreightCoordinate(build, deliverable.output),
				...(input.sizeBytes > 0 ? { sizeBytes: String(input.sizeBytes) } : {}),
				mediaType: deliverable.mediaType,
				ecosystem: deliverable.ecosystem,
			},
		],
		source: {
			repository: build.repository,
			commit: build.commit,
			ref: build.ref,
			ciRunId: build.runId,
			ciSystem: build.ciSystem,
			builderId: build.builderId,
		},
		provenance: input.provenance ? [input.provenance.ref] : [],
		labels: { "hobo.ci/deliverable": deliverable.id },
	};
}

export type CiFreightOutput = Readonly<{
	path: string;
	bytes: Uint8Array;
	/** Lowercase hex, as PipelineArtifact.sha256 records it. */
	sha256: string;
}>;

export type CiFreightOutputs = Readonly<{
	/** Sorted by path. */
	outputs: readonly CiFreightOutput[];
	manifests: readonly CiFreightManifest[];
}>;

function deliverableOf(id: string): HoboDeliverable {
	const found = Object.values(HOBO_DELIVERABLES).find((item) => item.id === id);
	if (!found)
		throw new Error(
			`unknown HoBo deliverable ${id}; known: ${Object.keys(HOBO_DELIVERABLES).join(", ")}`,
		);
	return found;
}

/**
 * Every CI output of a HoBo build: each deliverable's bytes at its output
 * path, its Freight manifest beside it, and one provenance statement over all
 * of them. Pure; the caller exposes the outputs as its CI system does.
 */
export function ciFreightOutputs(
	build: CiBuild,
	built: readonly Readonly<{ id: string; bytes: Uint8Array }>[],
): CiFreightOutputs {
	refuseBuild(build);
	const items = built.map((item) => ({
		deliverable: deliverableOf(item.id),
		bytes: item.bytes,
		sha256: sha256(item.bytes),
	}));
	const provenance = ciProvenanceStatement(
		build,
		items.map((item) => ({
			name: item.deliverable.output,
			digest: `sha256:${item.sha256}`,
		})),
	);
	const outputs: CiFreightOutput[] = [
		{
			path: CI_PROVENANCE_OUTPUT,
			bytes: provenance.bytes,
			sha256: provenance.digest.slice("sha256:".length),
		},
	];
	const manifests: CiFreightManifest[] = [];
	for (const item of items) {
		const manifest = ciFreightManifest({
			deliverable: item.deliverable,
			digest: `sha256:${item.sha256}`,
			sizeBytes: item.bytes.byteLength,
			build,
			provenance,
		});
		const document = writeCiFreightManifest(manifest);
		manifests.push(manifest);
		outputs.push(
			{ path: item.deliverable.output, bytes: item.bytes, sha256: item.sha256 },
			{
				path: `${item.deliverable.output}${CI_FREIGHT_MANIFEST_SUFFIX}`,
				bytes: document,
				sha256: sha256(document),
			},
		);
	}
	outputs.sort((a, b) => byText(a.path, b.path));
	return { outputs, manifests };
}

/**
 * The outputs as PipelineArtifacts of a @hobo/ci pipeline result. The store
 * journals the passing result as `ci.PipelineResultObserved`, the event a
 * HOBO_CI source's CiEventReader reads. An output over the pipeline artifact
 * limit (one MiB) is refused by createArtifact, never truncated.
 */
export async function ciFreightPipelineArtifacts(
	build: CiBuild,
	built: readonly Readonly<{ id: string; bytes: Uint8Array }>[],
): Promise<PipelineArtifact[]> {
	const { outputs } = ciFreightOutputs(build, built);
	return Promise.all(
		outputs.map((output) => createArtifact(output.path, output.bytes)),
	);
}

/**
 * The structural shape of a passing `ci.PipelineResultObserved` lease for
 * these outputs, for a CI system that exposes outputs as files (GitHub
 * Actions artifacts) rather than through the @hobo/ci store.
 */
export function ciFreightResult(
	build: CiBuild,
	outputs: readonly CiFreightOutput[],
): Readonly<{
	pipelineId: string;
	repository: string;
	headSha: string;
	result: Readonly<{
		id: string;
		status: "passed";
		artifacts: readonly Readonly<{ path: string; sha256: string }>[];
	}>;
}> {
	return {
		pipelineId: build.pipeline,
		repository: build.repository,
		headSha: build.commit,
		result: {
			id: build.runId,
			status: "passed",
			artifacts: outputs.map((output) => ({
				path: output.path,
				sha256: output.sha256,
			})),
		},
	};
}
