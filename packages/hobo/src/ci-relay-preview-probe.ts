import type { HttpTransport } from "@hobo/core";

/** Route the preview health check to the deployment just created by CD. */
export function protectedPreviewProbe(input: {
	readonly base: HttpTransport;
	readonly placeholderOrigin: string;
	readonly deploymentUrl: () => string | undefined;
	readonly jwt: () => Promise<string>;
}): HttpTransport {
	return async (request) => {
		const url = URL.canParse(request.url) ? new URL(request.url) : undefined;
		if (url?.origin !== input.placeholderOrigin) return input.base(request);
		const deployment = input.deploymentUrl();
		const destination =
			deployment && URL.canParse(deployment) ? new URL(deployment) : undefined;
		if (
			request.method !== "GET" ||
			url.pathname !== "/healthz" ||
			url.search ||
			!destination ||
			destination.protocol !== "https:" ||
			destination.username ||
			destination.password ||
			destination.port ||
			destination.pathname !== "/" ||
			destination.search ||
			destination.hash ||
			!destination.hostname.endsWith(".vercel.app")
		)
			return { status: 503, headers: {}, body: "" };
		try {
			const jwt = await input.jwt();
			return await input.base({
				...request,
				url: `${destination.origin}/healthz`,
				headers: { ...request.headers, "x-vercel-trusted-oidc-idp-token": jwt },
			});
		} catch {
			// Do not surface transport errors that could contain the OIDC token.
			return { status: 503, headers: {}, body: "" };
		}
	};
}
