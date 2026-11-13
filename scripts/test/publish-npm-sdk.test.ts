import { describe, expect, it } from "vitest";
import {
	type NpmReleaseProvenance,
	npmPublishCliPrefix,
	PINNED_NPM_CLI,
	publishNpmSdkArtifacts,
	SIGSTORE_BUNDLE_MEDIA_TYPE,
} from "../ci/publish-npm-sdk.mts";

describe("npm CLI pinning (publisher whoami check only)", () => {
	it("pins npm 11.21.1 via npx", () => {
		expect(npmPublishCliPrefix()).toEqual(["npx", "-y", PINNED_NPM_CLI]);
		expect(PINNED_NPM_CLI).toBe("npm@11.21.1");
	});
});

describe("release-hobo release-npm hosted runner contract", () => {
	it("signs and publishes on ubuntu-24.04 with the job's OIDC identity and the npm token", async () => {
		const { readFileSync } = await import("node:fs");
		const { join } = await import("node:path");
		const root = join(import.meta.dirname, "..", "..");
		const workflow = readFileSync(
			join(root, ".github/workflows/release-hobo.yml"),
			"utf8",
		);
		const jobRe = /^ {2}release-npm:/m;
		const start = jobRe.exec(workflow)?.index ?? -1;
		expect(start).toBeGreaterThanOrEqual(0);
		const rest = workflow.slice(start + 1);
		const nextJob = rest.search(/^ {2}[a-z][a-z0-9-]+:/m);
		const block =
			nextJob === -1
				? workflow.slice(start)
				: workflow.slice(start, start + 1 + nextJob);
		expect(block).toMatch(/runs-on:\s*ubuntu-24\.04/u);
		expect(block).toMatch(/environment:\s*release/u);
		// Keyless Sigstore signing needs the job's GitHub OIDC token.
		expect(block).toMatch(/id-token:\s*write/u);
		expect(block).toMatch(/NPM_TOKEN: \$\{\{ secrets\.NPM_TOKEN \}\}/u);
		expect(block).not.toMatch(/ci-runner-preflight/u);
		expect(block).toMatch(/jdx\/mise-action@/u);
	});
});

const STATEMENT = `sha256:${"c".repeat(64)}`;

function fakeSigner(signed: string[]) {
	return async (pkg: {
		name: string;
		version: string;
		tarball: Uint8Array;
	}): Promise<NpmReleaseProvenance> => {
		signed.push(`${pkg.name}@${pkg.version}`);
		return {
			bundle: new TextEncoder().encode(`{"bundle":"${pkg.name}"}`),
			statementDigest: STATEMENT,
			signerIdentity:
				"https://github.com/Hobo-Labs/HoBo/.github/workflows/release-hobo.yml@refs/heads/main",
		};
	};
}

describe("npm publishes only through release Freight and hobo deploy", () => {
	const staged = {
		version: "0.0.0-alpha.9",
		packages: [
			{ workspace: "@hobo/core", public: "@hobo-labs/core", file: "core.tgz" },
		],
	};
	const base = {
		stagingDir: "/tmp/x",
		token: "npm_fixtureToken",
		releaseRef: "v0.0.0-alpha.9",
		freightHome: "/tmp/cd",
	};
	const qualified = {
		freightId: "sha256:x",
		verdict: { outcome: "qualified" as const, codes: [], message: "" },
	};

	it("refuses to publish without a release Freight home (HOBO_RELEASE_CD_HOME)", async () => {
		const signed: string[] = [];
		await expect(
			publishNpmSdkArtifacts(
				{ ...base, freightHome: undefined },
				{
					stage: () => staged,
					tarballs: () => ["/tmp/x/core.tgz"],
					sign: fakeSigner(signed),
					whoami: () => {},
					qualify: async () => qualified,
				},
			),
		).rejects.toThrow(/HOBO_RELEASE_CD_HOME/);
		expect(signed).toEqual([]);
	});

	it("refuses without NPM_TOKEN: a scoped name cannot use npm's OIDC exchange, and there is no other publisher", async () => {
		await expect(
			publishNpmSdkArtifacts(
				{ ...base, token: " " },
				{
					stage: () => staged,
					whoami: () => {},
					qualify: async () => qualified,
				},
			),
		).rejects.toThrow(/set NPM_TOKEN/);
	});

	it("checks the publisher before anything is signed or recorded", async () => {
		const signed: string[] = [];
		await expect(
			publishNpmSdkArtifacts(base, {
				stage: () => staged,
				tarballs: () => ["/tmp/x/core.tgz"],
				read: () => new Uint8Array([1]),
				sign: fakeSigner(signed),
				whoami: () => {
					throw new Error("npm publisher must be hobodev, got someone");
				},
				qualify: async () => qualified,
			}),
		).rejects.toThrow(/hobodev/);
		expect(signed).toEqual([]);
	});

	it("fails when @hobo/cd blocks the candidate Freight (nothing else publishes)", async () => {
		await expect(
			publishNpmSdkArtifacts(base, {
				stage: () => staged,
				tarballs: () => ["/tmp/x/core.tgz"],
				read: () => new Uint8Array([1]),
				sign: fakeSigner([]),
				whoami: () => {},
				qualify: async () => ({
					freightId: "sha256:x",
					verdict: {
						outcome: "blocked",
						codes: ["npm-provenance-bundle-missing"],
						message: "no bundle",
					},
				}),
			}),
		).rejects.toThrow(/blocked .*nothing else publishes/);
	});

	it("records each tarball with its signed Sigstore bundle, by name, as release Freight", async () => {
		const signed: string[] = [];
		let input:
			| Parameters<
					NonNullable<Parameters<typeof publishNpmSdkArtifacts>[1]["qualify"]>
			  >[0]
			| undefined;
		await publishNpmSdkArtifacts(base, {
			stage: () => staged,
			tarballs: () => ["/tmp/x/core.tgz"],
			read: () => new Uint8Array([1, 2, 3]),
			sign: fakeSigner(signed),
			whoami: () => {},
			qualify: async (given) => {
				input = given;
				return qualified;
			},
		});
		expect(signed).toEqual(["@hobo-labs/core@0.0.0-alpha.9"]);
		expect(input?.family).toBe("npm");
		expect(input?.labels?.["hobo.cd/npm.dist-tag"]).toBe("alpha");
		expect(
			input?.stored?.map(({ name, kind, mediaType }) => ({
				name,
				kind,
				mediaType,
			})),
		).toEqual([
			{
				name: "@hobo-labs/core@0.0.0-alpha.9",
				kind: "ARTIFACT_KIND_PACKAGE",
				mediaType: "application/gzip",
			},
			{
				name: "@hobo-labs/core@0.0.0-alpha.9.sigstore",
				kind: "ARTIFACT_KIND_STATIC_ASSETS",
				mediaType: SIGSTORE_BUNDLE_MEDIA_TYPE,
			},
		]);
		expect(new TextDecoder().decode(input?.stored?.[1]?.bytes)).toBe(
			'{"bundle":"@hobo-labs/core"}',
		);
	});
});
