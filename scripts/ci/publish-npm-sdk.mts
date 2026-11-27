#!/usr/bin/env node
/**
 * Publish the allowlisted SDK packages to npm through HoBo itself.
 *
 * Every staged tarball gets a Sigstore provenance bundle, signed keyless in
 * this job (`@hobo/cd/provenance`: npm's GitHub Actions statement, a Fulcio
 * certificate for the job's GitHub OIDC identity, a Rekor entry). Tarballs and
 * bundles are recorded as release Freight (the bundle as the artifact
 * `<package>@<version>.sigstore`, by digest) and promoted into
 * hobo-release/npm-candidate through `hobo deploy`. Its realizer,
 * @hobo/provider-npm, binds each bundle to its tarball's sha512, publishes the
 * version with the bundle attached (npmjs verifies the signature) and sets
 * the release dist-tag, then observes both. There is no other publisher:
 * anything but a qualified verdict fails here.
 *
 * The bundle is not recorded as a Freight `ProvenanceRef`: a pushed manifest's
 * provenance is unverified by definition and the promotion trust gate refuses
 * unverified provenance (fail closed), while npm's per-package statement
 * carries no Bindle declaration hash for the verified attestation ingest.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseReleaseRef } from "../lib/release-version.mts";
import {
	qualifyReleaseCandidate,
	type ReleaseCredentials,
} from "./create-github-release.mts";
import {
	orderedSdkTarballPaths,
	type SdkArtifactManifest,
	stageSdkArtifactsDir,
} from "./stage-sdk-artifacts.mts";

const root = join(import.meta.dirname, "..", "..");
export const NPM_OIDC_REF = "github-actions://npm-oidc";
export const SIGSTORE_BUNDLE_MEDIA_TYPE =
	"application/vnd.dev.sigstore.bundle.v0.3+json";
const CD_PROVENANCE_DIST = join(
	root,
	"packages",
	"cd",
	"dist",
	"provenance",
	"index.js",
);

export function npmWorkflowCredentials(
	env: Readonly<Record<string, string | undefined>>,
	fetchImpl: typeof fetch = fetch,
): ReleaseCredentials {
	return {
		async resolve(ref, scope) {
			if (
				ref !== NPM_OIDC_REF ||
				(scope !== "npm.publish" &&
					scope !== "cd-realize:hobo-release/npm-candidate" &&
					scope !== "cd-realize:hobo-release-npm/npm-candidate")
			)
				throw new Error(
					"npm workload identity is not authorized for this scope",
				);
			const adapter = await import(
				pathToFileURL(
					join(
						root,
						"packages",
						"adapters",
						"adapter-infisical",
						"dist",
						"auth.js",
					),
				).href
			);
			const restrictedFetch: typeof fetch = async (input, init) => {
				const url = new URL(String(input));
				if (
					url.protocol !== "https:" ||
					url.hostname !== "pipelines.actions.githubusercontent.com" ||
					url.username ||
					url.password ||
					url.port ||
					url.hash
				)
					throw new Error("GitHub Actions OIDC endpoint is invalid");
				return fetchImpl(input, init);
			};
			let token: string;
			try {
				token = await adapter.githubActionsJwtSource({
					env,
					audience: "npm:registry.npmjs.org",
					fetch: restrictedFetch,
				})();
			} catch {
				throw new Error("GitHub Actions OIDC identity is unavailable");
			}
			return { token };
		},
	};
}

/** One tarball's signed provenance: the bundle bytes and what was signed, by whom. */
export type NpmReleaseProvenance = Readonly<{
	bundle: Uint8Array;
	/** `sha256:` of the signed in-toto statement. */
	statementDigest: string;
	/** The Fulcio certificate identity (this run's workflow). */
	signerIdentity: string;
}>;

export type SignNpmProvenance = (
	pkg: Readonly<{ name: string; version: string; tarball: Uint8Array }>,
) => Promise<NpmReleaseProvenance>;

