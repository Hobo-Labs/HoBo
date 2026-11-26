import { z } from "zod";
import {
	type ProviderUsageReader,
	readJson,
	type UsageHttpDeps,
	type UsageReadRequest,
	usableUsd,
} from "./reader.js";

export const WARPBUILD_USAGE_SOURCE =
	"https://warpbuild.com/docs/api/reports/GetCIBilling";
export const WARPBUILD_USAGE_OBSERVED_AT = "2026-11-17";
export const WARPBUILD_API_BASE = "https://api.warpbuild.com/api/v1";
export const WARPBUILD_USAGE_PATH = "/reports/billing/ci";

const billingReport = z.object({
	summary: z.object({ total_cost: z.number() }),
});

export type WarpbuildUsageReaderDeps = UsageHttpDeps &
	Readonly<{
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
