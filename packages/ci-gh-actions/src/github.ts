import { createSign } from "node:crypto";
import { z } from "zod";

export interface GithubTransport {
	/**
	 * `ifNoneMatch` makes a GET conditional: GitHub answers 304 when the ETag
	 * still matches, and a 304 does not count against the installation's rate
	 * limit. A transport may ignore it; the caller then just sees a 200.
	 */
	request(
		installationId: number,
		path: string,
		method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
		body?: string,
		ifNoneMatch?: string,
	): Promise<Response>;
}
const Run = z.object({
	id: z.number().int().positive(),
	run_attempt: z.number().int().positive(),
	event: z.string(),
	head_sha: z.string(),
	head_branch: z.string().nullable(),
	path: z.string(),
	display_title: z.string(),
	status: z.string(),
	conclusion: z.string().nullable(),
	run_started_at: z.string().nullable(),
	updated_at: z.string(),
	actor: z.object({ id: z.number().int().positive() }),
	repository: z.object({
		id: z.number().int().positive(),
		private: z.boolean(),
	}),
	head_repository: z.object({ id: z.number().int().positive() }).nullable(),
	pull_requests: z
		.array(
			z.object({
				base: z.object({
					ref: z.string(),
					repo: z.object({ id: z.number().int().positive() }),
				}),
			}),
		)
		.optional(),
});
export type GithubRun = z.infer<typeof Run>;
export async function getRun(
	api: GithubTransport,
	installationId: number,
	repository: string,
	runId: number,
): Promise<GithubRun> {
	const response = await api.request(
		installationId,
		`/repos/${repository}/actions/runs/${runId}`,
	);
	if (!response.ok)
		throw new Error(`GitHub run lookup failed (${response.status})`);
	return Run.parse(await response.json());
}
export async function getHostJob(
	api: GithubTransport,
	installationId: number,
	repository: string,
	runId: number,
) {
	const response = await api.request(
		installationId,
		`/repos/${repository}/actions/runs/${runId}/jobs`,
	);
	if (!response.ok)
		throw new Error(`GitHub host job lookup failed (${response.status})`);
	const result = z
		.object({
			jobs: z.array(
				z.object({
					name: z.string(),
					labels: z.array(z.string()),
					status: z.string(),
					started_at: z.string().nullable(),
					completed_at: z.string().nullable(),
				}),
			),
		})
		.parse(await response.json());
	if (result.jobs.length !== 1 || result.jobs[0]?.name !== "host")
		throw new Error("unexpected host job graph");
	return result.jobs[0];
}
export async function getJob(
	api: GithubTransport,
	installationId: number,
	repository: string,
	jobId: number,
) {
	const response = await api.request(
		installationId,
		`/repos/${repository}/actions/jobs/${jobId}`,
	);
	if (!response.ok)
		throw new Error(`GitHub job lookup failed (${response.status})`);
	return z
		.object({
			id: z.number().int().positive(),
			run_id: z.number().int().positive(),
			status: z.string(),
			labels: z.array(z.string()),
			runner_name: z.string().nullable().optional(),
			run_attempt: z.number().int().positive().optional(),
		})
		.parse(await response.json());
}

export interface GithubAppTransport extends GithubTransport {
	appRequest(path: string): Promise<Response>;
}

/** Only relative GitHub API paths; encoded separators cannot change the resource scope. */
export function githubApiUrl(path: string): string {
	const [pathname] = path.split("?");
	if (
		!pathname ||
		(!/^\/(?:repos|app|users)\b\/[A-Za-z0-9_.%/-]+$/.test(pathname) &&
			pathname !== "/app")
	)
		throw new Error("invalid GitHub API path");
	if (
		/%(?:2f|5c|00)/i.test(pathname) ||
		pathname
			.split("/")
			.some((part) => [".", ".."].includes(decodeURIComponent(part)))
	)
		throw new Error("invalid GitHub API path");
	const url = new URL(path, "https://api.github.com");
	if (
		url.origin !== "https://api.github.com" ||
		url.hash ||
		url.username ||
		url.password
	)
		throw new Error("invalid GitHub API path");
	const keys = new Set<string>();
	for (const [key, value] of url.searchParams) {
		if (
			keys.has(key) ||
			![
				"event",
				"per_page",
				"page",
				"ref",
				"state",
				"head",
				"status",
				"filter",
				"created",
			].includes(key) ||
			!value ||
			value.length > 200 ||
			Array.from(value).some((character) => {
				const point = character.codePointAt(0) ?? 0;
				return point < 32 || point === 127;
			})
		)
			throw new Error("invalid GitHub API query");
		keys.add(key);
		if (
			(key === "per_page" || key === "page") &&
			(!/^\d+$/.test(value) ||
				Number(value) < 1 ||
				Number(value) > (key === "per_page" ? 100 : 1000))
		)
			throw new Error("invalid GitHub API pagination");
		if (key === "event" && value !== "workflow_dispatch")
			throw new Error("invalid GitHub API event");
		if (
			key === "status" &&
			![
				"queued",
				"in_progress",
				"waiting",
				"pending",
				"requested",
				"completed",
			].includes(value)
		)
			throw new Error("invalid GitHub API status");
		if (
			key === "created" &&
			!/^>=\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/.test(value)
		)
			throw new Error("invalid GitHub API created");
		if (key === "filter" && value !== "latest")
			throw new Error("invalid GitHub API filter");
		if (key === "state" && !["all", "open", "closed"].includes(value))
			throw new Error("invalid GitHub API state");
	}
	return url.href;
}

