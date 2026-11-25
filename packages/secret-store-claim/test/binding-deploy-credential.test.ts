import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { create } from "@bufbuild/protobuf";
import { describe, expect, it } from "vitest";
import {
	formatSecretStoreBinding,
	githubSubjectMismatch,
	parseSecretStoreBinding,
	RELAY_SECRET_PATH,
	readSecretStoreBinding,
	readSecretStoreBindingForRepair,
	SecretStoreBindingSchema,
} from "../src/index.js";

function bindingJson(
	fields: Readonly<Record<string, string | undefined>> = {},
): string {
	return JSON.stringify({
		kind: "infisical-cloud-attach",
		endpoint: "https://app.infisical.com",
		projectId: "relay-project",
		deployProjectId: "deploy-project",
		environment: "prod",
		secretPath: "/hobo-ci-relay",
		relayIdentityId: "relay-identity",
		deployIdentityId: "writer-identity",
		deployCredentialIdentityId: "reader-identity",
		claimBundleId: "secret-store.ci-vercel.attach-1",
		claimState: "claimed",
		deployOidcSubject:
			"repo:Hobo-Labs@344805935/HoBo@1274791462:environment:hobo-ci-app-credentials",
		...fields,
	});
}

function legacyBindingJson(): string {
	return bindingJson({
		deployProjectId: undefined,
		deployCredentialIdentityId: undefined,
		deployOidcSubject: undefined,
	});
}

describe("deploy credential identity", () => {
	it("rejects the writer identity as the deploy credential reader", () => {
		expect(() =>
			readSecretStoreBinding(
				bindingJson({ deployCredentialIdentityId: "writer-identity" }),
			),
		).toThrow("does not meet its constraints");
	});

	it("rejects the relay identity as the deploy credential reader", () => {
		expect(() =>
			readSecretStoreBinding(
				bindingJson({ deployCredentialIdentityId: "relay-identity" }),
			),
		).toThrow("does not meet its constraints");
	});

	it("accepts a credential-free binding through strict and repair reads", () => {
		const legacy = legacyBindingJson();
		const strict = readSecretStoreBinding(legacy);
		expect(strict.claimState).toBe("claimed");
		expect(strict.deployProjectId).toBe("");
		expect(strict.deployCredentialIdentityId).toBe("");
		expect(strict.strictParse).toBe(true);
		const repaired = readSecretStoreBindingForRepair(legacy);
		expect(repaired.claimState).toBe("claimed");
		expect(repaired.deployCredentialIdentityId).toBe("");
		expect("strictParse" in repaired).toBe(false);
		expect(readSecretStoreBinding(bindingJson()).strictParse).toBe(true);
	});

	it("re-serializes a repaired binding through the strict read once the reader id and subject are recorded", () => {
		const repaired = readSecretStoreBindingForRepair(legacyBindingJson());
		const rewritten = formatSecretStoreBinding(
			parseSecretStoreBinding(
				create(SecretStoreBindingSchema, {
					...repaired,
					deployProjectId: "deploy-project",
					deployCredentialIdentityId: "reader-identity",
					deployOidcSubject:
						"repo:Hobo-Labs@344805935/HoBo@1274791462:environment:hobo-ci-app-credentials",
				}),
			),
		);
		expect(rewritten).toContain("reader-identity");
		expect(readSecretStoreBinding(rewritten).deployCredentialIdentityId).toBe(
			"reader-identity",
		);
	});

	it("fails closed on the writer reused as reader even for repair", () => {
		expect(() =>
			readSecretStoreBindingForRepair(
				bindingJson({ deployCredentialIdentityId: "writer-identity" }),
			),
		).toThrow("does not meet its constraints");
	});

	it("fails closed on the relay identity reused as reader even for repair", () => {
		expect(() =>
			readSecretStoreBindingForRepair(
				bindingJson({ deployCredentialIdentityId: "relay-identity" }),
			),
		).toThrow("does not meet its constraints");
	});

	it("accepts earlier half-configured shapes only for repair, never strict reads", () => {
		for (const fields of [
			{
				deployProjectId: "deploy-project",
				deployCredentialIdentityId: undefined,
				deployOidcSubject: undefined,
			},
			{ deployCredentialIdentityId: undefined },
		]) {
			const repaired = readSecretStoreBindingForRepair(bindingJson(fields));
			expect(repaired.deployCredentialIdentityId).toBe("");
			expect(() => readSecretStoreBinding(bindingJson(fields))).toThrow(
				"does not meet its constraints",
			);
		}
	});

	it("refuses a binding that records the reader without the modern shape everywhere, repair included", () => {
		for (const fields of [
			{ deployOidcSubject: undefined },
			{ deployProjectId: undefined },
			{ deployProjectId: "relay-project" },
			{ deployCredentialIdentityId: "writer-identity" },
			{ deployCredentialIdentityId: "relay-identity" },
		])
			expect(() =>
				readSecretStoreBindingForRepair(bindingJson(fields)),
			).toThrow("does not meet its constraints");
	});

	it("round-trips a credential-free repair through the strict read", () => {
		const repaired = readSecretStoreBindingForRepair(legacyBindingJson());
		expect(readSecretStoreBinding(JSON.stringify(repaired)).strictParse).toBe(
			true,
		);
	});
});

