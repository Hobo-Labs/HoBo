import type { EventEnvelope } from "@hobo/core";
import pg from "pg";
import { expect, it } from "vitest";
import type {
	PgClientLike,
	PgListenerLike,
	PgPoolLike,
	PgRow,
} from "../src/index.js";
import {
	adminQuery,
	describeLive,
	freshSchema,
	liveStore,
	OPTS,
	POSTGRES_URL,
} from "./support/live.js";

function deferred<T>() {
	let resolve: (value: T) => void = () => {};
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

async function bounded<T>(promise: Promise<T>): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<never>((_resolve, reject) => {
				timer = setTimeout(
					() => reject(new Error("subscription timed out")),
					10_000,
				);
			}),
		]);
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
}

function listener(
	onConnect: (client: pg.Client) => Promise<void>,
	onQuery: () => Promise<void>,
): PgListenerLike {
	const client = new pg.Client({ connectionString: POSTGRES_URL });
	return {
		async connect() {
			await client.connect();
			await onConnect(client);
		},
		async query(sql) {
			await onQuery();
			await client.query(sql);
		},
		onNotification(handler) {
			client.on("notification", (event) => handler(event.channel));
		},
		onError(handler) {
			client.on("error", handler);
		},
		end: () => client.end(),
	};
}

const noop = async () => {};

function interceptQueries(
	pool: pg.Pool,
	matches: (sql: string) => boolean,
	intercept: (
		run: () => ReturnType<PgClientLike["query"]>,
	) => ReturnType<PgClientLike["query"]>,
): PgPoolLike {
	return {
		async connect() {
			const client = await pool.connect();
			return {
				async query(sql, values) {
					const run = async () => {
						const result = await client.query<PgRow>(
							sql,
							values ? [...values] : [],
						);
						return { rows: result.rows, rowCount: result.rowCount };
					};
					return matches(sql) ? intercept(run) : run();
				},
				release: (destroy) => client.release(destroy),
			};
		},
		end: () => pool.end(),
	};
}

