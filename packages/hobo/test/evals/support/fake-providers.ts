import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { z } from "zod";

import { bodyOf, json, type ProviderHandler } from "./tls-world.js";

type VercelProjectEnv = Readonly<{
	id: string;
	key: string;
	value: string;
	type: string;
	target: readonly string[];
}>;

type VercelProjectCreate = Readonly<{ name: string }>;

const vercelProjectCreateBody = z.object({
	name: z.union([z.string(), z.number()]).optional(),
});

const vercelEnvCreateBody = z.object({
	key: z.string().optional(),
	value: z.string().optional(),
	type: z.string().optional(),
	target: z.array(z.string()).optional(),
});

function parseVercelProjectCreate(body: string): VercelProjectCreate {
	try {
		const parsed = vercelProjectCreateBody.parse(JSON.parse(body || "{}"));
		return { name: String(parsed.name ?? "") };
	} catch {
		return { name: "" };
	}
}

const stagedBuild = z.object({
	meta: z.record(z.string(), z.string()),
	bundled: z.boolean(),
});

export type StagedBuild = z.infer<typeof stagedBuild>;

export function readStagedBuilds(file: string): readonly StagedBuild[] {
	if (!existsSync(file)) return [];
	return readFileSync(file, "utf8")
		.split("\n")
		.filter((line) => line !== "")
		.map((line) => stagedBuild.parse(JSON.parse(line)));
}

export type FakeVercelCli = Readonly<{ cli: string; staged: string }>;

export function fakeVercelCli(dir: string, bundleFile: string): FakeVercelCli {
	const staged = path.join(dir, "staged.jsonl");
	const cli = path.join(dir, "vercel");
	writeFileSync(
		cli,
		[
			"#!/usr/bin/env node",
			'const { appendFileSync, existsSync, writeFileSync } = require("node:fs");',
			"const args = process.argv.slice(2);",
			`const staged = ${JSON.stringify(staged)};`,
			`const bundle = ${JSON.stringify(bundleFile)};`,
			'if (args[0] === "build") writeFileSync(staged + ".bundled", String(existsSync(bundle)));',
			'if (args[0] === "deploy") {',
			"\tconst meta = {};",
			'\targs.forEach((arg, i) => { if (arg === "--meta") { const [k, ...v] = args[i + 1].split("="); meta[k] = v.join("="); } });',
			'\tconst bundled = existsSync(staged + ".bundled") && require("node:fs").readFileSync(staged + ".bundled", "utf8") === "true";',
			'\tappendFileSync(staged, JSON.stringify({ meta, bundled }) + "\\n");',
			"}",
			"",
		].join("\n"),
	);
	chmodSync(cli, 0o755);
	return { cli, staged };
}

function parseVercelEnvCreate(body: string): Omit<VercelProjectEnv, "id"> {
	try {
		const parsed = vercelEnvCreateBody.parse(JSON.parse(body || "{}"));
		return {
			key: parsed.key ?? "",
			value: parsed.value ?? "",
			type: parsed.type ?? "",
			target: parsed.target ?? [],
		};
	} catch {
		return { key: "", value: "", type: "", target: [] };
	}
}

export function fakeVercel(stagedFile?: string) {
	const calls: string[] = [];
	const promoted: string[] = [];
	let production: string | undefined;
	const grants = new Map<
		string,
		{ code: string; approved: boolean; denied: boolean }
	>();
	const tokens = new Set<string>();
	const deployments: string[] = [];
	const projects = new Map<string, VercelProjectEnv[]>();
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
			if (grant.denied) return json(response, 400, { error: "access_denied" });
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
		if (method === "POST" && url.pathname === "/v9/projects") {
			const { name } = parseVercelProjectCreate(body);
			if (projects.has(name))
				return json(response, 409, { error: { code: "conflict" } });
			projects.set(name, []);
			return json(response, 200, { id: `prj_${name}`, name });
		}
		const env = /^\/v10\/projects\/([^/]+)\/env$/u.exec(url.pathname);
		if (env !== null) {
			const name = decodeURIComponent(env[1] ?? "");
			const envs = projects.get(name);
			if (envs === undefined)
				return json(response, 404, {
					error: { code: "not_found", message: "Project not found" },
				});
			if (method === "GET") return json(response, 200, { envs });
			if (method === "POST") {
				const made = parseVercelEnvCreate(body);
				envs.push({ id: `env_${envs.length}`, ...made });
				return json(response, 200, { created: made, failed: [] });
			}
		}
		const team = /^\/v2\/teams\/([^/]+)$/u.exec(url.pathname);
		if (method === "GET" && team !== null)
			return team[1] === "team_owner"
				? json(response, 200, { id: "team_owner", slug: "owner" })
				: json(response, 404, { error: { code: "not_found" } });
		const read = /^\/v9\/projects\/([^/]+)$/u.exec(url.pathname);
		if (method === "GET" && read !== null) {
			const asked = decodeURIComponent(read[1] ?? "");
			const name = asked.replace(/^prj_/u, "");
			return projects.has(name)
				? json(response, 200, {
						id: `prj_${name}`,
						name,
						...(production !== undefined
							? { targets: { production: { id: production } } }
							: undefined),
					})
				: json(response, 404, {
						error: { code: "not_found", message: "Project not found" },
					});
		}
		if (method === "GET" && url.pathname === "/v6/deployments")
			return json(response, 200, {
				deployments: (stagedFile === undefined
					? []
					: readStagedBuilds(stagedFile)
				).map((build, index) => ({
					uid: `dpl_staged${index}`,
					url: `hobo-cd-staged${index}.vercel.app`,
					readyState: "READY",
					target: "production",
					created: 1_794_600_000_000 + index,
					meta: build.meta,
				})),
			});
		const promote = /^\/v10\/projects\/[^/]+\/promote\/([^/]+)$/u.exec(
			url.pathname,
		);
		if (method === "POST" && promote !== null) {
			production = promote[1];
			promoted.push(promote[1] ?? "");
			return json(response, 201, {});
		}
		const patched = /^\/v9\/projects\/([^/]+)$/u.exec(url.pathname);
		if (method === "PATCH" && patched !== null)
			return projects.has(decodeURIComponent(patched[1] ?? ""))
				? json(response, 200, {
						oidcTokenConfig: { enabled: true, issuerMode: "team" },
					})
				: json(response, 404, { error: { code: "not_found" } });
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
		promoted,
		deny(link: string) {
			const code = new URL(link).searchParams.get("user_code");
			for (const grant of grants.values())
				if (grant.code === code) grant.denied = true;
		},
		approve(link: string) {
			const code = new URL(link).searchParams.get("user_code");
			for (const grant of grants.values())
				if (grant.code === code) grant.approved = true;
		},
	};
}

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
