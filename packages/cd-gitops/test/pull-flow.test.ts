import { create, toJson } from "@bufbuild/protobuf";
import type { CredentialResolver } from "@hobo/cd";
import {
	CampTargetId,
	CdCampRealizer,
	CdDeliveryFlow,
	CdReleaseApi,
	CdVerificationGate,
	DeliveryFlowTarget,
	DeliveryRunId,
	EpochMs,
	FreightAlias,
	FreightDigest,
	NonEmptyReason,
	NonNegativeCount,
	RealizationRef,
	RevisionRef,
	StageId,
	UniqueStageList,
	WarehouseId,
} from "@hobo/cd/domain";
import {
	createCdDeliveryFlowRouterLayer,
	createCdReleaseInMemoryLayer,
} from "@hobo/cd/host";
import type {
	HttpTransport,
	JsonObject,
	JsonValue,
	TransportRequest,
	TransportResponse,
} from "@hobo/core";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import { describe, expect, it } from "vitest";
import {
	GitHost,
	GitopsEngine,
	GitopsPublisherRecordSchema,
} from "../src/_generated/gitops_pb.js";
import { parsePublisherConfig } from "../src/config.js";
import {
	argoVerdict,
	observeArgoApplicationsBySelector,
	triggerArgoSync,
} from "../src/engines/index.js";
import {
	createArgoCdPullFlowAdapter,
	createFluxPullFlowAdapter,
} from "../src/flow-adapter.js";
import {
	createBitbucketClient,
	createGiteaClient,
	createGitHubClient,
	createGitLabClient,
} from "../src/hosts/index.js";
import { isJsonObject, isJsonString } from "../src/json.js";
import {
	applyJsonPathUpdate,
	applyKustomizeImageUpdate,
	applyManifestUpdateStep,
	applyYamlScalarUpdate,
} from "../src/updaters.js";

function jsonResponse(
	status: number,
	body: JsonValue,
	headers?: Readonly<Record<string, string>>,
): TransportResponse {
	return {
		status,
		headers: { "content-type": "application/json", ...headers },
		body: isJsonString(body) ? body : JSON.stringify(body),
	};
}

function parseBodyObject(raw: string | undefined): JsonObject {
	const parsed: JsonValue = JSON.parse(raw ?? "{}");
	return isJsonObject(parsed) ? parsed : {};
}

function readStr(obj: JsonObject, key: string): string {
	const val = obj[key];
	return isJsonString(val) ? val : "";
}

function makeConfig(
	engine: GitopsEngine,
	host: GitHost,
	apiBaseUrl: string,
	engineApiBaseUrl = "https://argocd.example.test",
) {
	return parsePublisherConfig(
		toJson(
			GitopsPublisherRecordSchema,
			create(GitopsPublisherRecordSchema, {
				schemaVersion: "hobo.cd-gitops.publisher/v1",
				name: engine === GitopsEngine.ARGO_CD ? "argo-cd" : "flux",
				engine,
				repository: {
					host,
					apiBaseUrl,
					cloneUrl: "https://git.example.test/acme/gitops.git",
					repository: "acme/gitops",
					branch: "main",
					pathPrefix: "clusters/hobo",
					credentialRef: "owner://GIT_TOKEN",
				},
				endpoint: {
					apiBaseUrl: engineApiBaseUrl,
					credentialRef: "owner://ENGINE_TOKEN",
					namespace: engine === GitopsEngine.ARGO_CD ? "argocd" : "flux-system",
					project: "default",
					destinationServer: "https://kubernetes.default.svc",
					destinationNamespace: "checkout",
					sourceRef: "hobo",
				},
				autoSync: true,
				prune: true,
				interval: "1m",
			}),
		),
	);
}

const staticCredentials: CredentialResolver = {
	resolve: async (_ref, scope) => ({
		token: scope === "cd.gitops.git" ? "git-tok-test" : "engine-tok-test",
	}),
};

