import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { createPgPool, type PgPoolLike } from "../src/index.js";
import {
	adminQuery,
	collect,
	describeLive,
	freshSchema,
	liveStore,
	OPTS,
	POSTGRES_URL,
} from "./support/live.js";

describeLive("shared PostgreSQL actor leases", () => {
	it("enforces the installed policy across stores and fences a stale writer immediately on takeover", async () => {
		const schema = freshSchema();
		const first = liveStore({
			schema,
			protectedActorStreamPrefixes: ["deployment:"],
		});
		const other = liveStore({ schema });
		await first.ready();
		await other.verifyActorStreamProtection("deployment:");
		const append = (token?: bigint) => {
			const options = { ...OPTS, expectedSeq: 0 };
			return token === undefined ? options : { ...options, fenceToken: token };
		};
		await expect(
			other.append("deployment:a", [{ type: "test.Event" }], append()),
		).rejects.toMatchObject({ code: "MISSING_FENCE" });
		await other.append("registry:other", [{ type: "test.Event" }], append());
		const lease = await first.actorLeaseHost.acquire("deployment:a", {
			holderId: "process-a",
		});
		await expect(
			other.actorLeaseHost.acquire("deployment:a", { holderId: "process-a" }),
		).rejects.toMatchObject({ failure: "lease-held" });
		await lease.revalidate();
		await lease.release();
		await expect(
			other.append(
				"deployment:a",
				[{ type: "test.Event" }],
				append(lease.fenceToken),
			),
		).rejects.toMatchObject({ code: "STALE_FENCE" });
		const next = await other.actorLeaseHost.acquire("deployment:a", {
			holderId: "process-b",
		});
		expect(next.fenceToken).toBeGreaterThan(lease.fenceToken);
		// New holder has not appended yet. The acquire itself must fence A.
		await expect(
			first.append(
				"deployment:a",
				[{ type: "test.Event" }],
				append(lease.fenceToken),
			),
		).rejects.toMatchObject({ code: "STALE_FENCE" });
		await lease.release(); // delayed release cannot release the new holder
		await next.revalidate();
		await other.append(
			"deployment:a",
			[{ type: "test.Event" }],
			append(next.fenceToken),
		);
		expect(await collect(other.read("deployment:a"))).toHaveLength(1);
		await next.release();
	});

	it("rejects an expired lease even before any other process takes over", async () => {
		const schema = freshSchema(),
			store = liveStore({
				schema,
				protectedActorStreamPrefixes: ["deployment:"],
			});
		const lease = await store.actorLeaseHost.acquire("deployment:expired", {
			holderId: "a",
		});
		await adminQuery(
			`UPDATE "${schema}".actor_leases SET expires_at = clock_timestamp() - INTERVAL '1 second' WHERE stream_id = $1`,
			[lease.key],
		);
		await expect(lease.revalidate()).rejects.toMatchObject({
			code: "STALE_FENCE",
		});
		await expect(
			store.append(lease.key, [{ type: "test.Event" }], {
				...OPTS,
				expectedSeq: 0,
				fenceToken: lease.fenceToken,
			}),
		).rejects.toMatchObject({ code: "STALE_FENCE" });
		const replacement = await store.actorLeaseHost.acquire(lease.key, {
			holderId: "b",
		});
		expect(replacement.fenceToken).toBeGreaterThan(lease.fenceToken);
		await replacement.release();
	});
	it("rejects a protected transaction whose lease expires immediately before commit", async () => {
		const schema = freshSchema();
		const base = liveStore({
			schema,
			protectedActorStreamPrefixes: ["deployment:"],
		});
		await base.ready();
		const lease = await base.actorLeaseHost.acquire("deployment:late-commit", {
			holderId: "original",
		});
		const pool = createPgPool(base.config);
		let expiresBeforeCommit = true;
		const wrapped: PgPoolLike = {
			async connect() {
				const client = await pool.connect();
				let protectedWrite = false;
				return {
					async query(sql, values) {
						if (
							sql.includes("INSERT INTO") &&
							sql.includes(".actor_commit_checks")
						)
							protectedWrite = true;
						if (protectedWrite && expiresBeforeCommit && sql === "COMMIT") {
							expiresBeforeCommit = false;
							await adminQuery(
								`UPDATE "${schema}".actor_leases SET expires_at = clock_timestamp() - INTERVAL '1 second' WHERE stream_id = $1`,
								[lease.key],
							);
						}
						return client.query(sql, values);
					},
					release: (destroy) => client.release(destroy),
				};
			},
			end: () => pool.end(),
		};
		const delayed = liveStore({ schema, pool: wrapped });
		try {
			await expect(
				delayed.append(lease.key, [{ type: "test.Event" }], {
					...OPTS,
					expectedSeq: 0,
					fenceToken: lease.fenceToken,
				}),
			).rejects.toThrow();
			expect(await collect(base.read(lease.key))).toHaveLength(0);
			const replacement = await base.actorLeaseHost.acquire(lease.key, {
				holderId: "replacement",
			});
			await base.append(lease.key, [{ type: "test.Event" }], {
				...OPTS,
				expectedSeq: 0,
				fenceToken: replacement.fenceToken,
			});
			expect(await collect(base.read(lease.key))).toHaveLength(1);
			await replacement.release();
		} finally {
			await pool.end();
		}
	});

	it("keeps the protection policy durable and refuses a conflicting configuration", async () => {
		const schema = freshSchema(),
			store = liveStore({
				schema,
				protectedActorStreamPrefixes: ["deployment:"],
			});
		await store.ready();
		const restarted = liveStore({ schema });
		await restarted.verifyActorStreamProtection("deployment:");
		await expect(
			restarted.verifyActorStreamProtection("other:"),
		).rejects.toMatchObject({ failure: "invalid-config" });
		await expect(
			liveStore({
				schema,
				protectedActorStreamPrefixes: ["different:"],
			}).ready(),
		).rejects.toMatchObject({ failure: "invalid-config" });
	});

	it("atomically adds protection and refuses later policy downgrades", async () => {
		const schema = freshSchema();
		const old = liveStore({
			schema,
			protectedActorStreamPrefixes: ["deployment:"],
		});
		await old.ready();
		const upgraded = liveStore({
			schema,
			protectedActorStreamPrefixes: [
				"deployment:",
				"hosting-transition:",
				"hosting-native-scope:",
			],
		});
		await upgraded.ready();
		// A previously open process reads the new policy inside its transaction.
		await expect(
			old.append("hosting-transition:tenant:t", [{ type: "test.Unfenced" }], {
				...OPTS,
				expectedSeq: 0,
				fenceToken: 1n,
			}),
		).rejects.toThrow();
		const lease = await upgraded.actorLeaseHost.acquire(
			"hosting-transition:tenant:t",
			{ holderId: "new-owner" },
		);
		await upgraded.append(lease.key, [{ type: "test.Fenced" }], {
			...OPTS,
			expectedSeq: 0,
			fenceToken: lease.fenceToken,
		});
		await lease.release();
		await expect(
			liveStore({
				schema,
				protectedActorStreamPrefixes: ["deployment:"],
			}).ready(),
		).rejects.toMatchObject({ failure: "invalid-config" });
		await upgraded.verifyActorStreamProtection("hosting-native-scope:");
	});

	it("allows exactly one concurrent claimant across separate connections", async () => {
		const schema = freshSchema();
		const first = liveStore({
			schema,
			protectedActorStreamPrefixes: ["deployment:"],
		});
		await first.ready();
		const second = liveStore({ schema });
		const grants = await Promise.allSettled([
			first.actorLeaseHost.acquire("deployment:race", { holderId: "a" }),
			second.actorLeaseHost.acquire("deployment:race", { holderId: "b" }),
		]);
		const winners = grants.filter((result) => result.status === "fulfilled");
		const losers = grants.filter((result) => result.status === "rejected");
		expect(winners).toHaveLength(1);
		expect(losers).toHaveLength(1);
		const winner = winners[0];
		if (winner?.status !== "fulfilled") throw new Error("missing winner");
		await winner.value.release();
	});

	it("does not repeat an acquisition after its commit response is lost", async () => {
		const schema = freshSchema();
		const base = liveStore({
			schema,
			protectedActorStreamPrefixes: ["deployment:"],
		});
		await base.ready();
		const pool = createPgPool(base.config);
		let loseCommit = true;
		const wrapped: PgPoolLike = {
			async connect() {
				const client = await pool.connect();
				let isLease = false;
				return {
					async query(sql, values) {
						if (sql.includes("INSERT INTO") && sql.includes(".actor_leases"))
							isLease = true;
						const result = await client.query(sql, values);
						if (isLease && loseCommit && sql === "COMMIT") {
							loseCommit = false;
							throw new Error("simulated lost commit response");
						}
						return result;
					},
					release: (destroy) => client.release(destroy),
				};
			},
			end: () => pool.end(),
		};
		const uncertain = liveStore({ schema, pool: wrapped });
		try {
			await expect(
				uncertain.actorLeaseHost.acquire("deployment:ambiguous", {
					holderId: "a",
				}),
			).rejects.toThrow();
			await expect(
				base.actorLeaseHost.acquire("deployment:ambiguous", { holderId: "b" }),
			).rejects.toMatchObject({ failure: "lease-held" });
			await adminQuery(
				`UPDATE "${schema}".actor_leases SET expires_at = clock_timestamp() - INTERVAL '1 second' WHERE stream_id = $1`,
				["deployment:ambiguous"],
			);
			const next = await base.actorLeaseHost.acquire("deployment:ambiguous", {
				holderId: "b",
			});
			expect(next.fenceToken).toBe(2n);
			await next.release();
		} finally {
			await pool.end();
		}
	});

	it("refuses a stale holder's snapshot on a protected stream after the lease moves", async () => {
		const schema = freshSchema(),
			store = liveStore({
				schema,
				protectedActorStreamPrefixes: ["deployment:"],
			});
		const key = "deployment:snap";
		const a = await store.actorLeaseHost.acquire(key, { holderId: "a" });
		await store.append(key, [{ type: "test.Event" }], {
			...OPTS,
			expectedSeq: 0,
			fenceToken: a.fenceToken,
		});
		// The current holder may snapshot; an unfenced snapshot may not.
		await store.snapshot(key, { by: "a" }, 1, { fenceToken: a.fenceToken });
		await expect(store.snapshot(key, { by: "anon" }, 1)).rejects.toMatchObject({
			code: "MISSING_FENCE",
		});
		await adminQuery(
			`UPDATE "${schema}".actor_leases SET expires_at = clock_timestamp() - INTERVAL '1 second' WHERE stream_id = $1`,
			[key],
		);
		const b = await store.actorLeaseHost.acquire(key, { holderId: "b" });
		await store.snapshot(key, { by: "b" }, 1, { fenceToken: b.fenceToken });
		await expect(
			store.snapshot(key, { by: "stale-a" }, 1, { fenceToken: a.fenceToken }),
		).rejects.toMatchObject({ code: "STALE_FENCE" });
		expect(await store.loadSnapshot(key)).toMatchObject({
			seq: 1,
			state: { by: "b" },
		});
		await b.release();
		// A released lease row still guards the stream.
		await expect(
			store.snapshot(key, { by: "late-b" }, 1, { fenceToken: b.fenceToken }),
		).rejects.toMatchObject({ code: "STALE_FENCE" });
		await store.snapshot("registry:snap", { free: true }, 0);
	});

	it("recovers after a process dies while holding a lease", async () => {
		const schema = freshSchema(),
			store = liveStore({
				schema,
				protectedActorStreamPrefixes: ["deployment:"],
			});
		await store.ready();
		const child = spawn(
			process.execPath,
			[
				"--import",
				"tsx",
				fileURLToPath(
					new URL("./support/actor-lease-crasher.ts", import.meta.url),
				),
			],
			{
				cwd: fileURLToPath(new URL("..", import.meta.url)),
				env: {
					...process.env,
					HOBO_TEST_POSTGRES_URL: POSTGRES_URL,
					HOBO_ACTOR_TEST_SCHEMA: schema,
				},
				stdio: ["ignore", "pipe", "inherit"],
			},
		);
		const granted = new Promise<void>((resolve, reject) => {
			child.once("error", reject);
			child.stdout.once("data", () => resolve());
			child.once("exit", (code) => {
				if (code !== null && code !== 0)
					reject(new Error("lease child exited"));
			});
		});
		try {
			await granted;
			child.kill("SIGKILL");
			await new Promise<void>((resolve) => child.once("exit", () => resolve()));
			await expect(
				store.actorLeaseHost.acquire("deployment:crash", {
					holderId: "restart",
				}),
			).rejects.toMatchObject({ failure: "lease-held" });
			await adminQuery(
				`UPDATE "${schema}".actor_leases SET expires_at = clock_timestamp() - INTERVAL '1 second' WHERE stream_id = $1`,
				["deployment:crash"],
			);
			const next = await store.actorLeaseHost.acquire("deployment:crash", {
				holderId: "restart",
			});
			expect(next.fenceToken).toBe(2n);
			await expect(
				store.append("deployment:crash", [{ type: "test.Event" }], {
					...OPTS,
					expectedSeq: 0,
					fenceToken: 1n,
				}),
			).rejects.toMatchObject({ code: "STALE_FENCE" });
			await store.append("deployment:crash", [{ type: "test.Event" }], {
				...OPTS,
				expectedSeq: 0,
				fenceToken: next.fenceToken,
			});
			await next.release();
		} finally {
			child.kill("SIGKILL");
		}
	});
});
