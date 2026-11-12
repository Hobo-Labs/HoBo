import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, describe, inject } from "vitest";
import {
	createPostgresEventStore,
	type PostgresEventStore,
	type PostgresEventStoreOptions,
} from "../../src/index.js";

export const POSTGRES_URL = inject("postgresUrl");
export const POSTGRES_LANE = inject("postgresLane");

/** `describe` that runs on the live lane and is skipped, with its reason, otherwise. */
export function describeLive(name: string, body: () => void): void {
	if (POSTGRES_URL !== "") describe(name, body);
	else describe.skip(`${name} — SKIPPED: ${POSTGRES_LANE}`, body);
}

export const T0 = "2026-11-12T00:00:00.000Z";

export interface ManualClock {
	now(): string;
	advance(ms: number): string;
	set(iso: string): void;
}

export function manualClock(start = T0): ManualClock {
	let ms = Date.parse(start);
	return {
		now: () => new Date(ms).toISOString(),
		advance(delta: number) {
			ms += delta;
			return new Date(ms).toISOString();
		},
		set(iso: string) {
			ms = Date.parse(iso);
		},
	};
}

const RUN = randomUUID().replaceAll("-", "").slice(0, 10);
let counter = 0;
const created = new Set<string>();

/** A schema no other test file or run uses; dropped after the file. */
export function freshSchema(): string {
	counter += 1;
	const schema = `hobo_t_${RUN}_${counter}`;
	created.add(schema);
	return schema;
}

const opened: PostgresEventStore[] = [];

export function liveStore(
	options: Partial<PostgresEventStoreOptions> & { schema?: string } = {},
): PostgresEventStore {
	const { schema, config, ...rest } = options;
	const store = createPostgresEventStore({
		config: {
			connectionString: POSTGRES_URL,
			schema: schema ?? freshSchema(),
			poolSize: 4,
			...config,
		},
		clock: manualClock(),
		...rest,
	});
	opened.push(store);
	return store;
}

/** Run SQL as an administrator on the lane (fixtures, inspection). */
export async function adminQuery<T = Record<string, unknown>>(
	sql: string,
	values: unknown[] = [],
): Promise<T[]> {
	const client = new pg.Client({ connectionString: POSTGRES_URL });
	await client.connect();
	try {
		const result = await client.query(sql, values);
		// SAFETY: test fixture reads; callers name the row shape they selected.
		return result.rows as T[];
	} finally {
		await client.end();
	}
}

export async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
	const out: T[] = [];
	for await (const item of iterable) out.push(item);
	return out;
}

export const OPTS = Object.freeze({
	actor: { kind: "system" as const, id: "test" },
	tenant: "t1",
});

afterAll(async () => {
	await Promise.all(opened.splice(0).map((store) => store.end()));
	if (POSTGRES_URL === "" || created.size === 0) return;
	const client = new pg.Client({ connectionString: POSTGRES_URL });
	await client.connect();
	try {
		for (const schema of created) {
			await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
		}
	} finally {
		await client.end();
	}
});