describe("Git host pull-request lifecycle across GitHub, GitLab, Gitea, and Bitbucket", () => {
	it("creates branches, opens, inspects, and merges PRs on GitHub", async () => {
		const calls: TransportRequest[] = [];
		const http: HttpTransport = async (req) => {
			calls.push(req);
			if (req.method === "POST" && req.url.endsWith("/git/refs")) {
				return jsonResponse(201, { ref: "refs/heads/hobo/promote/prod/run-1" });
			}
			if (req.method === "POST" && req.url.endsWith("/pulls")) {
				return jsonResponse(201, {
					number: 42,
					html_url: "https://github.com/acme/gitops/pull/42",
					state: "open",
					merged: false,
					head: { ref: "hobo/promote/prod/run-1" },
					base: { ref: "main" },
				});
			}
			if (req.method === "GET" && req.url.endsWith("/pulls/42")) {
				return jsonResponse(200, {
					number: 42,
					html_url: "https://github.com/acme/gitops/pull/42",
					state: "closed",
					merged: true,
					merge_commit_sha: "sha-merged-gh-42",
					head: { ref: "hobo/promote/prod/run-1" },
					base: { ref: "main" },
				});
			}
			if (req.method === "PUT" && req.url.endsWith("/pulls/42/merge")) {
				return jsonResponse(200, { merged: true, sha: "sha-merged-gh-42" });
			}
			return jsonResponse(404, { message: "not found" });
		};

		const cfg = makeConfig(
			GitopsEngine.ARGO_CD,
			GitHost.GITHUB,
			"https://api.github.com",
		);
		const client = createGitHubClient(
			cfg.repository,
			http,
			async () => "gh-tok",
		);
		await client.createBranch({
			name: "hobo/promote/prod/run-1",
			fromSha: "sha-base-1",
		});
		const opened = await client.openPullRequest({
			headBranch: "hobo/promote/prod/run-1",
			title: "Promote v1",
			body: "Body",
		});
		expect(opened).toEqual({
			id: "42",
			url: "https://github.com/acme/gitops/pull/42",
			state: "open",
			headBranch: "hobo/promote/prod/run-1",
			baseBranch: "main",
		});
		const merged = await client.mergePullRequest({
			prId: "42",
			method: "merge",
		});
		expect(merged).toEqual({
			merged: true,
			mergeCommitSha: "sha-merged-gh-42",
		});
		const observed = await client.getPullRequest("42");
		expect(observed.state).toBe("merged");
		expect(observed.mergeCommitSha).toBe("sha-merged-gh-42");
		expect(calls).toHaveLength(4);
	});

	it("supports branch creation and merge requests on GitLab", async () => {
		const http: HttpTransport = async (req) => {
			if (req.method === "POST" && req.url.endsWith("/repository/branches")) {
				return jsonResponse(201, { name: "hobo/promote/prod/run-2" });
			}
			if (req.method === "POST" && req.url.endsWith("/merge_requests")) {
				return jsonResponse(201, {
					iid: 17,
					web_url:
						"https://gitlab.example.test/acme/gitops/-/merge_requests/17",
					state: "opened",
					source_branch: "hobo/promote/prod/run-2",
					target_branch: "main",
				});
			}
			if (req.method === "GET" && req.url.endsWith("/merge_requests/17")) {
				return jsonResponse(200, {
					iid: 17,
					web_url:
						"https://gitlab.example.test/acme/gitops/-/merge_requests/17",
					state: "merged",
					merge_commit_sha: "sha-merged-gl-17",
					source_branch: "hobo/promote/prod/run-2",
					target_branch: "main",
				});
			}
			if (
				req.method === "PUT" &&
				req.url.endsWith("/merge_requests/17/merge")
			) {
				return jsonResponse(200, {
					state: "merged",
					merge_commit_sha: "sha-merged-gl-17",
				});
			}
			return jsonResponse(404, {});
		};
		const cfg = makeConfig(
			GitopsEngine.ARGO_CD,
			GitHost.GITLAB,
			"https://gitlab.example.test/api/v4",
		);
		const client = createGitLabClient(
			cfg.repository,
			http,
			async () => "gl-tok",
		);
		await client.createBranch({
			name: "hobo/promote/prod/run-2",
			fromSha: "sha-base-2",
		});
		const opened = await client.openPullRequest({
			headBranch: "hobo/promote/prod/run-2",
			title: "Promote v2",
			body: "Body",
		});
		expect(opened.id).toBe("17");
		expect(opened.state).toBe("open");
		const merged = await client.mergePullRequest({ prId: "17" });
		expect(merged).toEqual({
			merged: true,
			mergeCommitSha: "sha-merged-gl-17",
		});
		const observed = await client.getPullRequest("17");
		expect(observed.state).toBe("merged");
		expect(observed.mergeCommitSha).toBe("sha-merged-gl-17");
	});

	it("supports branch creation and pull requests on Gitea/Forgejo", async () => {
		const http: HttpTransport = async (req) => {
			if (req.method === "POST" && req.url.endsWith("/branches")) {
				return jsonResponse(201, { name: "hobo/promote/prod/run-3" });
			}
			if (req.method === "POST" && req.url.endsWith("/pulls")) {
				return jsonResponse(201, {
					number: 9,
					html_url: "https://gitea.example.test/acme/gitops/pulls/9",
					state: "open",
					merged: false,
					head: { ref: "hobo/promote/prod/run-3" },
					base: { ref: "main" },
				});
			}
			if (req.method === "POST" && req.url.endsWith("/pulls/9/merge")) {
				return jsonResponse(200, {});
			}
			if (req.method === "GET" && req.url.endsWith("/pulls/9")) {
				return jsonResponse(200, {
					number: 9,
					html_url: "https://gitea.example.test/acme/gitops/pulls/9",
					state: "closed",
					merged: true,
					merged_commit_sha: "sha-merged-gt-9",
					head: { ref: "hobo/promote/prod/run-3" },
					base: { ref: "main" },
				});
			}
			return jsonResponse(404, {});
		};
		const cfg = makeConfig(
			GitopsEngine.ARGO_CD,
			GitHost.GITEA,
			"https://gitea.example.test/api/v1",
		);
		const client = createGiteaClient(
			cfg.repository,
			http,
			async () => "gt-tok",
		);
		await client.createBranch({
			name: "hobo/promote/prod/run-3",
			fromSha: "sha-base-3",
		});
		const opened = await client.openPullRequest({
			headBranch: "hobo/promote/prod/run-3",
			title: "Promote v3",
			body: "Body",
		});
		expect(opened.id).toBe("9");
		const merged = await client.mergePullRequest({ prId: "9" });
		expect(merged).toEqual({
			merged: true,
			mergeCommitSha: "sha-merged-gt-9",
		});
	});

	it("supports branch creation and pull requests on Bitbucket Cloud", async () => {
		const http: HttpTransport = async (req) => {
			if (req.method === "POST" && req.url.endsWith("/refs/branches")) {
				return jsonResponse(201, { name: "hobo/promote/prod/run-4" });
			}
			if (req.method === "POST" && req.url.endsWith("/pullrequests")) {
				return jsonResponse(201, {
					id: 88,
					state: "OPEN",
					links: {
						html: {
							href: "https://bitbucket.org/acme/gitops/pull-requests/88",
						},
					},
					source: { branch: { name: "hobo/promote/prod/run-4" } },
					destination: { branch: { name: "main" } },
				});
			}
			if (req.method === "POST" && req.url.endsWith("/pullrequests/88/merge")) {
				return jsonResponse(200, {
					state: "MERGED",
					merge_commit: { hash: "sha-merged-bb-88" },
				});
			}
			if (req.method === "GET" && req.url.endsWith("/pullrequests/88")) {
				return jsonResponse(200, {
					id: 88,
					state: "DECLINED",
					links: {
						html: {
							href: "https://bitbucket.org/acme/gitops/pull-requests/88",
						},
					},
					source: { branch: { name: "hobo/promote/prod/run-4" } },
					destination: { branch: { name: "main" } },
				});
			}
			return jsonResponse(404, {});
		};
		const cfg = makeConfig(
			GitopsEngine.ARGO_CD,
			GitHost.BITBUCKET,
			"https://api.bitbucket.org/2.0",
		);
		const client = createBitbucketClient(
			cfg.repository,
			http,
			async () => "bb-tok",
		);
		await client.createBranch({
			name: "hobo/promote/prod/run-4",
			fromSha: "sha-base-4",
		});
		const opened = await client.openPullRequest({
			headBranch: "hobo/promote/prod/run-4",
			title: "Promote v4",
			body: "Body",
		});
		expect(opened.id).toBe("88");
		expect(opened.state).toBe("open");
		const merged = await client.mergePullRequest({ prId: "88" });
		expect(merged).toEqual({
			merged: true,
			mergeCommitSha: "sha-merged-bb-88",
		});
		const declined = await client.getPullRequest("88");
		expect(declined.state).toBe("closed");
	});
});

