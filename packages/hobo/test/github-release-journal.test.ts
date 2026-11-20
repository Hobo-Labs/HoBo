import { describe, expect, it } from "vitest";
import {
	createGithubReleaseJournal,
	findPendingGithubRelease,
} from "../src/github-release-journal.js";
import { isJsonString } from "../src/json.js";

const SHA = "0123456789abcdef0123456789abcdef01234567";
const TOKEN = "synthetic-github-token";
const reservation = {
	deploymentId: "dpl_new",
	previousDeploymentId: "dpl_old",
	commit: SHA,
	state: "reserved" as const,
};

function fixture(createdResponseId = 42) {
	const deployments: {
		id: number;
		sha: string;
		environment: string;
		payload: object;
	}[] = [];
	const statuses: { state: string }[] = [];
	const calls: { method: string; url: string; body?: string }[] = [];
	const fetcher: typeof fetch = async (raw, init) => {
		const url = new URL(String(raw));
		const method = init?.method ?? "GET";
		const body = isJsonString(init?.body) ? init.body : undefined;
		calls.push({ method, url: url.href, ...(body ? { body } : undefined) });
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
			const input = JSON.parse(body ?? "{}");
			const record = {
				id: 42,
				sha: SHA,
				environment: input.environment,
				payload: input.payload,
			};
			deployments.push(record);
			return Response.json(
				{ ...record, id: createdResponseId },
				{ status: 201 },
			);
		}
		if (method === "POST" && url.pathname.endsWith("/statuses")) {
			const status = JSON.parse(body ?? "{}");
			statuses.push(status);
			return Response.json(status, { status: 201 });
		}
		return Response.json({}, { status: 404 });
	};
	const journal = () =>
		createGithubReleaseJournal({
			repository: "Hobo-Labs/HoBo",
			token: TOKEN,
			commit: SHA,
			deploymentId: "dpl_new",
			fetch: fetcher,
		});
	const pending = () =>
		findPendingGithubRelease({
			repository: "Hobo-Labs/HoBo",
			token: TOKEN,
			commit: SHA,
			fetch: fetcher,
		});
	return { journal, pending, calls, deployments };
}

describe("GitHub release checkpoints", () => {
	it("persists the prior deployment before release and recovers it on another runner", async () => {
		const f = fixture();
		const first = f.journal();
		expect(await first.load()).toBeUndefined();
		expect(await first.reserve(reservation)).toEqual({
			checkpoint: reservation,
			created: true,
		});
		expect(await f.pending()).toEqual(reservation);
		const restarted = f.journal();
		expect(await restarted.load()).toEqual(reservation);
		expect(await restarted.reserve(reservation)).toEqual({
			checkpoint: reservation,
			created: false,
		});
		await restarted.save({ ...reservation, state: "verified" });
		expect(await first.load()).toEqual({ ...reservation, state: "verified" });
		expect(await f.pending()).toBeUndefined();
		const created = f.calls.find(
			(call) => call.method === "POST" && call.url.endsWith("/deployments"),
		);
		const payload = JSON.parse(created?.body ?? "{}");
		expect(payload.production_environment).toBe(false);
		expect(payload.auto_merge).toBe(false);
		expect(payload.payload.previousDeploymentId).toBe("dpl_old");
		expect(JSON.stringify(f.calls)).not.toContain(TOKEN);
	});

	it("refuses ambiguous checkpoint records before any promotion can rely on them", async () => {
		const f = fixture();
		await f.journal().reserve(reservation);
		const existing = f.deployments[0];
		if (!existing) throw new Error("Expected the reserved checkpoint.");
		f.deployments.push(existing);
		await expect(f.journal().load()).rejects.toThrow(/ambiguous/u);
	});

	it("does not claim a reservation when the creation receipt names another record", async () => {
		const f = fixture(43);
		await expect(f.journal().reserve(reservation)).rejects.toThrow(
			/not confirmed/u,
		);
	});

	it("rejects an invalid rollback target before creating a checkpoint", async () => {
		const f = fixture();
		await expect(
			f.journal().reserve({ ...reservation, previousDeploymentId: "invalid" }),
		).rejects.toThrow(/invalid/iu);
		expect(f.calls.some((call) => call.method === "POST")).toBe(false);
	});

	it("finds the matching checkpoint after a full page of same-commit history", async () => {
		const fetcher: typeof fetch = async (raw) => {
			const url = new URL(String(raw));
			if (url.pathname.endsWith("/statuses")) return Response.json([]);
			if (url.searchParams.get("page") === "1")
				return Response.json(
					Array.from({ length: 100 }, () => ({ payload: {} })),
				);
			return Response.json([
				{
					id: 42,
					sha: SHA,
					environment: "hobo-ci-release-checkpoint",
					payload: { schema: "hobo.release-checkpoint/v1", ...reservation },
				},
			]);
		};
		const journal = createGithubReleaseJournal({
			repository: "Hobo-Labs/HoBo",
			token: TOKEN,
			commit: SHA,
			deploymentId: "dpl_new",
			fetch: fetcher,
		});
		expect(await journal.load()).toEqual(reservation);
	});

	it("finds an unfinished older commit across paginated deployment history", async () => {
		const older = "f".repeat(40);
		let calls = 0;
		const fetcher: typeof fetch = async () => {
			calls++;
			const item =
				calls === 1
					? {
							databaseId: 2,
							commitOid: SHA,
							environment: "hobo-ci-release-checkpoint",
							payload: JSON.stringify({
								schema: "hobo.release-checkpoint/v1",
								...reservation,
							}),
							latestStatus: { state: "SUCCESS" },
						}
					: {
							databaseId: 1,
							commitOid: older,
							environment: "hobo-ci-release-checkpoint",
							payload: JSON.stringify({
								schema: "hobo.release-checkpoint/v1",
								...reservation,
								commit: older,
							}),
							latestStatus: null,
						};
			return Response.json({
				data: {
					repository: {
						deployments: {
							nodes: [item],
							pageInfo: {
								hasNextPage: calls === 1,
								endCursor: calls === 1 ? "next" : null,
							},
						},
					},
				},
			});
		};
		expect(
			await findPendingGithubRelease({
				repository: "Hobo-Labs/HoBo",
				token: TOKEN,
				commit: SHA,
				fetch: fetcher,
			}),
		).toEqual({ ...reservation, commit: older });
		expect(calls).toBe(2);
	});
});
