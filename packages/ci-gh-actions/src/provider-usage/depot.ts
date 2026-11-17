/**
 * Depot's GitHub Actions spend, from its usage projection (ADR-0183).
 *
 * Depot serves its API over Connect: each procedure is a POST of JSON to
 * `https://api.depot.dev/<service>/<method>` with an organization token as a
 * Bearer token and `Connect-Protocol-Version: 1`, as Depot's GitHub Actions
 * API page shows. `GetGithubActionsUsageProjection` takes a `timeRange`
 * (`startAt` inclusive, `endAt` exclusive, RFC 3339) and answers
 * `actualCost`, the observed GitHub Actions cost "in the smallest unit of
 * `currency`", with `currency` an ISO 4217 code. Depot's page says the cost
 * "uses the published list rate and excludes discounts, credits, and custom
 * pricing", so this reading is Depot's own list-price figure for the minutes
 * Depot measured, which is still better than the ledger's estimate. The call
 * reads; it changes nothing at Depot.
 *
 * Field names and types are from Depot's OpenAPI description of that
 * service, `https://depot.dev/openapi/depot-github-actions/v1.json`.
 */
import { z } from "zod";
import {
	type ProviderUsageReader,
	readJson,
	type UsageHttpDeps,
	type UsageReadRequest,
	usableUsd,
} from "./reader.js";

// public-contract: the Depot page the usage call was read from.
export const DEPOT_USAGE_SOURCE =
	"https://depot.dev/docs/api/github-actions-api";
// public-contract: the day that page and its OpenAPI description were read.
export const DEPOT_USAGE_OBSERVED_AT = "2026-11-17";
// public-contract: Depot's API origin.
export const DEPOT_API_ORIGIN = "https://api.depot.dev";
// public-contract: the read-only Connect procedure the Depot reader calls.
export const DEPOT_USAGE_PROCEDURE =
	"/depot.core.v1.GithubActionsService/GetGithubActionsUsageProjection";

/** A protobuf int64 in JSON: a number, or the decimal string Connect sends. */
const int64 = z.union([
	z.number().int(),
	z
		.string()
		.regex(/^-?\d+$/u)
		.transform((text) => Number(text)),
]);

const projection = z.object({
	actualCost: int64.optional(),
	currency: z.string().optional(),
});

/** Minor units per US dollar (ISO 4217 gives USD two decimals). */
const CENTS_PER_USD = 100;

export type DepotUsageReaderDeps = UsageHttpDeps &
	Readonly<{
		/** `DEPOT_API_ORIGIN` unless a fake stands in. */
		baseUrl: string;
	}>;

export class DepotUsageReader implements ProviderUsageReader {
	readonly provider = "depot";
	readonly source = DEPOT_USAGE_SOURCE;

	constructor(private readonly deps: DepotUsageReaderDeps) {}

	async spentUsd(request: UsageReadRequest): Promise<number | undefined> {
		const reply = await readJson(
			this.deps,
			`${this.deps.baseUrl.replace(/\/+$/u, "")}${DEPOT_USAGE_PROCEDURE}`,
			{
				method: "POST",
				headers: new Map([
					["authorization", `Bearer ${request.token}`],
					["connect-protocol-version", "1"],
					["content-type", "application/json"],
				]),
				body: JSON.stringify({
					timeRange: {
						startAt: new Date(request.window.startMs).toISOString(),
						endAt: new Date(request.window.endMs).toISOString(),
					},
				}),
			},
			projection,
		);
		// An empty month answers no cost at all: proto3 JSON leaves a zero out.
		if (reply === undefined) return undefined;
		const cost = reply.actualCost ?? 0;
		if (cost === 0) return 0;
		// A cost in another currency, or in none named, is not a dollar figure.
		if (reply.currency?.toUpperCase() !== "USD") return undefined;
		return usableUsd(cost / CENTS_PER_USD);
	}
}
