import type {
	HttpTransport,
	ResolveRequest,
	TransportRequest,
} from "@hobo/core";
import { describe, expect, it } from "vitest";
import {
	createVercelDeploymentComponentResolver,
	VERCEL_CRON_PRODUCT_ID,
	VERCEL_QUEUE_PRODUCT_ID,
	VERCEL_SCHEDULE_PRODUCT_ID,
} from "../src/deployment-component-resolver.js";
import {
	vercelCronMinimumInterval,
	verifyVercelDeploymentComponent,
} from "../src/deployment-components.js";

const revision = "0123456789abcdef0123456789abcdef01234567";
const previewBranch = "hobo-preview";
const configuration = {
	functions: {
		"api/queue.ts": {
			experimentalTriggers: [{ type: "queue/v2beta", topic: "hobo-ci" }],
		},
		"api/cd-tick.js": { experimentalTriggers: [{ type: "schedule/v1beta" }] },
	},
	schedules: {
		repair: { schedule: "*/15 * * * *", topic: "hobo-ci" },
		"hobo-cd-tick": { schedule: "* * * * *", function: "api/cd-tick" },
	},
	crons: [{ path: "/internal/cd/tick", schedule: "* * * * *" }],
	routes: [
		{
			src: "/(.*)",
			dest: "/api/cd",
			transforms: [{ type: "request.path", op: "set", args: "/$1" }],
		},
	],
};
const base = {
	deploymentId: "dpl_123",
	teamId: "team_123",
	project: "hobo-ci",
	organization: "Hobo-Labs",
	repository: "HoBo",
	revision,
	rootDirectory: "packages/ci-vercel",
	environment: "production",
} as const;
const queue = { topic: "hobo-ci", entry: "api/queue.ts" };
const schedule = {
	name: "repair",
	cron: "*/15 * * * *",
	...queue,
	maximumJitterSeconds: 900,
};
const cron = {
	path: "/internal/cd/tick",
	cron: "* * * * *",
	entry: "api/cd.js",
	maximumJitterSeconds: 60,
};
const privateSchedule = {
	name: "hobo-cd-tick",
	cron: "* * * * *",
	entry: "api/cd-tick.js",
	function: "api/cd-tick",
	maximumJitterSeconds: 60,
};
function request(
	productId: string,
	component: Record<string, string | number>,
	overrides: Record<string, string> = {},
): ResolveRequest {
	return {
		ref: {
			slot: productId === VERCEL_QUEUE_PRODUCT_ID ? "queue" : "service",
			productId,
			logicalId: "component",
		},
		desired: {
			...base,
			...component,
			...(overrides.environment === "preview" ? { previewBranch } : undefined),
			...overrides,
		},
		credentialRef: "hobo-secret://vercel/team",
	};
}

