import { z } from "zod";
import {
	type ProviderUsageReader,
	readJson,
	type UsageHttpDeps,
	type UsageReadRequest,
	usableUsd,
} from "./reader.js";
import { NAMESPACE_DEFAULT_REGION } from "./subscription.js";

export const NAMESPACE_USAGE_SOURCE =
	"https://namespace.so/docs/reference/typescript-sdk/compute/usage";
export const NAMESPACE_RATE_SOURCE =
	"https://namespace.so/docs/workspaces/billing-and-limits";
export const NAMESPACE_USAGE_OBSERVED_AT = "2026-11-17";
export const NAMESPACE_USD_PER_UNIT_MINUTE = 0.0015;
export const NAMESPACE_USAGE_PROCEDURE =
	"/namespace.cloud.compute.v1beta.UsageService/GetUsage";

export function namespaceComputeOrigin(region: string): string {
	return `https://${region}.compute.namespaceapis.com`;
}

const int64 = z.union([
	z.number().int(),
	z
		.string()
		.regex(/^-?\d+$/u)
		.transform((text) => Number(text)),
]);

const usageReply = z.object({
	total: z
		.object({
			instanceMinutes: z.object({ unit: int64.optional() }).optional(),
		})
		.optional(),
});

type CalendarDay = Readonly<{ year: number; month: number; day: number }>;

export type NamespacePeriod = Readonly<{
	periodStart: CalendarDay;
	periodEnd: CalendarDay;
}>;

function utcDay(ms: number): CalendarDay {
	const at = new Date(ms);
	return {
		year: at.getUTCFullYear(),
		month: at.getUTCMonth() + 1,
		day: at.getUTCDate(),
	};
}

export function namespacePeriod(
	startMs: number,
	endMs: number,
): NamespacePeriod {
	const periodStart = utcDay(startMs);
	const last = utcDay(Math.max(startMs, endMs - 1));
	const sameMonth =
		last.year === periodStart.year && last.month === periodStart.month;
	const periodEnd = sameMonth
		? last
		: utcDay(Date.UTC(periodStart.year, periodStart.month, 0));
	return { periodStart, periodEnd };
}

export type NamespaceUsageReaderDeps = UsageHttpDeps &
	Readonly<{
		originOf: (region: string) => string;
	}>;

export class NamespaceUsageReader implements ProviderUsageReader {
	readonly provider = "namespace";
	readonly source = NAMESPACE_USAGE_SOURCE;

	constructor(private readonly deps: NamespaceUsageReaderDeps) {}

	async spentUsd(request: UsageReadRequest): Promise<number | undefined> {
		const origin = this.deps.originOf(
			request.region ?? NAMESPACE_DEFAULT_REGION,
		);
		const reply = await readJson(
			this.deps,
			`${origin.replace(/\/+$/u, "")}${NAMESPACE_USAGE_PROCEDURE}`,
			{
				method: "POST",
				headers: new Map([
					["authorization", `Bearer ${request.token}`],
					["content-type", "application/json"],
				]),
				body: JSON.stringify(
					namespacePeriod(request.window.startMs, request.window.endMs),
				),
			},
			usageReply,
		);
		if (reply === undefined) return undefined;
		const units = reply.total?.instanceMinutes?.unit ?? 0;
		return usableUsd(units * NAMESPACE_USD_PER_UNIT_MINUTE);
	}
}
