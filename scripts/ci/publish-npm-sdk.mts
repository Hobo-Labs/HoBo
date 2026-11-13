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
 *
 * Auth is the hobodev automation token (NPM_TOKEN, resolved by the CD host
 * through the Camp's `env://NPM_TOKEN` locator, never recorded): npm's OIDC
 * trusted-publishing exchange routes only for the `%2f`-escaped scope, which
 * the transport guard refuses, so a scoped @hobo-labs name cannot use it.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseReleaseRef } from "../lib/release-version.mts";
import { qualifyReleaseCandidate } from "./create-github-release.mts";
import {
	orderedSdkTarballPaths,
	type SdkArtifactManifest,
	stageSdkArtifactsDir,
} from "./stage-sdk-artifacts.mts";

const root = join(import.meta.dirname, "..", "..");
const EXPECTED_PUBLISHER = "hobodev";
export const PINNED_NPM_CLI = "npm@11.21.1";
/** The media type of the Sigstore bundle npm attaches (`<name>-<version>.sigstore`). */
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

export function npmPublishCliPrefix(): readonly string[] {
	return ["npx", "-y", PINNED_NPM_CLI];
}

/** The token must belong to the hobodev publisher before anything is recorded. */
function assertPublisher(token: string): void {
	const env: NodeJS.ProcessEnv = { ...process.env, NODE_AUTH_TOKEN: token };
	delete env.NPM_TOKEN;
	const result = spawnSync(
		npmPublishCliPrefix()[0] ?? "npx",
		[...npmPublishCliPrefix().slice(1), "whoami"],
		{ env, encoding: "utf8" },
	);
	if (result.status !== 0) {
		throw new Error("npm whoami failed; check NPM_TOKEN for hobodev publisher");
	}
	const user = (result.stdout ?? "").trim();
	if (user !== EXPECTED_PUBLISHER) {
		throw new Error(
			`npm publisher must be ${EXPECTED_PUBLISHER}, got ${user || "(empty)"}`,
		);
	}
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

/** Seams for tests; production staging, signing, Freight and whoami by default. */
export type NpmPublishDeps = {
	readonly stage?: (dir: string) => SdkArtifactManifest;
	readonly tarballs?: (dir: string) => string[];
	readonly read?: (path: string) => Uint8Array;
	readonly sign?: SignNpmProvenance;
	readonly qualify?: (
		input: Parameters<typeof qualifyReleaseCandidate>[0],
	) => Promise<Awaited<ReturnType<typeof qualifyReleaseCandidate>>>;
	readonly whoami?: (token: string) => void;
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
		token: string;
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
	const token = options.token.trim();
	if (!token) {
		throw new Error(
			"npm publishes through hobo deploy with the hobodev token: set NPM_TOKEN (the npm Camp resolves env://NPM_TOKEN; npm's OIDC exchange cannot serve a scoped @hobo-labs name)",
		);
	}
	(deps.whoami ?? assertPublisher)(token);
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
		token: process.env.NPM_TOKEN ?? "",
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