describe("deterministic typed manifest updaters", () => {
	it("updates nested JSON keys deterministically and rejects non-object roots", () => {
		const next = applyJsonPathUpdate(
			'{"b":1,"image":{"tag":"v1"}}\n',
			["image", "tag"],
			"v2",
		);
		expect(next).toBe('{\n  "b": 1,\n  "image": {\n    "tag": "v2"\n  }\n}\n');
		expect(() => applyJsonPathUpdate("[]", ["image"], "v2")).toThrow(
			/root must be a JSON object/,
		);
	});

	it("updates nested YAML scalars in place, inserts missing keys, and blocks newline injection", () => {
		const initial = [
			"replicaCount: 2",
			"image:",
			"  repository: ghcr.io/acme/checkout",
			"  tag: v1.0.0",
			"",
		].join("\n");
		const updated = applyYamlScalarUpdate(initial, ["image", "tag"], "v1.1.0");
		expect(updated).toContain("  tag: v1.1.0\n");
		expect(updated).toContain("  repository: ghcr.io/acme/checkout\n");

		const inserted = applyYamlScalarUpdate(
			updated,
			["rollout", "canary"],
			true,
		);
		expect(inserted).toContain("rollout:\n  canary: true\n");

		expect(() =>
			applyYamlScalarUpdate(initial, ["image", "tag"], "v2\ninjected: true"),
		).toThrow(/must not contain newlines/);
	});

	it("updates existing and missing Kustomize images in YAML and JSON", () => {
		const yamlKustomization = [
			"apiVersion: kustomize.config.k8s.io/v1beta1",
			"kind: Kustomization",
			"images:",
			"  - name: ghcr.io/acme/checkout",
			"    newTag: v1.0.0",
			"",
		].join("\n");
		const updatedYaml = applyKustomizeImageUpdate(yamlKustomization, {
			imageName: "ghcr.io/acme/checkout",
			newTag: "v1.2.0",
			digest: "sha256:abc123",
		});
		expect(updatedYaml).toContain("    newTag: v1.2.0");
		expect(updatedYaml).toContain('    digest: "sha256:abc123"');

		const addedYaml = applyManifestUpdateStep(updatedYaml, {
			kind: "kustomize-image",
			path: "kustomization.yaml",
			imageName: "ghcr.io/acme/worker",
			newTag: "v2.0.0",
		});
		expect(addedYaml).toContain("  - name: ghcr.io/acme/worker");
		expect(addedYaml).toContain("    newTag: v2.0.0");

		const jsonUpdated = applyKustomizeImageUpdate(
			'{"kind":"Kustomization","images":[{"name":"ghcr.io/acme/api","newTag":"v1"}]}',
			{ imageName: "ghcr.io/acme/api", newTag: "v3" },
		);
		expect(JSON.parse(jsonUpdated)).toEqual({
			images: [{ name: "ghcr.io/acme/api", newTag: "v3" }],
			kind: "Kustomization",
		});
	});
});

describe("Argo CD OutOfSync diff, label selector multi-app observation, and sync trigger", () => {
	it("extracts outOfSyncCount and outOfSyncResources in argoVerdict", () => {
		const verdict = argoVerdict(
			{
				status: {
					sync: { status: "OutOfSync", revision: "sha-old" },
					health: { status: "Progressing" },
					resources: [
						{
							kind: "Deployment",
							namespace: "prod",
							name: "checkout",
							status: "OutOfSync",
						},
						{
							kind: "Service",
							namespace: "prod",
							name: "checkout",
							status: "Synced",
						},
					],
				},
			},
			"sha-new",
		);
		expect(verdict.state).toBe("converging");
		expect(verdict.outOfSyncCount).toBe(1);
		expect(verdict.outOfSyncResources).toEqual(["Deployment/prod/checkout"]);
		expect(verdict.reason?.message).toContain("Deployment/prod/checkout");
	});

	it("observes multiple Argo CD applications by label selector, triggers sync, and fails closed on empty match or degraded app", async () => {
		const cfg = makeConfig(
			GitopsEngine.ARGO_CD,
			GitHost.GITHUB,
			"https://api.github.com",
		);
		const syncedApps: string[] = [];
		let mode: "empty" | "converging" | "converged" | "degraded" = "empty";

		const http: HttpTransport = async (req) => {
			if (req.method === "POST" && req.url.endsWith("/sync")) {
				const match = req.url.match(/\/applications\/([^/]+)\/sync$/u);
				if (match?.[1] !== undefined) syncedApps.push(match[1]);
				return jsonResponse(200, { status: "ok" });
			}
			if (req.method === "GET" && req.url.includes("selector=")) {
				if (mode === "empty") return jsonResponse(200, { items: [] });
				if (mode === "converging") {
					return jsonResponse(200, {
						items: [
							{
								metadata: { name: "checkout-us", namespace: "argocd" },
								status: {
									sync: { status: "Synced", revision: "sha-rev-9" },
									health: { status: "Healthy" },
									resources: [
										{
											kind: "Deployment",
											namespace: "prod",
											name: "checkout-us",
											status: "Synced",
										},
									],
								},
							},
							{
								metadata: { name: "checkout-eu", namespace: "argocd" },
								status: {
									sync: { status: "OutOfSync", revision: "sha-rev-8" },
									health: { status: "Progressing" },
									resources: [
										{
											kind: "Deployment",
											namespace: "prod",
											name: "checkout-eu",
											status: "OutOfSync",
										},
									],
								},
							},
						],
					});
				}
				if (mode === "degraded") {
					return jsonResponse(200, {
						items: [
							{
								metadata: { name: "checkout-us", namespace: "argocd" },
								status: {
									sync: { status: "Synced", revision: "sha-rev-9" },
									health: { status: "Degraded" },
								},
							},
						],
					});
				}
				return jsonResponse(200, {
					items: [
						{
							metadata: { name: "checkout-us", namespace: "argocd" },
							status: {
								sync: { status: "Synced", revision: "sha-rev-9" },
								health: { status: "Healthy" },
								resources: [
									{
										kind: "Deployment",
										namespace: "prod",
										name: "checkout-us",
										status: "Synced",
									},
								],
							},
						},
						{
							metadata: { name: "checkout-eu", namespace: "argocd" },
							status: {
								sync: { status: "Synced", revision: "sha-rev-9" },
								health: { status: "Healthy" },
								resources: [
									{
										kind: "Deployment",
										namespace: "prod",
										name: "checkout-eu",
										status: "Synced",
									},
								],
							},
						},
					],
				});
			}
			return jsonResponse(404, {});
		};

		const empty = await observeArgoApplicationsBySelector(
			cfg,
			"app.kubernetes.io/part-of=checkout,env=prod",
			"sha-rev-9",
			http,
			async () => "argo-tok",
		);
		expect(empty.state).toBe("converging");
		expect(empty.reason?.code).toBe("gitops-engine-not-found");

		mode = "converging";
		const converging = await observeArgoApplicationsBySelector(
			cfg,
			"app.kubernetes.io/part-of=checkout,env=prod",
			"sha-rev-9",
			http,
			async () => "argo-tok",
			{ triggerSync: true },
		);
		expect(syncedApps).toEqual(["checkout-eu"]);
		expect(converging.state).toBe("converging");
		expect(converging.outOfSyncCount).toBe(1);
		expect(converging.outOfSyncResources).toEqual([
			"checkout-eu:Deployment/prod/checkout-eu",
		]);

		mode = "converged";
		const converged = await observeArgoApplicationsBySelector(
			cfg,
			"app.kubernetes.io/part-of=checkout,env=prod",
			"sha-rev-9",
			http,
			async () => "argo-tok",
		);
		expect(converged.state).toBe("converged");
		expect(converged.healthy).toBe(true);
		expect(converged.outOfSyncCount).toBe(0);

		mode = "degraded";
		const degraded = await observeArgoApplicationsBySelector(
			cfg,
			"app.kubernetes.io/part-of=checkout,env=prod",
			"sha-rev-9",
			http,
			async () => "argo-tok",
		);
		expect(degraded.state).toBe("blocked");

		const fluxCfg = makeConfig(
			GitopsEngine.FLUX,
			GitHost.GITHUB,
			"https://api.github.com",
			"https://k8s.example.test",
		);
		await expect(
			triggerArgoSync(fluxCfg, "app", "sha-1", http, async () => "tok"),
		).rejects.toThrow(/requires an Argo CD publisher config/);
	});
});

