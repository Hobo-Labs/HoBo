import type { HttpTransport } from "@hobo/core";

export function normalizeDeploymentUrl(
	raw: string | undefined,
	project: string,
): string | undefined {
	if (raw === undefined) return undefined;
	const trimmed = raw.trim();
	if (trimmed === "") return undefined;
	const absolute = /^[a-z][a-z0-9+.-]*:\/\//u.test(trimmed)
		? trimmed
		: `https://${trimmed}`;
	const authority = absolute
		.slice(absolute.indexOf("://") + 3)
		.split(/[/?#]/u)[0];
	if (authority === undefined || authority.includes(":")) return undefined;
	if (!URL.canParse(absolute)) return undefined;
	const url = new URL(absolute);
	if (
		url.protocol !== "https:" ||
		url.username !== "" ||
		url.password !== "" ||
		!url.hostname.endsWith(".vercel.app") ||
		(url.hostname !== `${project}.vercel.app` &&
			!url.hostname.startsWith(`${project}-`))
	)
		return undefined;
	return `${url.origin}/`;
}

export function protectedPreviewProbe(input: {
	readonly base: HttpTransport;
	readonly placeholderOrigin: string;
	readonly project: string;
	readonly deploymentUrl: () => string | undefined;
	readonly jwt: (audience: string) => Promise<string>;
	readonly paths?: readonly ("/healthz" | "/readyz")[];
}): HttpTransport {
	return async (request) => {
		const url = URL.canParse(request.url) ? new URL(request.url) : undefined;
		if (url?.origin !== input.placeholderOrigin) return input.base(request);
		const destination = normalizeDeploymentUrl(
			input.deploymentUrl(),
			input.project,
		);
		if (
			request.method !== "GET" ||
			!(input.paths ?? ["/healthz"]).some((path) => path === url.pathname) ||
			url.search ||
			!destination
		)
			return { status: 503, headers: {}, body: "" };
		try {
			const jwt = await input.jwt(new URL(destination).origin);
			return await input.base({
				...request,
				url: `${destination}${url.pathname.slice(1)}`,
				headers: { ...request.headers, "x-vercel-trusted-oidc-idp-token": jwt },
			});
		} catch {
			return { status: 503, headers: {}, body: "" };
		}
	};
}
