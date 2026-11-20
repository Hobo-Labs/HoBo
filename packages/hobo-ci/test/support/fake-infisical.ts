import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * Infisical, as a real HTTP server on 127.0.0.1, with the API routes HoBo
 * uses and failure injection per route. It answers only sessions it issued
 * (`signIn`), and only while they are not expired. State persists across
 * runs the way Infisical's does: an identity created on a run that later
 * failed is still there on the next one.
 */

/** What the fake answers: Infisical's JSON shapes, as test data. */
type Answer = Parameters<typeof JSON.stringify>[0];

export type InfisicalRoute =
	| "list-identities"
	| "create-identity"
	| "token-auth"
	| "oidc-auth"
	| "list-memberships"
	| "add-membership"
	| "create-token";

interface Identity {
	readonly id: string;
	readonly name: string;
	readonly authMethods: string[];
}

const jwtFor = (organizationId: string, nonce: string) =>
	`h.${Buffer.from(JSON.stringify({ organizationId, nonce })).toString("base64url")}.s`;

/** What Infisical's "Copy to clipboard" copies after a sign-in. */
export const copiedSession = (jwt: string) =>
	Buffer.from(
		JSON.stringify({
			JTWToken: jwt,
			email: "owner@example.com",
			privateKey: "",
		}),
	).toString("base64");

function routeOf(method: string, path: string): InfisicalRoute | undefined {
	if (
		method === "GET" &&
		/^\/api\/v2\/organizations\/[^/]+\/identity-memberships$/u.test(path)
	)
		return "list-identities";
	if (method === "POST" && path === "/api/v1/identities")
		return "create-identity";
	if (
		method === "POST" &&
		/^\/api\/v1\/auth\/token-auth\/identities\/[^/]+\/tokens$/u.test(path)
	)
		return "create-token";
	if (
		method === "POST" &&
		/^\/api\/v1\/auth\/token-auth\/identities\/[^/]+$/u.test(path)
	)
		return "token-auth";
	if (
		method === "POST" &&
		/^\/api\/v1\/auth\/oidc-auth\/identities\/[^/]+$/u.test(path)
	)
		return "oidc-auth";
	if (
		method === "GET" &&
		/^\/api\/v1\/projects\/[^/]+\/memberships\/identities$/u.test(path)
	)
		return "list-memberships";
	if (
		method === "POST" &&
		/^\/api\/v1\/projects\/[^/]+\/memberships\/identities\/[^/]+$/u.test(path)
	)
		return "add-membership";
	return undefined;
}

async function bodyOf(incoming: IncomingMessage): Promise<string> {
	const parts: Buffer[] = [];
	for await (const part of incoming) parts.push(Buffer.from(part));
	return Buffer.concat(parts).toString("utf8");
}

export async function startFakeInfisical(organizationId = "org-1") {
	const sessions = new Set<string>();
	const identities = new Map<string, Identity>();
	const members = new Set<string>();
	const calls: string[] = [];
	const tunnelled = new Set<number>();
	/** Per route, the statuses to answer next, in order; 0 drops the connection. */
	const faults = new Map<InfisicalRoute, number[]>();
	let direct = 0;
	const server = createServer(async (incoming, outgoing) => {
		// Through the tunnel, the connection comes from the proxy, not the run.
		if (!tunnelled.has(incoming.socket.remotePort ?? -1)) direct += 1;
		const method = incoming.method ?? "GET";
		const url = new URL(incoming.url ?? "/", "http://infisical.test");
		const route = routeOf(method, url.pathname);
		calls.push(`${method} ${url.pathname}`);
		const body = await bodyOf(incoming);
		const send = (status: number, json: Answer) => {
			outgoing.writeHead(status, { "content-type": "application/json" });
			outgoing.end(JSON.stringify(json));
		};
		const bearer = (incoming.headers.authorization ?? "").replace(
			/^Bearer /u,
			"",
		);
		if (!sessions.has(bearer)) return send(401, { message: "Token expired" });
		if (route === undefined) return send(404, { message: "no route" });
		const fault = faults.get(route)?.shift();
		if (fault === 0) {
			incoming.socket.destroy();
			return;
		}
		if (fault !== undefined)
			return send(fault, { message: `injected ${fault}` });
		const segments = url.pathname.split("/");
		switch (route) {
			case "list-identities": {
				const search = url.searchParams.get("search") ?? "";
				return send(200, {
					identityMemberships: [...identities.values()]
						.filter((identity) => identity.name.includes(search))
						.map((identity) => ({ identity })),
					totalCount: identities.size,
				});
			}
			case "create-identity": {
				const name = String(JSON.parse(body).name);
				if ([...identities.values()].some((i) => i.name === name))
					return send(400, { message: `Identity ${name} already exists` });
				const identity = { id: `ident-${randomUUID()}`, name, authMethods: [] };
				identities.set(identity.id, identity);
				return send(200, { identity });
			}
			case "token-auth":
			case "oidc-auth": {
				const identity = identities.get(segments.at(-1) ?? "");
				if (identity === undefined)
					return send(404, { message: "no identity" });
				if (identity.authMethods.includes(route))
					return send(400, {
						message: "Failed to add auth to already configured identity",
					});
				identity.authMethods.push(route);
				return send(200, {});
			}
			case "list-memberships":
				return send(200, {
					identityMemberships: [...members].map((identityId) => ({
						identityId,
					})),
				});
			case "add-membership": {
				const id = segments.at(-1) ?? "";
				if (members.has(id))
					return send(400, { message: "Identity is already a member" });
				members.add(id);
				return send(200, {});
			}
			case "create-token":
				return send(200, { accessToken: `identity-token-${randomUUID()}` });
		}
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	// SAFETY: a server listening on a TCP port reports an AddressInfo.
	const { port } = server.address() as AddressInfo;
	return {
		origin: `http://127.0.0.1:${port}`,
		/** Requests that did not come through a proxy tunnel. */
		direct: () => direct,
		/** The proxy tells the fake which of its sockets are tunnels. */
		tunnelled,
		calls,
		identities,
		faults,
		/** The owner signs in: a fresh session, as Infisical's web app issues. */
		signIn() {
			const jwt = jwtFor(organizationId, randomUUID());
			sessions.add(jwt);
			return jwt;
		},
		expireAll() {
			sessions.clear();
		},
		fail(route: InfisicalRoute, ...statuses: number[]) {
			faults.set(route, [...(faults.get(route) ?? []), ...statuses]);
		},
		close: () =>
			new Promise<void>((resolve) => {
				server.closeAllConnections();
				server.close(() => resolve());
			}),
	};
}
