import type { z } from "zod";
import type { UsageSyncProvider } from "./subscription.js";

export type UsageWindow = Readonly<{ startMs: number; endMs: number }>;

export type UsageReadRequest = Readonly<{
	window: UsageWindow;
	token: string;
	region: string | undefined;
}>;

export interface ProviderUsageReader {
	readonly provider: UsageSyncProvider;
	readonly source: string;
	spentUsd(request: UsageReadRequest): Promise<number | undefined>;
}

export type UsageHttpDeps = Readonly<{
	fetch: typeof fetch;
	timeoutMs: number;
}>;

// public-contract: how long one vendor usage call may take.
export const PROVIDER_USAGE_TIMEOUT_MS = 10_000;

export async function readJson<T>(
	deps: UsageHttpDeps,
	url: string,
	init: Readonly<{
		method: "GET" | "POST";
		headers: ReadonlyMap<string, string>;
		body: string | undefined;
	}>,
	reply: z.ZodType<T>,
): Promise<T | undefined> {
	const request: RequestInit = {
		method: init.method,
		headers: Object.fromEntries(init.headers),
		redirect: "error",
		signal: AbortSignal.timeout(deps.timeoutMs),
	};
	if (init.body !== undefined) request.body = init.body;
	try {
		const response = await deps.fetch(url, request);
		if (!response.ok) return undefined;
		const parsed = reply.safeParse(JSON.parse(await response.text()));
		return parsed.success ? parsed.data : undefined;
	} catch {
		return undefined;
	}
}

export function usableUsd(usd: number): number | undefined {
	return Number.isFinite(usd) && usd >= 0 ? usd : undefined;
}
