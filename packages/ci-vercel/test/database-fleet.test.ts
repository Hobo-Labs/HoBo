import {
	type AssignmentAcceptOutcome,
	type AssignmentReplica,
	assignmentKey,
	type FleetAssignmentValue,
	type PostgresFleetAssignment,
	parseAssignmentRegister,
	proposeAssignment,
} from "@hobo/data-postgres";
import { describe, expect, it, vi } from "vitest";
import type { RelayDatabase } from "../src/database-connections.js";
import { createDatabaseFleet } from "../src/database-fleet.js";
import { parseDatabaseFleet } from "../src/database-fleet-config.js";
import { DatabaseFenceError } from "../src/database-fleet-executor.js";

/** One backend's assignment log, in memory, with a switch to take it down. */
class Replica implements AssignmentReplica {
	rows: PostgresFleetAssignment[] = [];
	up = true;
	reads = 0;
	constructor(readonly id: string) {}
	async read(limit?: number) {
		this.reads += 1;
		if (!this.up) throw new Error("connection refused");
		return limit === undefined ? [...this.rows] : this.rows.slice(-limit);
	}
	async accept(
		assignment: PostgresFleetAssignment,
	): Promise<AssignmentAcceptOutcome> {
		if (!this.up) throw new Error("connection refused");
		const top = this.rows.at(-1)?.epoch ?? 0;
		if (top === assignment.epoch - 1) {
			this.rows.push(assignment);
			return "accepted";
		}
		const held = this.rows.find((row) => row.epoch === assignment.epoch);
		if (!held) return "gap";
		return assignmentKey(held) === assignmentKey(assignment)
			? "duplicate"
			: "conflict";
	}
}

const secret = "c".repeat(40);
const env = {
	HOBO_CI_PUBLIC_URL: "https://relay.example",
	CRON_SECRET: secret,
	HOBO_CI_DATABASE_BACKENDS: "a=A_,b=B_,c=C_",
	HOBO_CI_DATABASE_LEASE_SECONDS: "30",
	...Object.fromEntries(
		["A_", "B_", "C_"].flatMap((prefix) => [
			[`${prefix}DATABASE_URL`, "postgres://u@127.0.0.1:1/db"],
			[`${prefix}DATABASE_URL_UNPOOLED`, "postgres://u@127.0.0.1:1/db"],
		]),
	),
};

function harness() {
	const config = parseDatabaseFleet(env);
	if (!config) throw new Error("fleet was not configured");
	const replicas = ["a", "b", "c"].map((id) => new Replica(id));
	const register = parseAssignmentRegister(replicas);
	let clock = 1_000_000;
	const built: { database: RelayDatabase; closed: boolean; id: number }[] = [];
	const fleet = createDatabaseFleet({
		env,
		config,
		register,
		now: () => clock,
		sleep: async () => {},
		scheduledRepair: async () => {},
		build: async (database) => {
			const record = { database, closed: false, id: built.length };
			built.push(record);
			return {
				handle: async () => {
					// A statement through the fenced client: refused when the
					// fence does not hold, otherwise handed to the driver.
					const Client = database.primary.Client;
					if (!Client) throw new Error("application got an unfenced pool");
					void new Client({ host: "127.0.0.1", port: 1 })
						.query("SELECT 1")
						.catch(() => {});
					return new Response(`app-${record.id}`);
				},
				tick: async () => {},
				close: async () => {
					record.closed = true;
				},
			};
		},
	});
	const get = (path = "/v1/work") =>
		fleet.handle(new Request(`https://relay.example${path}`));
	const move = (expectedEpoch: number, value: Partial<FleetAssignmentValue>) =>
		proposeAssignment(register, {
			expectedEpoch,
			value: {
				active: "a",
				sealed: false,
				target: undefined,
				reason: "test",
				lossWindowMs: undefined,
				...value,
			},
			decidedBy: "test",
			nowMs: clock,
		});
	return {
		fleet,
		replicas,
		built,
		get,
		move,
		advance(ms: number) {
			clock += ms;
		},
		reads: () => replicas.reduce((total, replica) => total + replica.reads, 0),
	};
}

