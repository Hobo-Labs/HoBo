import { describe, expect, it } from "vitest";

import {
	CONVEX_ANON_ALTERNATIVE_HOSTING_FORMS,
	CONVEX_API_PORT,
	CONVEX_BACKEND_OCI_IMAGE,
} from "../src/ephemeral-anon.js";
import {
	CONVEX_BACKEND_IMAGE_DIGEST_LINUX_AMD64,
	CONVEX_BACKEND_IMAGE_DIGEST_LINUX_ARM64,
	CONVEX_BACKEND_IMAGE_INDEX_DIGEST,
	CONVEX_BACKEND_IMAGE_REPOSITORY,
	CONVEX_BACKEND_IMAGE_TAG,
	CONVEX_BACKEND_MAIN_PORT,
	CONVEX_CLOUD_SPONSORED_TRANSFER_FORM,
	CONVEX_DASHBOARD_PORT,
	CONVEX_HOSTING_FORM_IDS,
	CONVEX_HOSTING_FORMS,
	CONVEX_HTTP_ACTIONS_PORT,
	CONVEX_IMAGE_DIGESTS_VERIFIED_ON,
	CONVEX_LOCAL_ACCOUNTLESS_FORM,
	CONVEX_SELFHOSTED_OCI_FORM,
	convexHostingFormById,
	productionDurableHostingForms,
	selfHostedConfigRefs,
} from "../src/hosting-forms.js";

const DIGEST = /^sha256:[0-9a-f]{64}$/u;

