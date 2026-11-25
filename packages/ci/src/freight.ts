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
// public-contract: the in-toto Statement v1 _type URI.
export const IN_TOTO_STATEMENT_TYPE = "https://in-toto.io/Statement/v1";
// public-contract: the SLSA provenance v1 predicateType URI.
export const SLSA_PROVENANCE_PREDICATE = "https://slsa.dev/provenance/v1";
// public-contract: the SLSA buildType of a HoBo CI build.
export const HOBO_CI_BUILD_TYPE = "https://hobo.dev/ci/build/v1";
// public-contract: CI output path of the run's provenance statement (README output layout).
export const CI_PROVENANCE_OUTPUT = "freight/provenance.intoto.json";
// public-contract: suffix of a deliverable's Freight manifest output, next to its bytes (README output layout).
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

/** cd.proto ProvenanceRef; proto3 defaults ("" and false) are written as omitted. */
export type CiProvenanceRef = Readonly<{
	statementDigest: string;
	predicateType: string;
	builderId: string;
	signerIdentity: string;
	issuer: string;
	verified: boolean;
	verifier: string;
	subjectDigests: readonly string[];
}>;

/** cd.proto ArtifactRef; `kind` is the protobuf JSON enum name. */
export type CiFreightArtifact = Readonly<{
	name: string;
	kind: string;
	digest: string;
	coordinate: string;
	sizeBytes: number;
	mediaType: string;
	ecosystem: string;
}>;

/** cd.proto SourceRef. */
export type CiFreightSource = Readonly<{
	repository: string;
	commit: string;
	ref: string;
	ciRunId: string;
	ciSystem: string;
	builderId: string;
}>;

// domain-view: the fields of @hobo/cd's FreightManifestRecord that a HoBo CI
// build writes; @hobo/ci has no cd.proto codegen and cannot import @hobo/cd.
export type CiFreightManifest = Readonly<{
	schemaVersion: string;
	bindle: string;
	declarationHash: string;
	artifacts: readonly CiFreightArtifact[];
	source: CiFreightSource;
	provenance: readonly CiProvenanceRef[];
	labels: Readonly<Record<string, string>>;
	subject: "FREIGHT_SUBJECT_BINDLE";
}>;

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

// Canonical JSON (keys sorted by code unit, no whitespace), written field by
// field: every writer below lists its keys already in that order and leaves
// out proto3 defaults, as protobuf toJson does.
const text = (value: string) => JSON.stringify(value);
const field = (key: string, json: string) => `${text(key)}:${json}`;
const object = (fields: readonly string[]) => `{${fields.join(",")}}`;
const list = (items: readonly string[]) => `[${items.join(",")}]`;

function textField(fields: string[], key: string, value: string): void {
	if (value !== "") fields.push(field(key, text(value)));
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
			checkText(`${at}.mediaType`, item.mediaType, out);
		}
		seen.add(item.name);
	});
	const source = manifest.source;
	if (source.commit !== "" && !COMMIT.test(source.commit))
		out.push(invalid("source.commit", "commit must be 7-64 lowercase hex"));
	checkText("source.repository", source.repository, out);
	checkText("source.ref", source.ref, out);
	checkText("source.ciRunId", source.ciRunId, out);
	checkText("source.ciSystem", source.ciSystem, out);
	checkText("source.builderId", source.builderId, out);
	manifest.provenance.forEach((ref, index) => {
		const at = `provenance[${index}]`;
		if (!DIGEST.test(ref.statementDigest))
			out.push(
				invalid(`${at}.statementDigest`, "statementDigest must be sha256"),
			);
		if (ref.subjectDigests.some((digest) => !DIGEST.test(digest)))
			out.push(
				invalid(`${at}.subjectDigests`, "subject digests must be sha256"),
			);
		if (!["", "sigstore", "hobo-jwt"].includes(ref.verifier))
			out.push(invalid(`${at}.verifier`, "verifier is sigstore or hobo-jwt"));
		checkText(`${at}.builderId`, ref.builderId, out);
		checkText(`${at}.signerIdentity`, ref.signerIdentity, out);
	});
	for (const [key, value] of Object.entries(manifest.labels)) {
		if (!LABEL_KEY.test(key))
			out.push(
				invalid(`labels.${key}`, "label keys are lowercase [a-z0-9._/-]"),
			);
		else checkText(`labels.${key}`, value, out);
	}
	return out;
}

const byText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

function artifactJson(item: CiFreightArtifact): string {
	const fields: string[] = [];
	textField(fields, "coordinate", item.coordinate);
	textField(fields, "digest", item.digest);
	textField(fields, "ecosystem", item.ecosystem);
	textField(fields, "kind", item.kind);
	textField(fields, "mediaType", item.mediaType);
	textField(fields, "name", item.name);
	// uint64 is a JSON string in protobuf JSON; zero is the default and is omitted.
	if (item.sizeBytes > 0)
		textField(fields, "sizeBytes", String(item.sizeBytes));
	return object(fields);
}

