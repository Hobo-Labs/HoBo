import type { GithubTransport } from "./github.js";

const DEFAULT_TTL_MS = 20_000;

const CACHEABLE = [
	/^\/repos\/[^/]+\/[^/]+\/actions\/runs\/\d+\/jobs\b/u,
	/^\/repos\/[^/]+\/[^/]+\/actions\/runs\?status=in_progress\b/u,
	/^\/repos\/[^/]+\/[^/]+\/actions\/jobs\/\d+$/u,
] as const;

function cacheableGet(path: string): boolean {
	return CACHEABLE.some((pattern) => pattern.test(path));
}

type CacheEntry = Readonly<{
	body: string;
	etag: string | undefined;
	expiresAt: number;
}>;

/** Short TTL + conditional GET cache for hot reconcile/poll paths (saves installation rate limit). */
export function withGithubReadCache(
	api: GithubTransport,
	ttlMs = DEFAULT_TTL_MS,
): GithubTransport {
	if (!Number.isInteger(ttlMs) || ttlMs < 1_000 || ttlMs > 120_000)
		throw new Error("invalid GitHub read cache ttl");
	const cache = new Map<string, CacheEntry>();

	return {
		async request(installationId, path, method = "GET", body, ifNoneMatch) {
			if (method !== "GET" || !cacheableGet(path))
				return api.request(installationId, path, method, body, ifNoneMatch);
			const key = `${installationId}:${path}`;
			const now = Date.now();
			const hit = cache.get(key);
			if (hit && now < hit.expiresAt)
				return new Response(hit.body, {
					status: 200,
					headers: hit.etag ? { etag: hit.etag } : {},
				});
			const conditional = ifNoneMatch ?? hit?.etag;
			const response = await api.request(
				installationId,
				path,
				method,
				body,
				conditional,
			);
			if (response.status === 304 && hit) {
				cache.set(key, { ...hit, expiresAt: now + ttlMs });
				return new Response(hit.body, {
					status: 200,
					headers: hit.etag ? { etag: hit.etag } : {},
				});
			}
			if (!response.ok) return response;
			const bodyText = await response.text();
			const etag = response.headers.get("etag") ?? undefined;
			cache.set(key, { body: bodyText, etag, expiresAt: now + ttlMs });
			return new Response(bodyText, {
				status: response.status,
				headers: etag ? { etag } : {},
			});
		},
	};
}
