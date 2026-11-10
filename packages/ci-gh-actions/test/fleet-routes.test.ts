import { create } from "@bufbuild/protobuf";
import { AccountSchema, LeaseSchema, OfferSchema } from "@hobo/ci";
import { describe, expect, it } from "vitest";
import {
	createFleetRoutePublisher,
	type FleetRouteLog,
} from "../src/fleet-routes.js";
import type { GithubTransport } from "../src/github.js";

const REPOSITORY = "Hobo-Labs/HoBo";

function account() {
	const offer = (id: string, provider: string, runsOn: string, backend = "") =>
		create(OfferSchema, {
			id,
			provider,
			providerAccountId: `${provider}-account`,
			enabled: true,
			runsOn,
			backend,
			concurrency: 2,
			budgetMicros: backend === "isolated-container" ? 0 : 1_000_000,
			observedAt: "2026-11-09T00:00:00Z",
			validUntil: "2026-12-09T00:00:00Z",
			sourceUrl: "https://example.test/rates",
			bridgeAcknowledged: true,
		});
	return create(AccountSchema, {
		id: "hobo-labs",
		budgetMicros: 5_000_000,
		maxRuntimeMinutes: 19,
		startupMinutes: 1,
		offers: [
			offer(
				"box",
				"hobo-box-worker",
				"hobo-isolated-worker",
				"isolated-container",
			),
			offer("github-hosted", "github", "ubuntu-24.04"),
		],
	});
}

function boxLeases(count: number) {
	return Array.from({ length: count }, () =>
		create(LeaseSchema, {
			accountId: "hobo-labs",
			offerId: "box",
			state: "running",
		}),
	);
}

function github(
	options: {
		private?: boolean;
		variableStatus?: number;
		createStatus?: number;
		repositoryStatus?: number;
	} = {},
) {
	const calls: { path: string; method: string; body: string | undefined }[] =
		[];
	const transport: GithubTransport = {
		async request(_installationId, path, method = "GET", body) {
			calls.push({ path, method, body });
			if (path === `/repos/${REPOSITORY}`)
				return Response.json(
					{
						private: options.private ?? false,
						owner: { type: "Organization" },
					},
					{ status: options.repositoryStatus ?? 200 },
				);
			if (method === "PATCH")
				return new Response(null, { status: options.variableStatus ?? 204 });
			if (method === "POST")
				return new Response(null, { status: options.createStatus ?? 201 });
			return new Response(null, { status: 500 });
		},
	};
	return { transport, calls };
}

function input(leases = 0, at = "2026-11-10T00:00:00Z") {
	return {
		installationId: 7,
		repository: REPOSITORY,
		account: account(),
		leases: boxLeases(leases),
		at,
	};
}

describe("fleet route publisher", () => {
	it("keeps every class on its hobo label while the box has a free slot", async () => {
		const api = github();
		const publisher = createFleetRoutePublisher({ github: api.transport });
		const result = await publisher.publish(input(1));
		expect(result?.outcome).toBe("published");
		expect(result?.value).toBe(
			'{"fork":"hobo","pr":"hobo","trunk":"hobo-trunk"}',
		);
		expect(api.calls.at(-1)).toEqual({
			path: `/repos/${REPOSITORY}/actions/variables/HOBO_CI_FLEET_ROUTES`,
			method: "PATCH",
			body: JSON.stringify({
				name: "HOBO_CI_FLEET_ROUTES",
				value: '{"fork":"hobo","pr":"hobo","trunk":"hobo-trunk"}',
			}),
		});
	});

	it("routes new jobs to GitHub-hosted once the box is full on a public repository", async () => {
		const api = github();
		const publisher = createFleetRoutePublisher({ github: api.transport });
		const result = await publisher.publish(input(2));
		expect(result?.table.routes).toEqual({
			pr: "ubuntu-24.04",
			fork: "ubuntu-24.04",
			trunk: "ubuntu-24.04",
		});
		expect(result?.table.decisions.pr?.selected).toMatchObject({
			memberId: "github-hosted",
			role: "last-resort",
			incrementalBilledMicros: 0,
		});
	});

	it("serves a private repository from the connected offer at the account's own rate", async () => {
		const api = github({ private: true });
		const publisher = createFleetRoutePublisher({ github: api.transport });
		const result = await publisher.publish(input(2));
		// The catalog prices a private repository's GitHub minutes, but this
		// account's offer was observed at $0 (included minutes), and that wins.
		expect(result?.table.routes.pr).toBe("ubuntu-24.04");
		expect(result?.table.decisions.pr?.selected?.incrementalBilledMicros).toBe(
			0,
		);
	});

	it("writes only when the table changes and spaces changes apart", async () => {
		const api = github();
		const publisher = createFleetRoutePublisher({
			github: api.transport,
			minIntervalMs: 60_000,
		});
		const writes = () =>
			api.calls.filter((call) => call.method !== "GET").length;
		await publisher.publish(input(0, "2026-11-10T00:00:00Z"));
		expect(writes()).toBe(1);
		expect(
			(await publisher.publish(input(1, "2026-11-10T00:00:05Z")))?.outcome,
		).toBe("unchanged");
		expect(
			(await publisher.publish(input(2, "2026-11-10T00:00:10Z")))?.outcome,
		).toBe("deferred");
		expect(writes()).toBe(1);
		expect(
			(await publisher.publish(input(2, "2026-11-10T00:01:01Z")))?.outcome,
		).toBe("published");
		expect(writes()).toBe(2);
		// The repository was looked up once.
		expect(
			api.calls.filter((call) => call.path === `/repos/${REPOSITORY}`),
		).toHaveLength(1);
	});

	it("creates the variable when it does not exist yet", async () => {
		const api = github({ variableStatus: 404 });
		const publisher = createFleetRoutePublisher({ github: api.transport });
		expect((await publisher.publish(input()))?.outcome).toBe("published");
		expect(api.calls.at(-1)).toMatchObject({
			path: `/repos/${REPOSITORY}/actions/variables`,
			method: "POST",
		});
	});

	it("logs a refused write, reports failure and does not retry on the next pass", async () => {
		const events: [string, Parameters<FleetRouteLog>[1]][] = [];
		const api = github({ variableStatus: 403 });
		const publisher = createFleetRoutePublisher({
			github: api.transport,
			log: (event, fields) => events.push([event, { ...fields }]),
		});
		expect((await publisher.publish(input()))?.outcome).toBe("failed");
		expect(events).toEqual([
			[
				"hobo_ci_fleet_routes_error",
				{
					repository: REPOSITORY,
					variable: "HOBO_CI_FLEET_ROUTES",
					status: 403,
				},
			],
		]);
		const before = api.calls.length;
		expect(
			(await publisher.publish(input(0, "2026-11-10T00:00:05Z")))?.outcome,
		).toBe("deferred");
		expect(api.calls.length).toBe(before);
	});

	it("never throws when GitHub cannot be read", async () => {
		const events: string[] = [];
		const api = github({ repositoryStatus: 500 });
		const publisher = createFleetRoutePublisher({
			github: api.transport,
			log: (event) => events.push(event),
		});
		await expect(publisher.publish(input())).resolves.toBeUndefined();
		expect(events).toEqual(["hobo_ci_fleet_routes_error"]);
	});
});
