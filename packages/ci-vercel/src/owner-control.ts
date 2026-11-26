/** Delegate only explicit same-origin owner operations. The control credential
 * stays in the server process and retains its normal scopes and account binding. */
export function createOwnerControlDelegation(options: {
	publicOrigin: string;
	resolve: (request: Request) => Promise<string | undefined>;
}) {
	const origin = new URL(options.publicOrigin);
	if (origin.protocol !== "https:" || origin.origin !== options.publicOrigin)
		throw new Error("invalid owner control origin");
	return async (request: Request): Promise<Request> => {
		const path = new URL(request.url).pathname;
		const requestOrigin = request.headers.get("origin");
		const sameOrigin =
			requestOrigin === origin.origin ||
			(request.method === "GET" &&
				requestOrigin === null &&
				request.headers.get("sec-fetch-site") === "same-origin");
		const eligible =
			(request.method === "GET" &&
				(path === "/v1/accounts/self/policy" ||
					path === "/v1/accounts/self/installations")) ||
			(request.method === "PUT" &&
				(path === "/v2/accounts/self/policy" ||
					path === "/v2/accounts/self/providers")) ||
			(request.method === "POST" &&
				path === "/v1/accounts/self/repositories/isolated-connect");
		if (
			!eligible ||
			request.headers.has("authorization") ||
			!sameOrigin ||
			request.headers.get("x-hobo-owner-control") !== "1" ||
			(request.method !== "GET" &&
				request.headers
					.get("content-type")
					?.split(";", 1)[0]
					?.trim()
					.toLowerCase() !== "application/json")
		)
			return request;
		const token = await options.resolve(request);
		if (!token) return request;
		const headers = new Headers(request.headers);
		headers.set("authorization", `Bearer ${token}`);
		return new Request(request, { headers });
	};
}