/** Keyless Sigstore signing in this GitHub Actions job (`@hobo/cd/provenance`). */
export async function sigstoreNpmProvenance(
	env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<SignNpmProvenance> {
	if (!existsSync(CD_PROVENANCE_DIST))
		throw new Error(
			`npm provenance needs the built @hobo/cd (${CD_PROVENANCE_DIST}); run pnpm exec turbo run build --filter=@hobo/hobo...`,
		);
	const provenance = await import(pathToFileURL(CD_PROVENANCE_DIST).href);
	const build = provenance.githubActionsBuild(env);
	const signer = provenance.sigstoreKeylessSigner();
	return async (pkg) => {
		const signed = await provenance.signNpmProvenance(pkg, build, signer);
		return {
			bundle: signed.bundle,
			statementDigest: signed.statementDigest,
			signerIdentity: signed.signerIdentity,
		};
	};
}

export type NpmPublishDeps = {
	readonly stage?: (dir: string) => SdkArtifactManifest;
	readonly tarballs?: (dir: string) => string[];
	readonly read?: (path: string) => Uint8Array;
	readonly sign?: SignNpmProvenance;
	readonly qualify?: (
		input: Parameters<typeof qualifyReleaseCandidate>[0],
	) => Promise<Awaited<ReturnType<typeof qualifyReleaseCandidate>>>;
};

/**
 * Stage the SDK tarballs, sign each one's provenance, record tarballs and
 * bundles as release Freight and promote it into `hobo-release/npm-candidate`
 * through `hobo deploy` (scripts/ci/create-github-release.mts), whose realizer
 * publishes. Anything but a qualified verdict throws.
 */
export async function publishNpmSdkArtifacts(
	options: {
		stagingDir: string;
		credentials?: ReleaseCredentials;
		releaseRef: string;
		/** HOBO_HOME of the release Freight journal (HOBO_RELEASE_CD_HOME). */
		freightHome?: string;
	},
	deps: NpmPublishDeps = {},
): Promise<void> {
	const parsed = parseReleaseRef(options.releaseRef);
	if (parsed.npmDistTag === "latest") {
		throw new Error("refusing npm dist-tag latest on release train");
	}
	if (!options.freightHome?.trim()) {
		throw new Error(
			"npm publish needs release Freight: set HOBO_RELEASE_CD_HOME to the hobo deploy journal directory",
		);
	}
	const credentials =
		options.credentials ?? npmWorkflowCredentials(process.env);
	const identity = await credentials.resolve(NPM_OIDC_REF, "npm.publish");
	if (
		!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*$/u.test(
			identity.token ?? "",
		)
	)
		throw new Error("GitHub Actions OIDC identity is invalid");
	const manifest = (deps.stage ?? stageSdkArtifactsDir)(options.stagingDir);
	const tarballs = (deps.tarballs ?? orderedSdkTarballPaths)(
		options.stagingDir,
	);
	if (tarballs.length !== manifest.packages.length) {
		throw new Error("SDK tarball manifest count mismatch");
	}
	const read =
		deps.read ?? ((path: string) => new Uint8Array(readFileSync(path)));
	const sign = deps.sign ?? (await sigstoreNpmProvenance());
	const stored: NonNullable<
		Parameters<typeof qualifyReleaseCandidate>[0]["stored"]
	>[number][] = [];
	for (const [index, entry] of manifest.packages.entries()) {
		const tarball = read(tarballs[index] ?? "");
		const name = `${entry.public}@${manifest.version}`;
		const signed = await sign({
			name: entry.public,
			version: manifest.version,
			tarball,
		});
		console.log(
			`signed npm provenance for ${name}: statement ${signed.statementDigest}, signer ${signed.signerIdentity}`,
		);
		stored.push(
			{
				name,
				kind: "ARTIFACT_KIND_PACKAGE",
				mediaType: "application/gzip",
				bytes: tarball,
			},
			{
				name: `${name}.sigstore`,
				kind: "ARTIFACT_KIND_STATIC_ASSETS",
				mediaType: SIGSTORE_BUNDLE_MEDIA_TYPE,
				bytes: signed.bundle,
			},
		);
	}
	const { verdict } = await (deps.qualify ?? qualifyReleaseCandidate)({
		home: options.freightHome,
		family: "npm",
		seams: { credentials },
		stored,
		labels: {
			"hobo.release/ref": options.releaseRef,
			"hobo.cd/npm.dist-tag": parsed.npmDistTag,
		},
	});
	if (verdict.outcome !== "qualified")
		throw new Error(
			`release Freight npm is ${verdict.outcome} (${verdict.codes.join(", ")}); nothing else publishes`,
		);
}

async function main(): Promise<void> {
	const stagingDir = process.argv[2] ?? join(root, "/tmp/hobo-npm-release");
	if (!process.env.HOBO_RELEASE_VERSION) {
		console.error("::error::HOBO_RELEASE_VERSION required for npm publish");
		process.exit(1);
	}
	await publishNpmSdkArtifacts({
		stagingDir,
		releaseRef: process.env.HOBO_RELEASE_VERSION,
		freightHome: process.env.HOBO_RELEASE_CD_HOME ?? "",
	});
	const manifest = join(stagingDir, "MANIFEST.json");
	if (existsSync(manifest)) {
		console.log(readFileSync(manifest, "utf8"));
	}
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	try {
		await main();
	} catch (error) {
		console.error(
			`::error::${error instanceof Error ? error.message : String(error)}`,
		);
		process.exit(1);
	}
}
