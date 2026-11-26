/**
 * GitHub Actions usage adapter (PLATFORM side of the ledger). Reads
 * month-to-date Actions minutes/spend for the GitHub-hosted provider from,
 * in order: an operator env override, the enhanced billing platform usage
 * API, then the legacy per-account billing endpoint. Every failure mode
 * degrades to an unknown-usage snapshot (known=false) instead of throwing —
 * routing stays available and stays honest about unverified reads.
 */

import { create } from "@bufbuild/protobuf";

import {
	type UsageSnapshot,
	UsageSnapshotSchema,
} from "../_generated/runner_balancing_pb.js";
import { isJsonObject, type JsonValue, unknownUsage } from "../parse.js";

export type FetchLike = typeof fetch;

export interface GithubBillingOptions {
	/** Account that owns the Actions spend (org login or username). */
	owner: string;
	ownerKind: "org" | "user";
	token?: string | undefined;
	providerId?: string;
	/** Used only to estimate USD from the legacy minutes-based endpoint. */
	estimatedPricePerUnitUsd?: number;
	apiBase?: string;
	env?: Readonly<Record<string, string | undefined>>;
	fetchImpl?: FetchLike;
}

interface UsageItem {
	product?: JsonValue;
	unitType?: JsonValue;
	quantity?: JsonValue;
	netAmount?: JsonValue;
	discountAmount?: JsonValue;
}

export interface FoldedUsage {
	spendUsd: number;
	unitsUsed: number;
}

export interface UsageReader {
	providerId: string;
	read(): Promise<UsageSnapshot>;
}

interface LegacyActionsBilling {
	total_minutes_used?: JsonValue;
	total_paid_minutes_used?: JsonValue;
}

function envNumber(
	env: Readonly<Record<string, string | undefined>>,
	name: string,
): number | undefined {
	const raw = env[name]?.trim();
	if (raw === undefined || raw === "") return undefined;
	const value = Number(raw);
	return Number.isFinite(value) && value >= 0 ? value : undefined;
}

/** Sum actions/minutes usage items from the enhanced billing platform. */
export function foldUsageItems(
	items: readonly UsageItem[],
): FoldedUsage {
	let spendUsd = 0;
	let unitsUsed = 0;
	for (const item of items) {
		if (item.product !== "actions" || item.unitType !== "minutes") continue;
		const quantity = Number(item.quantity ?? 0);
		const net = Number(item.netAmount ?? 0);
		if (Number.isFinite(quantity) && quantity > 0) unitsUsed += quantity;
		if (Number.isFinite(net) && net > 0) spendUsd += net;
	}
	return { spendUsd, unitsUsed };
}

/** Fold the legacy billing/actions response into snapshot numbers. */
export function foldLegacyActionsBilling(
	body: LegacyActionsBilling,
	estimatedPricePerUnitUsd: number,
): FoldedUsage {
	const unitsUsed = Number(body.total_minutes_used ?? 0);
	const paidMinutes = Number(body.total_paid_minutes_used ?? 0);
	return {
		unitsUsed: Number.isFinite(unitsUsed) && unitsUsed > 0 ? unitsUsed : 0,
		spendUsd:
			Number.isFinite(paidMinutes) && paidMinutes > 0
				? paidMinutes * estimatedPricePerUnitUsd
				: 0,
	};
}

export function githubActionsUsage(options: GithubBillingOptions): UsageReader {
	const providerId = options.providerId ?? "github_hosted";
	const apiBase = options.apiBase ?? "https://api.github.com";
	const env = options.env ?? process.env;
	const fetchImpl = options.fetchImpl ?? fetch;
	const price = options.estimatedPricePerUnitUsd ?? 0.006;
	const accountPath =
		options.ownerKind === "org"
			? `orgs/${options.owner}`
			: `users/${options.owner}`;
	const usagePath =
		options.ownerKind === "org"
			? `organizations/${options.owner}`
			: `users/${options.owner}`;

	async function readJson(url: string): Promise<JsonValue | undefined> {
		if (options.token === undefined || options.token === "") return undefined;
		try {
			const response = await fetchImpl(url, {
				headers: {
					Authorization: `Bearer ${options.token}`,
					Accept: "application/vnd.github+json",
					"X-GitHub-Api-Version": "2022-11-28",
					"User-Agent": "hobo-example-ci-runner-balancing",
				},
			});
			if (!response.ok) return undefined;
			const body = await response.json();
			// SAFETY: fetch JSON is untyped; the caller parses fields it needs.
			return body as JsonValue;
		} catch {
			return undefined;
		}
	}

	return {
		providerId,
		async read(): Promise<UsageSnapshot> {
			const overrideSpend = envNumber(env, "HOBO_RB_GH_SPEND_USD");
			if (overrideSpend !== undefined) {
				return create(UsageSnapshotSchema, {
					providerId,
					spendUsd: overrideSpend,
					unitsUsed: envNumber(env, "HOBO_RB_GH_MINUTES") ?? 0,
					known: true,
					source: "env-override",
				});
			}

			const now = new Date();
			const enhanced = await readJson(
				`${apiBase}/${usagePath}/settings/billing/usage?year=${now.getUTCFullYear()}&month=${now.getUTCMonth() + 1}`,
			);
			// SAFETY: assertion to `hanced as { usageItems?: UsageItem[] } | undefined) ` is required at this boundary.
			const items = (enhanced as { usageItems?: UsageItem[] } | undefined)
				?.usageItems;
			if (Array.isArray(items)) {
				const folded = foldUsageItems(items);
				return create(UsageSnapshotSchema, {
					providerId,
					...folded,
					known: true,
					source: "github-billing-usage",
				});
			}

			const legacy = await readJson(
				`${apiBase}/${accountPath}/settings/billing/actions`,
			);
			if (legacy !== undefined && isJsonObject(legacy) && "total_minutes_used" in legacy) {
				const folded = foldLegacyActionsBilling(legacy, price);
				return create(UsageSnapshotSchema, {
					providerId,
					...folded,
					known: true,
					source: "github-billing-legacy+rate-estimate",
				});
			}

			return unknownUsage(providerId, "github-billing-unreachable");
		},
	};
}
