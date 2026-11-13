// npm provenance signing: the counterpart of the verifier for HoBo's own
// releases. A CI job builds the in-toto statement npm's client builds for a
// GitHub Actions publish (libnpmpublish `generateProvenance`: Statement v1,
// SLSA provenance v1, the GitHub Actions workflow build type), signs it
// keyless (Fulcio certificate for the job's GitHub OIDC identity, Rekor
// transparency-log entry) and gets back the Sigstore bundle npm attaches as
// `<name>-<version>.sigstore`. The bundle becomes release Freight; the npm
// realizer attaches it to the publish and the registry verifies it.
//
// The subject carries the tarball's sha512 (what npm checks) and its sha256
// (the Freight artifact digest, what HoBo's own verifier checks), so one
// bundle verifies on both sides. npm's client check of an external bundle
// (libnpmpublish `verifyProvenance`) compares only the name and sha512.
//
// Credentials: the signer's identity is the CI job's OIDC token, requested
// by `sigstore` from the Actions runtime (audience `sigstore`) at signing
// time and exchanged for a short-lived certificate; it is never returned,
// recorded or logged. Signing reaches Fulcio and Rekor through `sigstore`'s
// own client: it runs in the build job, never in a resolver or a decision.
import { createHash } from "node:crypto";
import {
	isJsonObject,
	isJsonString,
	type JsonObject,
	type JsonValue,
} from "../artifacts/json.js";

// public-contract: the DSSE payload type of an in-toto statement.
export const INTOTO_PAYLOAD_TYPE = "application/vnd.in-toto+json";
// public-contract: the SLSA predicate npm provenance carries.
export const SLSA_PROVENANCE_V1 = "https://slsa.dev/provenance/v1";
// public-contract: the build type npm's client names for a GitHub Actions publish.
export const GITHUB_WORKFLOW_BUILD_TYPE =
	"https://slsa-framework.github.io/github-actions-buildtypes/workflow/v1";
// public-contract: the OIDC issuer of GitHub Actions identities.
export const GITHUB_ACTIONS_ISSUER =
	"https://token.actions.githubusercontent.com";

/** The GitHub Actions run a statement attests, read from the job's env. */
export type WorkflowRunBuild = Readonly<{
	serverUrl: string;
	repository: string;
	repositoryId: string;
	repositoryOwnerId: string;
	/** `owner/repo/.github/workflows/<file>@<ref>` (GITHUB_WORKFLOW_REF). */
	workflowRef: string;
	ref: string;
	sha: string;
	eventName: string;
	runId: string;
	runAttempt: string;
	runnerEnvironment: string;
}>;

export class ProvenanceSigningError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ProvenanceSigningError";
	}
}

const BUILD_ENV = {
	serverUrl: "GITHUB_SERVER_URL",
	repository: "GITHUB_REPOSITORY",
	repositoryId: "GITHUB_REPOSITORY_ID",
	repositoryOwnerId: "GITHUB_REPOSITORY_OWNER_ID",
	workflowRef: "GITHUB_WORKFLOW_REF",
	ref: "GITHUB_REF",
	sha: "GITHUB_SHA",
	eventName: "GITHUB_EVENT_NAME",
	runId: "GITHUB_RUN_ID",
	runAttempt: "GITHUB_RUN_ATTEMPT",
	runnerEnvironment: "RUNNER_ENVIRONMENT",
} as const satisfies Record<keyof WorkflowRunBuild, string>;

/** The build from a GitHub Actions job's env; fails closed on any gap. */
export function githubActionsBuild(
	env: Readonly<Record<string, string | undefined>>,
): WorkflowRunBuild {
	const missing = Object.values(BUILD_ENV).filter((name) => !env[name]?.trim());
	if (missing.length > 0)
		throw new ProvenanceSigningError(
			`npm provenance needs the GitHub Actions run it attests; ${missing.join(", ")} unset. Remediation: sign inside the release job (GitHub Actions, id-token: write)`,
		);
	const read = (key: keyof WorkflowRunBuild) =>
		env[BUILD_ENV[key]]?.trim() ?? "";
	const build: WorkflowRunBuild = {
		serverUrl: read("serverUrl"),
		repository: read("repository"),
		repositoryId: read("repositoryId"),
		repositoryOwnerId: read("repositoryOwnerId"),
		workflowRef: read("workflowRef"),
		ref: read("ref"),
		sha: read("sha"),
		eventName: read("eventName"),
		runId: read("runId"),
		runAttempt: read("runAttempt"),
		runnerEnvironment: read("runnerEnvironment"),
	};
	if (!build.workflowRef.startsWith(`${build.repository}/`))
		throw new ProvenanceSigningError(
			"GITHUB_WORKFLOW_REF does not name a workflow of GITHUB_REPOSITORY",
		);
	return Object.freeze(build);
}

/** `pkg:npm/%40scope/name@version`, the subject name npm compares. */
export function npmPackagePurl(name: string, version: string): string {
	return `pkg:npm/${name.replace(/^@/u, "%40")}@${version}`;
}

/** The certificate identity Fulcio issues for this run's workflow. */
export function githubWorkflowIdentity(build: WorkflowRunBuild): string {
	return `${build.serverUrl}/${build.workflowRef}`;
}