describe("the repair read's confinement", () => {
	const repoRoot = path.resolve(import.meta.dirname, "..", "..", "..");

	const SKIPPED_DIRS = new Set([".git", "dist", "node_modules", "_generated"]);
	const pluginBundleDir = path.join(repoRoot, "plugins", "hobo", "bin");

	function sourceFiles(dir: string, found: string[] = []): string[] {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			if (entry.isDirectory()) {
				const child = path.join(dir, entry.name);
				if (!SKIPPED_DIRS.has(entry.name) && child !== pluginBundleDir)
					sourceFiles(child, found);
			} else if (/\.(?:ts|mts|cts|tsx|js|mjs|cjs|jsx)$/u.test(entry.name))
				found.push(path.join(dir, entry.name));
		}
		return found;
	}

	it("allows only connect repair, dry-run planning, and read-only hosting evidence outside this package, so an empty reader id cannot reach a deploy credential read", () => {
		const sources = sourceFiles(repoRoot);
		const foreign = sources.filter(
			(file) =>
				!file.startsWith(
					path.join(repoRoot, "packages", "secret-store-claim"),
				) &&
				readFileSync(file, "utf8").includes("readSecretStoreBindingForRepair"),
		);
		expect(foreign).toEqual([
			path.join(repoRoot, "packages", "hobo", "src", "ci-relay-deploy.ts"),
			path.join(
				repoRoot,
				"packages",
				"hobo",
				"src",
				"ci-secret-store-connect.ts",
			),
			path.join(repoRoot, "scripts", "ci", "hosting-evidence.mts"),
		]);
	});
});

describe("the deploy credential's project", () => {
	it("keeps the deploy credential's coordinates apart from the relay's: another project, never the relay's folder", () => {
		const binding = readSecretStoreBinding(bindingJson());
		expect(binding.deployProjectId).not.toBe(binding.projectId);
		expect(binding.secretPath).toBe(RELAY_SECRET_PATH);
		expect(RELAY_SECRET_PATH).not.toBe("/");
	});

	it("rejects a recorded reader without a deploy project, and a deploy project that reuses the relay's", () => {
		expect(() =>
			readSecretStoreBinding(bindingJson({ deployProjectId: undefined })),
		).toThrow("does not meet its constraints");
		expect(() =>
			readSecretStoreBinding(bindingJson({ deployProjectId: "relay-project" })),
		).toThrow("does not meet its constraints");
	});

	it("accepts a credential-free binding without a deploy project", () => {
		const legacy = legacyBindingJson();
		expect(readSecretStoreBindingForRepair(legacy).deployProjectId).toBe("");
		expect(readSecretStoreBinding(legacy).deployProjectId).toBe("");
	});
});

describe("the recorded deploy subject", () => {
	it("refuses an empty subject on a binding with the modern fields present, claimed or pending, a subject that is not a branch trust, and a wildcard branch or environment subject the trust anchor must never span", () => {
		for (const claimState of ["claimed", "pending"] as const)
			for (const deployOidcSubject of [
				"",
				"repo:Hobo-Labs@344805935/HoBo@1274791462:ref:refs/pull/7/merge",
				"repo:Hobo-Labs@344805935/HoBo@1274791462:ref:refs/tags/v1",
				"repo:Hobo-Labs@*/HoBo@*:ref:refs/heads/main",
				"repo:Hobo-Labs@344805935/HoBo@1274791462:ref:refs/heads/*",
				"repo:Hobo-Labs@344805935/HoBo@1274791462:ref:refs/heads/feature/*",
				"repo:Hobo-Labs@344805935/HoBo@1274791462:environment:production",
			])
				expect(() =>
					readSecretStoreBinding(
						bindingJson({ claimState, deployOidcSubject }),
					),
				).toThrow("does not meet its constraints");
	});

	it("keeps the subject recorded while the claim is still pending, as provision writes it", () => {
		const pending = readSecretStoreBinding(
			bindingJson({ claimState: "pending" }),
		);
		expect(pending.claimState).toBe("pending");
		expect(pending.deployOidcSubject).toBe(
			"repo:Hobo-Labs@344805935/HoBo@1274791462:environment:hobo-ci-app-credentials",
		);
	});

	it("parses a well-formed subject naming another repository, so the recorded subject is the trust anchor and a token that differs from it is named", () => {
		const other = readSecretStoreBinding(
			bindingJson({
				deployOidcSubject:
					"repo:Another-Owner@1/Another-Repo@2:environment:hobo-ci-app-credentials",
			}),
		);
		expect(
			githubSubjectMismatch(
				"repo:Hobo-Labs@344805935/HoBo@1274791462:environment:hobo-ci-app-credentials",
				other.deployOidcSubject,
			),
		).toContain("differs from the subject the deploy identity trusts");
	});
});
