import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createTrustedVault } from "@hobo/core";
import { createMemorySecretsPort } from "@hobo/identity";
import { afterEach, describe, expect, it } from "vitest";
import { loadDeliveryFile } from "../src/cd-delivery-module.js";
import {
	managedRelayRecords,
	runCiRelayManaged,
} from "../src/ci-relay-managed.js";
import { isJsonString } from "../src/json.js";
import { createReleaseJournal } from "../src/release-journal.js";
import { syntheticRelayBinding } from "./support/owner-store-stand-in.js";

const RELAY = resolve(import.meta.dirname, "../../ci-vercel");
const SHA = "0123456789abcdef0123456789abcdef01234567";
const PROJECT = "prj_relayTest";
const homes: string[] = [];

afterEach(async () => {
	await Promise.all(
		homes.splice(0).map((home) => rm(home, { recursive: true, force: true })),
	);
});

async function harness(
	options: {
		unhealthy?: boolean;
		failedPreview?: boolean;
		github?: boolean;
		noGithubToken?: boolean;
		resume?: boolean;
		resumeOlderWhilePreviousServes?: boolean;
		localResumeOlderWhilePreviousServes?: boolean;
		previewOnly?: boolean;
		store?: "infisical" | "1password" | "bitwarden";
		storeDenied?: boolean;
		wrongProject?: boolean;
		wrongTeam?: boolean;
		invalidProjectId?: boolean;
	} = {},
) {
	const home = await mkdtemp(join(tmpdir(), "managed-relay-"));
	homes.push(home);
	const vault = createTrustedVault();
	if (!options.store && !options.storeDenied)
		vault.put("VERCEL_TOKEN", "synthetic-deploy-token");
	const store = createMemorySecretsPort({ id: "memory" });
	if (options.store)
		await store.put("HOBO_CD_VERCEL_TOKEN", "synthetic-deploy-token");
	const calls: {
		method: string;
		path: string;
		body?: string;
		redirect?: RequestRedirect;
		signal?: AbortSignal | null;
	}[] = [];
	let current = options.resume ? "dpl_new" : "dpl_old";
	const resumeSha =
		options.resumeOlderWhilePreviousServes ||
		options.localResumeOlderWhilePreviousServes
			? "f".repeat(40)
			: SHA;
	let time = Date.now();
	const deployments: {
		id: number;
		sha: string;
		environment: string;
		payload: object;
	}[] = [];
	const statuses: { state: string }[] = [];
	if (options.resume || options.resumeOlderWhilePreviousServes)
		deployments.push({
			id: 42,
			sha: resumeSha,
			environment: "hobo-ci-release-checkpoint",
			payload: {
				schema: "hobo.release-checkpoint/v1",
				deploymentId: "dpl_new",
				previousDeploymentId: "dpl_old",
				commit: resumeSha,
			},
		});
	if (options.localResumeOlderWhilePreviousServes)
		await createReleaseJournal(home, PROJECT, "dpl_new").reserve({
			deploymentId: "dpl_new",
			previousDeploymentId: "dpl_old",
			commit: resumeSha,
			state: "reserved",
		});
	const fetcher: typeof fetch = async (raw, init) => {
		const url = new URL(String(raw));
		const method = init?.method ?? "GET";
		calls.push({
			method,
			path: url.pathname,
			redirect: init?.redirect,
			signal: init?.signal,
			...(isJsonString(init?.body) ? { body: init.body } : undefined),
		});
		if (url.hostname === "api.github.com") {
			if (url.pathname === "/graphql") {
				const nodes = deployments.map((record) => {
					const value = record;
					const last = statuses.at(-1);
					return {
						databaseId: value.id,
						commitOid: value.sha,
						environment: value.environment,
						payload: JSON.stringify(value.payload),
						latestStatus: last ? { state: last.state.toUpperCase() } : null,
					};
				});
				return Response.json({
					data: {
						repository: {
							deployments: {
								nodes,
								pageInfo: { hasNextPage: false, endCursor: null },
							},
						},
					},
				});
			}
			if (method === "GET" && url.pathname.endsWith("/deployments"))
				return Response.json(deployments);
			if (method === "GET" && url.pathname.endsWith("/statuses"))
				return Response.json(statuses.slice(-1));
			if (method === "POST" && url.pathname.endsWith("/deployments")) {
				const input = JSON.parse(String(init?.body));
				const record = {
					id: 42,
					sha: SHA,
					environment: input.environment,
					payload: input.payload,
				};
				deployments.push(record);
				return Response.json(record, { status: 201 });
			}
			if (method === "POST" && url.pathname.endsWith("/statuses")) {
				const value = JSON.parse(String(init?.body));
				statuses.push(value);
				return Response.json(value, { status: 201 });
			}
		}
		if (url.hostname === "hobo-ci.vercel.app") {
			if (url.pathname === "/healthz") return Response.json({ commit: SHA });
			return Response.json(
				{ ready: !options.unhealthy },
				{ status: options.unhealthy ? 503 : 200 },
			);
		}
		if (url.pathname === "/v9/projects/hobo-ci")
			return Response.json({
				id: options.invalidProjectId ? "invalid" : PROJECT,
				name: options.wrongProject ? "other" : "hobo-ci",
				accountId: options.wrongTeam
					? "team_other"
					: url.searchParams.get("teamId"),
			});
		if (
			url.pathname.startsWith("/v10/projects/") &&
			url.pathname.endsWith("/env")
		)
			return Response.json(
				method === "GET" ? { envs: [] } : { created: [], failed: [] },
			);
		if (url.pathname === "/v13/deployments" && method === "POST") {
			const body = JSON.parse(String(init?.body));
			return Response.json({
				id: body.target === "production" ? "dpl_new" : "dpl_preview",
				url:
					body.target === "production"
						? "relay-production.vercel.app"
						: "relay-preview.vercel.app",
			});
		}
		if (url.pathname === "/v13/deployments/dpl_preview")
			return Response.json({
				id: "dpl_preview",
				projectId: PROJECT,
				target: null,
				readyState: options.failedPreview ? "ERROR" : "READY",
				meta: { hoboSourceCommit: SHA },
			});
		if (url.pathname === "/v13/deployments/dpl_new")
			return Response.json({
				id: "dpl_new",
				projectId: PROJECT,
				target: "production",
				readyState: "READY",
				meta: { hoboSourceCommit: resumeSha, hoboStagedProduction: "true" },
			});
		if (url.pathname === "/v13/deployments/dpl_old")
			return Response.json({
				id: "dpl_old",
				projectId: PROJECT,
				target: "production",
				readyState: "READY",
			});
		if (url.pathname.startsWith("/v4/aliases/"))
			return Response.json({
				alias: "hobo-ci.vercel.app",
				projectId: PROJECT,
				deploymentId: current,
			});
		if (url.pathname === `/v10/projects/${PROJECT}/promote/dpl_new`) {
			current = "dpl_new";
			return Response.json({});
		}
		if (url.pathname === `/v1/projects/${PROJECT}/rollback/dpl_old`) {
			current = "dpl_old";
			return Response.json({});
		}
		return Response.json({ error: { code: "not_found" } }, { status: 404 });
	};
	const result = await runCiRelayManaged({
		cwd: RELAY,
		values: {
			sha: SHA,
			ref: "main",
			budget: "20",
			...(options.previewOnly ? { target: "preview" } : undefined),
		},
		env: {
			HOBO_USER: "relay-test",
			...(options.github
				? {
						GITHUB_ACTIONS: "true",
						GITHUB_REPOSITORY: "Hobo-Labs/HoBo",
						GITHUB_SHA: SHA,
						...(options.noGithubToken
							? undefined
							: { GITHUB_TOKEN: "synthetic-github-token" }),
					}
				: undefined),
		},
		credentials: vault,
		bindingStore: {
			read: async () => syntheticRelayBinding(),
			write: async () => undefined,
		},
		...(options.store || options.storeDenied
			? {
					openOwnerStore: async () => ({
						chosen: true,
						opened: {
							id: options.store ?? "infisical",
							port: store,
							reference: () => "private-store-coordinate",
						},
					}),
				}
			: undefined),
		fetch: fetcher,
		home,
		now: () => time,
		sleep: async (ms) => {
			time += ms;
		},
		feedWaitMs: 20,
		source: () => ({
			commit: SHA,
			files: [
				{
					path: "packages/ci-vercel/api/relay.ts",
					mode: "100644",
					content: Buffer.from("export default 1;"),
				},
			],
		}),
		snapshot: async () => ({ dir: RELAY, close: async () => {} }),
		emitProgress: () => {},
	});
	return { result, calls, current };
}