function provenanceJson(ref: CiProvenanceRef): string {
	const fields: string[] = [];
	textField(fields, "builderId", ref.builderId);
	textField(fields, "issuer", ref.issuer);
	textField(fields, "predicateType", ref.predicateType);
	textField(fields, "signerIdentity", ref.signerIdentity);
	textField(fields, "statementDigest", ref.statementDigest);
	if (ref.subjectDigests.length > 0)
		fields.push(
			field(
				"subjectDigests",
				list([...ref.subjectDigests].sort(byText).map(text)),
			),
		);
	if (ref.verified) fields.push(field("verified", "true"));
	textField(fields, "verifier", ref.verifier);
	return object(fields);
}

function sourceJson(source: CiFreightSource): string {
	const fields: string[] = [];
	textField(fields, "builderId", source.builderId);
	textField(fields, "ciRunId", source.ciRunId);
	textField(fields, "ciSystem", source.ciSystem);
	textField(fields, "commit", source.commit);
	textField(fields, "ref", source.ref);
	textField(fields, "repository", source.repository);
	return object(fields);
}

/** The canonical `hobo.freight-manifest/v1` document @hobo/cd parses, or a CiFreightError. */
export function writeCiFreightManifest(
	manifest: CiFreightManifest,
): Uint8Array {
	const reasons = check(manifest);
	if (reasons.length > 0) throw new CiFreightError(reasons);
	const artifacts = [...manifest.artifacts].sort((a, b) =>
		byText(a.name, b.name),
	);
	const provenance = [...manifest.provenance].sort((a, b) =>
		byText(
			`${a.statementDigest}|${a.builderId}|${a.verifier}`,
			`${b.statementDigest}|${b.builderId}|${b.verifier}`,
		),
	);
	const labels = Object.entries(manifest.labels).sort(([a], [b]) =>
		byText(a, b),
	);
	const fields: string[] = [];
	if (artifacts.length > 0)
		fields.push(field("artifacts", list(artifacts.map(artifactJson))));
	textField(fields, "bindle", manifest.bindle);
	textField(fields, "declarationHash", manifest.declarationHash);
	if (labels.length > 0)
		fields.push(
			field(
				"labels",
				object(labels.map(([key, value]) => field(key, text(value)))),
			),
		);
	if (provenance.length > 0)
		fields.push(field("provenance", list(provenance.map(provenanceJson))));
	textField(fields, "schemaVersion", manifest.schemaVersion);
	fields.push(field("source", sourceJson(manifest.source)));
	textField(fields, "subject", manifest.subject);
	return new TextEncoder().encode(object(fields));
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
	const declaration = object([
		field("bindle", text(deliverable.bindle)),
		field("ecosystem", text(deliverable.ecosystem)),
		field("kind", text(deliverable.kind)),
		field("mediaType", text(deliverable.mediaType)),
		field("output", text(deliverable.output)),
		field("schema", text("hobo.ci.deliverable/v1")),
	]);
	return `sha256:${sha256(declaration)}`;
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
	const dependency = object([
		field("digest", object([field("gitCommit", text(build.commit))])),
		field("uri", text(`git+${build.repository}@${build.ref}`)),
	]);
	const buildDefinition = object([
		field("buildType", text(HOBO_CI_BUILD_TYPE)),
		field(
			"externalParameters",
			object([
				field("pipeline", text(build.pipeline)),
				field("ref", text(build.ref)),
				field("repository", text(build.repository)),
			]),
		),
		field(
			"internalParameters",
			object([field("ciSystem", text(build.ciSystem))]),
		),
		field("resolvedDependencies", list([dependency])),
	]);
	const runDetails = object([
		field("builder", object([field("id", text(build.builderId))])),
		field("metadata", object([field("invocationId", text(build.runId))])),
	]);
	const subject = sorted.map((item) =>
		object([
			field(
				"digest",
				object([field("sha256", text(item.digest.replace(/^sha256:/, "")))]),
			),
			field("name", text(item.name)),
		]),
	);
	const statement = object([
		field("_type", text(IN_TOTO_STATEMENT_TYPE)),
		field(
			"predicate",
			object([
				field("buildDefinition", buildDefinition),
				field("runDetails", runDetails),
			]),
		),
		field("predicateType", text(SLSA_PROVENANCE_PREDICATE)),
		field("subject", list(subject)),
	]);
	const bytes = new TextEncoder().encode(statement);
	const digest = `sha256:${sha256(bytes)}`;
	return {
		bytes,
		digest,
		ref: {
			statementDigest: digest,
			predicateType: SLSA_PROVENANCE_PREDICATE,
			builderId: build.builderId,
			signerIdentity: "",
			issuer: "",
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
				sizeBytes: input.sizeBytes,
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

/** A passing `ci.PipelineResultObserved` lease, as far as a HOBO_CI source reads it. */
export type CiFreightResult = Readonly<{
	pipelineId: string;
	repository: string;
	headSha: string;
	result: Readonly<{
		id: string;
		status: "passed";
		artifacts: readonly Readonly<{ path: string; sha256: string }>[];
	}>;
}>;

/**
 * The structural shape of a passing `ci.PipelineResultObserved` lease for
 * these outputs, for a CI system that exposes outputs as files (GitHub
 * Actions artifacts) rather than through the @hobo/ci store.
 */
export function ciFreightResult(
	build: CiBuild,
	outputs: readonly CiFreightOutput[],
): CiFreightResult {
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