describeLive("PostgreSQL live subscription readiness", () => {
	it("catches an event committed after the head is read and before LISTEN", async () => {
		const schema = freshSchema();
		const entering = deferred<void>();
		const release = deferred<void>();
		const reader = liveStore({
			schema,
			listener: () =>
				listener(noop, async () => {
					entering.resolve();
					await release.promise;
				}),
		});
		const writer = liveStore({ schema });
		await reader.ready();
		await writer.ready();
		const seen = deferred<EventEnvelope>();
		const sub = reader.subscribe({}, (event) => seen.resolve(event));
		try {
			await bounded(entering.promise);
			await writer.append("race", [{ type: "race.Created", data: {} }], {
				...OPTS,
				expectedSeq: 0,
			});
			release.resolve();
			await bounded(sub.ready);
			expect((await bounded(seen.promise)).type).toBe("race.Created");
		} finally {
			release.resolve();
			sub.unsubscribe();
		}
	});

	it("reconnects and catches events committed while its listener is disconnected", async () => {
		const schema = freshSchema();
		const firstPid = deferred<number>();
		const reconnecting = deferred<void>();
		const release = deferred<void>();
		let attempts = 0;
		const reader = liveStore({
			schema,
			listener: () => {
				const attempt = ++attempts;
				return listener(
					async (client) => {
						if (attempt === 1) {
							const result = await client.query<{ pid: number }>(
								"SELECT pg_backend_pid() AS pid",
							);
							const pid = result.rows[0]?.pid;
							if (pid === undefined) throw new Error("listener PID missing");
							firstPid.resolve(pid);
						}
					},
					async () => {
						if (attempt === 2) {
							reconnecting.resolve();
							await release.promise;
						}
					},
				);
			},
		});
		const writer = liveStore({ schema });
		await reader.ready();
		await writer.ready();
		const seen = deferred<EventEnvelope>();
		const sub = reader.subscribe({}, (event) => seen.resolve(event));
		try {
			await bounded(sub.ready);
			await adminQuery("SELECT pg_terminate_backend($1)", [
				await bounded(firstPid.promise),
			]);
			await bounded(reconnecting.promise);
			await writer.append(
				"reconnect",
				[{ type: "reconnect.Created", data: {} }],
				{
					...OPTS,
					expectedSeq: 0,
				},
			);
			release.resolve();
			expect((await bounded(seen.promise)).type).toBe("reconnect.Created");
		} finally {
			release.resolve();
			sub.unsubscribe();
		}
	});

	it("reports listener setup failure through subscription readiness", async () => {
		const reader = liveStore({
			listener: () => ({
				connect: async () => {
					throw new Error("listener unavailable");
				},
				query: noop,
				onNotification: () => {},
				onError: () => {},
				end: noop,
			}),
		});
		await reader.ready();
		const sub = reader.subscribe({}, () => {});
		try {
			await expect(sub.ready).rejects.toThrow("listener unavailable");
		} finally {
			sub.unsubscribe();
		}
	});

	it("keeps a replacement subscription active when the first is closed during setup", async () => {
		const schema = freshSchema();
		const entering = deferred<void>();
		const release = deferred<void>();
		const ended = deferred<void>();
		let attempts = 0;
		const reader = liveStore({
			schema,
			listener: () => {
				const attempt = ++attempts;
				return listener(
					async (client) => {
						if (attempt === 1) client.once("end", () => ended.resolve());
					},
					async () => {
						if (attempt === 1) {
							entering.resolve();
							await release.promise;
						}
					},
				);
			},
		});
		const writer = liveStore({ schema });
		await reader.ready();
		await writer.ready();
		const firstSeen: EventEnvelope[] = [];
		const first = reader.subscribe({}, (event) => {
			firstSeen.push(event);
		});
		const firstFinished = first.ready.catch(() => undefined);
		let second: ReturnType<typeof reader.subscribe> | undefined;
		try {
			await bounded(entering.promise);
			first.unsubscribe();
			const seen = deferred<EventEnvelope>();
			second = reader.subscribe({}, (event) => seen.resolve(event));
			await bounded(second.ready);
			release.resolve();
			await bounded(firstFinished);
			await bounded(ended.promise);
			await writer.append(
				"replacement",
				[{ type: "replacement.Created", data: {} }],
				{
					...OPTS,
					expectedSeq: 0,
				},
			);
			expect((await bounded(seen.promise)).type).toBe("replacement.Created");
			expect(firstSeen).toEqual([]);
			expect(attempts).toBe(2);
		} finally {
			release.resolve();
			first.unsubscribe();
			second?.unsubscribe();
		}
	});

	it("retries a failed live read without requiring another notification", async () => {
		const schema = freshSchema();
		const pool = new pg.Pool({ connectionString: POSTGRES_URL });
		const failed = deferred<void>();
		let failNextRead = false;
		const reader = liveStore({
			schema,
			pool: interceptQueries(
				pool,
				(sql) => sql.includes("WHERE global_position > $1"),
				async (run) => {
					if (failNextRead) {
						failNextRead = false;
						failed.resolve();
						throw new Error("injected live read failure");
					}
					return run();
				},
			),
		});
		const writer = liveStore({ schema });
		await reader.ready();
		await writer.ready();
		const seen = deferred<EventEnvelope>();
		const sub = reader.subscribe({}, (event) => seen.resolve(event));
		try {
			await bounded(sub.ready);
			failNextRead = true;
			await writer.append("retry", [{ type: "retry.Created", data: {} }], {
				...OPTS,
				expectedSeq: 0,
			});
			await bounded(failed.promise);
			expect((await bounded(seen.promise)).type).toBe("retry.Created");
		} finally {
			sub.unsubscribe();
			await reader.end();
			await pool.end();
		}
	});

	it("does not deliver an old pump page to a replacement subscription", async () => {
		const schema = freshSchema();
		const pool = new pg.Pool({ connectionString: POSTGRES_URL });
		const captured = deferred<void>();
		const release = deferred<void>();
		let holdNextRead = false;
		const reader = liveStore({
			schema,
			pool: interceptQueries(
				pool,
				(sql) => sql.includes("WHERE global_position > $1"),
				async (run) => {
					const result = await run();
					if (holdNextRead && result.rows.length > 0) {
						holdNextRead = false;
						captured.resolve();
						await release.promise;
					}
					return result;
				},
			),
		});
		const writer = liveStore({ schema });
		await reader.ready();
		await writer.ready();
		const firstSeen: EventEnvelope[] = [];
		const first = reader.subscribe({}, (event) => {
			firstSeen.push(event);
		});
		let second: ReturnType<typeof reader.subscribe> | undefined;
		try {
			await bounded(first.ready);
			holdNextRead = true;
			await writer.append("replace", [{ type: "replace.First", data: {} }], {
				...OPTS,
				expectedSeq: 0,
			});
			await bounded(captured.promise);
			first.unsubscribe();
			const seen = deferred<EventEnvelope>();
			second = reader.subscribe({}, (event) => seen.resolve(event));
			await bounded(second.ready);
			release.resolve();
			await writer.append("replace", [{ type: "replace.Second", data: {} }], {
				...OPTS,
				expectedSeq: 1,
			});
			expect((await bounded(seen.promise)).type).toBe("replace.Second");
			expect(firstSeen).toEqual([]);
		} finally {
			release.resolve();
			first.unsubscribe();
			second?.unsubscribe();
			await reader.end();
			await pool.end();
		}
	});

	it("discards an old head read after its subscription is replaced", async () => {
		const schema = freshSchema();
		const pool = new pg.Pool({ connectionString: POSTGRES_URL });
		const captured = deferred<void>();
		const release = deferred<void>();
		let holdNextHead = false;
		const reader = liveStore({
			schema,
			pool: interceptQueries(
				pool,
				(sql) => sql.startsWith("SELECT last_position FROM"),
				async (run) => {
					const result = await run();
					if (holdNextHead) {
						holdNextHead = false;
						captured.resolve();
						await release.promise;
					}
					return result;
				},
			),
		});
		const writer = liveStore({ schema });
		await reader.ready();
		await writer.ready();
		holdNextHead = true;
		const first = reader.subscribe({}, () => {});
		const firstFinished = first.ready.catch(() => undefined);
		let second: ReturnType<typeof reader.subscribe> | undefined;
		try {
			await bounded(captured.promise);
			first.unsubscribe();
			await writer.append("head", [{ type: "head.Before", data: {} }], {
				...OPTS,
				expectedSeq: 0,
			});
			const seen = deferred<EventEnvelope>();
			second = reader.subscribe({}, (event) => seen.resolve(event));
			await bounded(second.ready);
			release.resolve();
			await bounded(firstFinished);
			await writer.append("head", [{ type: "head.After", data: {} }], {
				...OPTS,
				expectedSeq: 1,
			});
			expect((await bounded(seen.promise)).type).toBe("head.After");
		} finally {
			release.resolve();
			first.unsubscribe();
			second?.unsubscribe();
			await reader.end();
			await pool.end();
		}
	});
});
