/**
 * Declared usage adapter for providers without a public usage API
 * (Blacksmith, BuildJet, Cirrus, ...). Reads operator-declared usage from
 * env (`HOBO_RB_USAGE_<PROVIDER>_USD` / `_UNITS`) or a best-effort JSON
 * endpoint the operator points at. Anything unreadable degrades to an
 * unknown snapshot; declared numbers stay declared — the ledger never
 * treats them as platform-metered truth.
 */

import { create } from "@bufbuild/protobuf";

import {
	type UsageSnapshot,
	UsageSnapshotSchema,
} from "../_generated/runner_balancing_pb.js";
import {
	isJsonObject,
	type JsonObject,
	type JsonValue,
	unknownUsage,
} from "../parse.js";
import type { FetchLike, UsageReader } from "./github-billing.js";

export interface DeclaredUsageOptions {
	providerId: string;
	env?: Readonly<Record<string, string | undefined>>;
	usageUrl?: string | undefined;
	token?: string | undefined;
	fetchImpl?: FetchLike;
}

export function envKeyForProvider(providerId: string, suffix: string): string {
	return `HOBO_RB_USAGE_${providerId.toUpperCase().replaceAll(/[^A-Z0-9]/gu, "_")}_${suffix}`;
}

const AMOUNT_KEYS = [
	"usd",
	"costUsd",
	"cost_usd",
	"amountUsd",
	"amount_usd",
	"monthToDateUsd",
	"month_to_date_usd",
	"spend",
	"used",
	"usage",
] as const;

const UNIT_KEYS = ["minutes", "units", "unitsUsed", "units_used"] as const;

function pickNumber(
	record: JsonObject,
	keys: readonly string[],
): number | undefined {
	for (const key of keys) {
		const value = Number(record[key]);
		if (Number.isFinite(value) && value >= 0) return value;
	}
	return undefined;
}

export function declaredUsage(options: DeclaredUsageOptions): UsageReader {
	const env = options.env ?? process.env;
	const fetchImpl = options.fetchImpl ?? fetch;

	return {
		providerId: options.providerId,
		async read(): Promise<UsageSnapshot> {
			const spendRaw = env[envKeyForProvider(options.providerId, "USD")]?.trim();
			if (spendRaw !== undefined && spendRaw !== "") {
				const spendUsd = Number(spendRaw);
				const unitsUsed = Number(
					env[envKeyForProvider(options.providerId, "UNITS")]?.trim() ?? "0",
				);
				if (Number.isFinite(spendUsd) && spendUsd >= 0) {
					return create(UsageSnapshotSchema, {
						providerId: options.providerId,
						spendUsd,
						unitsUsed:
							Number.isFinite(unitsUsed) && unitsUsed >= 0 ? unitsUsed : 0,
						known: true,
						source: "operator-declared-env",
					});
				}
			}

			if (options.usageUrl === undefined || options.usageUrl === "") {
				return unknownUsage(options.providerId, "no-declared-source");
			}
			try {
				const headers =
					options.token !== undefined && options.token !== ""
						? {
								Accept: "application/json",
								"User-Agent": "hobo-example-ci-runner-balancing",
								Authorization: `Bearer ${options.token}`,
							}
						: {
								Accept: "application/json",
								"User-Agent": "hobo-example-ci-runner-balancing",
							};
				const response = await fetchImpl(options.usageUrl, { headers });
				if (!response.ok) {
					return unknownUsage(options.providerId, "declared-endpoint-error");
				}
				const parsed = await response.json();
				// SAFETY: fetch JSON is untyped; pickNumber reads known numeric keys.
				const body = parsed as JsonValue;
				if (!isJsonObject(body)) {
					return unknownUsage(options.providerId, "declared-endpoint-shape");
				}
				const record = body;
				const spendUsd = pickNumber(record, AMOUNT_KEYS);
				if (spendUsd === undefined) {
					return unknownUsage(options.providerId, "declared-endpoint-shape");
				}
				return create(UsageSnapshotSchema, {
					providerId: options.providerId,
					spendUsd,
					unitsUsed: pickNumber(record, UNIT_KEYS) ?? 0,
					known: true,
					source: "operator-declared-endpoint",
				});
			} catch {
				return unknownUsage(options.providerId, "declared-endpoint-error");
			}
		},
	};
}
