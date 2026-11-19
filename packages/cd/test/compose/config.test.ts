import { describe, expect, it } from "vitest";
import {
	CD_COMPOSE_ENV,
	cdFleetMemberUrlVariable,
	isSimulated,
	parseCdComposeConfig,
} from "../../src/compose/config.js";
import { CD_DEFAULTS } from "../../src/events.js";

const home = "/home/u/.hobo";

describe("parseCdComposeConfig (store selection, R6)", () => {
	it("defaults to SQLite and filesystem artifacts under HOBO_HOME", () => {
		const out = parseCdComposeConfig({ env: {}, home, simulate: false });
		expect(out.ok).toBe(true);
		if (!out.ok) return;
		expect(out.value.store).toEqual({
			backend: "sqlite",
			path: `${home}/cd/journal.sqlite`,
		});
		expect(out.value.artifacts).toEqual({
			backend: "filesystem",
			root: `${home}/cd/artifacts`,
		});
		expect(out.value.tickIntervalMs).toBe(CD_DEFAULTS.serviceTickMs);
		expect(out.value.tenant).toBe("local");
		expect(isSimulated(out.value)).toBe(false);
	});

	it("selects a Postgres fleet whose connection strings stay in the secret store", () => {
		const out = parseCdComposeConfig({
			env: {
				[CD_COMPOSE_ENV.postgresFleet]: "neon-eu:neon-claimable, supabase",
				[CD_COMPOSE_ENV.postgresWitnesses]: "prisma",
				[CD_COMPOSE_ENV.replicas]: "2",
				[CD_COMPOSE_ENV.s3Endpoint]: "https://s3.example.test",
				[CD_COMPOSE_ENV.s3Bucket]: "fixture",
				[CD_COMPOSE_ENV.s3Region]: "fixture",
				[CD_COMPOSE_ENV.s3CredentialRef]: "fixture",
			},
			home,
			simulate: false,
		});
		expect(out.ok && out.value.store).toEqual({
			backend: "postgres-fleet",
			members: [
				{
					id: "neon-eu",
					urlEntry: "HOBO_CD_POSTGRES_URL_NEON_EU",
					plan: "neon-claimable",
				},
				{ id: "supabase", urlEntry: "HOBO_CD_POSTGRES_URL_SUPABASE" },
			],
			witnesses: [{ id: "prisma", urlEntry: "HOBO_CD_POSTGRES_URL_PRISMA" }],
			poolSize: CD_DEFAULTS.postgresPoolSize,
			statementTimeoutMs: CD_DEFAULTS.postgresStatementTimeoutMs,
			minMajorVersion: CD_DEFAULTS.postgresMinMajorVersion,
		});
		expect(cdFleetMemberUrlVariable("neon-eu")).toBe(
			"HOBO_CD_POSTGRES_URL_NEON_EU",
		);
	});

	it("refuses a connection string in the environment, and a member named twice", () => {
		const inEnv = parseCdComposeConfig({
			env: {
				[CD_COMPOSE_ENV.postgresFleet]: "neon",
				HOBO_CD_POSTGRES_URL_NEON: "postgres://cd:pw@neon/cd",
			},
			home,
			simulate: false,
		});
		expect(inEnv.ok).toBe(false);
		const withPassword = parseCdComposeConfig({
			env: { [CD_COMPOSE_ENV.postgresUrl]: "postgres://cd:pw@db/cd" },
			home,
			simulate: false,
		});
		expect(withPassword.ok).toBe(false);
		const twice = parseCdComposeConfig({
			env: {
				[CD_COMPOSE_ENV.postgresFleet]: "neon",
				[CD_COMPOSE_ENV.postgresWitnesses]: "neon",
			},
			home,
			simulate: false,
		});
		expect(twice.ok).toBe(false);
		const badPlan = parseCdComposeConfig({
			env: { [CD_COMPOSE_ENV.postgresFleet]: "neon:Neon Free:x" },
			home,
			simulate: false,
		});
		expect(badPlan.ok).toBe(false);
	});

	it("selects Postgres when configured, with frozen pool and timeout defaults", () => {
		const out = parseCdComposeConfig({
			env: { [CD_COMPOSE_ENV.postgresUrl]: "postgres://cd@db/cd" },
			home,
			simulate: false,
		});
		expect(out.ok && out.value.store).toEqual({
			backend: "postgres",
			url: "postgres://cd@db/cd",
			poolSize: CD_DEFAULTS.postgresPoolSize,
			statementTimeoutMs: CD_DEFAULTS.postgresStatementTimeoutMs,
			minMajorVersion: CD_DEFAULTS.postgresMinMajorVersion,
		});
	});

	it("refuses multiple replicas without Postgres (compose-store-multinode)", () => {
		const out = parseCdComposeConfig({
			env: { [CD_COMPOSE_ENV.replicas]: "2" },
			home,
			simulate: false,
		});
		expect(out.ok).toBe(false);
		if (!out.ok) {
			expect(out.reasons[0]?.code).toBe("compose-store-multinode");
			expect(out.reasons[0]?.remediation).toMatch(/HOBO_CD_POSTGRES_URL/);
		}
	});

	it("refuses a non-postgres URL and a bad pool size", () => {
		for (const env of [
			{ [CD_COMPOSE_ENV.postgresUrl]: "mysql://x" },
			{
				[CD_COMPOSE_ENV.postgresUrl]: "postgres://x",
				[CD_COMPOSE_ENV.postgresPool]: "0",
			},
			{ [CD_COMPOSE_ENV.tickMs]: "fast" },
		]) {
			const out = parseCdComposeConfig({ env, home, simulate: false });
			expect(out.ok).toBe(false);
			if (!out.ok) expect(out.reasons[0]?.code).toBe("compose-store-invalid");
		}
	});

	it("reaches the in-memory fixtures only with --simulate", () => {
		const real = parseCdComposeConfig({ env: {}, home, simulate: false });
		const sim = parseCdComposeConfig({ env: {}, home, simulate: true });
		expect(real.ok && real.value.store.backend).toBe("sqlite");
		expect(sim.ok && sim.value.store.backend).toBe("memory");
		expect(sim.ok && sim.value.artifacts.backend).toBe("memory");
		expect(sim.ok && isSimulated(sim.value)).toBe(true);
	});

	it("parses s3-compatible artifacts and refuses an incomplete or plaintext one", () => {
		const ok = parseCdComposeConfig({
			env: {
				[CD_COMPOSE_ENV.s3Endpoint]: "https://s3.example",
				[CD_COMPOSE_ENV.s3Bucket]: "b",
				[CD_COMPOSE_ENV.s3Region]: "r",
				[CD_COMPOSE_ENV.s3CredentialRef]: "secret://cd/s3",
			},
			home,
			simulate: false,
		});
		expect(ok.ok && ok.value.artifacts.backend).toBe("s3-compatible");
		const bad = parseCdComposeConfig({
			env: { [CD_COMPOSE_ENV.s3Endpoint]: "http://s3.example" },
			home,
			simulate: false,
		});
		expect(bad.ok).toBe(false);
		if (!bad.ok) expect(bad.reasons[0]?.code).toBe("compose-artifacts-invalid");
	});

	it("requires shared artifact storage for multiple replicas", () => {
		const env = {
			[CD_COMPOSE_ENV.replicas]: "2",
			[CD_COMPOSE_ENV.postgresUrl]: "postgres://fixture@db.test/cd",
		};
		const local = parseCdComposeConfig({ env, home, simulate: false });
		expect(local.ok).toBe(false);
		if (!local.ok)
			expect(local.reasons[0]?.code).toBe("compose-artifacts-invalid");
		const shared = parseCdComposeConfig({
			env: {
				...env,
				[CD_COMPOSE_ENV.s3Endpoint]: "https://s3.example.test",
				[CD_COMPOSE_ENV.s3Bucket]: "fixture",
				[CD_COMPOSE_ENV.s3Region]: "fixture",
				[CD_COMPOSE_ENV.s3CredentialRef]: "fixture",
			},
			home,
			simulate: false,
		});
		expect(shared.ok && shared.value.artifacts.backend).toBe("s3-compatible");
	});
});
