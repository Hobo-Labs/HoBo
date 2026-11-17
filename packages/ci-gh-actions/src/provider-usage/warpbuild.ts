/**
 * WarpBuild's CI spend, from its CI billing report (ADR-0183).
 *
 * WarpBuild's API is served at `https://api.warpbuild.com/api/v1` and takes an
 * API key as a Bearer token, as its API reference page says. `GET
 * /reports/billing/ci` takes `start_date` and `end_date` (RFC 3339, both
 * required) and answers a `summary` whose `total_cost` is the cost of the CI
 * jobs in the range, runner and snapshot cost together. WarpBuild prints its
 * runner prices in US dollars and the report names no other currency, so the
 * total is read as dollars. `per_page=1` keeps the job list in the reply to
 * one row, since only the summary is read. The call reads; it changes nothing
 * at WarpBuild.
 *
 * WarpBuild marks every endpoint "alpha - expect breaking changes": a reply
 * that no longer has this shape answers "unmeasured", and the ledger is used.
 */
import { z } from "zod";
import {
	type ProviderUsageReader,
	readJson,
	type UsageHttpDeps,
	type UsageReadRequest,
	usableUsd,
} from "./reader.js";

// public-contract: the WarpBuild page the usage call was read from.
export const WARPBUILD_USAGE_SOURCE =
	"https://warpbuild.com/docs/api/reports/GetCIBilling";
// public-contract: the day that page and the API overview were read.
export const WARPBUILD_USAGE_OBSERVED_AT = "2026-11-17";
// public-contract: WarpBuild's API base URL.
export const WARPBUILD_API_BASE = "https://api.warpbuild.com/api/v1";
// public-contract: the read-only path the WarpBuild reader calls.
export const WARPBUILD_USAGE_PATH = "/reports/billing/ci";

const billingReport = z.object({
	summary: z.object({ total_cost: z.number() }),
});

export type WarpbuildUsageReaderDeps = UsageHttpDeps &
	Readonly<{
		/** `WARPBUILD_API_BASE` unless a fake stands in. */
		baseUrl: string;
	}>;

export class WarpbuildUsageReader implements ProviderUsageReader {
	readonly provider = "warpbuild";
	readonly source = WARPBUILD_USAGE_SOURCE;

	constructor(private readonly deps: WarpbuildUsageReaderDeps) {}

	async spentUsd(request: UsageReadRequest): Promise<number | undefined> {
		const query = new URLSearchParams([
			["start_date", new Date(request.window.startMs).toISOString()],
			["end_date", new Date(request.window.endMs).toISOString()],
			["per_page", "1"],
		]);
		const reply = await readJson(
			this.deps,
			`${this.deps.baseUrl.replace(/\/+$/u, "")}${WARPBUILD_USAGE_PATH}?${query}`,
			{
				method: "GET",
				headers: new Map([
					["accept", "application/json"],
					["authorization", `Bearer ${request.token}`],
				]),
				body: undefined,
			},
			billingReport,
		);
		return reply === undefined
			? undefined
			: usableUsd(reply.summary.total_cost);
	}
}
