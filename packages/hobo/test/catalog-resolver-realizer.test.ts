// The catalog resolver realizer (plan 0024): publication Camps declared on
// @hobo/provider-npm, @hobo/provider-oci-registry or @hobo/provider-github
// are realized by that provider's shipped resolver. Offline: no transport is
// reached in these tests; the end-to-end proof with recorded registry and
// GitHub worlds is scripts/test/release-freight-realize.test.ts.
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
import { ResolverError } from "@hobo/core";
import { describe, expect, it } from "vitest";
import {
	catalogPlannerProviders,
	createCatalogResolverRealizer,
} from "../src/cd-runtime.js";
import {
	catalogCampBinding,
	catalogRealizedProvider,
	CATALOG_REALIZER_LABELS as L,
} from "../src/provider-hosting-catalog.js";

const DIGEST = `sha256:${"c".repeat(64)}`;
const noArtifacts = { get: async () => undefined };

function camp(provider: string, labels: Record<string, string>) {
	return {
		campId: "hobo-release/oci-candidate" as CampId,
		yardId: "hobo-release",
		stationId: "local",
		provider,
		regions: [],
		envType: "candidate",
		labels,
		management: CampManagement.MANAGED,
	};
}

const OCI_LABELS = {
	[L.ociRegistry]: "ghcr.io",
	[L.credentialRef]: "env://GITHUB_TOKEN",
};

describe("catalogRealizedProvider", () => {
	it("names npm, oci-registry and github by native id or package name, nothing else", () => {
		expect(catalogRealizedProvider("@hobo/provider-npm")).toBe("npm");
		expect(catalogRealizedProvider("oci-registry")).toBe("oci-registry");
		expect(catalogRealizedProvider("@hobo/provider-github")).toBe("github");
		expect(catalogRealizedProvider("@hobo/provider-vercel")).toBeUndefined();
	});
});

