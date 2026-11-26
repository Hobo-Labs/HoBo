/**
 * A local stand-in for a fresh self-hosted Infisical: the admin bootstrap,
 * and the provisioning calls `@hobo/adapter-infisical`'s admin client makes,
 * with the shapes of `contracts/pacts/infisical-admin.pact.json` in that
 * package. It holds state so a test can see what was made, and refuses a
 * deleted identity's token with 401. No real Infisical is contacted.
 */

import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import type { JsonValue } from "@bufbuild/protobuf";

/** The request fields the stub reads; Infisical's JSON names. */
export type StubBody = {
	readonly email?: string;
	readonly organization?: string;
	readonly slug?: string;
	readonly workspaceId?: string;
	readonly environment?: string;
	readonly name?: string;
	readonly roles?: readonly { readonly role?: string }[];
	readonly boundIssuer?: string;
	readonly boundAudiences?: string;
	readonly boundSubject?: string;
	readonly boundClaims?: Readonly<Record<string, string>>;
};

export type StubInfisical = {
	readonly url: string;
	readonly bootstrapped: () => boolean;
	readonly projects: { id: string; slug: string }[];
	readonly folders: { projectId: string; environment: string; name: string }[];
	readonly identities: {
		id: string;
		name: string;
		projectId?: string;
		role?: string;
		oidc?: StubBody;
	}[];
	/** Every request body the stub received, for leak checks. */
	readonly bodies: string[];
	/** Identities whose OIDC trust was replaced in place (PATCH). */
	readonly patches: string[];
	/** The bootstrap admin token, for tests that act as the owner. */
	readonly adminToken: () => string;
	close(): Promise<void>;
};

async function bodyOf(request: IncomingMessage): Promise<string> {
	const chunks: Buffer[] = [];
	for await (const chunk of request) chunks.push(Buffer.from(chunk));
	return Buffer.concat(chunks).toString("utf8");
}

export async function startStubInfisical(): Promise<StubInfisical> {
	let bootstrapped = false;
	let adminToken: string | undefined;
	let adminIdentity: string | undefined;
	const projects: StubInfisical["projects"] = [];
	const folders: StubInfisical["folders"] = [];
	const identities: StubInfisical["identities"] = [];
	const bodies: string[] = [];
	const patches: string[] = [];
	let counter = 0;
	const next = (prefix: string) => `${prefix}-${++counter}`;

	const server = createServer(async (request, response) => {
		const raw = await bodyOf(request);
		bodies.push(raw);
		const body: StubBody = raw ? JSON.parse(raw) : {};
		const send = (status: number, payload: JsonValue) => {
			response.writeHead(status, { "content-type": "application/json" });
			response.end(JSON.stringify(payload));
		};
		const path = request.url ?? "/";
		if (request.method === "POST" && path === "/api/v1/admin/bootstrap") {
			if (bootstrapped)
				return send(400, {
					reqId: "req-1",
					statusCode: 400,
					error: "BadRequest",
				});
			bootstrapped = true;
			adminToken = `stub-admin-token-${next("t")}`;
			adminIdentity = next("bootstrap-identity");
			identities.push({ id: adminIdentity, name: "Instance Admin Identity" });
			return send(200, {
				message: "Successfully bootstrapped instance",
				user: { id: "user-1", email: body.email, superAdmin: true },
				organization: { id: "org-1", name: body.organization, slug: "hobo" },
				identity: {
					id: adminIdentity,
					name: "Instance Admin Identity",
					credentials: { token: adminToken },
				},
			});
		}
		const live = identities.some((identity) => identity.id === adminIdentity);
		if (
			adminToken === undefined ||
			request.headers.authorization !== `Bearer ${adminToken}` ||
			!live
		)
			return send(401, {
				reqId: "req-401",
				statusCode: 401,
				error: "Unauthorized",
			});

		if (request.method === "POST" && path === "/api/v1/projects") {
			const id = next("proj");
			projects.push({ id, slug: String(body.slug) });
			return send(200, { project: { id, slug: body.slug, orgId: "org-1" } });
		}
		if (request.method === "POST" && path === "/api/v1/folders") {
			folders.push({
				projectId: String(body.workspaceId),
				environment: String(body.environment),
				name: String(body.name),
			});
			return send(200, { folder: { id: next("folder"), name: body.name } });
		}
		const projectIdentity = /^\/api\/v1\/projects\/([^/]+)\/identities$/u.exec(
			path,
		);
		if (request.method === "POST" && projectIdentity) {
			const id = next("identity");
			const first = body.roles?.[0] ?? {};
			identities.push({
				id,
				name: String(body.name),
				projectId: projectIdentity[1] ?? "",
				role: String(first.role),
			});
			return send(200, { identity: { id, name: body.name } });
		}
		const oidc = /^\/api\/v1\/auth\/oidc-auth\/identities\/([^/]+)$/u.exec(
			path,
		);
		if (request.method === "POST" && oidc) {
			const identity = identities.find((entry) => entry.id === oidc[1]);
			if (!identity) return send(404, { reqId: "req-404", statusCode: 404 });
			identity.oidc = body;
			return send(200, {
				identityOidcAuth: { id: next("oidc"), identityId: identity.id },
			});
		}
		if (request.method === "PATCH" && oidc) {
			// An update replaces an existing trust; it never creates one.
			const identity = identities.find((entry) => entry.id === oidc[1]);
			if (!identity?.oidc)
				return send(404, { reqId: "req-404", statusCode: 404 });
			identity.oidc = body;
			patches.push(identity.id);
			return send(200, {
				identityOidcAuth: { id: next("oidc"), identityId: identity.id },
			});
		}
		const one = /^\/api\/v1\/identities\/([^/]+)$/u.exec(path);
		if (one) {
			const index = identities.findIndex((entry) => entry.id === one[1]);
			if (index < 0) return send(404, { reqId: "req-404", statusCode: 404 });
			const identity = identities[index];
			if (request.method === "DELETE") identities.splice(index, 1);
			return send(200, {
				identity: { id: identity?.id, name: identity?.name },
			});
		}
		return send(404, { reqId: "req-404", statusCode: 404 });
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	// SAFETY: a server listening on a TCP port reports an AddressInfo.
	const address = server.address() as AddressInfo;
	return {
		url: `http://127.0.0.1:${address.port}`,
		bootstrapped: () => bootstrapped,
		projects,
		folders,
		identities,
		bodies,
		patches,
		adminToken: () => adminToken ?? "",
		close: () =>
			new Promise<void>((resolve) => {
				server.closeAllConnections();
				server.close(() => resolve());
			}),
	};
}
