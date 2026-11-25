import { createHash } from "node:crypto";
import { create } from "@bufbuild/protobuf";
import {
	ArtifactKind,
	type CampId,
	CampManagement,
	type FreightId,
	FreightManifestRecordSchema,
	FreightRecordSchema,
	ReconcileStatus,
	SetRecordSchema,
} from "@hobo/cd";
import {
	ReleaseFreightBlockedError,
	formatReleaseFreightBlockedReason,
	validateReasonStructuredDetail,
} from "@hobo/cd/reconcile";
import { describe, expect, it } from "vitest";
import { createCatalogResolverRealizer } from "../src/cd-runtime.js";
import { CATALOG_REALIZER_LABELS as L } from "../src/provider-hosting-catalog.js";
import {
	TARBALL,
	digestOf as npmDigestOf,
} from "../../providers/provider-npm/test/support/world.js";
import { SITE_V1 } from "../../providers/provider-github/test/support/world.js";

const DIGEST = `sha256:${"c".repeat(64)}`;

function digestOf(bytes: Uint8Array): string {
	return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function camp(
	campId: CampId,
	provider: string,
	labels: Record<string, string>,
) {
	return {
		campId,
		yardId: "hobo-release",
		stationId: "local",
		provider,
		regions: [],
		envType: "candidate",
		labels,
		management: CampManagement.MANAGED,
	};
}

function artifactStore(...blobs: Uint8Array[]) {
	const map = new Map(blobs.map((bytes) => [digestOf(bytes), bytes]));
	return {
		get: async (digest: string) => map.get(digest),
	};
}

function freight(
	artifacts: {
		readonly name: string;
		readonly kind: ArtifactKind;
		readonly digest: string;
		readonly coordinate: string;
	}[],
) {
	return create(FreightRecordSchema, {
		freightId: DIGEST,
		manifest: create(FreightManifestRecordSchema, { artifacts }),
	});
}

const set = (campId: CampId) =>
	create(SetRecordSchema, {
		setId: "set-1",
		campId,
		freightId: DIGEST,
	});

const realizeCtx = {} as never;

describe("release Freight structured detail through catalog resolvers", () => {
	it.each([
		{
			family: "oci" as const,
			campId: "hobo-release/oci-candidate" as CampId,
			provider: "@hobo/provider-oci-registry",
			labels: {
				[L.ociRegistry]: "ghcr.io",
				[L.credentialRef]: "github-app://Hobo-Labs/HoBo",
			},
			artifacts: [
				{
					name: "hobo-sdk",
					kind: ArtifactKind.OCI_IMAGE,
					digest: DIGEST,
					coordinate: `ghcr.io/hobo-labs/hobo/hobo-sdk@${DIGEST}`,
				},
			],
			blobs: [] as Uint8Array[],
		},
		{
			family: "pages" as const,
			campId: "hobo-release/pages-candidate" as CampId,
			provider: "@hobo/provider-github",
			labels: {
				[L.githubRepository]: "Hobo-Labs/HoBo",
				[L.githubPagesBranch]: "gh-pages",
				[L.credentialRef]: "github-app://Hobo-Labs/HoBo",
			},
			artifacts: [
				{
					name: "site",
					kind: ArtifactKind.STATIC_ASSETS,
					digest: SITE_V1.digest,
					coordinate: "",
				},
			],
			blobs: SITE_V1.blobs,
		},
		{
			family: "npm" as const,
			campId: "hobo-release/npm-candidate" as CampId,
			provider: "@hobo/provider-npm",
			labels: {
				[L.npmRegistry]: "npmjs",
				[L.npmAuth]: "token",
				[L.credentialRef]: "owner://NPM_TOKEN",
				[L.npmDistTag]: "alpha",
			},
			artifacts: [
				{
					name: "@hobo-fixtures/widget@1.2.3",
					kind: ArtifactKind.PACKAGE,
					digest: npmDigestOf(TARBALL),
					coordinate: "",
				},
			],
			blobs: [TARBALL],
		},
	])(
		"surfaces structured scope-not-allowed for $family",
		async ({ campId, provider, labels, artifacts, blobs }) => {
			const declared = camp(campId, provider, labels);
			const realizer = createCatalogResolverRealizer({
				topology: {
					camps: async () => [declared],
					camp: async () => declared,
				},
				freight: async (id: FreightId) =>
					id === DIGEST ? freight(artifacts) : undefined,
				artifacts: artifactStore(...blobs),
				http: async () => {
					throw new Error("transport must not run");
				},
				credentials: {
					resolve: async (ref, scope) => {
						throw new ReleaseFreightBlockedError(
							"scope-not-allowed",
							ref,
							scope,
						);
					},
				},
				now: () => 0,
			});
			const observed = await realizer.converge(
				{
					campId,
					desired: set(campId),
					resolved: {} as never,
					reconcilerId: "conductor:test" as never,
					fence: 1n as never,
					signal: new AbortController().signal,
				},
				realizeCtx,
			);
			expect(observed.status).toBe(ReconcileStatus.BLOCKED);
			const structured = validateReasonStructuredDetail(
				observed.reasons[0]?.structured,
			);
			expect(structured?.detailKind).toBe("scope-not-allowed");
			expect(structured?.requestedScope).toBe(`cd-realize:${campId}`);
			expect(
				formatReleaseFreightBlockedReason(
					observed.reasons[0]?.code,
					structured,
				),
			).toContain("scope-not-allowed");
			expect(JSON.stringify(observed)).not.toContain("npm_");
		},
	);
});