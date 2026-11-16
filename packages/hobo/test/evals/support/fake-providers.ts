import { randomUUID } from "node:crypto";

import { bodyOf, json, type ProviderHandler } from "./tls-world.js";

/**
 * Vercel and Neon as their APIs answer, for the TLS world. Each records what
 * it was asked, and changes state only the way the real provider would: a
 * device grant is approved only when the owner approves it.
 */

/** api.vercel.com: the device grant (RFC 8628), teams, and deployments. */
export function fakeVercel() {
	const calls: string[] = [];
	const grants = new Map<
		string,
		{ code: string; approved: boolean; denied: boolean }
	>();
	const tokens = new Set<string>();
	const deployments: string[] = [];
	const handle: ProviderHandler = async (request, response) => {
		const url = new URL(request.url ?? "/", "https://api.vercel.com");
		const method = request.method ?? "GET";
		calls.push(`${method} ${url.pathname}`);
		const body = await bodyOf(request);
		if (
			method === "POST" &&
			url.pathname === "/login/oauth/device-authorization"
		) {
			const deviceCode = randomUUID();
			const code =
				`${randomUUID().slice(0, 4)}-${randomUUID().slice(0, 4)}`.toUpperCase();
			grants.set(deviceCode, { code, approved: false, denied: false });
			return json(response, 200, {
				device_code: deviceCode,
				user_code: code,
				verification_uri: "https://vercel.com/oauth/device",
				verification_uri_complete: `https://vercel.com/oauth/device?user_code=${code}`,
				expires_in: 60,
				interval: 5,
			});
		}
		if (method === "POST" && url.pathname === "/login/oauth/token") {
			const grant = grants.get(
				new URLSearchParams(body).get("device_code") ?? "",
			);
			if (grant === undefined)
				return json(response, 400, { error: "invalid_grant" });
			if (!grant.approved)
				return json(response, 400, { error: "authorization_pending" });
			const token = `vercel-${randomUUID()}`;
			tokens.add(token);
			return json(response, 200, { access_token: token, token_type: "Bearer" });
		}
		const bearer = (request.headers.authorization ?? "").replace(
			/^Bearer /u,
			"",
		);
		if (!tokens.has(bearer))
			return json(response, 403, { error: { code: "forbidden" } });
		if (method === "GET" && url.pathname === "/v2/teams")
			return json(response, 200, {
				teams: [{ id: "team_owner", slug: "owner" }],
				pagination: { next: null },
			});
		if (method === "POST" && /^\/v1[03]\/deployments$/u.test(url.pathname)) {
			const id = `dpl_${randomUUID().replace(/-/gu, "")}`;
			deployments.push(id);
			return json(response, 200, {
				id,
				url: `hobo-cd-${id.slice(4, 12)}.vercel.app`,
				readyState: "READY",
				status: "READY",
			});
		}
		return json(response, 404, {
			error: { code: "not_found", message: url.pathname },
		});
	};
	return {
		handle,
		calls,
		deployments,
		/** The owner declines on Vercel the grant whose link they were shown. */
		deny(link: string) {
			const code = new URL(link).searchParams.get("user_code");
			for (const grant of grants.values())
				if (grant.code === code) grant.denied = true;
		},
		/** The owner approves the grant whose link they were shown. */
		approve(link: string) {
			const code = new URL(link).searchParams.get("user_code");
			for (const grant of grants.values())
				if (grant.code === code) grant.approved = true;
		},
	};
}

/** neon.new: Claimable Postgres. */
export function fakeNeon() {
	const calls: string[] = [];
	const databases = new Map<string, Readonly<Record<string, string | null>>>();
	const handle: ProviderHandler = async (request, response) => {
		const url = new URL(request.url ?? "/", "https://neon.new");
		const method = request.method ?? "GET";
		calls.push(`${method} ${url.pathname}`);
		await bodyOf(request);
		if (method === "POST" && url.pathname === "/api/v1/database") {
			const id = randomUUID();
			const now = Date.now();
			const record = {
				id,
				status: "UNCLAIMED",
				neon_project_id: `proj-${id.slice(0, 8)}`,
				connection_string: `postgresql://owner:secret@ep-${id.slice(0, 8)}.neon.tech/neondb`,
				claim_url: `https://neon.new/database/${id}`,
				expires_at: new Date(now + 72 * 3600_000).toISOString(),
				created_at: new Date(now).toISOString(),
				updated_at: new Date(now).toISOString(),
			};
			databases.set(id, record);
			return json(response, 201, record);
		}
		const found = /^\/api\/v1\/database\/([0-9a-f-]+)$/u.exec(url.pathname);
		if (method === "GET" && found !== null) {
			const record = databases.get(found[1] ?? "");
			return record === undefined
				? json(response, 404, { message: "not found" })
				: json(response, 200, record);
		}
		return json(response, 404, { message: url.pathname });
	};
	return { handle, calls, databases };
}
