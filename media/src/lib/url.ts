const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

/** Prefix a public-asset path with the deploy base, exactly once. */
export function href(path: string): string {
	const p = path.startsWith("/") ? path : `/${path}`;
	return `${BASE}${p}`;
}