function fixture(
	options: {
		plan?: string;
		wrongRevision?: boolean;
		wrongProject?: boolean;
		missingBuild?: boolean;
		missingDeployment?: boolean;
		missingCronSecret?: boolean;
		cronAuthentication?: boolean;
		preview?: boolean;
		previewActive?: boolean;
		productionTrack?: boolean;
		foreignProductionAlias?: boolean;
		missingProductionSchedule?: boolean;
		wrongSchedule?: boolean;
		omitJitter?: boolean;
		wrongJitter?: boolean;
		artifact?: string;
		wrongTrack?: boolean;
		nativeTrack?: boolean;
		foreignAlias?: boolean;
		noTrackCallback?: boolean;
		lostEnable?: boolean;
		queueDrained?: boolean;
		queueFenced?: boolean;
		gitToken?: boolean;
		configuration?: object;
	} = {},
) {
	const calls: TransportRequest[] = [];
	let previewActive = options.previewActive === true;
	const journalEntries = new Map<string, string>();
	const transport: HttpTransport = async (call) => {
		calls.push(call);
		const url = new URL(call.url);
		if (url.hostname === "vercel-schedules.com") {
			const name = url.pathname.split("/")[3];
			const privateTarget = name === "hobo-cd-tick";
			if (options.missingProductionSchedule && !options.preview)
				return { status: 404, headers: {}, body: "{}" };
			if (url.pathname.endsWith("/disable") && call.method === "POST") {
				previewActive = false;
				return { status: 200, headers: {}, body: "{}" };
			}
			if (url.pathname.endsWith("/enable") && call.method === "POST") {
				previewActive = true;
				if (options.lostEnable) throw new Error("lost after commit");
				return { status: 200, headers: {}, body: "{}" };
			}
			return {
				status: 200,
				headers: {},
				body: JSON.stringify({
					ownerId: "team_123",
					projectId: "prj_123",
					name,
					namespace: "default",
					source: "static",
					timezone: "UTC",
					...(options.omitJitter
						? undefined
						: {
								jitter: options.wrongJitter
									? 10
									: options.plan === "hobby"
										? 15
										: 1,
							}),
					expression: {
						type: "cron",
						cron: options.wrongSchedule
							? "0 0 * * *"
							: privateTarget
								? "* * * * *"
								: "*/15 * * * *",
					},
					target: privateTarget
						? { type: "function", function: "api/cd-tick" }
						: { type: "queue", topic: "hobo-ci" },
					state: previewActive ? "active" : "inactive",
					updatedAt: 123,
				}),
			};
		}
		if (url.hostname === "api.github.com") {
			if (url.pathname.endsWith("/vercel.json"))
				return {
					status: 200,
					headers: {},
					body: JSON.stringify(options.configuration ?? configuration),
				};
			if (
				url.pathname.endsWith("/api/queue.ts") ||
				url.pathname.endsWith("/api/cd.js") ||
				url.pathname.endsWith("/api/cd-tick.js")
			)
				return {
					status: 200,
					headers: {},
					body: "export default function handler() {}",
				};
		}
		if (
			url.pathname === "/v9/projects/hobo-ci" ||
			url.pathname === "/v9/projects/prj_123"
		)
			return {
				status: 200,
				headers: {},
				body: JSON.stringify({
					id: "prj_123",
					name: "hobo-ci",
					accountId: options.wrongProject ? "team_wrong" : "team_123",
					rootDirectory: "packages/ci-vercel",
					...(options.productionTrack
						? {
								targets: {
									production: {
										id: "dpl_123",
										readyState: "READY",
										readySubstate: "PROMOTED",
									},
								},
							}
						: undefined),
					...(options.nativeTrack || options.foreignAlias
						? {
								alias: [
									{
										gitBranch: previewBranch,
										environment: "preview",
										redirect: null,
										deployment: {
											id: options.foreignAlias ? "dpl_foreign" : "dpl_123",
										},
									},
								],
							}
						: undefined),
				}),
			};
		if (url.pathname === "/v9/projects/prj_123/domains")
			return {
				status: 200,
				headers: {},
				body: JSON.stringify({
					domains: [{ name: "hobo-ci.example.com" }],
					pagination: { next: null },
				}),
			};
		if (url.pathname === "/v4/aliases/hobo-ci.example.com")
			return {
				status: 200,
				headers: {},
				body: JSON.stringify({
					alias: "hobo-ci.example.com",
					projectId: "prj_123",
					deploymentId: options.foreignProductionAlias
						? "dpl_other"
						: "dpl_123",
				}),
			};
		if (url.pathname === "/v13/deployments/dpl_123") {
			if (options.missingDeployment)
				return { status: 404, headers: {}, body: "{}" };
			return {
				status: 200,
				headers: {},
				body: JSON.stringify({
					id: "dpl_123",
					projectId: "prj_123",
					team: { id: "team_123" },
					target: options.preview ? null : "production",
					readyState: "READY",
					url: "hobo-ci-123.vercel.app",
					meta: {
						githubCommitSha: options.wrongRevision ? "f".repeat(40) : revision,
						githubCommitRef: previewBranch,
						githubOrg: "Hobo-Labs",
						githubRepo: "HoBo",
					},
				}),
			};
		}
		if (url.pathname === "/v11/deployments/dpl_123/builds")
			return {
				status: 200,
				headers: {},
				body: JSON.stringify({
					builds: options.missingBuild
						? []
						: [
								{ entrypoint: "api/queue.ts", output: [{ type: "lambda" }] },
								{ entrypoint: "api/cd.js", output: [{ type: "lambda" }] },
								{ entrypoint: "api/cd-tick.js", output: [{ type: "lambda" }] },
							],
				}),
			};
		if (url.pathname === "/v2/teams/team_123")
			return {
				status: 200,
				headers: {},
				body: JSON.stringify({
					id: "team_123",
					billing: { plan: options.plan ?? "pro" },
				}),
			};
		if (url.pathname === "/v10/projects/prj_123/env")
			return {
				status: 200,
				headers: {},
				body: JSON.stringify({
					envs: options.missingCronSecret
						? []
						: [
								{
									key: "CRON_SECRET",
									type: "sensitive",
									target: ["production"],
								},
							],
				}),
			};
		return { status: 404, headers: {}, body: "{}" };
	};
	const resolver = (
		product:
			| typeof VERCEL_QUEUE_PRODUCT_ID
			| typeof VERCEL_SCHEDULE_PRODUCT_ID
			| typeof VERCEL_CRON_PRODUCT_ID,
	) =>
		createVercelDeploymentComponentResolver(
			{
				teamId: "team_123",
				resolveCredential: async () => "vercel-token",
				...(options.artifact !== undefined
					? { observeGitArtifact: async () => options.artifact ?? "" }
					: undefined),
				verifyQueueDrain: async () => ({
					drained: options.queueDrained !== false,
					fencedUntilRetired: options.queueFenced !== false,
					evidenceRef: "drain:proof-1",
				}),
				...(options.gitToken
					? { resolveGitCredential: async () => "git-token" }
					: undefined),
				verifyCronAuthentication: async () =>
					options.cronAuthentication === true,
				...(options.noTrackCallback
					? undefined
					: { verifyPreviewScheduleTrack: async () => !options.wrongTrack }),
				mutationJournal: {
					persistence: "durable-cas",
					async claim({ mutationId, requestDigest }) {
						if (journalEntries.has(mutationId)) return { status: "uncertain" };
						journalEntries.set(mutationId, requestDigest);
						return { status: "claimed" };
					},
					async acknowledge() {},
					async uncertain() {},
				},
			},
			product,
		);
	return { calls, transport, resolver };
}