interface SimulatedGitState {
	branches: Map<string, string>;
	commits: Map<string, Map<string, string>>;
	prs: Map<
		string,
		{
			id: string;
			url: string;
			state: "open" | "merged" | "closed";
			headBranch: string;
			baseBranch: string;
			mergeCommitSha?: string;
		}
	>;
	nextCommit: number;
	nextPr: number;
	syncedApps: string[];
	argoByApp: Map<
		string,
		{
			syncStatus: string;
			healthStatus: string;
			revision: string;
		}
	>;
}

interface SimulatedGitAndArgoHarness {
	readonly state: SimulatedGitState;
	readonly http: HttpTransport;
	readonly mergePr: (prId: string) => string;
	readonly closePr: (prId: string) => void;
}

function createSimulatedGitAndArgoHarness(): SimulatedGitAndArgoHarness {
	const initialFiles = new Map<string, string>([
		[
			"env/dev/kustomization.yaml",
			"apiVersion: kustomize.config.k8s.io/v1beta1\nkind: Kustomization\nimages:\n  - name: ghcr.io/acme/checkout\n    newTag: v0.9.0\n",
		],
		[
			"env/prod/kustomization.yaml",
			"apiVersion: kustomize.config.k8s.io/v1beta1\nkind: Kustomization\nimages:\n  - name: ghcr.io/acme/checkout\n    newTag: v0.9.0\n",
		],
	]);
	const state: SimulatedGitState = {
		branches: new Map([["main", "sha-init-0"]]),
		commits: new Map([["sha-init-0", initialFiles]]),
		prs: new Map(),
		nextCommit: 1,
		nextPr: 1,
		syncedApps: [],
		argoByApp: new Map([
			[
				"hobo-camp-dev",
				{
					syncStatus: "Synced",
					healthStatus: "Healthy",
					revision: "sha-init-0",
				},
			],
			[
				"checkout-prod-us",
				{
					syncStatus: "Synced",
					healthStatus: "Healthy",
					revision: "sha-init-0",
				},
			],
		]),
	};

	const pendingTrees = new Map<string, Map<string, string>>();
	const pendingCommits = new Map<string, Map<string, string>>();

	const http: HttpTransport = async (req) => {
		const url = new URL(req.url);
		if (url.hostname === "api.github.com") {
			const headMatch = url.pathname.match(
				/^\/repos\/acme\/gitops\/git\/ref\/heads\/(.+)$/u,
			);
			if (req.method === "GET" && headMatch?.[1] !== undefined) {
				const branch = decodeURIComponent(headMatch[1]);
				const sha = state.branches.get(branch);
				if (sha === undefined) return jsonResponse(404, {});
				return jsonResponse(200, { object: { sha } });
			}
			const contentsMatch = url.pathname.match(
				/^\/repos\/acme\/gitops\/contents\/(.+)$/u,
			);
			if (req.method === "GET" && contentsMatch?.[1] !== undefined) {
				const path = decodeURIComponent(contentsMatch[1]);
				const ref = url.searchParams.get("ref") ?? "main";
				const tree = state.commits.get(ref);
				const content = tree?.get(path);
				if (content === undefined) return jsonResponse(404, {});
				return jsonResponse(200, {
					encoding: "base64",
					content: Buffer.from(content, "utf8").toString("base64"),
					sha: `blob-${path}`,
				});
			}
			const getCommitMatch = url.pathname.match(
				/^\/repos\/acme\/gitops\/git\/commits\/([^/]+)$/u,
			);
			if (req.method === "GET" && getCommitMatch?.[1] !== undefined) {
				const sha = getCommitMatch[1];
				return jsonResponse(200, { tree: { sha: `tree-${sha}` } });
			}
			if (
				req.method === "POST" &&
				url.pathname === "/repos/acme/gitops/git/trees"
			) {
				const parsed = parseBodyObject(req.body);
				const baseSha = readStr(parsed, "base_tree").replace(/^tree-/u, "");
				const nextTree = new Map(state.commits.get(baseSha) ?? []);
				const entries = parsed.tree;
				if (Array.isArray(entries)) {
					for (const item of entries) {
						if (!isJsonObject(item)) continue;
						nextTree.set(readStr(item, "path"), readStr(item, "content"));
					}
				}
				const treeSha = `tree-new-${state.nextCommit}`;
				pendingTrees.set(treeSha, nextTree);
				return jsonResponse(201, { sha: treeSha });
			}
			if (
				req.method === "POST" &&
				url.pathname === "/repos/acme/gitops/git/commits"
			) {
				const parsed = parseBodyObject(req.body);
				const commitSha = `sha-commit-${state.nextCommit++}`;
				const tree = pendingTrees.get(readStr(parsed, "tree")) ?? new Map();
				pendingCommits.set(commitSha, tree);
				state.commits.set(commitSha, tree);
				return jsonResponse(201, { sha: commitSha });
			}
			if (
				req.method === "POST" &&
				url.pathname === "/repos/acme/gitops/git/refs"
			) {
				const parsed = parseBodyObject(req.body);
				const ref = readStr(parsed, "ref");
				const sha = readStr(parsed, "sha");
				const branch = ref.replace(/^refs\/heads\//u, "");
				state.branches.set(branch, sha);
				return jsonResponse(201, { ref });
			}
			const patchRefMatch = url.pathname.match(
				/^\/repos\/acme\/gitops\/git\/refs\/heads\/(.+)$/u,
			);
			if (req.method === "PATCH" && patchRefMatch?.[1] !== undefined) {
				const branch = decodeURIComponent(patchRefMatch[1]);
				const parsed = parseBodyObject(req.body);
				const sha = readStr(parsed, "sha");
				state.branches.set(branch, sha);
				const files = pendingCommits.get(sha);
				if (files !== undefined) {
					state.commits.set(sha, files);
				}
				return jsonResponse(200, { object: { sha } });
			}
			if (
				req.method === "POST" &&
				url.pathname === "/repos/acme/gitops/pulls"
			) {
				const parsed = parseBodyObject(req.body);
				const id = String(state.nextPr++);
				const record = {
					id,
					url: `https://github.com/acme/gitops/pull/${id}`,
					state: "open" as const,
					headBranch: readStr(parsed, "head"),
					baseBranch: readStr(parsed, "base"),
				};
				state.prs.set(id, record);
				return jsonResponse(201, {
					number: Number(id),
					html_url: record.url,
					state: "open",
					merged: false,
					head: { ref: record.headBranch },
					base: { ref: record.baseBranch },
				});
			}
			const prMatch = url.pathname.match(
				/^\/repos\/acme\/gitops\/pulls\/(\d+)$/u,
			);
			if (req.method === "GET" && prMatch?.[1] !== undefined) {
				const pr = state.prs.get(prMatch[1]);
				if (pr === undefined) return jsonResponse(404, {});
				const basePayload = {
					number: Number(pr.id),
					html_url: pr.url,
					state: pr.state === "open" ? "open" : "closed",
					merged: pr.state === "merged",
					head: { ref: pr.headBranch },
					base: { ref: pr.baseBranch },
				};
				return jsonResponse(
					200,
					pr.mergeCommitSha !== undefined
						? { ...basePayload, merge_commit_sha: pr.mergeCommitSha }
						: basePayload,
				);
			}
		}

		if (url.hostname === "argocd.example.test") {
			const syncMatch = url.pathname.match(
				/^\/api\/v1\/applications\/([^/]+)\/sync$/u,
			);
			if (req.method === "POST" && syncMatch?.[1] !== undefined) {
				const appName = decodeURIComponent(syncMatch[1]);
				const parsed = parseBodyObject(req.body);
				const revision = readStr(parsed, "revision");
				state.syncedApps.push(appName);
				const current = state.argoByApp.get(appName);
				if (current !== undefined && revision !== "") {
					state.argoByApp.set(appName, {
						...current,
						revision,
					});
				}
				return jsonResponse(200, { status: "synced" });
			}
			const appMatch = url.pathname.match(
				/^\/api\/v1\/applications\/([^/]+)$/u,
			);
			if (req.method === "GET" && appMatch?.[1] !== undefined) {
				const appName = decodeURIComponent(appMatch[1]);
				const app = state.argoByApp.get(appName);
				if (app === undefined) return jsonResponse(404, {});
				return jsonResponse(200, {
					metadata: { name: appName, namespace: "argocd" },
					status: {
						sync: { status: app.syncStatus, revision: app.revision },
						health: { status: app.healthStatus },
						resources: [
							{
								kind: "Deployment",
								namespace: "checkout",
								name: appName,
								status: app.syncStatus,
							},
						],
					},
				});
			}
			if (req.method === "GET" && url.pathname === "/api/v1/applications") {
				const app = state.argoByApp.get("checkout-prod-us");
				if (app === undefined) return jsonResponse(200, { items: [] });
				return jsonResponse(200, {
					items: [
						{
							metadata: { name: "checkout-prod-us", namespace: "argocd" },
							status: {
								sync: { status: app.syncStatus, revision: app.revision },
								health: { status: app.healthStatus },
								resources: [
									{
										kind: "Deployment",
										namespace: "checkout",
										name: "checkout-prod-us",
										status: app.syncStatus,
									},
								],
							},
						},
					],
				});
			}
		}

		return jsonResponse(404, { url: req.url });
	};

	const mergePr = (prId: string): string => {
		const pr = state.prs.get(prId);
		if (pr === undefined) throw new Error(`missing PR ${prId}`);
		const headSha = state.branches.get(pr.headBranch);
		if (headSha === undefined) throw new Error(`missing head ${pr.headBranch}`);
		const mergeSha = `sha-merge-${state.nextCommit++}`;
		state.commits.set(mergeSha, new Map(state.commits.get(headSha) ?? []));
		state.branches.set(pr.baseBranch, mergeSha);
		state.prs.set(prId, { ...pr, state: "merged", mergeCommitSha: mergeSha });
		return mergeSha;
	};

	const closePr = (prId: string): void => {
		const pr = state.prs.get(prId);
		if (pr === undefined) throw new Error(`missing PR ${prId}`);
		state.prs.set(prId, { ...pr, state: "closed" });
	};

	return { state, http, mergePr, closePr };
}

const dummyRealizerLayer = CdCampRealizer.toLayer(
	Effect.succeed({
		realize: () =>
			Effect.succeed({
				realizationRef: RealizationRef.make("unused"),
			}),
		rollback: () => Effect.succeed({ rolledBack: true }),
	}),
);

const passingGateLayer = CdVerificationGate.toLayer(
	Effect.succeed({
		evaluate: () =>
			Effect.succeed({
				passed: true,
				summary: NonEmptyReason.make("canary SLO checks passed"),
			}),
	}),
);

const sleep = (ms: number) =>
	Effect.promise(() => new Promise((resolve) => setTimeout(resolve, ms)));

describe("end-to-end Kargo + Argo CD pull-based CD flows with CdRelease and pluggable flow router", () => {
	it("drives full PR lifecycle, Argo selector convergence, and rollback PR directly through createArgoCdPullFlowAdapter", async () => {
		const harness = createSimulatedGitAndArgoHarness();
		const argoConfig = makeConfig(
			GitopsEngine.ARGO_CD,
			GitHost.GITHUB,
			"https://api.github.com",
		);
		const argoAdapter = createArgoCdPullFlowAdapter({
			config: argoConfig,
			http: harness.http,
			credentials: staticCredentials,
			resolvePlan: (ctx) => ({
				updates: [
					{
						kind: "kustomize-image",
						path: "env/prod/kustomization.yaml",
						imageName: "ghcr.io/acme/checkout",
						newTag: "v2.4.0",
						digest: ctx.freightDigest,
					},
				],
			}),
			resolveEngineTarget: () => ({
				kind: "selector",
				selector: "app.kubernetes.io/part-of=checkout,env=prod",
				namespace: "argocd",
			}),
		});

		const runId = DeliveryRunId.make("run-pr-direct-1");
		const stageId = StageId.make("prod");
		const campId = CampTargetId.make("camp-prod");
		const digest = FreightDigest.make("sha256:freight-checkout-v240");
		const flowTarget = DeliveryFlowTarget.make("argo-cd");

		const published = await Effect.runPromise(
			argoAdapter.publishRevision({
				deliveryRunId: runId,
				stageId,
				campId,
				freightDigest: digest,
				flowKind: "gitops-pr-pull",
				flowTarget,
				previousRevision: RevisionRef.make("sha-init-0"),
			}),
		);
		expect(published.outcome._tag).toBe("PullRequestOpened");
		if (published.outcome._tag !== "PullRequestOpened") return;
		expect(published.outcome.prId).toBe("1");
		expect(published.outcome.prUrl).toBe(
			"https://github.com/acme/gitops/pull/1",
		);

		const stillOpen = await Effect.runPromise(
			argoAdapter.observePullRequest({
				deliveryRunId: runId,
				flowKind: "gitops-pr-pull",
				flowTarget,
				prId: published.outcome.prId,
				targetRef: published.outcome.targetRef,
			}),
		);
		expect(stillOpen.observation._tag).toBe("Open");

		const mergeSha = harness.mergePr("1");
		const merged = await Effect.runPromise(
			argoAdapter.observePullRequest({
				deliveryRunId: runId,
				flowKind: "gitops-pr-pull",
				flowTarget,
				prId: published.outcome.prId,
				targetRef: published.outcome.targetRef,
			}),
		);
		expect(merged.observation._tag).toBe("Merged");
		if (merged.observation._tag !== "Merged") return;
		expect(merged.observation.mergeRevision).toBe(mergeSha);

		harness.state.argoByApp.set("checkout-prod-us", {
			syncStatus: "OutOfSync",
			healthStatus: "Progressing",
			revision: "sha-init-0",
		});
		const converging = await Effect.runPromise(
			argoAdapter.observeConvergence({
				deliveryRunId: runId,
				stageId,
				campId,
				flowKind: "gitops-pr-pull",
				flowTarget,
				targetRevision: merged.observation.mergeRevision,
				triggerSync: false,
			}),
		);
		expect(converging.observation._tag).toBe("Converging");
		if (converging.observation._tag === "Converging") {
			expect(converging.observation.outOfSyncCount).toBe(1);
		}

		harness.state.argoByApp.set("checkout-prod-us", {
			syncStatus: "Synced",
			healthStatus: "Healthy",
			revision: "sha-init-0",
		});
		const converged = await Effect.runPromise(
			argoAdapter.observeConvergence({
				deliveryRunId: runId,
				stageId,
				campId,
				flowKind: "gitops-pr-pull",
				flowTarget,
				targetRevision: merged.observation.mergeRevision,
				triggerSync: true,
			}),
		);
		expect(converged.observation._tag).toBe("Converged");
		expect(harness.state.syncedApps).toContain("checkout-prod-us");

		const rolledBack = await Effect.runPromise(
			argoAdapter.rollbackRevision({
				deliveryRunId: runId,
				stageId,
				campId,
				flowKind: "gitops-pr-pull",
				flowTarget,
				targetRevision: merged.observation.mergeRevision,
				previousRevision: RevisionRef.make("sha-init-0"),
				reason: NonEmptyReason.make("post-release canary error budget burn"),
			}),
		);
		expect(rolledBack.rolledBack).toBe(true);
		expect(rolledBack.summary).toContain("Opened rollback PR 2");
		const rollbackFiles = rolledBack.rollbackRevision
			? harness.state.commits.get(rolledBack.rollbackRevision)
			: undefined;
		expect(rollbackFiles?.get("env/prod/kustomization.yaml")).toContain(
			"newTag: v0.9.0",
		);
	});

	it("promotes Freight through CdRelease: dev (direct Argo pull + kustomize updater) -> soak gate -> prod (PR-based Argo selector pull + verify + qualify)", async () => {
		const harness = createSimulatedGitAndArgoHarness();
		const argoConfig = makeConfig(
			GitopsEngine.ARGO_CD,
			GitHost.GITHUB,
			"https://api.github.com",
		);
		const argoAdapter = createArgoCdPullFlowAdapter({
			config: argoConfig,
			http: harness.http,
			credentials: staticCredentials,
			resolvePlan: (ctx) => ({
				updates: [
					{
						kind: "kustomize-image",
						path:
							ctx.stageId === "dev"
								? "env/dev/kustomization.yaml"
								: "env/prod/kustomization.yaml",
						imageName: "ghcr.io/acme/checkout",
						newTag: "v2.4.0",
						digest: ctx.freightDigest,
					},
				],
			}),
			resolveEngineTarget: ({ stageId }) =>
				stageId === "prod"
					? {
							kind: "selector",
							selector: "app.kubernetes.io/part-of=checkout,env=prod",
							namespace: "argocd",
						}
					: {
							kind: "application",
							name: "hobo-camp-dev",
							namespace: "argocd",
						},
		});

		const autoMergeOnObserve = {
			...argoAdapter,
			observePullRequest: (
				input: Parameters<typeof argoAdapter.observePullRequest>[0],
			) =>
				Effect.suspend(() => {
					const pr = harness.state.prs.get(input.prId);
					if (pr?.state === "open") {
						harness.mergePr(input.prId);
					}
					return argoAdapter.observePullRequest(input);
				}),
		};

		const World = createCdReleaseInMemoryLayer(
			dummyRealizerLayer,
			passingGateLayer,
			createCdDeliveryFlowRouterLayer({ "argo-cd": autoMergeOnObserve }),
		);

		const warehouseId = WarehouseId.make("wh-checkout");
		const digest = FreightDigest.make("sha256:freight-checkout-v240");
		const devStage = StageId.make("dev");
		const prodStage = StageId.make("prod");
		const devRun = DeliveryRunId.make("run-dev-1");
		const prodRun = DeliveryRunId.make("run-prod-1");
		const flowTarget = DeliveryFlowTarget.make("argo-cd");
		const t0 = EpochMs.make(1_700_000_000_000);
		const soakMs = NonNegativeCount.make(60_000);

		const result = await Effect.runPromise(
			Effect.gen(function* () {
				const client = yield* CdReleaseApi.clientInProcess;
				yield* client.RecordFreight(digest, {
					warehouseId,
					alias: FreightAlias.make("amber-hawk"),
					artifacts: [
						{
							kind: "oci-image",
							repository: "ghcr.io/acme/checkout",
							reference: "v2.4.0",
							digest,
						},
					],
					recordedAtMs: t0,
				});
				yield* client.SetFreightAlias(digest, {
					alias: FreightAlias.make("release-2-4-0"),
				});
				yield* client.ConfigureCdStage(devStage, {
					config: {
						warehouseId,
						upstreamStages: UniqueStageList.make([]),
						availabilityStrategy: "direct",
						quorumCount: null,
						requiredSoakMs: NonNegativeCount.make(0),
						autoPromotion: "newest",
						deliveryFlow: "gitops-pull",
						flowTarget,
						campId: CampTargetId.make("camp-dev"),
						requiresApproval: false,
						implicitHealthVerification: true,
						triggerPullSync: true,
					},
				});
				yield* client.ConfigureCdStage(prodStage, {
					config: {
						warehouseId: null,
						upstreamStages: UniqueStageList.make([devStage]),
						availabilityStrategy: "all",
						quorumCount: null,
						requiredSoakMs: soakMs,
						autoPromotion: "manual",
						deliveryFlow: "gitops-pr-pull",
						flowTarget,
						campId: CampTargetId.make("camp-prod"),
						requiresApproval: false,
						implicitHealthVerification: false,
						triggerPullSync: true,
					},
				});

				yield* client.RequestStagePromotion(devStage, {
					deliveryRunId: devRun,
					freightDigest: digest,
					nowMs: t0,
					upstreamQualifications: [],
					manualApprovalExpiresAtMs: null,
				});
				yield* sleep(120);

				const devRunView = yield* client.CdDeliveryRunStatusView.get(devRun);
				const freightAfterDev = yield* client.CdFreightCatalogView.get(digest);

				const earlyExit = yield* Effect.exit(
					client.RequestStagePromotion(prodStage, {
						deliveryRunId: DeliveryRunId.make("run-prod-early"),
						freightDigest: digest,
						nowMs: EpochMs.make(t0 + 30_000),
						upstreamQualifications: [{ stageId: devStage, qualifiedAtMs: t0 }],
						manualApprovalExpiresAtMs: null,
					}),
				);

				yield* client.RequestStagePromotion(prodStage, {
					deliveryRunId: prodRun,
					freightDigest: digest,
					nowMs: EpochMs.make(t0 + 60_000),
					upstreamQualifications: [{ stageId: devStage, qualifiedAtMs: t0 }],
					manualApprovalExpiresAtMs: null,
				});
				yield* sleep(150);

				const prodRunView = yield* client.CdDeliveryRunStatusView.get(prodRun);
				const prodStageView = yield* client.CdStageStatusView.get(prodStage);
				const freightAfterProd = yield* client.CdFreightCatalogView.get(digest);

				return {
					devRunView,
					freightAfterDev,
					earlyExit,
					prodRunView,
					prodStageView,
					freightAfterProd,
				};
			}).pipe(Effect.scoped, Effect.provide(World)),
		);

		expect(result.devRunView?._tag).toBe("Completed");
		expect(Exit.isFailure(result.earlyExit)).toBe(true);
		expect(result.prodRunView?._tag).toBe("Completed");
		expect(result.prodStageView?._tag).toBe("Idle");
		if (result.prodStageView?._tag === "Idle") {
			expect(result.prodStageView.currentFreightDigest).toBe(digest);
			expect(result.prodStageView.currentVerified).toBe(true);
		}
		expect(result.freightAfterProd?._tag).toBe("Active");
		if (result.freightAfterProd?._tag === "Active") {
			expect(result.freightAfterProd.alias).toBe("release-2-4-0");
			const qualifiedStages = result.freightAfterProd.qualifications
				.map((q) => q.stageId)
				.sort();
			expect(qualifiedStages).toEqual(["dev", "prod"]);
		}
		expect(harness.state.syncedApps).toContain("hobo-camp-dev");
		expect(harness.state.syncedApps).toContain("checkout-prod-us");
	});

	it("fails closed on closed PR and rolls back via Git commit when Argo CD reports Degraded", async () => {
		const harness = createSimulatedGitAndArgoHarness();
		const argoConfig = makeConfig(
			GitopsEngine.ARGO_CD,
			GitHost.GITHUB,
			"https://api.github.com",
		);
		const baseAdapter = createArgoCdPullFlowAdapter({
			config: argoConfig,
			http: harness.http,
			credentials: staticCredentials,
			resolvePlan: (ctx) => ({
				files: [
					{
						path: "env/prod/release.json",
						content: `{"run":"${ctx.deliveryRunId}","freight":"${ctx.freightDigest}"}\n`,
					},
				],
			}),
			resolveEngineTarget: () => ({
				kind: "application",
				name: "checkout-prod-us",
				namespace: "argocd",
			}),
		});

		const closingPrAdapter = {
			...baseAdapter,
			observePullRequest: (
				input: Parameters<typeof baseAdapter.observePullRequest>[0],
			) =>
				Effect.suspend(() => {
					const pr = harness.state.prs.get(input.prId);
					if (pr?.state === "open") {
						harness.closePr(input.prId);
					}
					return baseAdapter.observePullRequest(input);
				}),
		};

		const World = createCdReleaseInMemoryLayer(
			dummyRealizerLayer,
			passingGateLayer,
			createCdDeliveryFlowRouterLayer({
				"argo-cd-pr": closingPrAdapter,
				"argo-cd-direct": baseAdapter,
			}),
		);

		const warehouseId = WarehouseId.make("wh-checkout");
		const goodDigest = FreightDigest.make("sha256:freight-good-1");
		const badDigest = FreightDigest.make("sha256:freight-bad-2");
		const prStage = StageId.make("prod-pr");
		const directStage = StageId.make("prod-direct");
		const closedRun = DeliveryRunId.make("run-closed-pr");
		const goodRun = DeliveryRunId.make("run-good-base");
		const degradedRun = DeliveryRunId.make("run-degraded-rollback");
		const t0 = EpochMs.make(1_700_000_000_000);

		const outcome = await Effect.runPromise(
			Effect.gen(function* () {
				const client = yield* CdReleaseApi.clientInProcess;
				yield* client.RecordFreight(goodDigest, {
					warehouseId,
					alias: FreightAlias.make("good-1"),
					artifacts: [
						{
							kind: "oci-image",
							repository: "ghcr.io/acme/checkout",
							reference: "1.0.0",
							digest: goodDigest,
						},
					],
					recordedAtMs: t0,
				});
				yield* client.RecordFreight(badDigest, {
					warehouseId,
					alias: FreightAlias.make("bad-2"),
					artifacts: [
						{
							kind: "oci-image",
							repository: "ghcr.io/acme/checkout",
							reference: "2.0.0-bad",
							digest: badDigest,
						},
					],
					recordedAtMs: EpochMs.make(t0 + 10),
				});

				yield* client.ConfigureCdStage(prStage, {
					config: {
						warehouseId,
						upstreamStages: UniqueStageList.make([]),
						availabilityStrategy: "direct",
						quorumCount: null,
						requiredSoakMs: NonNegativeCount.make(0),
						autoPromotion: "manual",
						deliveryFlow: "gitops-pr-pull",
						flowTarget: DeliveryFlowTarget.make("argo-cd-pr"),
						campId: CampTargetId.make("camp-prod-pr"),
						requiresApproval: false,
						implicitHealthVerification: true,
						triggerPullSync: false,
					},
				});
				yield* client.RequestStagePromotion(prStage, {
					deliveryRunId: closedRun,
					freightDigest: badDigest,
					nowMs: t0,
					upstreamQualifications: [],
					manualApprovalExpiresAtMs: null,
				});
				yield* sleep(120);
				const closedView = yield* client.CdDeliveryRunStatusView.get(closedRun);
				const badFreightView =
					yield* client.CdFreightCatalogView.get(badDigest);

				yield* client.ConfigureCdStage(directStage, {
					config: {
						warehouseId,
						upstreamStages: UniqueStageList.make([]),
						availabilityStrategy: "direct",
						quorumCount: null,
						requiredSoakMs: NonNegativeCount.make(0),
						autoPromotion: "manual",
						deliveryFlow: "gitops-pull",
						flowTarget: DeliveryFlowTarget.make("argo-cd-direct"),
						campId: CampTargetId.make("camp-prod-direct"),
						requiresApproval: false,
						implicitHealthVerification: true,
						triggerPullSync: true,
					},
				});
				yield* client.RequestStagePromotion(directStage, {
					deliveryRunId: goodRun,
					freightDigest: goodDigest,
					nowMs: t0,
					upstreamQualifications: [],
					manualApprovalExpiresAtMs: null,
				});
				yield* sleep(120);

				harness.state.argoByApp.set("checkout-prod-us", {
					syncStatus: "Synced",
					healthStatus: "Degraded",
					revision: "sha-init-0",
				});
				yield* client.RequestStagePromotion(directStage, {
					deliveryRunId: degradedRun,
					freightDigest: badDigest,
					nowMs: EpochMs.make(t0 + 200),
					upstreamQualifications: [],
					manualApprovalExpiresAtMs: null,
				});
				yield* sleep(150);

				const degradedView =
					yield* client.CdDeliveryRunStatusView.get(degradedRun);
				return { closedView, badFreightView, degradedView };
			}).pipe(Effect.scoped, Effect.provide(World)),
		);

		expect(outcome.closedView?._tag).toBe("Failed");
		expect(outcome.badFreightView?._tag).toBe("Active");
		if (outcome.badFreightView?._tag === "Active") {
			expect(outcome.badFreightView.qualifications).toEqual([]);
		}
		expect(outcome.degradedView?._tag).toBe("RolledBack");
		if (outcome.degradedView?._tag === "RolledBack") {
			expect(outcome.degradedView.rollbackRevision).not.toBeNull();
			const restored = outcome.degradedView.rollbackRevision
				? harness.state.commits
						.get(outcome.degradedView.rollbackRevision)
						?.get("env/prod/release.json")
				: undefined;
			expect(restored).toContain("run-good-base");
		}
	});

	it("routes across pluggable argo-cd, flux, and external octopus-deploy adapters and fails closed for unsupported targets or flow kinds", async () => {
		const harness = createSimulatedGitAndArgoHarness();
		const argoCfg = makeConfig(
			GitopsEngine.ARGO_CD,
			GitHost.GITHUB,
			"https://api.github.com",
		);
		const fluxCfg = makeConfig(
			GitopsEngine.FLUX,
			GitHost.GITHUB,
			"https://api.github.com",
			"https://k8s.example.test",
		);

		const argoAdapter = createArgoCdPullFlowAdapter({
			config: argoCfg,
			http: harness.http,
			credentials: staticCredentials,
		});
		const fluxAdapter = createFluxPullFlowAdapter({
			config: fluxCfg,
			http: harness.http,
			credentials: staticCredentials,
		});

		const octopusCalls: string[] = [];
		const routerLayer = createCdDeliveryFlowRouterLayer({
			"argo-cd": argoAdapter,
			flux: fluxAdapter,
			"octopus-deploy": {
				publishRevision: (input) => {
					octopusCalls.push(`publish:${input.stageId}`);
					return Effect.succeed({
						outcome: {
							_tag: "Committed",
							revision: RevisionRef.make("octo-rel-100"),
							targetRef: NonEmptyReason.make("octopus:space-1/checkout"),
						},
					});
				},
				observePullRequest: () =>
					Effect.succeed({
						observation: {
							_tag: "Closed",
							summary: NonEmptyReason.make("not used"),
						},
					}),
				observeConvergence: (input) => {
					octopusCalls.push(`observe:${input.targetRevision}`);
					return Effect.succeed({
						observation: {
							_tag: "Converged",
							appliedRevision: input.targetRevision,
							summary: NonEmptyReason.make("Octopus deployment task succeeded"),
						},
					});
				},
				rollbackRevision: () =>
					Effect.succeed({
						rolledBack: true,
						rollbackRevision: RevisionRef.make("octo-rel-99"),
						summary: NonEmptyReason.make("redeployed previous Octopus release"),
					}),
			},
		});

		const World = createCdReleaseInMemoryLayer(
			dummyRealizerLayer,
			passingGateLayer,
			routerLayer,
		);

		const warehouseId = WarehouseId.make("wh-edge");
		const digest = FreightDigest.make("sha256:freight-octo-1");
		const octoStage = StageId.make("windows-edge");
		const octoRun = DeliveryRunId.make("run-octo-1");
		const t0 = EpochMs.make(1_700_000_000_000);

		const runView = await Effect.runPromise(
			Effect.gen(function* () {
				const client = yield* CdReleaseApi.clientInProcess;
				yield* client.RecordFreight(digest, {
					warehouseId,
					alias: FreightAlias.make("octo-1"),
					artifacts: [
						{
							kind: "package",
							repository: "https://nuget.example.test/checkout",
							reference: "1.0.0",
							digest,
						},
					],
					recordedAtMs: t0,
				});
				yield* client.ConfigureCdStage(octoStage, {
					config: {
						warehouseId,
						upstreamStages: UniqueStageList.make([]),
						availabilityStrategy: "direct",
						quorumCount: null,
						requiredSoakMs: NonNegativeCount.make(0),
						autoPromotion: "manual",
						deliveryFlow: "release-orchestrator",
						flowTarget: DeliveryFlowTarget.make("octopus-deploy"),
						campId: CampTargetId.make("camp-win"),
						requiresApproval: false,
						implicitHealthVerification: true,
						triggerPullSync: false,
					},
				});
				yield* client.RequestStagePromotion(octoStage, {
					deliveryRunId: octoRun,
					freightDigest: digest,
					nowMs: t0,
					upstreamQualifications: [],
					manualApprovalExpiresAtMs: null,
				});
				yield* sleep(120);
				return yield* client.CdDeliveryRunStatusView.get(octoRun);
			}).pipe(Effect.scoped, Effect.provide(World)),
		);

		expect(runView?._tag).toBe("Completed");
		if (runView?._tag === "Completed") {
			expect(runView.appliedRevision).toBe("octo-rel-100");
		}
		expect(octopusCalls).toEqual([
			"publish:windows-edge",
			"observe:octo-rel-100",
		]);

		const mismatchExit = await Effect.runPromise(
			Effect.result(
				argoAdapter.publishRevision({
					deliveryRunId: DeliveryRunId.make("run-bad-kind"),
					stageId: StageId.make("dev"),
					campId: CampTargetId.make("camp-dev"),
					freightDigest: digest,
					flowKind: "conductor-direct",
					flowTarget: DeliveryFlowTarget.make("argo-cd"),
					previousRevision: null,
				}),
			),
		);
		expect(mismatchExit._tag).toBe("Failure");
		if (mismatchExit._tag === "Failure") {
			expect(mismatchExit.failure._tag).toBe("UnsupportedDeliveryFlow");
		}

		const unknownTargetExit = await Effect.runPromiseExit(
			Effect.gen(function* () {
				const flow = yield* CdDeliveryFlow;
				return yield* flow.publishRevision({
					deliveryRunId: DeliveryRunId.make("run-unknown-target"),
					stageId: StageId.make("prod"),
					campId: CampTargetId.make("camp-prod"),
					freightDigest: digest,
					flowKind: "gitops-pull",
					flowTarget: DeliveryFlowTarget.make("spinnaker"),
					previousRevision: null,
				});
			}).pipe(Effect.provide(routerLayer)),
		);
		expect(Exit.isFailure(unknownTargetExit)).toBe(true);
	});
});
