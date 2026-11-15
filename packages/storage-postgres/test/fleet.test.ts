import { randomUUID } from "node:crypto";

import {
	type ContinuityFleetPlan,
	continuityFleetPlan,
} from "@hobo/backend-fleet";
import pg from "pg";
import { afterAll, expect, it } from "vitest";

import {
	createPostgresEventStore,
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
	it("forwards an actor fence when snapshotting through the fleet", async () => {
		const a = await freshDatabase("snap_a");
		const b = await freshDatabase("snap_b");
		const witness = await freshDatabase("snap_w");
		const fleet = await open([a, b], { down: new Set(), dropOnce: new Set() }, [
			witness,
		]);
		const supervisor = createPostgresEventStore({
			config: { connectionString: a.connectionString },
			protectedActorStreamPrefixes: ["deployment:"],
		});
		try {
			await fleet.tick();
			await supervisor.ready();
			const lease = await supervisor.actorLeaseHost.acquire(
				"deployment:snapshot",
				{
					holderId: "fleet-test",
				},
			);
			await fleet.append(lease.key, [{ type: "deployment.Started" }], {
				...OPTS,
				expectedSeq: 0,
				fenceToken: lease.fenceToken,
			});
			await expect(
				fleet.snapshot(lease.key, { live: true }, 1),
			).rejects.toMatchObject({
				code: "MISSING_FENCE",
			});
			await expect(
				fleet.snapshot(lease.key, { live: true }, 1, {
					fenceToken: lease.fenceToken,
				}),
			).resolves.toMatchObject({ seq: 1, state: { live: true } });
			await lease.release();
			await expect(
				fleet.snapshot(lease.key, { live: false }, 1, {
					fenceToken: lease.fenceToken,
				}),
			).rejects.toMatchObject({ code: "STALE_FENCE" });
		} finally {
			await supervisor.end();
			await fleet.end();
		}
	}, 60_000);

	it("copies to a standby, fails over, survives an interrupted copy and keeps appending", {
		timeout: 60_000,
	}, async () => {
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
	});

	it("fences a write under a stale lease at the commit boundary", {
		timeout: 60_000,
	}, async () => {
		const a = await freshDatabase("fa");
		const b = await freshDatabase("fb");
		const w = await freshDatabase("fw");
		const outage: Outage = { down: new Set(), dropOnce: new Set() };
		// A lease long enough that the store never re-reads the register.
		const store = await createPostgresFleetEventStore({
			members: [a, b],
			witnesses: [w],
			plan,
			decidedBy: "fleet-test",
			leaseMs: 3_600_000,
			graceMs: 0,
			pool: switchable(outage),
		});
		try {
			await store.tick();
			await store.append("f", [{ type: "f.Started", data: {} }], {
				...OPTS,
				expectedSeq: 0,
			});
			expect(store.writer()).toBe("fa");
			// Another process moves the writer: the entry reaches the old writer's
			// copy of the register, and this store's lease still names it.
			const register = new pg.Client({ connectionString: a.connectionString });
			await register.connect();
			try {
				await register.query(
					`INSERT INTO hobo_eventstore.hobo_fleet_assignments
						(epoch, active, sealed, target, reason, loss_window_ms, decided_at, decided_by)
					SELECT max(epoch) + 1, 'fb', false, NULL, 'failover', 0, now(), 'other'
					FROM hobo_eventstore.hobo_fleet_assignments`,
				);
			} finally {
				await register.end();
			}
			await expect(
				store.append("f", [{ type: "f.Late", data: {} }], {
					...OPTS,
					expectedSeq: 1,
				}),
			).rejects.toThrow(/no longer the fleet's writer/);
			expect(await rows(a)).toBe(1);
		} finally {
			await store.end();
		}
	});

	it("takes scheduled backups on the witness, prunes them, and restores one", {
		timeout: 60_000,
	}, async () => {
		const a = await freshDatabase("ba");
		const w = await freshDatabase("bw");
		const outage: Outage = { down: new Set(), dropOnce: new Set() };
		let clock = 1_000_000;
		const store = await createPostgresFleetEventStore({
			members: [a],
			witnesses: [w],
			plan: continuityFleetPlan({
				tier: "standard",
				onLoss: "restore",
				recoveryPointMs: 60 * 60_000,
				failoverAfterMs: 1_000,
				standbys: 0,
				migration: "on-failure",
				backupEveryMs: 60_000,
				backupsKept: 2,
			}),
			decidedBy: "fleet-test",
			leaseMs: 0,
			graceMs: 0,
			now: () => clock,
			pool: switchable(outage),
		});
		try {
			// The first tick backs up the (empty) journal; within the period,
			// a tick takes none.
			expect((await store.tick()).backup?.kind).toBe("taken");
			await store.append("b", [{ type: "b.One", data: {} }], {
				...OPTS,
				expectedSeq: 0,
			});
			clock += 30_000;
			expect((await store.tick()).backup?.kind).toBe("not-due");
			// Two more periods: three taken, two kept.
			for (const n of [2, 3]) {
				await store.append("b", [{ type: `b.N${n}`, data: {} }], {
					...OPTS,
					expectedSeq: n - 1,
				});
				clock += 60_000;
				const outcome = (await store.tick()).backup;
				expect(outcome?.kind).toBe("taken");
			}
			const held = await store.backups();
			expect(held.map((backup) => backup.rows > 0)).toEqual([true, true]);
			expect(held[0]?.takenAtMs).toBeGreaterThan(held[1]?.takenAtMs ?? 0);
			// The writer holds events, so restoring over it is refused.
			await expect(store.restore({ into: "ba" })).rejects.toThrow(
				/holds events/,
			);
			// A replaced, empty writer gets the newest backup back.
			const admin = new pg.Client({ connectionString: a.connectionString });
			await admin.connect();
			try {
				await admin.query("TRUNCATE hobo_eventstore.events CASCADE");
			} finally {
				await admin.end();
			}
			const restored = await store.restore({ into: "ba" });
			expect(restored.name).toBe(held[0]?.name);
			expect(await rows(a)).toBe(3);
		} finally {
			await store.end();
		}
	});

	it("without a witness, a fleet of two holds rather than guess", {
		timeout: 60_000,
	}, async () => {
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
	});

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
