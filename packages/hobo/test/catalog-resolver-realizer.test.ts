// The catalog resolver realizer (plan 0024): publication Camps declared on
// @hobo/provider-npm, @hobo/provider-oci-registry or @hobo/provider-github
// are realized by that provider's shipped resolver. Offline: no transport is
// reached in these tests; the end-to-end proof with recorded registry and
// GitHub worlds is scripts/test/release-freight-realize.test.ts.
import { createHash } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
import type { TransportRequest } from "@hobo/core";
import { isLatin1Transport } from "@hobo/provider-oci-registry";
import { describe, expect, it } from "vitest";
import {
	catalogPlannerProviders,
	createCatalogResolverRealizer,
} from "../src/cd-runtime.js";
import {
	catalogCampBinding,
	catalogRealizedProvider,
	gitBlobDedupeTransport,
	CATALOG_REALIZER_LABELS as L,
} from "../src/provider-hosting-catalog.js";

const DIGEST = `sha256:${"c".repeat(64)}`;
// SAFETY: a CampId is a branded topology id; this literal is a declared Camp id.
const CAMP_ID = "hobo-release/oci-candidate" as CampId;
const noArtifacts = { get: async () => undefined };

function camp(provider: string, labels: Record<string, string>) {
	return {
		campId: CAMP_ID,
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
		).toThrow(expect.objectContaining({ code: "catalog-binding-invalid" }));
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

	it("pushes OCI content on a byte transport and mounts from the Freight's mount source on the Camp's registry", () => {
		const binding = catalogCampBinding(
			camp("@hobo/provider-oci-registry", OCI_LABELS),
			{ artifacts: noArtifacts, resolveCredential: async () => ({}) },
		);
		const [request] =
			binding?.requests({
				freightId: DIGEST,
				labels: {
					[L.ociTags]: "v1.2.3",
					[L.ociMountFrom]: "hobo-labs/hobo/hobo-ci-worker",
				},
				artifacts: [
					{
						name: "hobo-cli",
						kind: "OCI_IMAGE",
						digest: DIGEST,
						coordinate: `ghcr.io/hobo-labs/hobo/hobo-cli@${DIGEST}`,
					},
				],
			}) ?? [];
		expect(request?.desired).toMatchObject({
			repository: "hobo-labs/hobo/hobo-cli",
			sourceRegistry: "ghcr.io",
			sourceRepository: "hobo-labs/hobo/hobo-ci-worker",
			copyReferrers: false,
		});
		const host = async () => ({ status: 200, headers: {}, body: "" });
		const transport = binding?.transport?.(host, new Set());
		expect(transport && isLatin1Transport(transport)).toBe(true);
	});

	it("binds an anonymous npm Camp that observes without resolving a credential", async () => {
		const resolved: string[] = [];
		const binding = catalogCampBinding(
			camp("@hobo/provider-npm", {
				[L.npmRegistry]: "npmjs",
				[L.npmAuth]: "anonymous",
				[L.credentialRef]: "none://npm-public-read",
				[L.realizeMode]: "observe",
			}),
			{
				artifacts: noArtifacts,
				resolveCredential: async (ref) => {
					resolved.push(ref);
					return {};
				},
			},
		);
		expect(binding?.mode).toBe("observe");
		const resolver = binding?.registry.get(binding.productId);
		const [request] =
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
			}) ?? [];
		if (!resolver || !request) throw new Error("npm binding has no request");
		await expect(
			resolver.reconcile(request, async () => {
				throw new Error("an anonymous Camp reached the registry");
			}),
		).rejects.toMatchObject({ code: "RESOLVER_CREDENTIAL_MISSING" });
		expect(resolved).toEqual([]);
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
		expect(() =>
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
			}),
		).toThrow(
			expect.objectContaining({ code: "npm-provenance-bundle-missing" }),
		);
	});

	it("names npm OIDC trusted publishing of a scoped package as its own provider limit", () => {
		const binding = catalogCampBinding(
			camp("@hobo/provider-npm", {
				[L.npmRegistry]: "npmjs",
				[L.npmAuth]: "oidc-trusted-publishing",
				[L.credentialRef]: "env://NPM_ID_TOKEN",
			}),
			{ artifacts: noArtifacts, resolveCredential: async () => ({}) },
		);
		expect(() =>
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
			}),
		).toThrow(expect.objectContaining({ code: "npm-oidc-scoped-unsupported" }));
	});

	it("refuses a mislabelled npm Camp or Freight as catalog-binding-invalid, never a provider limit", () => {
		const deps = {
			artifacts: noArtifacts,
			resolveCredential: async () => ({}),
		};
		const npm = {
			[L.npmRegistry]: "npmjs",
			[L.npmAuth]: "oidc-trusted-publishing",
			[L.npmProvenance]: "required",
			[L.credentialRef]: "env://NPM_ID_TOKEN",
		};
		const invalid = expect.objectContaining({
			code: "catalog-binding-invalid",
		});
		const { [L.credentialRef]: _ref, ...noRef } = npm;
		const { [L.npmAuth]: _auth, ...noAuth } = npm;
		for (const labels of [
			noRef,
			noAuth,
			{ ...npm, [L.npmRegistry]: "ftp://registry" },
			{ ...npm, [L.npmAuth]: "password" },
			{ ...npm, [L.realizeMode]: "write" },
		])
			expect(() =>
				catalogCampBinding(camp("@hobo/provider-npm", labels), deps),
			).toThrow(invalid);
		const binding = catalogCampBinding(camp("@hobo/provider-npm", npm), deps);
		expect(() =>
			binding?.requests({
				freightId: DIGEST,
				labels: {},
				artifacts: [
					{
						name: "core-tarball",
						kind: "PACKAGE",
						digest: DIGEST,
						coordinate: "",
					},
				],
			}),
		).toThrow(invalid);
	});

	it("binds converge by default and observe when the Camp declares it", () => {
		const deps = {
			artifacts: noArtifacts,
			resolveCredential: async () => ({}),
		};
		expect(
			catalogCampBinding(camp("@hobo/provider-oci-registry", OCI_LABELS), deps)
				?.mode,
		).toBe("converge");
		expect(
			catalogCampBinding(
				camp("@hobo/provider-oci-registry", {
					...OCI_LABELS,
					[L.realizeMode]: "observe",
				}),
				deps,
			)?.mode,
		).toBe("observe");
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
		// SAFETY: a minimal planner request; satisfies reads only its port.
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
		campId: CAMP_ID,
		desired: set,
		// SAFETY: the catalog realizer never reads the resolved deployment set.
		resolved: {} as never,
		// SAFETY: a branded reconciler id; the realizer only echoes it.
		reconcilerId: "conductor:test" as never,
		// SAFETY: a branded fence token; the realizer only echoes it.
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
		// SAFETY: the catalog realizer never reads the CD context.
		const observed = await realizer().converge(input, {} as never);
		expect(observed.status).toBe(ReconcileStatus.BLOCKED);
		// The recorded image is on docker.io, the Camp binds ghcr.io: a
		// misdeclared target, never a provider limit.
		expect(observed.reasons[0]?.code).toBe("catalog-binding-invalid");
	});

	it("refuses a Camp on a provider it does not realize (compose-realizer-missing)", async () => {
		const observed = await realizer("@hobo/provider-vercel").observe(
			input,
			// SAFETY: the catalog realizer never reads the CD context.
			{} as never,
		);
		expect(observed.status).toBe(ReconcileStatus.BLOCKED);
		expect(observed.reasons[0]?.code).toBe("compose-realizer-missing");
	});
});

