import { randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, describe, expect, it } from "vitest";

import { openCdStore } from "../src/cd-store.js";

// The CD journal on a fleet of PostgreSQL backends, opened the way `hobo serve
// cd` opens it. Gated like the other live lanes on HOBO_TEST_POSTGRES_URL.
const ADMIN = process.env.HOBO_TEST_POSTGRES_URL;
const RUN = randomUUID().replaceAll("-", "").slice(0, 8);
const created: string[] = [];

async function admin(sql: string): Promise<void> {
	const client = new pg.Client({ connectionString: ADMIN });
	await client.connect();
	try {
		await client.query(sql);
	} finally {
		await client.end();
	}
}

/** Stand-in for the owner's secret store: entry name to connection string. */
const store = new Map<string, string>();
const readSecret = async (entry: string) => store.get(entry);

async function database(id: string): Promise<{ id: string; urlEntry: string }> {
	const name = `hobo_cd_fleet_${RUN}_${id.replaceAll("-", "_")}`;
	await admin(`CREATE DATABASE ${name}`);
	created.push(name);
	const urlEntry = `HOBO_CD_POSTGRES_URL_${id.toUpperCase().replaceAll("-", "_")}`;
	store.set(
		urlEntry,
		(ADMIN ?? "").replace(/^(postgres(?:ql)?:\/\/[^/?]*)\/[^?]*/u, `$1/${name}`),
	);
	return { id, urlEntry };
}

afterAll(async () => {
	for (const name of created)
		await admin(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
});

describe.skipIf(ADMIN === undefined)("CD journal on a PostgreSQL fleet", () => {
	it(
		"opens on the first member and reports unverified failure domains",
		{ timeout: 60_000 },
		async () => {
			const members = [
				await database("vendor-a"),
				await database("vendor-b"),
				await database("vendor-c"),
			];
			const opened = await openCdStore(
				{
					backend: "postgres-fleet",
					members,
					witnesses: [],
					poolSize: 4,
					statementTimeoutMs: 5_000,
					minMajorVersion: 16,
				},
				{ now: () => Date.now() },
				readSecret,
			);
			try {
				await opened.store.append(
					"rollout:r1",
					[{ type: "rollout.Started", data: {} }],
					{
						expectedSeq: 0,
						actor: { kind: "system", id: "test" },
						tenant: "local",
					},
				);
				expect(opened.fleet?.()).toEqual({
					writer: "vendor-a",
					shortfalls: [
						"backend failure-domain diversity is unverified; distinct member names do not establish independent vendors.",
					],
				});
			} finally {
				await opened.close();
			}
		},
	);

	it("will not open a fleet without the secret store", async () => {
		await expect(
			openCdStore(
				{
					backend: "postgres-fleet",
					members: [{ id: "a", urlEntry: "HOBO_CD_POSTGRES_URL_A" }],
					witnesses: [],
					poolSize: 2,
					statementTimeoutMs: 5_000,
					minMajorVersion: 16,
				},
				{ now: () => Date.now() },
			),
		).rejects.toThrow(/secret store/);
	});

	it("names the shortfall of a fleet that cannot fail over on its own", async () => {
		const members = [await database("solo-a"), await database("solo-b")];
		const opened = await openCdStore(
			{
				backend: "postgres-fleet",
				members,
				witnesses: [],
				poolSize: 2,
				statementTimeoutMs: 5_000,
				minMajorVersion: 16,
			},
			{ now: () => Date.now() },
			readSecret,
		);
		try {
			expect(opened.fleet?.().shortfalls.join(" ")).toMatch(/witness/);
		} finally {
			await opened.close();
		}
	});
});