describe("database fleet fence", () => {
	it("makes the first configured backend the writer of an empty fleet", async () => {
		const h = harness();
		const response = await h.get();
		expect(await response.text()).toBe("app-0");
		expect(h.fleet.assignment()).toMatchObject({
			epoch: 1,
			active: "a",
			decidedBy: "bootstrap",
		});
		expect(h.replicas.map((replica) => replica.rows.length)).toEqual([1, 1, 1]);
		await h.fleet.close();
	});

	it("confirms the assignment at most once per half lease", async () => {
		const h = harness();
		await h.get();
		const afterStart = h.reads();
		for (let request = 0; request < 20; request += 1) await h.get();
		expect(h.reads()).toBe(afterStart);
		h.advance(14_000);
		await h.get();
		expect(h.reads()).toBe(afterStart);
		h.advance(2000);
		await h.get();
		expect(h.reads()).toBeGreaterThan(afterStart);
		expect(h.reads()).toBeLessThanOrEqual(afterStart + 3);
		expect(h.built).toHaveLength(1);
		await h.fleet.close();
	});

	it("refuses a statement once the lease has run out on the wall clock", async () => {
		const h = harness();
		await h.get();
		const Client = h.built[0]?.database.primary.Client;
		if (!Client) throw new Error("application got an unfenced pool");
		const client = new Client({ host: "127.0.0.1", port: 1 });
		// A frozen instance wakes up after its lease: nothing was re-confirmed.
		h.advance(30_000);
		expect(() => client.query("INSERT INTO t VALUES (1)")).toThrow(
			DatabaseFenceError,
		);
		// The next request confirms again before anything is written.
		expect((await h.get()).status).toBe(200);
		void client.query("SELECT 1").catch(() => {});
		await h.fleet.close();
	});

	it("moves to the new writer and closes the old pools when the assignment changes", async () => {
		const h = harness();
		await h.get();
		expect((await h.move(1, { active: "b" })).status).toBe("decided");
		// Still inside the lease: this instance has not looked again yet.
		expect(await (await h.get()).text()).toBe("app-0");
		h.advance(15_000);
		expect(await (await h.get()).text()).toBe("app-1");
		expect(h.built[0]?.closed).toBe(true);
		expect(h.fleet.assignment()).toMatchObject({ epoch: 2, active: "b" });
		// The old application's clients are refused from then on.
		const Old = h.built[0]?.database.primary.Client;
		if (!Old) throw new Error("application got an unfenced pool");
		expect(() =>
			new Old({ host: "127.0.0.1", port: 1 }).query("UPDATE t SET x = 1"),
		).toThrow(DatabaseFenceError);
		await h.fleet.close();
	});

	it("answers 503 with Retry-After while sealed, and resumes on the target", async () => {
		const h = harness();
		await h.get();
		await h.move(1, { sealed: true, target: "c" });
		h.advance(15_000);
		const sealed = await h.get();
		expect(sealed.status).toBe(503);
		expect(sealed.headers.get("retry-after")).toBe("30");
		expect(sealed.headers.get("cache-control")).toBe("no-store");
		await h.move(2, { active: "c" });
		h.advance(15_000);
		expect(await (await h.get()).text()).toBe("app-1");
		await h.fleet.close();
	});

	it("stays live and says why it is not ready while no writer is assigned", async () => {
		const h = harness();
		await h.get();
		await h.move(1, { sealed: true, target: "c" });
		h.advance(15_000);
		// Liveness is the process: a probe must not restart a relay that is
		// only waiting for a writer.
		const live = await h.get("/healthz");
		expect(live.status).toBe(200);
		expect(await live.json()).toEqual({ ok: true });
		expect(live.headers.get("cache-control")).toBe("no-store");
		const ready = await h.get("/readyz");
		expect(ready.status).toBe(503);
		expect(await ready.json()).toEqual({
			ready: false,
			reason: "store-unavailable",
		});
		expect(ready.headers.get("retry-after")).toBe("30");
		// Liveness never reaches the application or the backends.
		const before = h.reads();
		await h.get("/healthz");
		expect(h.reads()).toBe(before);
		// A request that is not a probe is still refused without a body.
		const post = await h.fleet.handle(
			new Request("https://relay.example/readyz", { method: "POST" }),
		);
		expect(post.status).toBe(503);
		expect(await post.text()).toBe("");
		await h.fleet.close();
	});

	it("fails closed without a majority and recovers when it returns", async () => {
		const h = harness();
		await h.get();
		for (const replica of h.replicas.slice(1)) replica.up = false;
		h.advance(15_000);
		expect((await h.get()).status).toBe(503);
		expect(h.fleet.assignment()).toBeUndefined();
		// It does not hammer the backends on every request while down.
		const before = h.reads();
		for (let request = 0; request < 10; request += 1) await h.get();
		expect(h.reads()).toBe(before);
		const [, second] = h.replicas;
		if (second) second.up = true;
		h.advance(2000);
		expect((await h.get()).status).toBe(200);
		expect(h.built).toHaveLength(1);
		await h.fleet.close();
	});

	it("fails closed while the newest epoch is undecided", async () => {
		const h = harness();
		await h.get();
		const [first] = h.replicas;
		const top = first?.rows.at(-1);
		if (!first || !top) throw new Error("fleet was not bootstrapped");
		// An interrupted proposer left an entry on one backend only.
		first.rows.push({ ...top, epoch: 2, decidedBy: "interrupted" });
		h.advance(15_000);
		expect((await h.get()).status).toBe(503);
		await h.fleet.close();
	});

	it("serves the schedule and the queue handoff itself, writer or not", async () => {
		const h = harness();
		for (const replica of h.replicas) replica.up = false;
		const info = vi.spyOn(console, "info").mockImplementation(() => {});
		try {
			const denied = await h.get("/internal/tick");
			expect(denied.status).toBe(403);
			const scheduled = await h.fleet.handle(
				new Request("https://relay.example/internal/tick", {
					headers: { authorization: `Bearer ${secret}` },
				}),
			);
			expect(scheduled.status).toBe(204);
			// The repair message reaches the reconciler even though no
			// application can be built; with nothing reachable the handoff
			// fails and the queue will deliver it again.
			const wakeup = await h.fleet.handle(
				new Request("https://relay.example/internal/queue-wakeup", {
					method: "POST",
					headers: {
						authorization: `Bearer ${secret}`,
						"content-type": "application/json",
					},
					body: JSON.stringify({ source: "static", name: "hobo-ci-repair" }),
				}),
			);
			expect(wakeup.status).toBe(503);
			const events = info.mock.calls.map(([line]) => JSON.parse(String(line)));
			expect(events).toContainEqual(
				expect.objectContaining({
					event: "hobo_ci_database_fleet_unsettled",
					status: "no-majority",
				}),
			);
			for (const line of info.mock.calls.map(([text]) => String(text)))
				expect(line).not.toContain("postgres://");
		} finally {
			info.mockRestore();
			await h.fleet.close();
		}
	}, 30_000);
});