describe("gitBlobDedupeTransport", () => {
	const url = "https://api.github.com/repos/hobo-fixtures/site/git/blobs";
	const bytes = Buffer.from("<h1>HoBo</h1>\n");
	// `git hash-object` of the bytes above.
	const sha = createHash("sha1")
		.update(`blob ${bytes.byteLength}\0`)
		.update(bytes)
		.digest("hex");
	const post: TransportRequest = {
		method: "POST",
		url,
		headers: { authorization: "Bearer t" },
		body: JSON.stringify({
			content: bytes.toString("base64"),
			encoding: "base64",
		}),
		timeoutMs: 1000,
		maxResponseBytes: 1024,
	};

	it("looks a blob up before posting it, and never posts one GitHub acknowledged", async () => {
		const sent: string[] = [];
		const held = new Set<string>();
		const inner = async (request: TransportRequest) => {
			sent.push(`${request.method} ${request.url}`);
			if (request.method === "GET")
				return held.has(request.url.slice(url.length + 1))
					? { status: 200, headers: {}, body: JSON.stringify({ sha }) }
					: { status: 404, headers: {}, body: "" };
			held.add(sha);
			return { status: 201, headers: {}, body: JSON.stringify({ sha }) };
		};
		const memory = new Set<string>();
		const first = await gitBlobDedupeTransport(inner, memory)(post);
		expect(first.status).toBe(201);
		expect(sent).toEqual([`GET ${url}/${sha}`, `POST ${url}`]);
		// A later pass (same Camp memory): no request at all.
		const again = await gitBlobDedupeTransport(inner, memory)(post);
		expect(JSON.parse(again.body).sha).toBe(sha);
		expect(sent).toHaveLength(2);
		// A fresh process (empty memory): a read, never a second upload.
		await gitBlobDedupeTransport(inner, new Set())(post);
		expect(sent).toEqual([
			`GET ${url}/${sha}`,
			`POST ${url}`,
			`GET ${url}/${sha}`,
		]);
	});

	it("passes every other request through untouched", async () => {
		const sent: TransportRequest[] = [];
		const inner = async (request: TransportRequest) => {
			sent.push(request);
			return { status: 201, headers: {}, body: "{}" };
		};
		const trees = { ...post, url: url.replace("blobs", "trees") };
		await gitBlobDedupeTransport(inner, new Set())(trees);
		expect(sent).toEqual([trees]);
	});
});

describe("openCdRuntime conductor composition", () => {
	it("refuses a topology that needs both the catalog and a Kubernetes fleet conductor", async () => {
		const { openCdRuntime, CD_KUBE_FLEET_ENV } = await import(
			"../src/cd-runtime.js"
		);
		const home = await mkdtemp(join(tmpdir(), "cd-conductor-"));
		const fleet = join(home, "fleet.json");
		await writeFile(
			fleet,
			JSON.stringify({
				ocm: {
					schemaVersion: "hobo.cd-kube-fleet.ocm/v1",
					hub: {
						schemaVersion: "hobo.cd-kube-fleet.hub/v1",
						name: "hub-a",
						kind: "HUB_KIND_OCM",
						apiBaseUrl: "https://hub.example:6443",
						credentialRef: "secret://kube/hub-a",
						auth: "KUBE_AUTH_BEARER",
					},
					clusters: [{ campId: "prod/eu", cluster: "eu-1" }],
					departureAction: "DEPARTURE_ACTION_ORPHAN_DATA",
				},
			}),
		);
		const opened = await openCdRuntime({
			env: { [CD_KUBE_FLEET_ENV]: fleet },
			home,
			cwd: home,
			topologyFiles: [
				join(
					import.meta.dirname,
					"..",
					"..",
					"..",
					"release",
					"hobo-release.delivery.ts",
				),
			],
		});
		expect(opened.ok).toBe(false);
		if (opened.ok) return;
		expect(opened.reasons[0]?.code).toBe("cd-conductor-conflict");
	});
});
