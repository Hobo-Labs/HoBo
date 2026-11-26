/** Join a site-root-relative path onto the configured base path. */
export function href(path: string): string {
	const base = import.meta.env.BASE_URL.replace(/\/$/, "");
	return `${base}${path.startsWith("/") ? path : `/${path}`}`;
}
