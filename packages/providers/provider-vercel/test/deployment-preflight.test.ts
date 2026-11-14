import type { HttpTransport, TransportRequest } from "@hobo/core";
import { describe, expect, it } from "vitest";
import {
	preflightVercelGitDeployment,
	type VercelDeploymentPreflightInput,
} from "../src/deployment-preflight.js";
import type { VercelResolverOptions } from "../src/resolvers.js";

const sha = "0123456789abcdef0123456789abcdef01234567";
const input: VercelDeploymentPreflightInput = {
	teamId: "team_123",
	project: "hobo-ci",
	organization: "Hobo-Labs",
	repository: "HoBo",
	revision: sha,
	rootDirectory: "packages/ci-vercel",
	buildCommand: "pnpm build",
	environment: "production",
	credentialRef: "hobo-secret://vercel/team",
	components: [
		{
			kind: "schedule",
			name: "repair",
			cron: "*/15 * * * *",
			topic: "hobo-ci",
			entry: "api/queue.ts",
			maximumJitterSeconds: 900,
		},
	],
};
function fixture(
	options: {
		wrongLink?: boolean;
		missingLink?: boolean;
		missingProject?: boolean;
		wrongRevision?: boolean;
		plan?: string;
		wrongConfig?: boolean;
		autoGit?: boolean;
		wrongSettings?: boolean;
		sourceError?: boolean;
		gitAuth?: boolean;
		missingEntry?: boolean;
		wrongHttpRoute?: boolean;
		malformedLink?: boolean;
		wrongBranch?: boolean;
	} = {},
) {
	const calls: TransportRequest[] = [];
	const scopes: unknown[] = [];
	const transport: HttpTransport = async (call) => {
		calls.push(call);
		const url = new URL(call.url);
		if (url.hostname === "api.github.com") {
			if (options.sourceError) throw new Error("private-token-must-not-leak");
			if (url.pathname.includes("/git/commits/"))
				return {
					status: 200,
					headers: {},
					body: JSON.stringify({
						sha: options.wrongRevision ? "f".repeat(40) : sha,
					}),
				};
			if (url.pathname.includes("/git/ref/heads/"))
				return {
					status: 200,
					headers: {},
					body: JSON.stringify({
						ref: "refs/heads/hobo-preview",
						object: { sha: options.wrongBranch ? "f".repeat(40) : sha },
					}),
				};
			if (url.pathname.endsWith("/vercel.json"))
				return {
					status: 200,
					headers: {},
					body: JSON.stringify({
						git: { deploymentEnabled: options.autoGit === true },
						functions: {
							"api/queue.ts": {
								experimentalTriggers: [
									{ type: "queue/v2beta", topic: "hobo-ci" },
								],
							},
							"api/cd-tick.js": {
								experimentalTriggers: [{ type: "schedule/v1beta" }],
							},
						},
						schedules: {
							repair: {
								schedule: options.wrongConfig ? "* * * * *" : "*/15 * * * *",
								topic: "hobo-ci",
							},
							"hobo-cd-tick": {
								schedule: "* * * * *",
								function: "api/cd-tick",
							},
						},
						crons: [{ path: "/internal/tick", schedule: "* * * * *" }],
						routes: [
							{ src: "/internal/tick", dest: "/api/tick" },
							{
								src: "/(.*)",
								dest: options.wrongHttpRoute ? "/api/other" : "/api/http",
								transforms: [{ type: "request.path", op: "set", args: "/$1" }],
							},
						],
					}),
				};
			if (options.missingEntry && url.pathname.endsWith("/api/http.js"))
				return { status: 404, headers: {}, body: "{}" };
			return {
				status: 200,
				headers: {},
				body: "export default function handler() {}",
			};
		}
		if (url.pathname === "/v9/projects/hobo-ci") {
			if (options.missingProject)
				return { status: 404, headers: {}, body: "{}" };
			return {
				status: 200,
				headers: {},
				body: JSON.stringify({
					id: "prj_123",
					name: "hobo-ci",
					accountId: "team_123",
					rootDirectory: options.wrongSettings ? "wrong" : "packages/ci-vercel",
					buildCommand: "pnpm build",
					link: options.malformedLink
						? "not-a-link"
						: options.missingLink
							? null
							: {
									type: "github",
									org: "Hobo-Labs",
									repo: options.wrongLink ? "Other" : "HoBo",
								},
				}),
			};
		}
		if (url.pathname === "/v2/teams/team_123")
			return {
				status: 200,
				headers: {},
				body: JSON.stringify({
					id: "team_123",
					billing: { plan: options.plan ?? "hobby" },
				}),
			};
		return { status: 404, headers: {}, body: "{}" };
	};
	return {
		calls,
		scopes,
		transport,
		options: {
			teamId: "team_123",
			resolveCredential: async () => "vercel-token",
			...(options.gitAuth
				? {
						resolveGitCredential: async (
							_ref: string,
							scope: Parameters<
								NonNullable<VercelResolverOptions["resolveGitCredential"]>
							>[1],
						) => {
							scopes.push(scope);
							return "github-token";
						},
					}
				: undefined),
		},
	};
}
describe("Vercel read-only deployment preflight", () => {
	it("requires a real preview branch whose current head is the approved SHA", async () => {
		const f = fixture();
		const preview = {
			...input,
			environment: "preview" as const,
			previewBranch: "hobo-preview",
		};
		expect(
			await preflightVercelGitDeployment(preview, f.options, f.transport),
		).toMatchObject({
			previewBranch: "hobo-preview",
			previewScheduleActivation: "requires-enable",
		});
		expect(f.calls.every((call) => call.method === "GET")).toBe(true);
		await expect(
			preflightVercelGitDeployment(
				{ ...preview, previewBranch: sha },
				f.options,
				f.transport,
			),
		).rejects.toThrow(/branch name/u);
		const wrong = fixture({ wrongBranch: true });
		await expect(
			preflightVercelGitDeployment(preview, wrong.options, wrong.transport),
		).rejects.toThrow(/branch head/u);
	});
	it("checks the declared HTTP entry as well as queue and schedule entries", async () => {
		const f = fixture();
		const route = {
			src: "/(.*)",
			dest: "/api/http",
			transforms: [{ type: "request.path", op: "set", args: "/$1" }],
		};
		const evidence = await preflightVercelGitDeployment(
			{ ...input, requiredEntries: ["api/http.js"], requiredRoutes: [route] },
			f.options,
			f.transport,
		);
		expect(evidence.entriesChecked).toBe(2);
		expect(evidence.routesChecked).toBe(1);
		expect(
			f.calls.some((call) =>
				new URL(call.url).pathname.endsWith("/api/http.js"),
			),
		).toBe(true);
		const missing = fixture({ missingEntry: true });
		await expect(
			preflightVercelGitDeployment(
				{ ...input, requiredEntries: ["api/http.js"] },
				missing.options,
				missing.transport,
			),
		).rejects.toThrow(/GitHub function source preflight/u);
		const wrongRoute = fixture({ wrongHttpRoute: true });
		await expect(
			preflightVercelGitDeployment(
				{ ...input, requiredEntries: ["api/http.js"], requiredRoutes: [route] },
				wrongRoute.options,
				wrongRoute.transport,
			),
		).rejects.toThrow(/route differs/u);
	});
	it("checks linked project, exact remote revision, entry and actual plan without mutations", async () => {
		const f = fixture();
		expect(
			await preflightVercelGitDeployment(input, f.options, f.transport),
		).toMatchObject({
			teamId: "team_123",
			projectId: "prj_123",
			projectAction: "none",
			gitLinkAction: "none",
			revision: sha,
			componentsChecked: 1,
			billingPlan: "hobby",
			deploymentPermission: "not-observed",
			gitLinkPermission: "not-observed",
			scheduleCapacity: "not-observed",
			runtimeAuthentication: "not-observed",
		});
		expect(f.calls.every((call) => call.method === "GET")).toBe(true);
		expect(
			f.calls
				.filter((call) => new URL(call.url).hostname === "api.github.com")
				.every((call) => !call.headers?.authorization),
		).toBe(true);
	});
	it("rejects foreign projects, mismatched revision, and incompatible configuration", async () => {
		for (const options of [
			{ wrongLink: true },
			{ malformedLink: true },
			{ wrongRevision: true },
			{ wrongConfig: true },
		]) {
			const f = fixture(options);
			await expect(
				preflightVercelGitDeployment(input, f.options, f.transport),
			).rejects.toThrow();
			expect(f.calls.every((call) => call.method === "GET")).toBe(true);
		}
	});
	it("plans project creation, settings updates, and missing links without making mutations", async () => {
		for (const [options, expected] of [
			[
				{ missingProject: true },
				{ projectAction: "create", gitLinkAction: "create-with-project" },
			],
			[{ missingLink: true }, { projectAction: "none", gitLinkAction: "link" }],
			[
				{ wrongSettings: true },
				{ projectAction: "update", gitLinkAction: "none" },
			],
		] as const) {
			const f = fixture(options);
			expect(
				await preflightVercelGitDeployment(input, f.options, f.transport),
			).toMatchObject({
				...expected,
				deploymentPermission: "not-observed",
				gitLinkPermission: "not-observed",
			});
			expect(f.calls.every((call) => call.method === "GET")).toBe(true);
		}
		const foreign = fixture({ wrongLink: true });
		await expect(
			preflightVercelGitDeployment(input, foreign.options, foreign.transport),
		).rejects.toMatchObject({ reason: "PROJECT_GIT_MISMATCH" });
	});
	it("rejects Git-driven deployments that bypass the budget supervisor", async () => {
		const f = fixture({ autoGit: true });
		await expect(
			preflightVercelGitDeployment(input, f.options, f.transport),
		).rejects.toMatchObject({ reason: "UNSUPERVISED_GIT_DEPLOYMENT" });
	});
	it("does not treat Hobby timing as sufficient for a minute cron", async () => {
		const f = fixture();
		const cron: VercelDeploymentPreflightInput = {
			...input,
			components: [
				{
					kind: "cron",
					path: "/internal/tick",
					cron: "* * * * *",
					entry: "api/tick.ts",
					maximumJitterSeconds: 60,
				},
			],
		};
		await expect(
			preflightVercelGitDeployment(cron, f.options, f.transport),
		).rejects.toThrow(/once per day/u);
	});
	it("checks a private scheduled function against the actual plan and source", async () => {
		const f = fixture({ plan: "pro" });
		const candidate: VercelDeploymentPreflightInput = {
			...input,
			components: [
				{
					kind: "schedule-function",
					name: "hobo-cd-tick",
					cron: "* * * * *",
					entry: "api/cd-tick.js",
					function: "api/cd-tick",
					maximumJitterSeconds: 60,
				},
			],
		};
		expect(
			await preflightVercelGitDeployment(candidate, f.options, f.transport),
		).toMatchObject({ billingPlan: "pro", componentsChecked: 1 });
		const hobby = fixture();
		await expect(
			preflightVercelGitDeployment(candidate, hobby.options, hobby.transport),
		).rejects.toThrow(/timing/u);
	});
	it("rejects duplicate and invalid component targets before provider I/O", async () => {
		const f = fixture();
		await expect(
			preflightVercelGitDeployment(
				{ ...input, components: [...input.components, ...input.components] },
				f.options,
				f.transport,
			),
		).rejects.toThrow(/duplicated/u);
		await expect(
			preflightVercelGitDeployment(
				{
					...input,
					components: [
						{ kind: "queue", topic: "../outside", entry: "api/queue.ts" },
					],
				},
				f.options,
				f.transport,
			),
		).rejects.toThrow(/invalid name/u);
		expect(f.calls).toHaveLength(0);
	});
	it("uses separate scoped GitHub custody and never sends it to Vercel", async () => {
		const f = fixture({ gitAuth: true });
		await preflightVercelGitDeployment(
			{ ...input, gitSourceAuthRef: "hobo-secret://github/source" },
			f.options,
			f.transport,
		);
		expect(f.scopes).toEqual([
			{ organization: "Hobo-Labs", repository: "HoBo", revision: sha },
		]);
		for (const call of f.calls)
			expect(call.headers?.authorization).toBe(
				new URL(call.url).hostname === "api.github.com"
					? "Bearer github-token"
					: "Bearer vercel-token",
			);
	});
	it("redacts upstream failures instead of returning source credentials", async () => {
		const f = fixture({ sourceError: true, gitAuth: true });
		await expect(
			preflightVercelGitDeployment(
				{ ...input, gitSourceAuthRef: "hobo-secret://github/source" },
				f.options,
				f.transport,
			),
		).rejects.toThrow(/^GitHub preflight read failed$/u);
	});
});