describe("Vercel deployment component configuration", () => {
	it("requires a private schedule-only function with an exact build target", () => {
		verifyVercelDeploymentComponent({
			configuration,
			component: { kind: "schedule-function", ...privateSchedule },
			environment: "production",
			plan: "pro",
		});
		expect(() =>
			verifyVercelDeploymentComponent({
				configuration,
				component: { kind: "schedule-function", ...privateSchedule },
				environment: "production",
				plan: "hobby",
			}),
		).toThrow(/timing/u);
		expect(() =>
			verifyVercelDeploymentComponent({
				configuration: {
					...configuration,
					functions: {
						...configuration.functions,
						"api/cd-tick.js": {
							experimentalTriggers: [
								{ type: "queue/v2beta", topic: "anything" },
							],
						},
					},
				},
				component: { kind: "schedule-function", ...privateSchedule },
				environment: "production",
				plan: "pro",
			}),
		).toThrow(/private/u);
		expect(() =>
			verifyVercelDeploymentComponent({
				configuration,
				component: {
					kind: "schedule-function",
					...privateSchedule,
					function: "api/other",
				},
				environment: "production",
				plan: "pro",
			}),
		).toThrow(/entry/u);
	});
	it("computes conservative intervals and rejects invalid field values", () => {
		expect(vercelCronMinimumInterval("*/15 * * * *")).toBe(15);
		expect(vercelCronMinimumInterval("5/20 * * * *")).toBe(20);
		expect(vercelCronMinimumInterval("0 0 * * *")).toBe(1440);
		for (const value of [
			"* * * *",
			"60 * * * *",
			"*/0 * * * *",
			"5-1 * * * *",
			"@daily",
		])
			expect(() => vercelCronMinimumInterval(value)).toThrow();
	});
	it("checks exact consumers and static schedule timing on the actual plan", () => {
		verifyVercelDeploymentComponent({
			configuration,
			component: { kind: "schedule", ...schedule },
			environment: "production",
			plan: "hobby",
		});
		expect(() =>
			verifyVercelDeploymentComponent({
				configuration,
				component: { kind: "schedule", ...schedule, maximumJitterSeconds: 899 },
				environment: "production",
				plan: "hobby",
			}),
		).toThrow(/timing/u);
		expect(() =>
			verifyVercelDeploymentComponent({
				configuration,
				component: { kind: "schedule", ...schedule, topic: "other" },
				environment: "production",
				plan: "pro",
			}),
		).toThrow(/topic/u);
	});
	it("requires production, a supported plan, the exact cron and a routed handler", () => {
		verifyVercelDeploymentComponent({
			configuration,
			component: { kind: "cron", ...cron },
			environment: "production",
			plan: "pro",
		});
		expect(() =>
			verifyVercelDeploymentComponent({
				configuration,
				component: { kind: "cron", ...cron },
				environment: "preview",
				plan: "pro",
			}),
		).toThrow(/production/u);
		expect(() =>
			verifyVercelDeploymentComponent({
				configuration,
				component: { kind: "cron", ...cron },
				environment: "production",
				plan: "hobby",
			}),
		).toThrow(/once per day/u);
		expect(() =>
			verifyVercelDeploymentComponent({
				configuration: { ...configuration, routes: [] },
				component: { kind: "cron", ...cron },
				environment: "production",
				plan: "pro",
			}),
		).toThrow(/route/u);
		expect(() =>
			verifyVercelDeploymentComponent({
				configuration: {
					...configuration,
					schedules: { duplicate: { path: cron.path, schedule: cron.cron } },
				},
				component: { kind: "cron", ...cron },
				environment: "production",
				plan: "pro",
			}),
		).toThrow(/twice/u);
	});
});

