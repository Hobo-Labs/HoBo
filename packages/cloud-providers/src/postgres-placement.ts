import {
	type DataStoreCatalogEntry,
	type DataStorePortRequest,
	type DataStoreProvider,
	matchDataStoreOfferings,
} from "@hobo/core";

import {
	POSTGRES_BACKEND_CATALOG,
	postgresBackendProfiles,
} from "./postgres-backends.js";

// Cheapest-available PostgreSQL placement (docs/design/postgres-backend-catalog.md
// "Placement"). No single vendor is a dependency: a request for
// `data.postgres` is placed on a *fleet* — a writer and standbys on other
// vendors — chosen from every catalog backend that satisfies it, so Neon,
// Supabase, Prisma Postgres, pgEdge, PlanetScale, the hyperscalers and a
// self-hosted Postgres all compete on the same terms.
//
// - A backend the host cannot reach is skipped, never fatal. Placement is
//   `unavailable` only when no configured backend that satisfies the request
//   is reachable.
// - Order is cost first (known monthly fee, ascending; unknown fees after
//   every known one), then probe latency, then catalog order. The cheapest
//   reachable backend is the writer.
// - Standbys prefer vendors other than the writer's, so one vendor's outage
//   leaves a standby to fail over to. A fleet with fewer standbys than asked
//   for is `degraded`, not refused: it serves, and says what it lacks.
//
// The result's `fleetOrder` is the `backends` order `reconcileFleet`
// (`@hobo/data-postgres`) takes — the first entry is the writer of an empty
// fleet — and the runtime keeps the fleet converged from there: it copies the
// writer to every standby, and `decideFleet` (`@hobo/backend-fleet`) fails
// over to a standby within the RPO when the writer stops answering or
// switches to a cheaper one when an allowance runs out. Placement chooses who
// is in the fleet; the fleet decides, continuously, who writes.

/** What the host knows about one configured backend at placement time. */
export interface PostgresOffer {
	/** The catalog backend this offer is an account on. */
	readonly provider: DataStoreProvider;
	/** Distinguishes two accounts on one product (`neon-eu`, `neon-us`). */
	readonly id?: string;
	/** `reachable` passed a probe; `unreachable` failed one; `unknown` was not probed. */
	readonly health: "reachable" | "unreachable" | "unknown";
	/** Fixed monthly fee in millionths of a US dollar; absent when unknown. */
	readonly monthlyFeeMicros?: number;
	readonly probeLatencyMs?: number;
}

export interface PostgresPlacementRequest {
	readonly request?: DataStorePortRequest;
	/** Standbys wanted beside the writer (default 1). */
	readonly standbys?: number;
}

export interface PlacedPostgresBackend {
	readonly id: string;
	readonly provider: DataStoreProvider;
	readonly vendor: string;
	readonly role: "writer" | "standby";
	readonly health: PostgresOffer["health"];
	readonly monthlyFeeMicros: number | undefined;
}

export interface SkippedPostgresBackend {
	readonly id: string;
	readonly provider: DataStoreProvider;
	readonly reason: "unreachable" | "unsatisfied" | "not-in-catalog";
	readonly detail: string;
}

export interface PostgresPlacement {
	readonly status: "placed" | "degraded" | "unavailable";
	readonly writer: PlacedPostgresBackend | undefined;
	readonly standbys: readonly PlacedPostgresBackend[];
	/** Writer first: the `backends` order `reconcileFleet` takes. */
	readonly fleetOrder: readonly string[];
	readonly skipped: readonly SkippedPostgresBackend[];
	/** Why the placement is degraded or unavailable; empty when placed. */
	readonly reasons: readonly string[];
}

interface Candidate {
	readonly id: string;
	readonly offer: PostgresOffer;
	readonly entry: DataStoreCatalogEntry;
	readonly catalogIndex: number;
}

function offerId(offer: PostgresOffer): string {
	return offer.id ?? offer.provider;
}

function byCost(a: Candidate, b: Candidate): number {
	const fee = (c: Candidate) =>
		c.offer.monthlyFeeMicros ?? Number.POSITIVE_INFINITY;
	if (fee(a) !== fee(b)) return fee(a) < fee(b) ? -1 : 1;
	// A probed-reachable backend outranks an unprobed one at the same fee.
	const probed = (c: Candidate) => (c.offer.health === "reachable" ? 0 : 1);
	if (probed(a) !== probed(b)) return probed(a) - probed(b);
	const latency = (c: Candidate) =>
		c.offer.probeLatencyMs ?? Number.POSITIVE_INFINITY;
	if (latency(a) !== latency(b)) return latency(a) < latency(b) ? -1 : 1;
	if (a.catalogIndex !== b.catalogIndex) return a.catalogIndex - b.catalogIndex;
	return a.id.localeCompare(b.id);
}

