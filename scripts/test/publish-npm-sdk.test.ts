import { describe, expect, it } from "vitest";
import {
	npmPublishAuthEnv,
	npmPublishCliPrefix,
	PINNED_NPM_CLI,
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
