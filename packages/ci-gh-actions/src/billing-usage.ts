import type { JobFact, MinutesReader, MinutesUsage } from "@hobo/ci";
import { isGithubHostedLabel } from "@hobo/ci";
import { z } from "zod";

export const GITHUB_INCLUDED_COMPUTE_SOURCE =
	"https://docs.github.com/en/billing/concepts/product-billing/github-actions";
export const GITHUB_INCLUDED_COMPUTE_OBSERVED_AT = "2026-11-17";

export const GITHUB_LINUX_USD_PER_MINUTE = 0.006;

export const GITHUB_INCLUDED_COMPUTE_USD: ReadonlyMap<string, number> = new Map(
	[
		["free", 12],
		["pro", 18],
		["team", 18],
		["enterprise", 300],
	],
);

export function includedMinutesOfPlan(plan: string): number | undefined {
	const usd = GITHUB_INCLUDED_COMPUTE_USD.get(plan.trim().toLowerCase());
	return usd === undefined
		? undefined
		: Math.round(usd / GITHUB_LINUX_USD_PER_MINUTE);
}

const usageItem = z.object({
	product: z.string(),
	unitType: z.string(),
	quantity: z.number(),
	grossAmount: z.number().optional(),
});
const usageReport = z.object({ usageItems: z.array(usageItem) });
const accountPlan = z.object({ plan: z.object({ name: z.string() }) });

export function actionsMinutesUsed(
	items: readonly z.infer<typeof usageItem>[],
): number {
	let minutes = 0;
	for (const item of items) {
		if (item.product.toLowerCase() !== "actions") continue;
		if (item.unitType.toLowerCase() !== "minutes") continue;
		minutes +=
			item.grossAmount === undefined
				? item.quantity
				: item.grossAmount / GITHUB_LINUX_USD_PER_MINUTE;
	}
	return minutes;
}

export function githubBilledMinutes(
	jobs: readonly JobFact[],
	sinceMs: number,
	nowMs: number,
): number {
	let ms = 0;
	for (const job of jobs) {
		if (!job.billed || job.startedAtMs === undefined) continue;
		if (!job.labels.some((label) => isGithubHostedLabel(label))) continue;
		const start = Math.max(job.startedAtMs, sinceMs);
		const end = Math.min(job.completedAtMs ?? nowMs, nowMs);
		if (end > start) ms += end - start;
	}
	return ms / 60_000;
}

export type GithubMinutesReaderDeps = Readonly<{
	fetch: typeof fetch;
	baseUrl: string;
	token: (owner: string) => Promise<string | undefined>;
	plan: ((owner: string) => Promise<string | undefined>) | undefined;
	recentMinutes:
		| ((owner: string, sinceMs: number) => Promise<number | undefined>)
		| undefined;
	now: () => number;
	cacheMs: number;
}>;

export const GITHUB_BURN_WINDOW_HOURS = 2;

export const GITHUB_MINUTES_CACHE_MS = 5 * 60_000;

type Reading = Readonly<{ atMs: number; usage: MinutesUsage | undefined }>;

export class GithubMinutesReader implements MinutesReader {
	private readonly readings = new Map<string, Reading>();

	constructor(private readonly deps: GithubMinutesReaderDeps) {}

	async usage(owner: string): Promise<MinutesUsage | undefined> {
		const key = owner.toLowerCase();
		const nowMs = this.deps.now();
		const kept = this.readings.get(key);
		if (kept && nowMs - kept.atMs < this.deps.cacheMs) return kept.usage;
		const usage = await this.read(owner, nowMs).catch(() => undefined);
		this.readings.set(key, { atMs: nowMs, usage });
		return usage;
	}

	private async getJson(
		path: string,
		token: string,
	): Promise<string | null | undefined> {
		const response = await this.deps.fetch(
			`${this.deps.baseUrl.replace(/\/+$/u, "")}${path}`,
			{
				headers: {
					accept: "application/vnd.github+json",
					authorization: `Bearer ${token}`,
					"x-github-api-version": "2022-11-28",
				},
			},
		);
		if (response.status === 404) return null;
		return response.ok ? await response.text() : undefined;
	}

	private async firstJson(
		paths: readonly string[],
		token: string,
	): Promise<string | undefined> {
		for (const path of paths) {
			const body = await this.getJson(path, token);
			if (body !== null) return body;
		}
		return undefined;
	}

	private async planOf(
		owner: string,
		token: string,
	): Promise<string | undefined> {
		const given = this.deps.plan ? await this.deps.plan(owner) : undefined;
		if (given !== undefined) return given;
		const name = encodeURIComponent(owner);
		const body = await this.firstJson(
			[`/orgs/${name}`, `/users/${name}`],
			token,
		);
		if (body === undefined) return undefined;
		const parsed = accountPlan.safeParse(JSON.parse(body));
		return parsed.success ? parsed.data.plan.name : undefined;
	}

	private async read(
		owner: string,
		nowMs: number,
	): Promise<MinutesUsage | undefined> {
		const token = await this.deps.token(owner);
		if (token === undefined) return undefined;
		const plan = await this.planOf(owner, token);
		const includedMinutes =
			plan === undefined ? undefined : includedMinutesOfPlan(plan);
		if (includedMinutes === undefined) return undefined;
		const now = new Date(nowMs);
		const name = encodeURIComponent(owner);
		const query = `year=${now.getUTCFullYear()}&month=${now.getUTCMonth() + 1}`;
		const body = await this.firstJson(
			[
				`/organizations/${name}/settings/billing/usage?${query}`,
				`/users/${name}/settings/billing/usage?${query}`,
			],
			token,
		);
		if (body === undefined) return undefined;
		const report = usageReport.safeParse(JSON.parse(body));
		if (!report.success) return undefined;
		const usedMinutes = actionsMinutesUsed(report.data.usageItems);
		const windowMs = GITHUB_BURN_WINDOW_HOURS * 60 * 60_000;
		const recent = this.deps.recentMinutes
			? await this.deps.recentMinutes(owner, nowMs - windowMs)
			: undefined;
		return recent === undefined
			? { usedMinutes, includedMinutes }
			: {
					usedMinutes,
					includedMinutes,
					burnPerHour: recent / GITHUB_BURN_WINDOW_HOURS,
				};
	}
}
