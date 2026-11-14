import { randomUUID } from "node:crypto";

import { type ContinuityFleetPlan, continuityFleetPlan } from "@hobo/backend-fleet";
import pg from "pg";
import { afterAll, expect, it } from "vitest";

import {
	createPostgresFleetEventStore,
	type PgPoolLike,
	type PostgresFleetEventStore,
	type PostgresFleetMember,
} from "../src/index.js";
import {
	adminQuery,
	collect,
	describeLive,
	OPTS,
	POSTGRES_URL,
} from "./support/live.js";

const RUN = randomUUID().replaceAll("-", "").slice(0, 8);
const databases: string[] = [];

async function freshDatabase(name: string): Promise<PostgresFleetMember> {
	const database = `hobo_fleet_${RUN}_${name}`;
	await adminQuery(`CREATE DATABASE ${database}`);
	databases.push(database);
	// The lane's URL may name a socket directory and no host, which the WHATWG
	// parser refuses; swap the database segment as text.
	const connectionString = POSTGRES_URL.replace(
		/^(postgres(?:ql)?:\/\/[^/?]*)\/[^?]*/u,
		`$1/${database}`,
	);
	return { id: name, connectionString };
}

afterAll(async () => {
	for (const database of databases)
		await adminQuery(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
});

const plan: ContinuityFleetPlan = continuityFleetPlan({
	tier: "standard",
	onLoss: "restore",
	recoveryPointMs: 5 * 60_000,
	failoverAfterMs: 1_000,
	standbys: 1,
	migration: "continuous",
	backupEveryMs: 0,
	backupsKept: 0,
});

interface Outage {
	readonly down: Set<string>;
	/** Members whose next connection fails once (an interrupted copy). */
	readonly dropOnce: Set<string>;
}

/** Real pools behind a switch that can take a member down. */
function switchable(outage: Outage) {
	return (member: PostgresFleetMember, schema: string): PgPoolLike => {
		const pool = new pg.Pool({
			connectionString: member.connectionString,
			max: 4,
			options: `-c search_path=${schema}`,
		});
		pool.on("error", () => {});
		const refuse = () => {
			const error = new Error("connect ECONNREFUSED (simulated outage)");
			Object.assign(error, { code: "ECONNREFUSED" });
			return error;
		};
		return {
			async connect() {
				if (outage.down.has(member.id)) throw refuse();
				const client = await pool.connect();
				if (!outage.dropOnce.has(member.id)) return client;
				// Let the copy start, then cut the connection under it.
				let statements = 0;
				return {
					async query(text, values) {
						statements += 1;
						if (statements > 3 && outage.dropOnce.delete(member.id))
							throw refuse();
						return client.query(text, values ? [...values] : undefined);
					},
					release: (destroy) => client.release(destroy),
				};
			},
			end: () => pool.end(),
		};
	};
}

async function open(
	members: readonly PostgresFleetMember[],
	outage: Outage,
	witnesses: readonly PostgresFleetMember[] = [],
): Promise<PostgresFleetEventStore> {
	return createPostgresFleetEventStore({
		members,
		witnesses,
		plan,
		decidedBy: "fleet-test",
		leaseMs: 0,
		graceMs: 0,
		pool: switchable(outage),
	});
}

async function rows(member: PostgresFleetMember): Promise<number> {
	const client = new pg.Client({ connectionString: member.connectionString });
	await client.connect();
	try {
		const result = await client.query(
			"SELECT count(*)::text AS n FROM hobo_eventstore.events",
		);
		return Number(result.rows[0]?.n);
	} finally {
		await client.end();
	}
}

describeLive("PostgreSQL EventStore on a fleet", () => {
	it(
		"copies to a standby, fails over, survives an interrupted copy and keeps appending",
		{ timeout: 60_000 },
		async () => {
			const a = await freshDatabase("a");
			const b = await freshDatabase("b");
			const w = await freshDatabase("w");
			const outage: Outage = { down: new Set(), dropOnce: new Set() };
			// A writer, one standby and a witness that holds only the register.
			const store = await open([a, b], outage, [w]);
			try {
				// An empty fleet: the first tick names the first member writer.
				expect((await store.tick()).status).toBe("settled");
				const first = await store.append(
					"deploy:1",
					[{ type: "deploy.Started", data: { n: 1 } }],
					{ ...OPTS, expectedSeq: 0 },
				);
				expect(store.writer()).toBe("a");

				// The copy is interrupted part-way: the standby is left as it was.
				outage.dropOnce.add("b");
				await store.tick();
				// The next tick copies it whole.
				await store.tick();
				expect(await rows(b)).toBe(1);

				// The writer's vendor goes down: the fleet fails over within the RPO.
				outage.down.add("a");
				const report = await store.tick();
				expect(report.decision?.action).toBe("failover");
				expect(report.assignment?.active).toBe("b");

				// Work continues on the new writer, with the history it had.
				const second = await store.append(
					"deploy:1",
					[{ type: "deploy.Finished", data: {} }],
					{ ...OPTS, expectedSeq: 1 },
				);
				expect(store.writer()).toBe("b");
				expect(second.firstPosition > first.lastPosition).toBe(true);
				const history = await collect(store.read("deploy:1"));
				expect(history.map((event) => event.type)).toEqual([
					"deploy.Started",
					"deploy.Finished",
				]);
			} finally {
				await store.end();
			}
		},
	);

	it(
		"without a witness, a fleet of two holds rather than guess",
		{ timeout: 60_000 },
		async () => {
			const a = await freshDatabase("pa");
			const b = await freshDatabase("pb");
			const outage: Outage = { down: new Set(), dropOnce: new Set() };
			const store = await open([a, b], outage);
			try {
				await store.tick();
				await store.append("s", [{ type: "s.Started", data: {} }], {
					...OPTS,
					expectedSeq: 0,
				});
				await store.tick();
				outage.down.add("pa");
				const report = await store.tick();
				expect(report.status).toBe("no-majority");
				await expect(
					store.append("s", [{ type: "s.More", data: {} }], {
						...OPTS,
						expectedSeq: 1,
					}),
				).rejects.toThrow(/fleet's writer is no-majority/);
			} finally {
				await store.end();
			}
		},
	);

	it("refuses rebuildable plans for a journal with standbys", () => {
		expect(() =>
			createPostgresFleetEventStore({
				members: [
					{ id: "a", connectionString: "postgresql://x/a" },
					{ id: "b", connectionString: "postgresql://x/b" },
				],
				plan: continuityFleetPlan({
					tier: "rebuildable",
					onLoss: "rebuild",
					recoveryPointMs: 0,
					failoverAfterMs: 60_000,
					standbys: 0,
					migration: "continuous",
					backupEveryMs: 0,
					backupsKept: 0,
				}),
				decidedBy: "t",
			}),
		).toThrow(/snapshot continuity plan/);
	});
});