describe("managed relay delivery through HoBo CD", () => {
	it.each([
		"infisical",
		"1password",
		"bitwarden",
	] as const)("uses the owner's %s store without exposing its coordinates", async (store) => {
		const { result } = await harness({ store, previewOnly: true });
		expect(result.code).toBe("HOBO_CI_MANAGED_PREVIEW");
		const output = JSON.stringify(result);
		expect(output).not.toContain("private-store-coordinate");
		expect(output).not.toContain("synthetic-deploy-token");
		expect(output).not.toContain(PROJECT);
	});

	it("refuses an unavailable owner connection before contacting Vercel", async () => {
		const { result, calls } = await harness({ storeDenied: true });
		expect(result.code).toBe("HOBO_CI_DEPLOY_AUTH_REQUIRED");
		expect(calls).toEqual([]);
	});

	it("redirect-guards and bounds every deployment and journal request", async () => {
		const { result, calls } = await harness({ github: true });
		expect(result.code).toBe("HOBO_CI_MANAGED_DEPLOYED");
		expect(calls.length).toBeGreaterThan(0);
		for (const call of calls) {
			expect(call.redirect).toBe("error");
			expect(call.signal).toBeInstanceOf(AbortSignal);
			expect(call.signal?.aborted).toBe(false);
		}
	});

	it("refuses a project lookup that does not match the selected project", async () => {
		const { result, calls } = await harness({ wrongProject: true });
		expect(result.code).toBe("HOBO_CI_MANAGED_PROJECT_UNAVAILABLE");
		expect(calls.some((call) => call.path === "/v13/deployments")).toBe(false);
	});

	it.each([
		{ wrongTeam: true },
		{ invalidProjectId: true },
	])("refuses an invalid project receipt: %o", async (options) => {
		const { result, calls } = await harness(options);
		expect(result.code).toBe("HOBO_CI_MANAGED_PROJECT_UNAVAILABLE");
		expect(calls.some((call) => call.path === "/v13/deployments")).toBe(false);
	});

	it("rejects a delivery pipeline with duplicate nodes", async () => {
		const loaded = await loadDeliveryFile("deploy/delivery.ts", { cwd: RELAY });
		if (!loaded.ok) throw new Error("The relay delivery fixture did not load.");
		const pipeline = loaded.value.pipelines[0];
		const preview = pipeline?.nodes.find((node) => node.name === "preview");
		if (!pipeline || !preview)
			throw new Error("The relay preview fixture is absent.");
		pipeline.nodes.push(preview);
		expect(() => managedRelayRecords(loaded.value)).toThrow(/duplicate/iu);
	});

	it("builds the pinned source in both Camps and promotes only after verification", async () => {
		const { result, calls, current } = await harness();
		expect(result.code).toBe("HOBO_CI_MANAGED_DEPLOYED");
		expect(current).toBe("dpl_new");
		const requests = calls.filter(
			(call) => call.method === "POST" && call.path === "/v13/deployments",
		);
		expect(requests).toHaveLength(2);
		const bodies = requests.map((request) => JSON.parse(request.body ?? "{}"));
		expect(
			bodies.every(
				(body) =>
					body.gitSource === undefined && body.gitMetadata.commitSha === SHA,
			),
		).toBe(true);
		expect(bodies[1]?.autoAssignCustomDomains).toBe(false);
		expect(calls.some((call) => call.path.includes("protection-bypass"))).toBe(
			false,
		);
	});

	it("restores production if the newly promoted relay is unhealthy", async () => {
		const { result, calls, current } = await harness({ unhealthy: true });
		expect(result.ok).toBe(false);
		expect(current).toBe("dpl_old");
		expect(
			calls.some(
				(call) => call.path === `/v1/projects/${PROJECT}/rollback/dpl_old`,
			),
		).toBe(true);
	});

	it("never creates a production deployment when preview fails", async () => {
		const { result, calls, current } = await harness({ failedPreview: true });
		expect(result.ok).toBe(false);
		expect(current).toBe("dpl_old");
		expect(
			calls.filter(
				(call) => call.method === "POST" && call.path === "/v13/deployments",
			),
		).toHaveLength(1);
	});

	it("supports preview-only delivery without changing production", async () => {
		const { result, calls, current } = await harness({ previewOnly: true });
		expect(result.code).toBe("HOBO_CI_MANAGED_PREVIEW");
		expect(current).toBe("dpl_old");
		expect(
			calls.filter(
				(call) => call.method === "POST" && call.path === "/v13/deployments",
			),
		).toHaveLength(1);
		expect(calls.some((call) => call.path.includes("/promote/"))).toBe(false);
	});

	it("persists the rollback target in GitHub before changing production", async () => {
		const { result, calls } = await harness({ github: true });
		expect(result.code).toBe("HOBO_CI_MANAGED_DEPLOYED");
		const reserve = calls.findIndex(
			(call) =>
				call.method === "POST" &&
				call.path === "/repos/Hobo-Labs/HoBo/deployments",
		);
		const promote = calls.findIndex(
			(call) => call.path === `/v10/projects/${PROJECT}/promote/dpl_new`,
		);
		expect(reserve).toBeGreaterThanOrEqual(0);
		expect(promote).toBeGreaterThan(reserve);
		expect(JSON.stringify(calls)).not.toContain("synthetic-github-token");
	});

	it("refuses a workflow without a durable checkpoint credential before contacting Vercel", async () => {
		const { result, calls } = await harness({
			github: true,
			noGithubToken: true,
		});
		expect(result.code).toBe("HOBO_CI_MANAGED_JOURNAL_REQUIRED");
		expect(calls).toEqual([]);
	});

	it("recovers an already promoted candidate from a prior runner without creating it again", async () => {
		const { result, calls, current } = await harness({
			github: true,
			resume: true,
		});
		expect(result.code).toBe("HOBO_CI_MANAGED_DEPLOYED");
		expect(current).toBe("dpl_new");
		expect(
			calls.filter(
				(call) => call.method === "POST" && call.path === "/v13/deployments",
			),
		).toHaveLength(1);
		expect(
			calls.some(
				(call) => call.path === `/v10/projects/${PROJECT}/promote/dpl_new`,
			),
		).toBe(false);
	});

	it("keeps an older unfinished release when its previous deployment is still serving", async () => {
		const { result, calls, current } = await harness({
			github: true,
			resumeOlderWhilePreviousServes: true,
		});
		expect(result.code).toBe("HOBO_CI_MANAGED_RECOVERY_FAILED");
		expect(current).toBe("dpl_old");
		expect(calls.some((call) => call.path.includes("/promote/"))).toBe(false);
		expect(calls.some((call) => call.path.includes("/rollback/"))).toBe(false);
		expect(
			calls.some(
				(call) => call.path.endsWith("/statuses") && call.method === "POST",
			),
		).toBe(false);
		expect(
			calls.some(
				(call) => call.path === "/v13/deployments" && call.method === "POST",
			),
		).toBe(false);
	});

	it("finds an unfinished local release before creating another deployment", async () => {
		const { result, calls, current } = await harness({
			localResumeOlderWhilePreviousServes: true,
		});
		expect(result.code).toBe("HOBO_CI_MANAGED_RECOVERY_FAILED");
		expect(current).toBe("dpl_old");
		expect(
			calls.some(
				(call) =>
					call.path.includes("/promote/") || call.path.includes("/rollback/"),
			),
		).toBe(false);
		expect(
			calls.some(
				(call) => call.path === "/v13/deployments" && call.method === "POST",
			),
		).toBe(false);
	});
});
