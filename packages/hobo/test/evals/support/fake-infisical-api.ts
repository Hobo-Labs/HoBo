import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import { createServer as createTlsServer } from "node:https";
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

export async function startFakeInfisical(
	organizationId = "org-1",
	/** Serve https with this key and certificate, as Infisical does. */
	tls?: { readonly key: string; readonly cert: string },
) {
	const sessions = new Set<string>();
	const identities = new Map<string, Identity>();
	const members = new Set<string>();
	/** Secrets by environment, folder and key, as Infisical keeps them. */
	const secrets = new Map<string, { value: string; version: number }>();
	/** Folders by environment and path; each environment starts with its root. */
	const folders = new Set(["dev:/", "staging:/", "prod:/"]);
	const calls: string[] = [];
	const tunnelled = new Set<number>();
	/** Per route, the statuses to answer next, in order; 0 drops the connection. */
	const faults = new Map<InfisicalRoute, number[]>();
	let direct = 0;
	const handle = async (
		incoming: IncomingMessage,
		outgoing: import("node:http").ServerResponse,
	) => {
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
		const projectOf = (id: string) => ({
			id,
			name: "secrets",
			slug: "secrets",
			type: "secret-manager",
			environments: ["dev", "staging", "prod"].map((slug) => ({
				name: slug,
				slug,
				id: `env-${slug}`,
			})),
		});
		const projectRead = /^\/api\/v1\/projects\/([^/]+)$/u.exec(url.pathname);
		if (method === "GET" && projectRead !== null)
			return send(200, { project: projectOf(projectRead[1] ?? "") });
		if (method === "GET" && url.pathname === "/api/v1/projects")
			return send(200, { projects: [projectOf("proj-1")] });
		if (url.pathname === "/api/v1/folders") {
			if (method === "GET") {
				const environment = url.searchParams.get("environment") ?? "";
				const parent = url.searchParams.get("path") ?? "/";
				if (!folders.has(`${environment}:${parent}`))
					return send(404, { message: "Folder not found" });
				const prefix = parent === "/" ? "/" : `${parent}/`;
				return send(200, {
					folders: [...folders]
						.filter((held) => held.startsWith(`${environment}:${prefix}`))
						.map((held) => held.slice(environment.length + 1 + prefix.length))
						.filter((name) => name !== "" && !name.includes("/"))
						.map((name) => ({ id: `folder-${name}`, name })),
				});
			}
			const wanted = JSON.parse(body);
			const parent = String(wanted.path ?? "/");
			const environment = String(wanted.environment);
			const path = `${parent === "/" ? "" : parent}/${String(wanted.name)}`;
			if (!folders.has(`${environment}:${parent}`))
				return send(404, { message: "Folder not found" });
			if (folders.has(`${environment}:${path}`))
				return send(400, { message: "Folder already exists" });
			folders.add(`${environment}:${path}`);
			return send(200, {
				folder: { id: `folder-${String(wanted.name)}`, name: wanted.name },
			});
		}
		const secretRoute = /^\/api\/v4\/secrets(?:\/([^/]+))?$/u.exec(
			url.pathname,
		);
		if (secretRoute !== null) {
			const key = decodeURIComponent(secretRoute[1] ?? "");
			// Where: the query on a read, the body on a write.
			const where =
				method === "GET"
					? {
							environment: url.searchParams.get("environment") ?? "",
							secretPath: url.searchParams.get("secretPath") ?? "/",
						}
					: JSON.parse(body);
			const folder = `${String(where.environment)}:${String(where.secretPath ?? "/")}`;
			// As Infisical: nothing is read from or written to a folder that
			// does not exist.
			if (!folders.has(folder))
				return send(404, {
					message: `Folder with path '${String(where.secretPath)}' in environment '${String(where.environment)}' was not found`,
				});
			const inFolder = [...secrets].filter(([held]) =>
				held.startsWith(`${folder}:`),
			);
			if (key === "" && method === "GET")
				return send(200, {
					secrets: inFolder.map(([held, kept]) => ({
						secretKey: held.slice(folder.length + 1),
						secretValue:
							url.searchParams.get("viewSecretValue") === "false"
								? ""
								: kept.value,
						version: kept.version,
						secretValueHidden:
							url.searchParams.get("viewSecretValue") === "false",
					})),
				});
			const at = `${folder}:${key}`;
			const held = secrets.get(at);
			if (method === "GET")
				return held === undefined
					? send(404, { message: `Secret with name '${key}' not found` })
					: send(200, {
							secret: {
								secretKey: key,
								secretValue: held.value,
								version: held.version,
							},
						});
			const value = String(where.secretValue);
			if (method === "PATCH") {
				if (held === undefined)
					return send(404, { message: `Secret with name '${key}' not found` });
				secrets.set(at, { value, version: held.version + 1 });
			} else {
				// As Infisical: a key that exists is refused, the original kept.
				if (held !== undefined)
					return send(400, { message: `Secret '${key}' already exists` });
				secrets.set(at, { value, version: 1 });
			}
			return send(200, {
				secret: { secretKey: key, version: secrets.get(at)?.version ?? 1 },
			});
		}
		if (
			method === "POST" &&
			/^\/api\/v1\/projects\/[^/]+\/identities$/u.test(url.pathname)
		)
			return send(200, {
				identity: { id: "00000000-0000-4000-8000-0000000000cd" },
			});
		const oidc = /^\/api\/v1\/auth\/oidc-auth\/identities\/([^/]+)$/u.exec(
			url.pathname,
		);
		if (oidc !== null)
			return send(200, { identityOidcAuth: { identityId: oidc[1] } });
		const project = /^\/api\/v1\/projects\/([^/]+)$/u.exec(url.pathname);
		if (project !== null && method === "GET")
			return send(200, { project: { id: project[1], orgId: organizationId } });
		if (/^\/api\/v1\/organizations\/[^/]+\/plan$/u.test(url.pathname))
			return send(200, {
				plan: {
					slug: null,
					rateLimits: { readLimit: 60, writeLimit: 200, secretsLimit: 40 },
				},
			});
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
			case "create-token": {
				// An identity token works like Infisical's: for the secrets API.
				const accessToken = `identity-token-${randomUUID()}`;
				sessions.add(accessToken);
				return send(200, { accessToken });
			}
		}
	};
	const server =
		tls === undefined
			? createServer((i, o) => void handle(i, o))
			: createTlsServer(tls, (i, o) => void handle(i, o));
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	// SAFETY: a server listening on a TCP port reports an AddressInfo.
	const { port } = server.address() as AddressInfo;
	return {
		/** The handler, for a TLS world that answers as app.infisical.com. */
		handle,
		origin: `${tls === undefined ? "http" : "https"}://127.0.0.1:${port}`,
		/** Requests that did not come through a proxy tunnel. */
		direct: () => direct,
		/** The proxy tells the fake which of its sockets are tunnels. */
		tunnelled,
		calls,
		identities,
		faults,
		/** The names held in the store (never the values). */
		secretNames: () =>
			[...secrets.keys()].map((at) => at.split(":").at(-1) ?? at),
		seedJournalFleet() {
			const folder = "prod:/hobo-cd";
			folders.add(folder);
			const values = new Map([
				[
					"HOBO_CD_SETTINGS",
					JSON.stringify({
						HOBO_CD_POSTGRES_FLEET:
							"journal-1:neon-claimable,journal-2:neon-claimable,journal-3:neon-claimable",
						HOBO_CD_POSTGRES_WITNESSES: "journal-witness:neon-claimable",
					}),
				],
			]);
			for (const member of ["1", "2", "3", "WITNESS"])
				values.set(
					`HOBO_CD_POSTGRES_URL_JOURNAL_${member}`,
					`postgresql://fixture:fixture@journal-${member.toLowerCase()}.example.test/db`,
				);
			for (const [name, value] of values)
				secrets.set(`${folder}:${name}`, { value, version: 1 });
		},
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
