import type {
	DependencyObservationRequest,
	DependencyObservationStatus,
} from "./orchestrator.js";

export interface HttpDependencyObserverOptions {
	readonly resolveUrl: (
		request: DependencyObservationRequest,
	) => string | undefined;
	readonly timeoutMs?: number;
	readonly fetch?: typeof globalThis.fetch;
}

export function createHttpDependencyObserver(
	options: HttpDependencyObserverOptions,
): (
	request: DependencyObservationRequest,
) => Promise<DependencyObservationStatus> {
	const timeoutMs = options.timeoutMs ?? 5_000;
	if (
		!Number.isSafeInteger(timeoutMs) ||
		timeoutMs < 1 ||
		timeoutMs > 2_147_483_647
	)
		throw new RangeError("dependency probe timeout must be a positive integer");
	const fetch = options.fetch ?? globalThis.fetch;
	return async (request) => {
		const url = options.resolveUrl(request);
		if (url === undefined) return "pending";
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), timeoutMs);
		try {
			const response = await fetch(url, {
				method: "GET",
				redirect: "manual",
				signal: controller.signal,
			});
			await response.body?.cancel();
			return response.ok ? request.condition : "pending";
		} catch {
			return "pending";
		} finally {
			clearTimeout(timer);
		}
	};
}