describe("Convex hosting forms are three distinct things", () => {
	it("exposes exactly three ids and resolves each one", () => {
		expect(CONVEX_HOSTING_FORM_IDS).toEqual([
			"convex.local-accountless/v1",
			"convex.selfhosted-oci/v1",
			"convex.cloud-sponsored-transfer/v1",
		]);
		expect(new Set(CONVEX_HOSTING_FORMS.map((f) => f.id)).size).toBe(3);
		expect(new Set(CONVEX_HOSTING_FORMS.map((f) => f.kind)).size).toBe(3);
		for (const id of CONVEX_HOSTING_FORM_IDS) {
			expect(convexHostingFormById(id).id).toBe(id);
		}
	});

	it("deep-freezes every form so nobody mutates the descriptor", () => {
		for (const form of CONVEX_HOSTING_FORMS) {
			expect(Object.isFrozen(form)).toBe(true);
			expect(Object.isFrozen(form.sourceRefs)).toBe(true);
			for (const ref of form.sourceRefs) {
				expect(Object.isFrozen(ref)).toBe(true);
				expect(ref.url).toMatch(/^https:\/\//u);
				expect(ref.checkedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/u);
			}
		}
	});

	it("only the two durable forms may back a production claim", () => {
		expect(productionDurableHostingForms().map((f) => f.id)).toEqual([
			"convex.selfhosted-oci/v1",
			"convex.cloud-sponsored-transfer/v1",
		]);
	});
});

describe("convex.local-accountless/v1", () => {
	const form = CONVEX_LOCAL_ACCOUNTLESS_FORM;

	it("is development-only with an explicit no-production-durability flag", () => {
		expect(form.developmentOnly).toBe(true);
		expect(form.noProductionDurability).toBe(true);
		expect(form.productionDurability).toBe(false);
		expect(form.requiresAccount).toBe(false);
	});

	it("keeps state with the local process", () => {
		expect(form.stateOwner).toBe("local-process");
		expect(form.stateLocations).toContain(".convex/");
		expect(form.lifetime).toMatch(/convex dev/u);
		expect(form.publicIngress).toBe("none");
	});

	it("classifies a tunnel as a Connector, never a claim", () => {
		expect(form.tunnel.classification).toBe("connector");
		expect(form.tunnel.isCapabilityClaim).toBe(false);
		expect(form.tunnel.grantsDurability).toBe(false);
	});

	it("records that the local admin key is irrevocable", () => {
		expect(form.authority.kind).toBe("admin-key");
		expect(form.authority.revocable).toBe(false);
	});
});

describe("convex.selfhosted-oci/v1", () => {
	const form = CONVEX_SELFHOSTED_OCI_FORM;

	it("pins verified image digests for both published architectures", () => {
		expect(form.image.repository).toBe(CONVEX_BACKEND_IMAGE_REPOSITORY);
		expect(form.image.tagIsMutable).toBe(true);
		expect(form.image.indexDigest).toMatch(DIGEST);
		expect(form.image.indexDigest).toBe(CONVEX_BACKEND_IMAGE_INDEX_DIGEST);
		expect(form.image.digestsVerifiedOn).toBe(CONVEX_IMAGE_DIGESTS_VERIFIED_ON);
		expect(CONVEX_IMAGE_DIGESTS_VERIFIED_ON).toMatch(/^\d{4}-\d{2}-\d{2}$/u);

		const platforms = form.image.platformDigests.map((p) => p.platform);
		expect(platforms).toEqual(["linux/amd64", "linux/arm64"]);
		expect(form.architectures).toEqual(platforms);
		for (const entry of form.image.platformDigests) {
			expect(entry.digest).toMatch(DIGEST);
		}
		expect(CONVEX_BACKEND_IMAGE_DIGEST_LINUX_AMD64).not.toBe(
			CONVEX_BACKEND_IMAGE_DIGEST_LINUX_ARM64,
		);
	});

	it("exposes both public HTTP surfaces plus a private dashboard", () => {
		const byName = new Map(form.ports.map((port) => [port.name, port]));
		expect(byName.get("backend")?.port).toBe(3210);
		expect(byName.get("backend")?.surface).toBe("client-api");
		expect(byName.get("backend")?.public).toBe(true);
		expect(byName.get("site-proxy")?.port).toBe(3211);
		expect(byName.get("site-proxy")?.surface).toBe("http-actions");
		expect(byName.get("site-proxy")?.public).toBe(true);
		expect(byName.get("dashboard")?.port).toBe(CONVEX_DASHBOARD_PORT);
		expect(byName.get("dashboard")?.public).toBe(false);
		expect(CONVEX_BACKEND_MAIN_PORT).toBe(3210);
		expect(CONVEX_HTTP_ACTIONS_PORT).toBe(3211);
		expect(CONVEX_BACKEND_MAIN_PORT).not.toBe(CONVEX_HTTP_ACTIONS_PORT);
	});

	it("requires a persistent volume and keeps SQL/object storage optional", () => {
		expect(form.persistentVolume.required).toBe(true);
		expect(form.persistentVolume.containerPath).toBe("/convex/data");
		expect(form.externalSql.required).toBe(false);
		expect([...form.externalSql.categories].sort()).toEqual([
			"mysql",
			"postgres",
		]);
		expect(form.objectStorage.required).toBe(false);
		expect(form.objectStorage.category).toBe("s3-compatible");
		expect([...form.objectStorage.bucketRoles].sort()).toEqual([
			"exports",
			"files",
			"modules",
			"search",
			"snapshot-imports",
		]);
	});

	it("probes readiness and liveness on the documented /version endpoint", () => {
		for (const probe of [form.probes.readiness, form.probes.liveness]) {
			expect(probe.kind).toBe("http-get");
			expect(probe.port).toBe(CONVEX_BACKEND_MAIN_PORT);
			expect(probe.path).toBe("/version");
			expect(probe.intervalSeconds).toBeGreaterThan(0);
			expect(probe.initialDelaySeconds).toBeGreaterThan(0);
		}
	});

	it("names config without ever being able to carry a value", () => {
		const refs = selfHostedConfigRefs();
		const names = refs.map((ref) => ref.name);
		expect(names).toContain("CONVEX_CLOUD_ORIGIN");
		expect(names).toContain("CONVEX_SITE_ORIGIN");
		expect(names).toContain("POSTGRES_URL");
		expect(names).toContain("S3_STORAGE_FILES_BUCKET");
		expect(new Set(names).size).toBe(names.length);

		const secretNames = refs
			.filter((ref) => ref.sensitivity === "secret-ref")
			.map((ref) => ref.name);
		expect(secretNames).toContain("INSTANCE_SECRET");
		expect(secretNames).toContain("AWS_SECRET_ACCESS_KEY");

		for (const ref of refs) {
			expect(Object.keys(ref).sort()).toEqual([
				"name",
				"purpose",
				"required",
				"sensitivity",
			]);
			expect(["non-sensitive", "secret-ref"]).toContain(ref.sensitivity);
		}
	});
});

describe("convex.cloud-sponsored-transfer/v1", () => {
	const form = CONVEX_CLOUD_SPONSORED_TRANSFER_FORM;

	it("is sponsor-backed and explicitly not anonymous", () => {
		expect(form.anonymous).toBe(false);
		expect(form.sponsorBacked).toBe(true);
		expect(form.productionDurability).toBe(true);
		expect(form.prohibited).toContain("presenting this form as anonymous");
	});

	it("requires a destination team and revokes sponsor keys afterwards", () => {
		expect(form.requiresDestinationTeam).toBe(true);
		expect(form.sponsorDeployKeysRevokedAfterTransfer).toBe(true);
		expect(form.transferSteps[0]).toMatch(/destination Convex team/u);
		expect(form.transferSteps.some((s) => /deleted/u.test(s))).toBe(true);
		expect(
			form.transferSteps.some((s) => /no longer authorizes/u.test(s)),
		).toBe(true);
	});

	it("records that admin keys — unlike deploy keys — cannot be revoked", () => {
		const adminKey = form.deployKeyKinds.find((k) => k.kind === "admin key");
		expect(adminKey?.revocable).toBe(false);
		const revocable = form.deployKeyKinds.filter((k) => k.revocable);
		expect(revocable.length).toBe(form.deployKeyKinds.length - 1);
	});
});

describe("ephemeral-anon stays consistent with the hosting forms", () => {
	it("derives the legacy image constant from the pinned repository", () => {
		expect(CONVEX_BACKEND_OCI_IMAGE).toBe(
			`${CONVEX_BACKEND_IMAGE_REPOSITORY}:${CONVEX_BACKEND_IMAGE_TAG}`,
		);
		expect(CONVEX_BACKEND_OCI_IMAGE).toBe(
			"ghcr.io/get-convex/convex-backend:latest",
		);
		expect(CONVEX_API_PORT).toBe(CONVEX_BACKEND_MAIN_PORT);
	});

	it("offers all three forms as alternatives without claiming any is anon+durable", () => {
		expect(
			CONVEX_ANON_ALTERNATIVE_HOSTING_FORMS.map((a) => a.hostingFormId),
		).toEqual([...CONVEX_HOSTING_FORM_IDS]);
		for (const alternative of CONVEX_ANON_ALTERNATIVE_HOSTING_FORMS) {
			expect(alternative.anonymous && alternative.productionDurability).toBe(
				false,
			);
		}
	});
});
