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

export interface PostgresOffer {
	readonly provider: DataStoreProvider;
	readonly id?: string;
	readonly health: "reachable" | "unreachable" | "unknown";
	readonly monthlyFeeMicros?: number;
	readonly probeLatencyMs?: number;
	readonly failureDomains?: readonly string[];
}

export interface PostgresPlacementRequest {
	readonly request?: DataStorePortRequest;
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
	readonly reason:
		| "unreachable"
		| "unprobed"
		| "unsatisfied"
		| "not-in-catalog";
	readonly detail: string;
}

export interface PostgresPlacement {
	readonly status: "placed" | "degraded" | "unavailable";
	readonly writer: PlacedPostgresBackend | undefined;
	readonly standbys: readonly PlacedPostgresBackend[];
	readonly fleetOrder: readonly string[];
	readonly skipped: readonly SkippedPostgresBackend[];
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
	const latency = (c: Candidate) =>
		c.offer.probeLatencyMs ?? Number.POSITIVE_INFINITY;
	if (latency(a) !== latency(b)) return latency(a) < latency(b) ? -1 : 1;
	if (a.catalogIndex !== b.catalogIndex) return a.catalogIndex - b.catalogIndex;
	return a.id.localeCompare(b.id);
}

function independent(a: Candidate, b: Candidate): boolean {
	const left = a.offer.failureDomains;
	const right = b.offer.failureDomains;
	return (
		left !== undefined &&
		left.length > 0 &&
		right !== undefined &&
		right.length > 0 &&
		left.every((domain) => !right.includes(domain))
	);
}

function isOfferString(value: string): boolean {
	return Object.prototype.toString.call(value) === "[object String]";
}

function validateOffer(offer: PostgresOffer, id: string): void {
	if (!isOfferString(id) || !/^[a-z0-9][a-z0-9_-]{0,62}$/u.test(id))
		throw new RangeError(
			"Postgres offer id must be a short lower-case fleet token",
		);
	if (!["reachable", "unreachable", "unknown"].includes(offer.health))
		throw new RangeError(`invalid Postgres offer health for ${id}`);
	if (
		offer.monthlyFeeMicros !== undefined &&
		(!Number.isSafeInteger(offer.monthlyFeeMicros) ||
			offer.monthlyFeeMicros < 0)
	)
		throw new RangeError(`invalid Postgres offer fee for ${id}`);
	if (
		offer.probeLatencyMs !== undefined &&
		(!Number.isFinite(offer.probeLatencyMs) || offer.probeLatencyMs < 0)
	)
		throw new RangeError(`invalid Postgres offer probe latency for ${id}`);
	const domains = offer.failureDomains;
	if (
		domains !== undefined &&
		(!Array.isArray(domains) ||
			domains.some(
				(domain) =>
					!isOfferString(domain) ||
					domain.length === 0 ||
					domain.trim() !== domain,
			) ||
			new Set(domains).size !== domains.length)
	)
		throw new RangeError(`invalid Postgres offer failure domains for ${id}`);
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
		validateOffer(offer, id);
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
		if (offer.health !== "reachable") {
			skipped.push({
				id,
				provider: offer.provider,
				reason: offer.health === "unknown" ? "unprobed" : "unreachable",
				detail:
					offer.health === "unknown"
						? `${entry.vendor} ${entry.product} has not passed a probe`
						: `${entry.vendor} ${entry.product} did not answer its probe`,
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

	const remaining = [...rest];
	const standbys: Candidate[] = [];
	while (standbys.length < wantedStandbys && remaining.length > 0) {
		const selected = [writer, ...standbys];
		remaining.sort((a, b) => {
			const aIndependent = selected.every((c) => independent(a, c));
			const bIndependent = selected.every((c) => independent(b, c));
			if (aIndependent !== bIndependent) return aIndependent ? -1 : 1;
			const aOtherVendor = a.entry.vendor !== writer.entry.vendor;
			const bOtherVendor = b.entry.vendor !== writer.entry.vendor;
			if (aOtherVendor !== bOtherVendor) return aOtherVendor ? -1 : 1;
			return byCost(a, b);
		});
		const next = remaining.shift();
		if (next !== undefined) standbys.push(next);
	}

	const reasons: string[] = [];
	if (standbys.length < wantedStandbys)
		reasons.push(
			`${standbys.length} of ${wantedStandbys} standbys available; configure another PostgreSQL vendor for failover`,
		);
	if (
		standbys.some(
			(candidate, index) =>
				![writer, ...standbys.slice(0, index)].every((other) =>
					independent(candidate, other),
				),
		)
	)
		reasons.push("standby failure-domain independence is shared or unverified");

	return {
		status: reasons.length === 0 ? "placed" : "degraded",
		writer: placed(writer, "writer"),
		standbys: standbys.map((c) => placed(c, "standby")),
		fleetOrder: [writer.id, ...standbys.map((c) => c.id)],
		skipped,
		reasons,
	};
}
