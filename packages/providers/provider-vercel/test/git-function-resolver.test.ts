import type {
	HttpTransport,
	ResolveRequest,
	ResourceMutationJournal,
	TransportRequest,
} from "@hobo/core";
import { describe, expect, it } from "vitest";
import {
	createVercelGitFunctionResolver,
	VERCEL_GIT_FUNCTION_PRODUCT_ID,
} from "../src/git-function-resolver.js";

const revision = "0123456789abcdef0123456789abcdef01234567";
const artifact = `sha256:${"a".repeat(64)}`;
const request: ResolveRequest = {
	ref: {
		slot: "service",
		productId: VERCEL_GIT_FUNCTION_PRODUCT_ID,
		logicalId: "cd",
	},
	desired: {
		project: "hobo-cd",
		organization: "Hobo-Labs",
		repository: "HoBo",
		revision,
		rootDirectory: "packages/hobo",
		buildCommand: "pnpm build",
		teamId: "team_owned",
		operationId: "operation-1",
	},
	credentialRef: "hobo-secret://vercel/owned",
};
function journal(): ResourceMutationJournal {
	const entries = new Map<string, string>();
	return {
		persistence: "durable-cas",
		async claim({ mutationId, requestDigest }) {
			const prior = entries.get(mutationId);
			if (prior) {
				if (prior !== requestDigest) throw new Error("mutation digest changed");
				return { status: "uncertain" };
			}
			entries.set(mutationId, requestDigest);
			return { status: "claimed" };
		},
		async acknowledge() {},
		async uncertain() {},
	};
}
function fixture(
	options: {
		projectExists?: boolean;
		lostPost?: boolean;
		noArtifact?: boolean;
		wrongRevision?: boolean;
		wrongTeam?: boolean;
		preview?: boolean;
		retirementProof?: boolean;
		inventoryProof?: "valid" | "foreign" | "expired" | "denied";
		verifyEnv?: boolean;
		gitBuilt?: boolean;
		foreignSettings?: boolean;
	} = {},
) {
	const calls: TransportRequest[] = [];
	let projectExists = options.projectExists ?? true;
	// A Git-built deployment exists before HoBo acts and carries no HoBo marker.
	let created = options.gitBuilt ?? false;
	let metadata: Record<string, string> = {};
	const transport: HttpTransport = async (call) => {
		calls.push(call);
		const url = new URL(call.url);
		if (url.pathname === "/v9/projects" && call.method === "POST") {
			projectExists = true;
			return {
				status: 201,
				headers: {},
				body: JSON.stringify({ id: "prj_owned" }),
			};
		}
		if (url.pathname.startsWith("/v9/projects/")) {
			if (!projectExists) return { status: 404, headers: {}, body: "{}" };
			return {
				status: 200,
				headers: {},
				body: JSON.stringify({
					id: "prj_owned",
					name: "hobo-cd",
					accountId: options.wrongTeam ? "team_foreign" : "team_owned",
					rootDirectory: options.foreignSettings
						? "apps/site"
						: "packages/hobo",
					buildCommand: options.foreignSettings ? "next build" : "pnpm build",
				}),
			};
		}
		if (url.pathname === "/v7/deployments")
			return {
				status: 200,
				headers: {},
				body: JSON.stringify({
					deployments: created ? [{ uid: "dpl_owned", meta: metadata }] : [],
					pagination: { next: null },
				}),
			};
		if (url.pathname === "/v13/deployments" && call.method === "POST") {
			const data = JSON.parse(call.body ?? "{}");
			metadata = data.meta;
			created = true;
			if (options.lostPost) throw new Error("lost response");
			return { status: 201, headers: {}, body: '{"id":"dpl_owned"}' };
		}
		if (
			url.pathname === "/v13/deployments/dpl_owned" &&
			call.method === "DELETE" &&
			created
		) {
			created = false;
			return { status: 200, headers: {}, body: "{}" };
		}
		if (
			url.pathname === "/v13/deployments/dpl_owned" &&
			call.method === "GET" &&
			created
		)
			return {
				status: 200,
				headers: {},
				body: JSON.stringify({
					id: "dpl_owned",
					projectId: "prj_owned",
					team: { id: "team_owned" },
					target: options.preview ? null : "production",
					readyState: "READY",
					meta: {
						...metadata,
						githubCommitSha: options.wrongRevision ? "f".repeat(40) : revision,
						...(options.preview
							? { githubCommitRef: "hobo-preview" }
							: undefined),
						githubOrg: "Hobo-Labs",
						githubRepo: "HoBo",
					},
					url: "cd-immutable.vercel.app",
				}),
			};
		return { status: 404, headers: {}, body: "{}" };
	};
	const resolver = createVercelGitFunctionResolver({
		teamId: "team_owned",
		resolveCredential: async () => "test-material",
		mutationJournal: journal(),
		...(options.verifyEnv
			? { verifyGitDeploymentEnvironment: async () => true }
			: undefined),
		...(options.retirementProof
			? {
					verifyGitRetirement: async () => ({
						queuesDrained: true,
						fencedUntilRetired: true,
						evidenceRef: "drain:deployment-proof",
					}),
				}
			: undefined),
		...(options.inventoryProof
			? {
					gitInventoryNowMs: () => 1_000,
					verifyGitInventoryAccess: async (input) => ({
						...input,
						teamId:
							options.inventoryProof === "foreign"
								? "team_foreign"
								: input.teamId,
						readDeployment: options.inventoryProof !== "denied",
						enumerateAllDeployments: true,
						observedAtMs: 900,
						expiresAtMs: options.inventoryProof === "expired" ? 999 : 2_000,
						evidenceRef: "vercel:scoped-inventory-access",
					}),
				}
			: undefined),
		...(options.noArtifact
			? undefined
			: { observeGitArtifact: async () => artifact }),
	});
	return { calls, resolver, transport };
}
describe("supervised Vercel Git functions", () => {
	it("pins approved public environment in the operation and deployment without project-wide mutation", async () => {
		const environmentVariables = [
			{ name: "HOBO_CI_CACHE_MEMBERS", value: '["blob"]' },
		];
		const withEnvironment = {
			...request,
			desired: {
				...request.desired,
				projectId: "prj_owned",
				environmentVariables,
			},
		};
		const noAuthority = fixture();
		await expect(
			noAuthority.resolver.reconcile(withEnvironment, noAuthority.transport),
		).rejects.toThrow(/trusted host verification/u);
		expect(noAuthority.calls).toHaveLength(0);
		const f = fixture({ verifyEnv: true });
		await f.resolver.reconcile(withEnvironment, f.transport);
		const post = f.calls.find(
			(c) =>
				c.method === "POST" && new URL(c.url).pathname === "/v13/deployments",
		);
		const data = JSON.parse(post?.body ?? "{}");
		expect(data.env).toEqual({ HOBO_CI_CACHE_MEMBERS: '["blob"]' });
		expect(
			f.calls
				.filter((c) => c.method !== "GET")
				.map((c) => new URL(c.url).pathname),
		).toEqual(["/v13/deployments"]);
		const other = fixture({ verifyEnv: true });
		await other.resolver.reconcile(
			{
				...withEnvironment,
				desired: {
					...withEnvironment.desired,
					environmentVariables: [
						{ name: "HOBO_CI_CACHE_MEMBERS", value: '["blob","turso"]' },
					],
				},
			},
			other.transport,
		);
		const otherPost = other.calls.find(
			(c) =>
				c.method === "POST" && new URL(c.url).pathname === "/v13/deployments",
		);
		expect(JSON.parse(otherPost?.body ?? "{}").meta.hoboOperation).not.toEqual(
			data.meta.hoboOperation,
		);
		await expect(
			f.resolver.read?.(
				{
					...withEnvironment,
					desired: { ...withEnvironment.desired, source: true },
					ref: { ...withEnvironment.ref, physicalId: "dpl_owned" },
				},
				f.transport,
			),
		).rejects.toThrow(/source adoption/u);
	});
	it("stages preview without selecting production and verifies the observed environment", async () => {
		const f = fixture({ preview: true });
		const preview = {
			...request,
			desired: {
				...request.desired,
				environment: "preview",
				previewBranch: "hobo-preview",
			},
		};
		expect((await f.resolver.reconcile(preview, f.transport)).action).toBe(
			"create",
		);
		const post = f.calls.find(
			(call) =>
				call.method === "POST" &&
				new URL(call.url).pathname === "/v13/deployments",
		);
		const data = JSON.parse(post?.body ?? "{}");
		expect(data.target).toBeUndefined();
		expect(data.autoAssignCustomDomains).toBe(false);
		expect(data.gitSource).toMatchObject({
			ref: "hobo-preview",
			sha: revision,
		});
		expect((await f.resolver.reconcile(preview, f.transport)).action).toBe(
			"adopt",
		);
		const wrong = fixture();
		await expect(
			wrong.resolver.reconcile(preview, wrong.transport),
		).rejects.toThrow(/identity, scope, revision or operation/u);
	});
	it("rejects unsupported environments before contacting Vercel", async () => {
		const f = fixture();
		await expect(
			f.resolver.reconcile(
				{ ...request, desired: { ...request.desired, environment: "staging" } },
				f.transport,
			),
		).rejects.toThrow(/production or preview/u);
		expect(f.calls).toHaveLength(0);
		await expect(
			f.resolver.reconcile(
				{
					...request,
					desired: {
						...request.desired,
						environment: "preview",
						previewBranch: revision,
					},
				},
				f.transport,
			),
		).rejects.toThrow(/Git branch/u);
		for (const branch of ["refs/heads/main", revision.toUpperCase()])
			await expect(
				f.resolver.reconcile(
					{
						...request,
						desired: {
							...request.desired,
							environment: "preview",
							previewBranch: branch,
						},
					},
					f.transport,
				),
			).rejects.toThrow(/Git branch/u);
		expect(f.calls).toHaveLength(0);
	});
	it("creates the project and stages the exact production build without routing it", async () => {
		const f = fixture({ projectExists: false });
		const result = await f.resolver.reconcile(request, f.transport);
		expect(result).toMatchObject({
			action: "create",
			physicalId: "dpl_owned",
			outputs: {
				ready: true,
				artifactDigest: artifact,
				servingEndpoint: "https://cd-immutable.vercel.app",
			},
		});
		const post = f.calls.find(
			(call) =>
				call.method === "POST" &&
				new URL(call.url).pathname === "/v13/deployments",
		);
		const data = JSON.parse(post?.body ?? "{}");
		expect(data).toMatchObject({
			project: "prj_owned",
			projectSettings: {
				rootDirectory: "packages/hobo",
				buildCommand: "pnpm build",
				framework: null,
				sourceFilesOutsideRootDirectory: true,
			},
			target: "production",
			autoAssignCustomDomains: false,
			gitSource: {
				type: "github",
				org: "Hobo-Labs",
				repo: "HoBo",
				ref: revision,
				sha: revision,
			},
		});
		expect(f.calls.some((call) => call.url.includes("/promote/"))).toBe(false);
		const replay = await f.resolver.reconcile(request, f.transport);
		expect(replay.action).toBe("adopt");
		expect(f.calls.filter((call) => call.method === "POST")).toHaveLength(2);
	});
	it("recovers a lost deployment response without a second create", async () => {
		const f = fixture({ lostPost: true });
		await expect(f.resolver.reconcile(request, f.transport)).rejects.toThrow(
			"mutation outcome is uncertain",
		);
		expect((await f.resolver.reconcile(request, f.transport)).action).toBe(
			"adopt",
		);
		expect(f.calls.filter((call) => call.method === "POST")).toHaveLength(1);
	});
	it("requires independent artifact evidence before creating anything", async () => {
		const f = fixture({ projectExists: false, noArtifact: true });
		await expect(f.resolver.reconcile(request, f.transport)).rejects.toThrow(
			/artifact evidence/,
		);
		expect(f.calls.every((call) => call.method === "GET")).toBe(true);
	});
	it("rejects another team before provider mutations", async () => {
		const f = fixture({ wrongTeam: true });
		await expect(f.resolver.reconcile(request, f.transport)).rejects.toThrow(
			/account/,
		);
		expect(f.calls.every((call) => call.method === "GET")).toBe(true);
	});
	it("pins the provider-confirmed project identity and never recreates a different project", async () => {
		const pinnedProject = {
			...request,
			desired: { ...request.desired, projectId: "prj_owned" },
		};
		const valid = fixture();
		expect(
			(await valid.resolver.reconcile(pinnedProject, valid.transport))
				.physicalId,
		).toBe("dpl_owned");
		const wrong = fixture();
		await expect(
			wrong.resolver.reconcile(
				{ ...request, desired: { ...request.desired, projectId: "prj_other" } },
				wrong.transport,
			),
		).rejects.toThrow(/project identity/u);
		expect(wrong.calls.every((call) => call.method === "GET")).toBe(true);
		const absent = fixture({ projectExists: false });
		await expect(
			absent.resolver.reconcile(pinnedProject, absent.transport),
		).rejects.toThrow(/approved Vercel project is absent/u);
		expect(absent.calls.every((call) => call.method === "GET")).toBe(true);
	});
	it("does not accept a deployment built from another commit", async () => {
		const f = fixture({ wrongRevision: true });
		await expect(f.resolver.reconcile(request, f.transport)).rejects.toThrow(
			/revision/,
		);
	});
	it("requires a producer fence and drain proof before deleting an owning deployment", async () => {
		const blocked = fixture();
		await blocked.resolver.reconcile(request, blocked.transport);
		const pinned = {
			...request,
			ref: { ...request.ref, physicalId: "dpl_owned" },
		};
		await expect(
			blocked.resolver.delete(pinned, blocked.transport),
		).rejects.toThrow(/drain.*fence/u);
		expect(blocked.calls.some((call) => call.method === "DELETE")).toBe(false);
		const allowed = fixture({ retirementProof: true });
		await allowed.resolver.reconcile(request, allowed.transport);
		await allowed.resolver.delete(pinned, allowed.transport);
		expect(
			allowed.calls.filter((call) => call.method === "DELETE"),
		).toHaveLength(1);
		expect(
			await allowed.resolver.read?.(pinned, allowed.transport),
		).toBeUndefined();
	});
	it("proves absence only with scoped inventory permission, the exact project and a persistent drain fence", async () => {
		const f = fixture({ retirementProof: true, inventoryProof: "valid" });
		const pinned = {
			...request,
			ref: { ...request.ref, physicalId: "dpl_owned" },
			desired: { ...request.desired, projectId: "prj_owned" },
		};
		await f.resolver.reconcile({ ...pinned, ref: request.ref }, f.transport);
		expect(await f.resolver.observeAbsence?.(pinned, f.transport)).toBe(false);
		await f.resolver.delete(pinned, f.transport);
		expect(await f.resolver.observeAbsence?.(pinned, f.transport)).toBe(true);
		expect(
			f.calls
				.filter((call) => call.method === "GET")
				.some(
					(call) =>
						new URL(call.url).pathname === "/v7/deployments" &&
						new URL(call.url).searchParams.get("projectId") === "prj_owned",
				),
		).toBe(true);
		for (const inventoryProof of ["foreign", "expired", "denied"] as const) {
			const bad = fixture({ retirementProof: true, inventoryProof });
			await expect(
				bad.resolver.observeAbsence?.(pinned, bad.transport),
			).rejects.toThrow(/permission/u);
		}
		const missingProof = fixture({ retirementProof: true });
		await expect(
			missingProof.resolver.observeAbsence?.(pinned, missingProof.transport),
		).rejects.toThrow(/inventory access/u);
		const noProject = fixture({
			retirementProof: true,
			inventoryProof: "valid",
			projectExists: false,
		});
		await expect(
			noProject.resolver.observeAbsence?.(pinned, noProject.transport),
		).rejects.toThrow(/project scope/u);
		const wrongTeam = fixture({
			retirementProof: true,
			inventoryProof: "valid",
			wrongTeam: true,
		});
		await expect(
			wrongTeam.resolver.observeAbsence?.(pinned, wrongTeam.transport),
		).rejects.toThrow(/identity or account/u);
		const noDrain = fixture({ inventoryProof: "valid" });
		await expect(
			noDrain.resolver.observeAbsence?.(pinned, noDrain.transport),
		).rejects.toThrow(/drain.*fence/u);
	});
	it("rejects incomplete or unauthorized inventories and never deletes on an ambiguous missing read", async () => {
		const pinned = {
			...request,
			ref: { ...request.ref, physicalId: "dpl_owned" },
			desired: { ...request.desired, projectId: "prj_owned" },
		};
		const f = fixture({ retirementProof: true, inventoryProof: "valid" });
		const incomplete: HttpTransport = async (call) =>
			new URL(call.url).pathname === "/v7/deployments"
				? {
						status: 200,
						headers: {},
						body: JSON.stringify({ deployments: [] }),
					}
				: f.transport(call);
		await expect(
			f.resolver.observeAbsence?.(pinned, incomplete),
		).rejects.toThrow(/inventory is incomplete/u);
		const denied: HttpTransport = async (call) =>
			new URL(call.url).pathname === "/v7/deployments"
				? { status: 403, headers: {}, body: "{}" }
				: f.transport(call);
		await expect(f.resolver.observeAbsence?.(pinned, denied)).rejects.toThrow();
		const noAccess = fixture({ retirementProof: true });
		await expect(
			noAccess.resolver.delete(pinned, noAccess.transport),
		).rejects.toThrow(/inventory access/u);
		expect(noAccess.calls.every((call) => call.method === "GET")).toBe(true);
	});
	it("can read an explicitly inventoried source from an earlier operation without accepting a foreign revision", async () => {
		const f = fixture();
		await f.resolver.reconcile(request, f.transport);
		const source = {
			...request,
			ref: { ...request.ref, physicalId: "dpl_owned" },
			desired: {
				...request.desired,
				operationId: "later-operation",
				source: true,
			},
		};
		expect((await f.resolver.read?.(source, f.transport))?.physicalId).toBe(
			"dpl_owned",
		);
		await expect(
			f.resolver.read?.({ ...source, ref: request.ref }, f.transport),
		).rejects.toThrow("exact approved native identity");
	});
	it("never deletes an adopted source deployment that lacks the HoBo operation marker", async () => {
		const f = fixture({ gitBuilt: true, retirementProof: true });
		const adopted = {
			...request,
			ref: { ...request.ref, physicalId: "dpl_owned" },
			desired: { ...request.desired, source: true },
		};
		expect((await f.resolver.read?.(adopted, f.transport))?.physicalId).toBe(
			"dpl_owned",
		);
		await expect(f.resolver.delete(adopted, f.transport)).rejects.toThrow(
			/operation marker/u,
		);
		expect(f.calls.some((call) => call.method === "DELETE")).toBe(false);
	});
	it("never rewrites an unpinned existing project HoBo did not create", async () => {
		const f = fixture({ foreignSettings: true });
		await expect(f.resolver.reconcile(request, f.transport)).rejects.toThrow(
			/did not create/u,
		);
		expect(f.calls.every((call) => call.method === "GET")).toBe(true);
		expect(f.calls.some((call) => call.method === "PATCH")).toBe(false);
	});
});
