import { describe, expect, it } from "vitest";

import type { JsonObject } from "../src/json.js";
import {
	createVercelClient,
	VercelApiError,
	type VercelFetch,
	type VercelFetchResponse,
} from "../src/vercel-client.js";

// Promote and rollback move production between deployments that already
// exist, with no rebuild: the build-once half of HoBo.CD's Vercel delivery.
// NO network: every request goes to a scripted transport.

type SentInit = Parameters<VercelFetch>[1];

interface Sent {
	readonly url: string;
	readonly init: SentInit;
}

function reply(status: number, body: JsonObject): VercelFetchResponse {
	return {
		ok: status >= 200 && status < 300,
		status,
		async text() {
			return JSON.stringify(body);
		},
		async json() {
			return body;
		},
	};
}

function scripted(answers: readonly VercelFetchResponse[]) {
	const sent: Sent[] = [];
	let next = 0;
	const fetch: VercelFetch = async (url, init) => {
		sent.push({ url, init });
		const answer = answers[next];
		next += 1;
		if (answer === undefined) throw new Error(`unexpected request ${url}`);
		return answer;
	};
	return { fetch, sent };
}

const TOKEN = "synthetic-vercel-token-for-tests";
const TEAM = "team_BRBUnG6uGhSsVV3EG5GFV3FM";
const PROJECT = "prj_J5YGgyIQm09MKI0uqyi0hl9cYrBO";

describe("promote and rollback", () => {
	it("promotes a deployment by id with no body, team-scoped", async () => {
		const transport = scripted([reply(201, {})]);
		const client = createVercelClient({
			token: TOKEN,
			teamId: TEAM,
			fetch: transport.fetch,
		});
		await client.promoteDeployment(PROJECT, "dpl_staged1");
		expect(transport.sent).toHaveLength(1);
		const [request] = transport.sent;
		expect(request?.url).toBe(
			`https://api.vercel.com/v10/projects/${PROJECT}/promote/dpl_staged1?teamId=${TEAM}`,
		);
		expect(request?.init.method).toBe("POST");
		expect(request?.init.body).toBeUndefined();
		expect(request?.init.headers).toEqual({
			Authorization: `Bearer ${TOKEN}`,
		});
	});

	it("accepts 202 (promotion queued) as success", async () => {
		const transport = scripted([reply(202, {})]);
		const client = createVercelClient({ token: TOKEN, fetch: transport.fetch });
		await expect(
			client.promoteDeployment(PROJECT, "dpl_staged1"),
		).resolves.toBeUndefined();
	});

	it("fails typed when Vercel refuses the promotion, without the token", async () => {
		const transport = scripted([
			reply(409, {
				error: {
					code: "deployment_not_ready",
					message: "The deployment is not ready to be promoted",
				},
			}),
		]);
		const client = createVercelClient({ token: TOKEN, fetch: transport.fetch });
		const error = await client
			.promoteDeployment(PROJECT, "dpl_staged1")
			.catch((caught: unknown) => caught);
		expect(error).toBeInstanceOf(VercelApiError);
		expect(String(error)).not.toContain(TOKEN);
		expect(error).toMatchObject({ status: 409, code: "deployment_not_ready" });
	});

	it("rolls production back to an earlier deployment, with a bounded description", async () => {
		const transport = scripted([reply(201, {})]);
		const client = createVercelClient({
			token: TOKEN,
			teamId: TEAM,
			fetch: transport.fetch,
		});
		await client.rollbackProduction(
			PROJECT,
			"dpl_previous",
			"hobo ci deploy: production verification failed",
		);
		const url = new URL(transport.sent[0]?.url ?? "");
		expect(url.pathname).toBe(`/v1/projects/${PROJECT}/rollback/dpl_previous`);
		expect(url.searchParams.get("teamId")).toBe(TEAM);
		expect(url.searchParams.get("description")).toBe(
			"hobo ci deploy: production verification failed",
		);
		expect(transport.sent[0]?.init.method).toBe("POST");
	});

	it("refuses an id that is not a Vercel id before sending anything", async () => {
		const transport = scripted([]);
		const client = createVercelClient({ token: TOKEN, fetch: transport.fetch });
		await expect(
			client.promoteDeployment(PROJECT, "../dpl_x"),
		).rejects.toThrow();
		await expect(
			client.rollbackProduction("prj/../other", "dpl_x"),
		).rejects.toThrow();
		expect(transport.sent).toHaveLength(0);
	});
});

describe("what production serves, and what a Freight staged", () => {
	it("reads the canonical project id and the deployment production serves", async () => {
		const transport = scripted([
			reply(200, {
				id: PROJECT,
				targets: {
					production: { id: "dpl_live", url: "hobo-ci-abc.vercel.app" },
				},
			}),
		]);
		const client = createVercelClient({
			token: TOKEN,
			teamId: TEAM,
			fetch: transport.fetch,
		});
		expect(await client.readProject("hobo-ci")).toEqual({
			id: PROJECT,
			productionDeploymentId: "dpl_live",
		});
		expect(transport.sent[0]?.url).toBe(
			`https://api.vercel.com/v9/projects/hobo-ci?teamId=${TEAM}`,
		);
		expect(transport.sent[0]?.init.method).toBe("GET");
	});

	it("answers undefined for a project production has never served", async () => {
		const transport = scripted([reply(200, { id: PROJECT, targets: {} })]);
		const client = createVercelClient({ token: TOKEN, fetch: transport.fetch });
		expect(await client.readProject(PROJECT)).toEqual({ id: PROJECT });
	});

	it("lists production builds with their meta, newest first as Vercel answers", async () => {
		const transport = scripted([
			reply(200, {
				deployments: [
					{
						uid: "dpl_staged",
						url: "hobo-ci-staged.vercel.app",
						state: "READY",
						target: "production",
						created: 1_794_600_000_000,
						meta: { hoboFreight: "frt_1", hoboSha: "a".repeat(40), n: 3 },
					},
					{ url: "no-id.vercel.app" },
					"not an object",
				],
			}),
		]);
		const client = createVercelClient({
			token: TOKEN,
			teamId: TEAM,
			fetch: transport.fetch,
		});
		const found = await client.listProjectDeployments({
			project: PROJECT,
			target: "production",
			limit: 500,
		});
		expect(found).toEqual([
			{
				id: "dpl_staged",
				url: "https://hobo-ci-staged.vercel.app",
				readyState: "READY",
				target: "production",
				createdAt: 1_794_600_000_000,
				meta: { hoboFreight: "frt_1", hoboSha: "a".repeat(40) },
			},
		]);
		const url = new URL(transport.sent[0]?.url ?? "");
		expect(url.pathname).toBe("/v6/deployments");
		expect(url.searchParams.get("projectId")).toBe(PROJECT);
		expect(url.searchParams.get("target")).toBe("production");
		// One page, capped at Vercel's maximum.
		expect(url.searchParams.get("limit")).toBe("100");
		expect(url.searchParams.get("teamId")).toBe(TEAM);
	});
});
