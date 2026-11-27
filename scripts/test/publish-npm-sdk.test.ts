import { describe, expect, it } from "vitest";
import {
	NPM_OIDC_REF,
	type NpmReleaseProvenance,
	npmWorkflowCredentials,
	publishNpmSdkArtifacts,
	SIGSTORE_BUNDLE_MEDIA_TYPE,
} from "../ci/publish-npm-sdk.mts";

describe("release-hobo release-npm hosted runner contract", () => {
	it("signs and publishes on ubuntu-24.04 with the job's OIDC identity", async () => {
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
		expect(block).not.toMatch(/secrets\.NPM_TOKEN/u);
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
	const ownerNpm = (token: string, asked: string[] = []) => ({
		async resolve(ref: string) {
			asked.push(ref);
			return { token };
		},
	});
	const base = {
		stagingDir: "/tmp/x",
		credentials: ownerNpm("eyJ.a.b"),
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
				{
					stagingDir: base.stagingDir,
					credentials: base.credentials,
					releaseRef: base.releaseRef,
				},
				{
					stage: () => staged,
					tarballs: () => ["/tmp/x/core.tgz"],
					sign: fakeSigner(signed),
					qualify: async () => qualified,
				},
			),
		).rejects.toThrow(/HOBO_RELEASE_CD_HOME/);
		expect(signed).toEqual([]);
	});

	it("refuses a missing or invalid workload identity before signing", async () => {
		const signed: string[] = [];
		await expect(
			publishNpmSdkArtifacts(
				{ ...base, credentials: ownerNpm(" ") },
				{ stage: () => staged, sign: fakeSigner(signed) },
			),
		).rejects.toThrow(/OIDC identity is invalid/);
		expect(signed).toEqual([]);
	});

	it("fails when @hobo/cd blocks the candidate Freight (nothing else publishes)", async () => {
		await expect(
			publishNpmSdkArtifacts(base, {
				stage: () => staged,
				tarballs: () => ["/tmp/x/core.tgz"],
				read: () => new Uint8Array([1]),
				sign: fakeSigner([]),
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
					NonNullable<
						NonNullable<Parameters<typeof publishNpmSdkArtifacts>[1]>["qualify"]
					>
			  >[0]
			| undefined;
		await publishNpmSdkArtifacts(base, {
			stage: () => staged,
			tarballs: () => ["/tmp/x/core.tgz"],
			read: () => new Uint8Array([1, 2, 3]),
			sign: fakeSigner(signed),
			qualify: async (given) => {
				input = given;
				return qualified;
			},
		});
		expect(signed).toEqual(["@hobo-labs/core@0.0.0-alpha.9"]);
		expect(input?.family).toBe("npm");
		expect(input?.seams?.credentials).toBe(base.credentials);
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

describe("npm workflow workload identity", () => {
	it("requests an npm-audience ID token only for its candidate camp", async () => {
		const seen: string[] = [];
		const credentials = npmWorkflowCredentials(
			{
				ACTIONS_ID_TOKEN_REQUEST_URL:
					"https://pipelines.actions.githubusercontent.com/token?request=1",
				ACTIONS_ID_TOKEN_REQUEST_TOKEN: "request-token",
			},
			async (input, init) => {
				seen.push(String(input));
				expect(new Headers(init?.headers).get("authorization")).toBe(
					"bearer request-token",
				);
				expect(init?.redirect).toBe("error");
				return Response.json({ value: "eyJ.a.b" });
			},
		);
		expect(
			await credentials.resolve(
				NPM_OIDC_REF,
				"cd-realize:hobo-release/npm-candidate",
			),
		).toEqual({ token: "eyJ.a.b" });
		expect(new URL(seen[0] ?? "").searchParams.get("audience")).toBe(
			"npm:registry.npmjs.org",
		);
		await expect(
			credentials.resolve(NPM_OIDC_REF, "cd-realize:other"),
		).rejects.toThrow(/not authorized/);
		expect(seen).toHaveLength(1);
	});

	it("never sends the GitHub request token to an untrusted host", async () => {
		let called = false;
		const credentials = npmWorkflowCredentials(
			{
				ACTIONS_ID_TOKEN_REQUEST_URL:
					"https://actions.githubusercontent.com.attacker.test/token",
				ACTIONS_ID_TOKEN_REQUEST_TOKEN: "request-token",
			},
			async () => {
				called = true;
				return Response.json({});
			},
		);
		await expect(
			credentials.resolve(NPM_OIDC_REF, "npm.publish"),
		).rejects.toThrow(/unavailable/);
		expect(called).toBe(false);
	});
	it("fails closed without disclosing a rejected or malformed identity response", async () => {
		for (const response of [
			new Response("sensitive-response", { status: 401 }),
			new Response("sensitive-response", { status: 200 }),
		]) {
			const credentials = npmWorkflowCredentials(
				{
					ACTIONS_ID_TOKEN_REQUEST_URL:
						"https://pipelines.actions.githubusercontent.com/token",
					ACTIONS_ID_TOKEN_REQUEST_TOKEN: "request-token",
				},
				async () => response,
			);
			await expect(
				credentials.resolve(NPM_OIDC_REF, "npm.publish"),
			).rejects.toThrow(/GitHub Actions OIDC/);
		}
	});
});