function placed(
	candidate: Candidate,
	role: PlacedPostgresBackend["role"],
): PlacedPostgresBackend {
	return {
		id: candidate.id,
		provider: candidate.offer.provider,
		vendor: candidate.entry.vendor,
		role,
		health: candidate.offer.health,
		monthlyFeeMicros: candidate.offer.monthlyFeeMicros,
	};
}

/**
 * Place a PostgreSQL request on the cheapest reachable fleet of the
 * configured offers. Pure: probes are the caller's, and nothing is created.
 */
export function placePostgresFleet(
	offers: readonly PostgresOffer[],
	options: PostgresPlacementRequest = {},
): PostgresPlacement {
	const wantedStandbys = options.standbys ?? 1;
	if (!Number.isInteger(wantedStandbys) || wantedStandbys < 0)
		throw new RangeError("standbys must be a non-negative integer");
	const profiles = postgresBackendProfiles();
	const skipped: SkippedPostgresBackend[] = [];
	const candidates: Candidate[] = [];
	const seen = new Set<string>();

	for (const offer of offers) {
		const id = offerId(offer);
		if (seen.has(id)) throw new RangeError(`duplicate Postgres offer id ${id}`);
		seen.add(id);
		const catalogIndex = POSTGRES_BACKEND_CATALOG.findIndex(
			(entry) => entry.provider === offer.provider,
		);
		const entry = POSTGRES_BACKEND_CATALOG[catalogIndex];
		const profile = profiles[catalogIndex];
		if (entry === undefined || profile === undefined) {
			skipped.push({
				id,
				provider: offer.provider,
				reason: "not-in-catalog",
				detail: `${offer.provider} is not a PostgreSQL backend in the catalog`,
			});
			continue;
		}
		const match = matchDataStoreOfferings(profile, options.request ?? {});
		if (match.kind !== "full") {
			skipped.push({
				id,
				provider: offer.provider,
				reason: "unsatisfied",
				detail:
					match.kind === "none"
						? match.remediation
						: `missing ${match.missing.join(", ")}`,
			});
			continue;
		}
		if (offer.health === "unreachable") {
			skipped.push({
				id,
				provider: offer.provider,
				reason: "unreachable",
				detail: `${entry.vendor} ${entry.product} did not answer its probe; placed elsewhere`,
			});
			continue;
		}
		candidates.push({ id, offer, entry, catalogIndex });
	}

	candidates.sort(byCost);
	const [writer, ...rest] = candidates;
	if (writer === undefined)
		return {
			status: "unavailable",
			writer: undefined,
			standbys: [],
			fleetOrder: [],
			skipped,
			reasons: [
				offers.length === 0
					? "no PostgreSQL backend is configured; configure at least two vendors (e.g. Neon and Supabase) for failover"
					: "no configured PostgreSQL backend that satisfies the request is reachable",
			],
		};

	// Standbys: other vendors first (cheapest first within each pass), so a
	// single vendor's outage cannot take the writer and every standby down.
	const otherVendor = rest.filter(
		(c) => c.entry.vendor !== writer.entry.vendor,
	);
	const sameVendor = rest.filter((c) => c.entry.vendor === writer.entry.vendor);
	const standbys = [...otherVendor, ...sameVendor].slice(0, wantedStandbys);

	const reasons: string[] = [];
	if (standbys.length < wantedStandbys)
		reasons.push(
			`${standbys.length} of ${wantedStandbys} standbys available; configure another PostgreSQL vendor for failover`,
		);
	else if (
		wantedStandbys > 0 &&
		standbys.every((c) => c.entry.vendor === writer.entry.vendor)
	)
		reasons.push(
			`every standby is on ${writer.entry.vendor}, the writer's vendor; one outage can take the fleet down`,
		);

	return {
		status: reasons.length === 0 ? "placed" : "degraded",
		writer: placed(writer, "writer"),
		standbys: standbys.map((c) => placed(c, "standby")),
		fleetOrder: [writer.id, ...standbys.map((c) => c.id)],
		skipped,
		reasons,
	};
}
