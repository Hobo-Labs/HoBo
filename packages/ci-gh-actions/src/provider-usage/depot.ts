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

const CENTS_PER_USD = 100;

export type DepotUsageReaderDeps = UsageHttpDeps &
	Readonly<{
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
		if (reply === undefined) return undefined;
		const cost = reply.actualCost ?? 0;
		if (cost === 0) return 0;
		if (reply.currency?.toUpperCase() !== "USD") return undefined;
		return usableUsd(cost / CENTS_PER_USD);
	}
}