/** App keys never leave the relay; concurrent lookups share short-lived installation tokens. */
export function createGithubAppTransport(options: {
	appId: string;
	privateKey: string;
	fetch?: typeof fetch;
	now?: () => number;
}): GithubAppTransport {
	const send = options.fetch ?? fetch;
	const now = options.now ?? Date.now;
	const tokens = new Map<number, { token: string; expiresAt: number }>();
	const minting = new Map<number, Promise<string>>();
	const common = {
		Accept: "application/vnd.github+json",
		"X-GitHub-Api-Version": "2026-03-10",
		"Content-Type": "application/json",
	};
	function jwt(): string {
		const issued = Math.floor(now() / 1000) - 60;
		const header = Buffer.from(
			JSON.stringify({ alg: "RS256", typ: "JWT" }),
		).toString("base64url");
		const payload = Buffer.from(
			JSON.stringify({ iat: issued, exp: issued + 600, iss: options.appId }),
		).toString("base64url");
		const input = `${header}.${payload}`;
		return `${input}.${createSign("RSA-SHA256").update(input).sign(options.privateKey).toString("base64url")}`;
	}
	async function installationToken(id: number): Promise<string> {
		if (!Number.isSafeInteger(id) || id <= 0)
			throw new Error("invalid installation id");
		const cached = tokens.get(id);
		if (cached && cached.expiresAt > now() + 60_000) return cached.token;
		const pending = minting.get(id);
		if (pending) return pending;
		const task = (async () => {
			const response = await send(
				`https://api.github.com/app/installations/${id}/access_tokens`,
				{
					method: "POST",
					headers: { ...common, Authorization: `Bearer ${jwt()}` },
					redirect: "error",
					signal: AbortSignal.timeout(15000),
				},
			);
			if (!response.ok)
				throw new Error(
					`GitHub App authentication failed (${response.status})`,
				);
			const result = z
				.object({ token: z.string().min(1), expires_at: z.string().optional() })
				.parse(await response.json());
			if (result.expires_at && Number.isFinite(Date.parse(result.expires_at)))
				tokens.set(id, {
					token: result.token,
					expiresAt: Math.min(
						Date.parse(result.expires_at),
						now() + 50 * 60000,
					),
				});
			return result.token;
		})().finally(() => minting.delete(id));
		minting.set(id, task);
		return task;
	}
	return {
		async appRequest(path) {
			const url = githubApiUrl(path);
			if (
				!/^\/app(?:\/installations\/\d+)?$/.test(new URL(url).pathname) &&
				!/^\/repos\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/installation$/.test(
					new URL(url).pathname,
				) &&
				!/^\/users\/[A-Za-z0-9_.%[\]-]+$/.test(new URL(url).pathname)
			)
				throw new Error("unsupported GitHub App metadata request");
			return send(url, {
				headers: { ...common, Authorization: `Bearer ${jwt()}` },
				redirect: "error",
				signal: AbortSignal.timeout(15000),
			});
		},
		async request(installationId, path, method = "GET", body, ifNoneMatch) {
			const url = githubApiUrl(path);
			const token = await installationToken(installationId);
			const conditional =
				method === "GET" && ifNoneMatch ? { "If-None-Match": ifNoneMatch } : {};
			const init: RequestInit = {
				method,
				headers: {
					...common,
					...conditional,
					Authorization: `Bearer ${token}`,
				},
				redirect: "error",
				signal: AbortSignal.timeout(15000),
			};
			if (body !== undefined) init.body = body;
			const response = await send(url, init);
			if (response.status === 401) tokens.delete(installationId);
			return response;
		},
	};
}