describe("Vercel deployment-owned component resolver", () => {
	it("rejects queues and schedules in a foreign slot before provider reads or writes", async () => {
		for (const [product, component, slot] of [
			[VERCEL_QUEUE_PRODUCT_ID, queue, "service"],
			[VERCEL_SCHEDULE_PRODUCT_ID, privateSchedule, "queue"],
			[VERCEL_CRON_PRODUCT_ID, cron, "queue"],
		] as const) {
			const f = fixture();
			const input = request(product, component);
			const foreign = { ...input, ref: { ...input.ref, slot } };
			const resolver = f.resolver(product);
			await expect(resolver.read?.(foreign, f.transport)).rejects.toThrow(
				/product differs from its requested slot/u,
			);
			await expect(resolver.reconcile(foreign, f.transport)).rejects.toThrow(
				/product differs from its requested slot/u,
			);
			await expect(resolver.delete?.(foreign, f.transport)).rejects.toThrow(
				/product differs from its requested slot/u,
			);
			expect(f.calls).toHaveLength(0);
		}
	});
	it("returns independently observed build identity for deployment-owned components", async () => {
		const digest = `sha256:${"c".repeat(64)}`;
		const f = fixture({ artifact: digest });
		const result = await f
			.resolver(VERCEL_SCHEDULE_PRODUCT_ID)
			.read?.(
				request(VERCEL_SCHEDULE_PRODUCT_ID, privateSchedule),
				f.transport,
			);
		expect(result?.outputs.artifactDigest).toBe(digest);
		const invalid = fixture({ artifact: "not-a-digest" });
		await expect(
			invalid
				.resolver(VERCEL_SCHEDULE_PRODUCT_ID)
				.read?.(
					request(VERCEL_SCHEDULE_PRODUCT_ID, privateSchedule),
					invalid.transport,
				),
		).rejects.toThrow(/artifact evidence is invalid/u);
	});
	it("observes and reconciles production activation only after the exact deployment is promoted", async () => {
		const staged = fixture({ plan: "pro" });
		const input = request(VERCEL_SCHEDULE_PRODUCT_ID, privateSchedule);
		const activeInput = {
			...input,
			ref: { ...input.ref, physicalId: "dpl_123" },
			desired: { ...input.desired, requireProductionScheduleActivation: true },
		};
		const stagedResult = await staged
			.resolver(VERCEL_SCHEDULE_PRODUCT_ID)
			.reconcile(activeInput, staged.transport);
		expect(stagedResult.outputs).toMatchObject({
			ready: false,
			activation: "not-observed",
		});
		expect(staged.calls.some((call) => call.method === "POST")).toBe(false);

		const foreign = fixture({
			plan: "pro",
			productionTrack: true,
			foreignProductionAlias: true,
		});
		expect(
			(
				await foreign
					.resolver(VERCEL_SCHEDULE_PRODUCT_ID)
					.reconcile(activeInput, foreign.transport)
			).outputs.ready,
		).toBe(false);
		expect(foreign.calls.some((call) => call.method === "POST")).toBe(false);

		const f = fixture({ plan: "pro", productionTrack: true });
		const resolver = f.resolver(VERCEL_SCHEDULE_PRODUCT_ID);
		expect(
			(await resolver.read?.(activeInput, f.transport))?.outputs,
		).toMatchObject({ ready: false, activation: "inactive" });
		expect(f.calls.every((call) => call.method === "GET")).toBe(true);
		expect(
			(await resolver.reconcile(activeInput, f.transport)).outputs,
		).toMatchObject({ ready: true, activation: "active" });
		expect(
			f.calls
				.filter((call) => call.method === "POST")
				.map((call) => new URL(call.url).pathname),
		).toEqual(["/v1/schedules/hobo-cd-tick/enable"]);
		expect(
			f.calls.find(
				(call) => new URL(call.url).hostname === "vercel-schedules.com",
			)?.url,
		).not.toContain("branch=");
	});
	it("does not infer production activation from a missing or mismatched schedule", async () => {
		const input = request(VERCEL_SCHEDULE_PRODUCT_ID, schedule);
		const activeInput = {
			...input,
			ref: { ...input.ref, physicalId: "dpl_123" },
			desired: { ...input.desired, requireProductionScheduleActivation: true },
		};
		const missing = fixture({
			plan: "pro",
			productionTrack: true,
			missingProductionSchedule: true,
		});
		expect(
			(
				await missing
					.resolver(VERCEL_SCHEDULE_PRODUCT_ID)
					.read?.(activeInput, missing.transport)
			)?.outputs.ready,
		).toBe(false);
		const wrong = fixture({
			plan: "pro",
			productionTrack: true,
			wrongSchedule: true,
		});
		await expect(
			wrong
				.resolver(VERCEL_SCHEDULE_PRODUCT_ID)
				.read?.(activeInput, wrong.transport),
		).rejects.toThrow(/differs/u);
		expect(wrong.calls.every((call) => call.method === "GET")).toBe(true);
		const incorrectJitter = fixture({
			plan: "pro",
			productionTrack: true,
			wrongJitter: true,
		});
		await expect(
			incorrectJitter
				.resolver(VERCEL_SCHEDULE_PRODUCT_ID)
				.read?.(activeInput, incorrectJitter.transport),
		).rejects.toThrow(/differs/u);
		const defaultJitter = fixture({
			plan: "pro",
			productionTrack: true,
			previewActive: true,
			omitJitter: true,
		});
		expect(
			(
				await defaultJitter
					.resolver(VERCEL_SCHEDULE_PRODUCT_ID)
					.read?.(activeInput, defaultJitter.transport)
			)?.outputs.activation,
		).toBe("active");
	});
	it("verifies a private schedule function without reading a cron secret", async () => {
		const f = fixture({ plan: "pro" });
		const result = await f
			.resolver(VERCEL_SCHEDULE_PRODUCT_ID)
			.reconcile(
				request(VERCEL_SCHEDULE_PRODUCT_ID, privateSchedule),
				f.transport,
			);
		expect(result.outputs).toMatchObject({
			ready: true,
			component: "schedule-function",
			activation: "not-observed",
		});
		expect(
			f.calls.some((call) => new URL(call.url).pathname.endsWith("/env")),
		).toBe(false);
	});
	it("enables and retires a private preview schedule on the exact deployment track", async () => {
		const f = fixture({ plan: "pro", preview: true });
		const input = request(VERCEL_SCHEDULE_PRODUCT_ID, privateSchedule, {
			environment: "preview",
		});
		const pinned = { ...input, ref: { ...input.ref, physicalId: "dpl_123" } };
		const r = f.resolver(VERCEL_SCHEDULE_PRODUCT_ID);
		expect((await r.reconcile(input, f.transport)).outputs.activation).toBe(
			"active",
		);
		await r.delete(pinned, f.transport);
		expect(
			f.calls
				.filter((call) => call.method === "POST")
				.map((call) => new URL(call.url).pathname),
		).toEqual([
			"/v1/schedules/hobo-cd-tick/enable",
			"/v1/schedules/hobo-cd-tick/disable",
		]);
	});
	it("reuses the exact provider deployment without creating or deleting it", async () => {
		const f = fixture();
		const input = request(VERCEL_QUEUE_PRODUCT_ID, queue);
		const result = await f
			.resolver(VERCEL_QUEUE_PRODUCT_ID)
			.reconcile(input, f.transport);
		expect(result).toMatchObject({
			action: "adopt",
			physicalId: "dpl_123",
			outputs: { ready: true, activation: "not-observed" },
		});
		const pinned = { ...input, ref: { ...input.ref, physicalId: "dpl_123" } };
		expect(
			(await f.resolver(VERCEL_QUEUE_PRODUCT_ID).reconcile(pinned, f.transport))
				.action,
		).toBe("noop");
		await f.resolver(VERCEL_QUEUE_PRODUCT_ID).delete(pinned, f.transport);
		expect(f.calls.every((call) => call.method === "GET")).toBe(true);
	});
	it("rejects a foreign project, a different revision, a missing build and an absent owner", async () => {
		for (const options of [
			{ wrongProject: true },
			{ wrongRevision: true },
			{ missingBuild: true },
			{ missingDeployment: true },
		]) {
			const f = fixture(options);
			await expect(
				f
					.resolver(VERCEL_QUEUE_PRODUCT_ID)
					.reconcile(request(VERCEL_QUEUE_PRODUCT_ID, queue), f.transport),
			).rejects.toThrow();
			expect(f.calls.every((call) => call.method === "GET")).toBe(true);
		}
	});
	it("only reports absence after the shared deployment is absent", async () => {
		const f = fixture({ missingDeployment: true });
		const input = request(VERCEL_QUEUE_PRODUCT_ID, queue);
		expect(
			await f
				.resolver(VERCEL_QUEUE_PRODUCT_ID)
				.observeAbsence?.(
					{ ...input, ref: { ...input.ref, physicalId: "dpl_123" } },
					f.transport,
				),
		).toBe(true);
	});
	it("refuses queue retirement unless delayed and in-flight deliveries are drained and producers remain fenced", async () => {
		const input = request(VERCEL_QUEUE_PRODUCT_ID, queue);
		const pinned = { ...input, ref: { ...input.ref, physicalId: "dpl_123" } };
		for (const options of [{ queueDrained: false }, { queueFenced: false }]) {
			const f = fixture(options);
			await expect(
				f.resolver(VERCEL_QUEUE_PRODUCT_ID).delete(pinned, f.transport),
			).rejects.toThrow(/drain.*fence/u);
			expect(f.calls.every((call) => call.method === "GET")).toBe(true);
		}
		const f = fixture();
		await expect(
			f.resolver(VERCEL_QUEUE_PRODUCT_ID).delete(pinned, f.transport),
		).resolves.toBeUndefined();
	});
	it("keeps GitHub and Vercel credentials on their own hosts", async () => {
		const f = fixture({ gitToken: true });
		await f.resolver(VERCEL_QUEUE_PRODUCT_ID).reconcile(
			request(VERCEL_QUEUE_PRODUCT_ID, queue, {
				gitSourceAuthRef: "hobo-secret://github/source",
			}),
			f.transport,
		);
		for (const call of f.calls)
			expect(call.headers?.authorization).toBe(
				new URL(call.url).hostname === "api.github.com"
					? "Bearer git-token"
					: "Bearer vercel-token",
			);
	});
	it("observes preview without effects, then enables and verifies its exact branch schedule", async () => {
		const input = request(VERCEL_SCHEDULE_PRODUCT_ID, schedule, {
			environment: "preview",
		});
		const f = fixture({ preview: true });
		const r = f.resolver(VERCEL_SCHEDULE_PRODUCT_ID);
		expect((await r.read?.(input, f.transport))?.outputs.ready).toBe(false);
		expect(f.calls.some((call) => call.method === "POST")).toBe(false);
		expect((await r.reconcile(input, f.transport)).outputs).toMatchObject({
			ready: true,
			activation: "active",
		});
		const mutation = f.calls.find((call) => call.method === "POST");
		expect(mutation?.body).toBeUndefined();
		expect(new URL(mutation?.url ?? "").searchParams.get("branch")).toBe(
			previewBranch,
		);
		await r.reconcile(input, f.transport);
		expect(f.calls.filter((call) => call.method === "POST")).toHaveLength(1);
	});
	it("does not activate a branch whose current deployment is unverified", async () => {
		const f = fixture({ preview: true, wrongTrack: true });
		await expect(
			f.resolver(VERCEL_SCHEDULE_PRODUCT_ID).reconcile(
				request(VERCEL_SCHEDULE_PRODUCT_ID, schedule, {
					environment: "preview",
				}),
				f.transport,
			),
		).rejects.toThrow(/track/u);
		expect(f.calls.every((call) => call.method === "GET")).toBe(true);
	});
	it("uses provider preview-alias identity and rejects contradictory aliases", async () => {
		const input = request(VERCEL_SCHEDULE_PRODUCT_ID, schedule, {
			environment: "preview",
		});
		const native = fixture({
			preview: true,
			nativeTrack: true,
		});
		expect(
			(
				await native
					.resolver(VERCEL_SCHEDULE_PRODUCT_ID)
					.reconcile(input, native.transport)
			).outputs.ready,
		).toBe(true);
		const unfenced = fixture({
			preview: true,
			nativeTrack: true,
			noTrackCallback: true,
		});
		await expect(
			unfenced
				.resolver(VERCEL_SCHEDULE_PRODUCT_ID)
				.reconcile(input, unfenced.transport),
		).rejects.toThrow(/track is not verified/u);
		const foreign = fixture({ preview: true, foreignAlias: true });
		await expect(
			foreign
				.resolver(VERCEL_SCHEDULE_PRODUCT_ID)
				.reconcile(input, foreign.transport),
		).rejects.toThrow(/different deployment/u);
		expect(foreign.calls.every((call) => call.method === "GET")).toBe(true);
	});
	it("recovers a lost activation response without a duplicate mutation", async () => {
		const f = fixture({ preview: true, lostEnable: true });
		const input = request(VERCEL_SCHEDULE_PRODUCT_ID, schedule, {
			environment: "preview",
		});
		const r = f.resolver(VERCEL_SCHEDULE_PRODUCT_ID);
		await expect(r.reconcile(input, f.transport)).rejects.toThrow(/uncertain/u);
		expect((await r.reconcile(input, f.transport)).outputs.ready).toBe(true);
		expect(f.calls.filter((call) => call.method === "POST")).toHaveLength(1);
	});
	it("disables the scoped preview schedule before the owning deployment is removed", async () => {
		const f = fixture({ preview: true, previewActive: true });
		const input = request(VERCEL_SCHEDULE_PRODUCT_ID, schedule, {
			environment: "preview",
		});
		const pinned = { ...input, ref: { ...input.ref, physicalId: "dpl_123" } };
		const r = f.resolver(VERCEL_SCHEDULE_PRODUCT_ID);
		await r.delete(pinned, f.transport);
		expect((await r.read?.(pinned, f.transport))?.outputs.ready).toBe(false);
		await r.delete(pinned, f.transport);
		expect(f.calls.filter((call) => call.method === "POST")).toHaveLength(1);
		expect(f.calls.find((call) => call.method === "POST")?.url).toContain(
			"/disable?",
		);
	});
	it("requires both protected production credential metadata and independently verified handler authentication", async () => {
		const input = request(VERCEL_CRON_PRODUCT_ID, cron);
		for (const options of [
			{ missingCronSecret: true, cronAuthentication: true },
			{ cronAuthentication: false },
			{ plan: "hobby", cronAuthentication: true },
		]) {
			const f = fixture(options);
			await expect(
				f.resolver(VERCEL_CRON_PRODUCT_ID).reconcile(input, f.transport),
			).rejects.toThrow();
		}
		const f = fixture({ cronAuthentication: true });
		expect(
			(await f.resolver(VERCEL_CRON_PRODUCT_ID).reconcile(input, f.transport))
				.outputs.ready,
		).toBe(true);
		expect(
			f.calls.find((call) => new URL(call.url).pathname.endsWith("/env"))?.url,
		).toContain("decrypt=false");
	});
});