/** The in-toto statement npm's client builds for this publish, plus sha256. */
export function npmProvenanceStatement(
	pkg: Readonly<{ name: string; version: string; tarball: Uint8Array }>,
	build: WorkflowRunBuild,
): JsonObject {
	const relative = build.workflowRef.slice(build.repository.length + 1);
	const at = relative.indexOf("@");
	return {
		_type: "https://in-toto.io/Statement/v1",
		subject: [
			{
				name: npmPackagePurl(pkg.name, pkg.version),
				digest: {
					sha512: createHash("sha512").update(pkg.tarball).digest("hex"),
					sha256: createHash("sha256").update(pkg.tarball).digest("hex"),
				},
			},
		],
		predicateType: SLSA_PROVENANCE_V1,
		predicate: {
			buildDefinition: {
				buildType: GITHUB_WORKFLOW_BUILD_TYPE,
				externalParameters: {
					workflow: {
						ref: relative.slice(at + 1),
						repository: `${build.serverUrl}/${build.repository}`,
						path: relative.slice(0, at),
					},
				},
				internalParameters: {
					github: {
						event_name: build.eventName,
						repository_id: build.repositoryId,
						repository_owner_id: build.repositoryOwnerId,
					},
				},
				resolvedDependencies: [
					{
						uri: `git+${build.serverUrl}/${build.repository}@${build.ref}`,
						digest: { gitCommit: build.sha },
					},
				],
			},
			runDetails: {
				builder: {
					id: `https://github.com/actions/runner/${build.runnerEnvironment}`,
				},
				metadata: {
					invocationId: `${build.serverUrl}/${build.repository}/actions/runs/${build.runId}/attempts/${build.runAttempt}`,
				},
			},
		},
	};
}

/**
 * Signs a DSSE payload and returns the serialized Sigstore bundle. The
 * production signer is `sigstoreKeylessSigner`; tests inject one bound to a
 * per-run trust root.
 */
export type ProvenanceSigner = (
	payload: Uint8Array,
	payloadType: string,
) => Promise<JsonValue>;

/**
 * Keyless signing with `sigstore@5.0.1`: Fulcio (public-good) issues a
 * certificate for the CI job's OIDC identity and Rekor logs the signature.
 * With no `identityToken`, `sigstore` requests one from the GitHub Actions
 * runtime (audience `sigstore`), exactly as `npm publish --provenance` does.
 */
export function sigstoreKeylessSigner(
	options: Readonly<{
		identityToken?: string;
		fulcioURL?: string;
		rekorURL?: string;
	}> = {},
): ProvenanceSigner {
	return async (payload, payloadType) => {
		const sigstore = await import("sigstore");
		const bundle = await sigstore.attest(Buffer.from(payload), payloadType, {
			...(options.identityToken
				? { identityToken: options.identityToken }
				: undefined),
			...(options.fulcioURL ? { fulcioURL: options.fulcioURL } : undefined),
			...(options.rekorURL ? { rekorURL: options.rekorURL } : undefined),
		});
		const json: JsonValue = JSON.parse(JSON.stringify(bundle));
		return json;
	};
}

/** The signed provenance of one tarball, as release Freight records it. */
export type NpmProvenance = Readonly<{
	/** The Sigstore bundle bytes npm attaches (`<name>-<version>.sigstore`). */
	bundle: Uint8Array;
	/** `sha256:` of the signed statement (ProvenanceRef.statement_digest). */
	statementDigest: string;
	predicateType: string;
	builderId: string;
	signerIdentity: string;
	issuer: string;
	/** `sha256:` of the tarball (ProvenanceRef.subject_digests). */
	subjectDigest: string;
}>;

/**
 * Build, sign and bind npm provenance for one tarball. The bundle the signer
 * returns must carry exactly this statement in a DSSE envelope of the in-toto
 * payload type, or nothing is returned (fail closed): a bundle about other
 * bytes never reaches the Freight.
 */
export async function signNpmProvenance(
	pkg: Readonly<{ name: string; version: string; tarball: Uint8Array }>,
	build: WorkflowRunBuild,
	signer: ProvenanceSigner,
): Promise<NpmProvenance> {
	const statement = npmProvenanceStatement(pkg, build);
	const payload = new TextEncoder().encode(JSON.stringify(statement));
	const signed = await signer(payload, INTOTO_PAYLOAD_TYPE);
	const envelope = isJsonObject(signed) ? signed.dsseEnvelope : undefined;
	if (
		!isJsonObject(signed) ||
		!isJsonString(signed.mediaType) ||
		!signed.mediaType.startsWith("application/vnd.dev.sigstore.bundle") ||
		!isJsonObject(envelope) ||
		envelope.payloadType !== INTOTO_PAYLOAD_TYPE ||
		!isJsonString(envelope.payload) ||
		!Buffer.from(envelope.payload, "base64").equals(Buffer.from(payload))
	)
		throw new ProvenanceSigningError(
			`the signer returned no Sigstore bundle over the provenance statement of ${pkg.name}@${pkg.version}`,
		);
	return Object.freeze({
		bundle: new TextEncoder().encode(JSON.stringify(signed)),
		statementDigest: `sha256:${createHash("sha256").update(payload).digest("hex")}`,
		predicateType: SLSA_PROVENANCE_V1,
		builderId: `https://github.com/actions/runner/${build.runnerEnvironment}`,
		signerIdentity: githubWorkflowIdentity(build),
		issuer: GITHUB_ACTIONS_ISSUER,
		subjectDigest: `sha256:${createHash("sha256").update(pkg.tarball).digest("hex")}`,
	});
}
