/**
 * What every provider usage reader answers, and the HTTP read they share.
 *
 * A reader turns one vendor's usage API into US dollars spent over a window.
 * It makes read calls only. A refusal, a reply in another shape, a currency
 * other than US dollars or a network failure all answer undefined
 * ("unmeasured"); a reader never throws to its caller.
 */
import type { z } from "zod";
import type { UsageSyncProvider } from "./subscription.js";

/** The span usage is read for: `startMs` inclusive, `endMs` exclusive. */
export type UsageWindow = Readonly<{ startMs: number; endMs: number }>;

export type UsageReadRequest = Readonly<{
	window: UsageWindow;
	/** The resolved token, used for this call only. */
	token: string;
	/** Namespace's compute region; undefined for the other providers. */
	region: string | undefined;
}>;

export interface ProviderUsageReader {
	readonly provider: UsageSyncProvider;
	/** The vendor page the API was read from. */
	readonly source: string;
	/** US dollars spent in the window, or undefined when it cannot be read. */
	spentUsd(request: UsageReadRequest): Promise<number | undefined>;
}

export type UsageHttpDeps = Readonly<{
	/** The vendor's API, or a pact fake. */
	fetch: typeof fetch;
	/** How long one call may take. */
	timeoutMs: number;
}>;

// public-contract: how long one vendor usage call may take.
export const PROVIDER_USAGE_TIMEOUT_MS = 10_000;

/** The body of a 2xx reply as `reply` parses it, or undefined for anything else. */
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

/** A dollar amount the routing step can use: finite and not negative. */
export function usableUsd(usd: number): number | undefined {
	return Number.isFinite(usd) && usd >= 0 ? usd : undefined;
}
