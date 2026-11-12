import { describe, expect, it } from "vitest";
import {
	npmPublishAuthEnv,
	npmPublishCliPrefix,
	PINNED_NPM_CLI,
	publishNpmSdkArtifacts,
	resolveNpmPublishAuthMode,
} from "../ci/publish-npm-sdk.mts";
import { npmPublishArgs, parseReleaseRef } from "../lib/release-version.mts";

describe("resolveNpmPublishAuthMode", () => {
	it("uses OIDC when NPM_TOKEN is empty (OpenSesame dual-path)", () => {
		expect(resolveNpmPublishAuthMode("")).toBe("oidc");
		expect(resolveNpmPublishAuthMode(undefined)).toBe("oidc");
	});

	it("uses token auth when NPM_TOKEN is set", () => {
		expect(resolveNpmPublishAuthMode("npm_test_token")).toBe("token");
	});
});

describe("npmPublishAuthEnv", () => {
	it("maps token auth to NODE_AUTH_TOKEN only", () => {
		expect(npmPublishAuthEnv("token", " npm_secret ")).toEqual({
			NODE_AUTH_TOKEN: "npm_secret",
		});
	});

	it("clears token env for OIDC trusted publishing", () => {
		expect(npmPublishAuthEnv("oidc", "")).toEqual({});
	});
});

describe("npm publish CLI pinning", () => {
	it("pins npm 11.21.1 via npx (OpenSesame parity)", () => {
		expect(npmPublishCliPrefix()).toEqual(["npx", "-y", PINNED_NPM_CLI]);
		expect(PINNED_NPM_CLI).toBe("npm@11.21.1");
	});

	it("never publishes with dist-tag latest on alpha train", () => {
		const parsed = parseReleaseRef("v0.0.0-alpha.9");
		expect(parsed.npmDistTag).toBe("alpha");
		expect(npmPublishArgs("hobo-labs-core-0.0.0-alpha.9.tgz", parsed)).toEqual([
			"publish",
			"hobo-labs-core-0.0.0-alpha.9.tgz",
			"--provenance",
			"--access",
			"public",
			"--tag",
			"alpha",
		]);
	});
});

describe("release-hobo release-npm hosted runner contract", () => {
	it("runs npm publish on ubuntu-24.04 for OIDC trusted publishing", async () => {
		const { readFileSync } = await import("node:fs");
		const { join } = await import("node:path");
		const root = join(import.meta.dirname, "..", "..");
		const workflow = readFileSync(
			join(root, ".github/workflows/release-hobo.yml"),
			"utf8",
		);
		const jobRe = /^  release-npm:/m;
		const start = jobRe.exec(workflow)?.index;
		expect(start).toBeGreaterThanOrEqual(0);
		const rest = workflow.slice(start! + 1);
		const nextJob = rest.search(/^  [a-z][a-z0-9-]+:/m);
		const block =
			nextJob === -1
				? workflow.slice(start!)
				: workflow.slice(start!, start! + 1 + nextJob);
		expect(block).toMatch(/runs-on:\s*ubuntu-24\.04/u);
		expect(block).toMatch(/environment:\s*release/u);
		expect(block).toMatch(/id-token:\s*write/u);
		expect(block).not.toMatch(/ci-runner-preflight/u);
		expect(block).toMatch(/jdx\/mise-action@/u);
	});
});

const impedance = {
	outcome: "impedance" as const,
	codes: ["npm-provenance-bundle-missing"],
	message: "no Sigstore bundle",
};

describe("npm publish goes through release Freight first", () => {
	const staged = {
		version: "0.0.0-alpha.9",
		packages: [
			{ workspace: "@hobo/core", public: "@hobo-labs/core", file: "core.tgz" },
		],
	};

	it("refuses to publish without a release Freight home (HOBO_RELEASE_CD_HOME)", async () => {
		const npm: string[][] = [];
		await expect(
			publishNpmSdkArtifacts(
				{ stagingDir: "/tmp/x", token: "", releaseRef: "v0.0.0-alpha.9" },
				{
					stage: () => staged,
					tarballs: () => ["/tmp/x/core.tgz"],
					qualify: async () => ({ freightId: "sha256:x", verdict: impedance }),
					npm: (args) => npm.push(args),
				},
			),
		).rejects.toThrow(/HOBO_RELEASE_CD_HOME/);
		expect(npm).toEqual([]);
	});

	it("publishes nothing when @hobo/cd blocks the candidate Freight", async () => {
		const npm: string[][] = [];
		await expect(
			publishNpmSdkArtifacts(
				{
					stagingDir: "/tmp/x",
					token: "",
					releaseRef: "v0.0.0-alpha.9",
					freightHome: "/tmp/cd",
				},
				{
					stage: () => staged,
					tarballs: () => ["/tmp/x/core.tgz"],
					read: () => new Uint8Array([1]),
					qualify: async () => {
						throw new Error(
							"release Freight npm blocked: freight-artifacts-unverified",
						);
					},
					npm: (args) => npm.push(args),
				},
			),
		).rejects.toThrow(/blocked/);
		expect(npm).toEqual([]);
	});

	it("publishes nothing itself when the npm realizer qualified the candidate", async () => {
		const npm: string[][] = [];
		await publishNpmSdkArtifacts(
			{
				stagingDir: "/tmp/x",
				token: "",
				releaseRef: "v0.0.0-alpha.9",
				freightHome: "/tmp/cd",
			},
			{
				stage: () => staged,
				tarballs: () => ["/tmp/x/core.tgz"],
				read: () => new Uint8Array([1]),
				qualify: async () => ({
					freightId: "sha256:x",
					verdict: { outcome: "qualified", codes: [], message: "" },
				}),
				npm: (args) => npm.push(args),
			},
		);
		expect(npm).toEqual([]);
	});

	it("records every staged tarball as Freight, then publishes them in pack order on the npm impedance verdict", async () => {
		const npm: string[][] = [];
		let recorded: readonly { name: string }[] = [];
		await publishNpmSdkArtifacts(
			{
				stagingDir: "/tmp/x",
				token: "",
				releaseRef: "v0.0.0-alpha.9",
				freightHome: "/tmp/cd",
			},
			{
				stage: () => staged,
				tarballs: () => ["/tmp/x/core.tgz"],
				read: () => new Uint8Array([1, 2, 3]),
				qualify: async (input) => {
					recorded = input.stored ?? [];
					expect(input.labels?.["hobo.cd/npm.dist-tag"]).toBe("alpha");
					expect(npm).toEqual([]);
					return { freightId: "sha256:x", verdict: impedance };
				},
				npm: (args) => npm.push(args),
			},
		);
		expect(recorded.map((r) => r.name)).toEqual([
			"@hobo-labs/core@0.0.0-alpha.9",
		]);
		expect(npm).toEqual([
			npmPublishArgs("core.tgz", parseReleaseRef("v0.0.0-alpha.9")),
		]);
	});
});