describe("catalogCampBinding", () => {
	it("refuses a Camp missing its credential locator (typed, never defaulted)", () => {
		expect(() =>
			catalogCampBinding(camp("@hobo/provider-oci-registry", {}), {
				artifacts: noArtifacts,
				resolveCredential: async () => ({ token: "x" }),
			}),
		).toThrow(ResolverError);
	});

	it("maps an OCI Freight artifact to its digest and the declared tags only", () => {
		const binding = catalogCampBinding(
			camp("@hobo/provider-oci-registry", OCI_LABELS),
			{ artifacts: noArtifacts, resolveCredential: async () => ({}) },
		);
		const [request] =
			binding?.requests({
				freightId: DIGEST,
				labels: { [L.ociTags]: "v1.2.3" },
				artifacts: [
					{
						name: "hobo-sdk",
						kind: "OCI_IMAGE",
						digest: DIGEST,
						coordinate: `ghcr.io/hobo-labs/hobo/hobo-sdk@${DIGEST}`,
					},
				],
			}) ?? [];
		expect(request?.credentialRef).toBe("env://GITHUB_TOKEN");
		expect(request?.desired).toEqual({
			registry: "ghcr.io",
			repository: "hobo-labs/hobo/hobo-sdk",
			digest: DIGEST,
			tags: ["v1.2.3"],
			copyReferrers: false,
		});
	});

	it("refuses an image recorded on another registry than the Camp's", () => {
		const binding = catalogCampBinding(
			camp("@hobo/provider-oci-registry", OCI_LABELS),
			{ artifacts: noArtifacts, resolveCredential: async () => ({}) },
		);
		expect(() =>
			binding?.requests({
				freightId: DIGEST,
				labels: {},
				artifacts: [
					{
						name: "hobo-sdk",
						kind: "OCI_IMAGE",
						digest: DIGEST,
						coordinate: `docker.io/hobo/hobo-sdk@${DIGEST}`,
					},
				],
			}),
		).toThrow(/not the Camp's registry/);
	});

	it("refuses a provenance-required npm package whose Freight carries no Sigstore bundle", () => {
		const binding = catalogCampBinding(
			camp("@hobo/provider-npm", {
				[L.npmRegistry]: "npmjs",
				[L.npmAuth]: "oidc-trusted-publishing",
				[L.npmProvenance]: "required",
				[L.credentialRef]: "env://NPM_ID_TOKEN",
			}),
			{ artifacts: noArtifacts, resolveCredential: async () => ({}) },
		);
		let error: unknown;
		try {
			binding?.requests({
				freightId: DIGEST,
				labels: { [L.npmDistTag]: "alpha" },
				artifacts: [
					{
						name: "@hobo-labs/core@0.0.1",
						kind: "PACKAGE",
						digest: DIGEST,
						coordinate: "",
					},
				],
			});
		} catch (caught) {
			error = caught;
		}
		expect(error).toBeInstanceOf(ResolverError);
		expect((error as ResolverError).code).toBe("RESOLVER_PRODUCT_UNSUPPORTED");
	});

	it("resolves only the Camp's declared locator", async () => {
		const asked: string[] = [];
		const binding = catalogCampBinding(
			camp("@hobo/provider-github", {
				[L.githubRepository]: "hobo-fixtures/site",
				[L.githubPagesBranch]: "gh-pages",
				[L.credentialRef]: "env://GITHUB_TOKEN",
			}),
			{
				artifacts: noArtifacts,
				resolveCredential: async (ref) => {
					asked.push(ref);
					return { token: "t" };
				},
			},
		);
		const [request] =
			binding?.requests({
				freightId: DIGEST,
				labels: { [L.githubCommitMessage]: "deploy: abc1234" },
				artifacts: [
					{
						name: "site",
						kind: "STATIC_ASSETS",
						digest: DIGEST,
						coordinate: "",
					},
				],
			}) ?? [];
		expect(request?.desired).toMatchObject({
			owner: "hobo-fixtures",
			repo: "site",
			publishMode: "branch",
			branch: "gh-pages",
			commitMessage: "deploy: abc1234",
		});
		expect(asked).toEqual([]);
	});
});

describe("catalogPlannerProviders", () => {
	it("offers each catalogued provider exactly its one product as a port", () => {
		const providers = catalogPlannerProviders([
			camp("@hobo/provider-oci-registry", OCI_LABELS),
			camp("@hobo/provider-vercel", {}),
		]);
		expect(providers.map((p) => p.id)).toEqual(["oci-registry"]);
		const [capability] = providers[0]?.capabilities ?? [];
		expect(capability?.port).toBe("oci-registry.image/v1");
		expect(capability?.satisfies({ port: "compute" } as never)).toEqual({
			kind: "none",
		});
	});
});

describe("createCatalogResolverRealizer", () => {
	const set = create(SetRecordSchema, {
		setId: "set-1",
		campId: "hobo-release/oci-candidate",
		freightId: DIGEST,
	});
	const freight = create(FreightRecordSchema, {
		freightId: DIGEST,
		manifest: create(FreightManifestRecordSchema, {
			artifacts: [
				{
					name: "hobo-sdk",
					kind: ArtifactKind.OCI_IMAGE,
					digest: DIGEST,
					coordinate: `docker.io/hobo/hobo-sdk@${DIGEST}`,
				},
			],
		}),
	});
	const input = {
		campId: "hobo-release/oci-candidate" as CampId,
		desired: set,
		resolved: {} as never,
		reconcilerId: "conductor:test" as never,
		fence: 1n as never,
		signal: new AbortController().signal,
	};

	function realizer(provider = "@hobo/provider-oci-registry") {
		const declared = camp(provider, OCI_LABELS);
		return createCatalogResolverRealizer({
			topology: {
				camps: async () => [declared],
				camp: async () => declared,
			},
			freight: async (id: FreightId) => (id === DIGEST ? freight : undefined),
			artifacts: noArtifacts,
			http: async () => {
				throw new Error("no transport in this test");
			},
			credentials: { resolve: async () => ({ token: "t" }) },
			now: () => 0,
		});
	}

	it("reports a resolver refusal as BLOCKED with its typed code, never converged", async () => {
		const observed = await realizer().converge(input, {} as never);
		expect(observed.status).toBe(ReconcileStatus.BLOCKED);
		expect(observed.reasons[0]?.code).toBe("RESOLVER_PRODUCT_UNSUPPORTED");
	});

	it("refuses a Camp on a provider it does not realize (compose-realizer-missing)", async () => {
		const observed = await realizer("@hobo/provider-vercel").observe(
			input,
			{} as never,
		);
		expect(observed.status).toBe(ReconcileStatus.BLOCKED);
		expect(observed.reasons[0]?.code).toBe("compose-realizer-missing");
	});
});
