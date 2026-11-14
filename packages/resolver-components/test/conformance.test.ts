// The reference components pass the conformance kit; a component that
// breaks the contract fails the named check.
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
	buildReferenceComponent,
	httpArtifactUpload,
	sftpStatic,
} from "../src/components/index.js";
import {
	CONFORMANCE_CHECKS,
	createFakeSftpBridge,
	createFakeUploadEndpoint,
	failedChecks,
	runResolverComponentConformance,
} from "../src/conformance/index.js";
import { defineResolverGuest, ok, outcome } from "../src/guest/index.js";
import { manifestJson } from "./fixtures.js";
import { CREDENTIAL_REF, hosted, SECRET } from "./harness.js";

const sha = (text: string) =>
	`sha256:${createHash("sha256").update(text).digest("hex")}`;

describe("conformance kit: reference components", () => {
	it("http-artifact-upload passes every check", async () => {
		const reference = httpArtifactUpload([
			{ host: "static.example.net", credential: true },
		]);
		const built = buildReferenceComponent(reference);
		const { component } = await hosted(
			built.manifestJson,
			reference.guest,
			reference.source,
		);
		const endpoint = createFakeUploadEndpoint({
			host: "static.example.net",
			token: SECRET,
		});
		const report = await runResolverComponentConformance({
			component,
			productId: "http/artifact-upload",
			upstream: endpoint.transport,
			desired: {
				uploadUrl: "https://static.example.net/site/index.html",
				artifactDigest: sha("<h1>v1</h1>"),
				content: "<h1>v1</h1>",
				contentType: "text/html",
				healthUrl: "https://static.example.net/healthz",
			},
			changed: {
				uploadUrl: "https://static.example.net/site/index.html",
				artifactDigest: sha("<h1>v2</h1>"),
				content: "<h1>v2</h1>",
				contentType: "text/html",
				healthUrl: "https://static.example.net/healthz",
			},
			credentialRef: CREDENTIAL_REF,
			credentialMaterial: [`Bearer ${SECRET}`],
		});
		expect(failedChecks(report)).toEqual([]);
		expect(report.passed).toBe(true);
		expect(report.checks.map((check) => check.id)).toEqual([
			...CONFORMANCE_CHECKS,
		]);
	});

	it("sftp-static passes every check through the agent-local bridge", async () => {
		const reference = sftpStatic();
		const built = buildReferenceComponent(reference);
		const { component } = await hosted(
			built.manifestJson,
			reference.guest,
			reference.source,
			{ mode: "agent" },
		);
		const bridge = createFakeSftpBridge({
			host: "sftp-bridge.hobo.local",
			token: SECRET,
		});
		const report = await runResolverComponentConformance({
			component,
			productId: "sftp/static-file",
			upstream: bridge.transport,
			desired: {
				remotePath: "/var/www/index.html",
				content: "v1",
				digest: sha("v1"),
			},
			changed: {
				remotePath: "/var/www/index.html",
				content: "v2",
				digest: sha("v2"),
				mode: "0640",
			},
			credentialRef: CREDENTIAL_REF,
			credentialMaterial: [`Bearer ${SECRET}`],
		});
		expect(failedChecks(report)).toEqual([]);
	});

	it("sftp-static refuses to load in conductor mode (agent-only bridge)", async () => {
		const reference = sftpStatic();
		const built = buildReferenceComponent(reference);
		await expect(
			hosted(built.manifestJson, reference.guest, reference.source),
		).rejects.toThrow(/component.manifest-invalid/u);
	});
});

describe("conformance kit: contract violations fail the named check", () => {
	it("a non-idempotent component fails reconcile.idempotent", async () => {
		const guest = defineResolverGuest(() => ({
			describe: async () => ({
				componentId: "acme-static",
				version: "1.2.3",
				classes: [
					{
						productId: "acme/site",
						slot: "web",
						retainedFields: ["replicas"],
						observeFields: ["tls.version", "cacheTtl"],
						directives: ["forceDelete"],
					},
				],
			}),
			reconcile: async () => ok(outcome("create", `site-${Math.random()}`, {})),
			read: async () => ok(null),
			delete: async () => ok(null),
			instances: async () => ok([]),
		}));
		const { component } = await hosted(manifestJson(), guest, "non-idempotent");
		const report = await runResolverComponentConformance({
			component,
			productId: "acme/site",
			upstream: async () => ({ status: 200, headers: {}, body: "" }),
			desired: { a: 1 },
			changed: { a: 2 },
			credentialRef: CREDENTIAL_REF,
			credentialMaterial: [`Bearer ${SECRET}`],
		});
		expect(report.passed).toBe(false);
		expect(failedChecks(report)).toContain("reconcile.idempotent");
		expect(failedChecks(report)).toContain("read.observes");
	});
});
