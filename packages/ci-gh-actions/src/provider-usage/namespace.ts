/**
 * Namespace's compute spend, from its usage service (ADR-0183).
 *
 * Namespace serves its API over Connect at `{region}.compute.namespaceapis.com`
 * with a Namespace token as a Bearer token, as its Public API page says: a
 * unary procedure is a POST of JSON to `/<proto package>.<Service>/<Method>`.
 * `namespace.cloud.compute.v1beta.UsageService/GetUsage` takes `periodStart`
 * and `periodEnd` as calendar dates (both inclusive, in one month) and answers
 * `total.instanceMinutes.unit`, the unit minutes the workspace used, as the
 * TypeScript SDK's usage page and its generated `usage_pb.ts` describe.
 *
 * Namespace answers usage, not money. Its billing page says "a unit minute
 * represents using 1 vCPU and 2GB of RAM for a minute times the platform
 * multiplier" and "additional unit minutes are charged at $0.0015 / unit
 * minute", so the reading is unit minutes at that rate. Minutes a prepaid plan
 * includes cost less than that, so this over-reads a workspace on a plan,
 * which only makes the spend limit pass over Namespace sooner. The total
 * counts every instance of the workspace, not only CI runners. The call reads;
 * it changes nothing at Namespace.
 */
import { z } from "zod";
import {
	type ProviderUsageReader,
	readJson,
	type UsageHttpDeps,
	type UsageReadRequest,
	usableUsd,
} from "./reader.js";
import { NAMESPACE_DEFAULT_REGION } from "./subscription.js";

// public-contract: the Namespace page the usage call was read from.
export const NAMESPACE_USAGE_SOURCE =
	"https://namespace.so/docs/reference/typescript-sdk/compute/usage";
// public-contract: the Namespace page the unit-minute rate was read from.
export const NAMESPACE_RATE_SOURCE =
	"https://namespace.so/docs/workspaces/billing-and-limits";
// public-contract: the day both pages were read.
export const NAMESPACE_USAGE_OBSERVED_AT = "2026-11-17";
// public-contract: US dollars per unit minute, Namespace's rate above a plan.
export const NAMESPACE_USD_PER_UNIT_MINUTE = 0.0015;
// public-contract: the read-only Connect procedure the Namespace reader calls.
export const NAMESPACE_USAGE_PROCEDURE =
	"/namespace.cloud.compute.v1beta.UsageService/GetUsage";

/** The compute endpoint of a Namespace region. */
export function namespaceComputeOrigin(region: string): string {
	return `https://${region}.compute.namespaceapis.com`;
}

/** A protobuf int64 in JSON: a number, or the decimal string Connect sends. */
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

/** The days of a `GetUsage` request, both inclusive. */
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

/**
 * The inclusive days of a window as Namespace takes them: from the start's
 * day to the day before the end, kept inside the start's month.
 */
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
		/** The compute origin of a region: `namespaceComputeOrigin` unless a fake stands in. */
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
		// proto3 JSON leaves a zero out, so a quiet month answers no total.
		const units = reply.total?.instanceMinutes?.unit ?? 0;
		return usableUsd(units * NAMESPACE_USD_PER_UNIT_MINUTE);
	}
}
