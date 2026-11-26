import { describe, expect, it } from "vitest";

import { type PostgresOffer, placePostgresFleet } from "../src/index.js";

// Cheapest-available PostgreSQL placement: no vendor is a dependency. An
// unreachable backend is skipped, standbys go to other vendors, and placement
// is unavailable only when nothing configured answers.

const usd = (dollars: number) => dollars * 1_000_000;

const NEON: PostgresOffer = {
	provider: "neon-postgres",
	health: "reachable",
	monthlyFeeMicros: 0,
	failureDomains: ["neon", "aws-east"],
};
const SUPABASE: PostgresOffer = {
	provider: "supabase-postgres",
	health: "reachable",
	monthlyFeeMicros: 0,
	probeLatencyMs: 40,
	failureDomains: ["supabase", "gcp-west"],
};
const PRISMA: PostgresOffer = {
	provider: "prisma-postgres",
	health: "reachable",
	monthlyFeeMicros: usd(10),
	failureDomains: ["prisma", "azure-east"],
};
const SELF_HOSTED: PostgresOffer = {
	provider: "self-hosted-postgres",
	health: "reachable",
	failureDomains: ["self-hosted-site"],
};

describe("placePostgresFleet", () => {
	it("never selects an unprobed backend even if it is cheaper", () => {
		const placement = placePostgresFleet([
			{ ...NEON, health: "unknown" },
			PRISMA,
		]);
		expect(placement.writer?.provider).toBe("prisma-postgres");
		expect(placement.status).toBe("degraded");
		expect(placement.skipped).toContainEqual(
			expect.objectContaining({
				provider: "neon-postgres",
				reason: "unprobed",
			}),
		);
		expect(placePostgresFleet([{ ...NEON, health: "unknown" }]).status).toBe(
			"unavailable",
		);
	});

	it("does not claim independent failover when vendors share a failure domain or domain evidence is absent", () => {
		const shared = placePostgresFleet([
			NEON,
			{ ...SUPABASE, failureDomains: ["supabase", "aws-east"] },
		]);
		expect(shared.status).toBe("degraded");
		expect(shared.reasons.join(" ")).toMatch(/failure.domain/i);
		const { failureDomains: _domains, ...unverified } = SUPABASE;
		const unknown = placePostgresFleet([NEON, unverified]);
		expect(unknown.status).toBe("degraded");
	});

	it("prefers verified independent standbys over cheaper overlapping ones", () => {
		const placement = placePostgresFleet([
			NEON,
			{ ...SUPABASE, failureDomains: ["supabase", "aws-east"] },
			PRISMA,
		]);
		expect(placement.standbys[0]?.provider).toBe("prisma-postgres");
		expect(placement.status).toBe("placed");
	});

	it("marks a fleet degraded if selected standbys share a failure domain", () => {
		const placement = placePostgresFleet(
			[NEON, SUPABASE, { ...PRISMA, failureDomains: ["prisma", "gcp-west"] }],
			{ standbys: 2 },
		);
		expect(placement.status).toBe("degraded");
		expect(placement.reasons.join(" ")).toMatch(/failure.domain/i);
	});

	it("rejects malformed cost, latency, and backend identities", () => {
		for (const offer of [
			{ ...NEON, monthlyFeeMicros: -1 },
			{ ...NEON, monthlyFeeMicros: Number.NaN },
			{ ...NEON, probeLatencyMs: -1 },
			{ ...NEON, id: "INVALID ID" },
			{ ...NEON, failureDomains: ["aws", "aws"] },
		])
			expect(() => placePostgresFleet([offer])).toThrow(RangeError);
	});
	it("places the cheapest reachable backend as writer and a standby on another vendor", () => {
		const placement = placePostgresFleet([PRISMA, SUPABASE, NEON]);
		expect(placement.status).toBe("placed");
		// Equal fee and both probed: the recorded lower latency (Supabase 40ms vs
		// none recorded for Neon) breaks the tie.
		expect(placement.writer?.provider).toBe("supabase-postgres");
		expect(placement.standbys.map((b) => b.provider)).toEqual([
			"neon-postgres",
		]);
		expect(placement.fleetOrder).toEqual([
			"supabase-postgres",
			"neon-postgres",
		]);
	});

	it("skips Neon when it is unreachable instead of failing the deployment", () => {
		const placement = placePostgresFleet([
			{ ...NEON, health: "unreachable" },
			SUPABASE,
			PRISMA,
		]);
		expect(placement.status).toBe("placed");
		expect(placement.writer?.provider).toBe("supabase-postgres");
		expect(placement.standbys.map((b) => b.provider)).toEqual([
			"prisma-postgres",
		]);
		expect(placement.skipped).toEqual([
			expect.objectContaining({
				provider: "neon-postgres",
				reason: "unreachable",
			}),
		]);
	});

	it("serves degraded when only one vendor answers", () => {
		const placement = placePostgresFleet([
			{ ...NEON, health: "unreachable" },
			SUPABASE,
		]);
		expect(placement.status).toBe("degraded");
		expect(placement.writer?.provider).toBe("supabase-postgres");
		expect(placement.reasons.join(" ")).toMatch(/0 of 1 standbys/);
	});

	it("ranks unknown fees after every known one", () => {
		const placement = placePostgresFleet([SELF_HOSTED, PRISMA], {
			standbys: 1,
		});
		expect(placement.writer?.provider).toBe("prisma-postgres");
		expect(placement.standbys[0]?.provider).toBe("self-hosted-postgres");
	});

	it("prefers another vendor for standbys even when a same-vendor account is cheaper", () => {
		const placement = placePostgresFleet([
			{ ...NEON, id: "neon-eu" },
			{ ...NEON, id: "neon-us", monthlyFeeMicros: usd(1) },
			PRISMA,
		]);
		expect(placement.writer?.id).toBe("neon-eu");
		expect(placement.standbys.map((b) => b.id)).toEqual(["prisma-postgres"]);
	});

	it("is unavailable only when no configured backend answers", () => {
		const placement = placePostgresFleet([
			{ ...NEON, health: "unreachable" },
			{ ...SUPABASE, health: "unreachable" },
		]);
		expect(placement.status).toBe("unavailable");
		expect(placement.fleetOrder).toEqual([]);
		expect(placement.skipped).toHaveLength(2);
		expect(placePostgresFleet([]).reasons[0]).toMatch(/at least two vendors/);
	});

	it("refuses non-Postgres stores and duplicate ids", () => {
		const placement = placePostgresFleet([
			{ provider: "cloudflare-d1", health: "reachable" },
			SUPABASE,
		]);
		expect(placement.skipped[0]?.reason).toBe("not-in-catalog");
		expect(() => placePostgresFleet([NEON, NEON])).toThrow(/duplicate/);
		expect(() => placePostgresFleet([NEON], { standbys: -1 })).toThrow(
			RangeError,
		);
	});
});
