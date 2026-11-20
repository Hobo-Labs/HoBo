/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-unsafe-dictionary-type, anti-slop/no-runtime-typeof -- SAFETY: this provider boundary checks the project, deployment, alias, and health response fields before use. */
import { readBoundedJsonResponse } from "./bounded-json-response.js";
import type { ReleaseProvider } from "./release-controller.js";

export interface VercelReleaseProvider extends ReleaseProvider {
	sourceState(
		id: string,
		commit: string,
		target: "preview" | "production",
	): Promise<string>;
}

function object(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function resolveVercelProject(input: {
	readonly token: string;
	readonly teamId: string;
	readonly name: string;
	readonly fetch: typeof fetch;
}): Promise<string> {
	if (
		!/^[!-~]{8,4096}$/u.test(input.token) ||
		!/^team_[A-Za-z0-9]+$/u.test(input.teamId) ||
		!/^[a-z0-9][a-z0-9._-]{0,99}$/u.test(input.name)
	)
		throw new TypeError("Invalid Vercel project selection.");
	const response = await input.fetch(
		`https://api.vercel.com/v9/projects/${encodeURIComponent(input.name)}?teamId=${encodeURIComponent(input.teamId)}`,
		{
			method: "GET",
			headers: { Authorization: `Bearer ${input.token}` },
			redirect: "error",
		},
	);
	if (!response.ok) {
		await response.body?.cancel().catch(() => {});
		throw new Error("Vercel project lookup failed.");
	}
	const value = await readBoundedJsonResponse(response);
	if (
		!object(value) ||
		value.name !== input.name ||
		value.accountId !== input.teamId ||
		typeof value.id !== "string" ||
		!/^prj_[A-Za-z0-9]+$/u.test(value.id)
	)
		throw new Error(
			"Vercel project lookup did not match the selected project.",
		);
	return value.id;
}

export function createVercelReleaseProvider(input: {
	readonly token: string;
	readonly teamId: string;
	readonly projectId: string;
	readonly productionOrigin: string;
	readonly fetch?: typeof fetch;
	readonly deadline?: number;
	readonly now?: () => number;
}): VercelReleaseProvider {
	if (
		!/^[!-~]{8,4096}$/u.test(input.token) ||
		!/^team_[A-Za-z0-9]+$/u.test(input.teamId) ||
		!/^prj_[A-Za-z0-9]+$/u.test(input.projectId)
	)
		throw new TypeError("Invalid Vercel release coordinates.");
	const origin = new URL(input.productionOrigin);
	if (
		origin.protocol !== "https:" ||
		origin.username ||
		origin.password ||
		origin.port ||
		origin.pathname !== "/" ||
		origin.search ||
		origin.hash ||
		!/^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.vercel\.app$/u.test(origin.hostname)
	)
		throw new TypeError(
			"The relay production origin must be a Vercel HTTPS origin.",
		);
	const http = input.fetch ?? fetch;
	const requestTimeout = () => {
		const remaining =
			input.deadline === undefined
				? 20_000
				: Math.min(20_000, input.deadline - (input.now ?? Date.now)());
		if (!Number.isSafeInteger(remaining) || remaining <= 0)
			throw new Error("The release deadline expired.");
		return remaining;
	};
	const team = `teamId=${encodeURIComponent(input.teamId)}`;
	const api = async (
		method: "GET" | "POST",
		path: string,
	): Promise<Response> => {
		try {
			const response = await http(
				`https://api.vercel.com${path}${path.includes("?") ? "&" : "?"}${team}`,
				{
					method,
					headers: { Authorization: `Bearer ${input.token}` },
					redirect: "error",
					signal: AbortSignal.timeout(requestTimeout()),
				},
			);
			if (!response.ok) {
				await response.body?.cancel().catch(() => {});
				throw new Error("provider refused operation");
			}
			return response;
		} catch {
			throw new Error("Vercel release operation failed.");
		}
	};
	const deployment = (id: string) => {
		if (!/^dpl_[A-Za-z0-9]+$/u.test(id))
			throw new Error("Invalid deployment ID.");
		return encodeURIComponent(id);
	};
	async function read(id: string): Promise<Record<string, unknown>> {
		const response = await api("GET", `/v13/deployments/${deployment(id)}`);
		const value = await readBoundedJsonResponse(response);
		if (
			!object(value) ||
			value.id !== id ||
			value.projectId !== input.projectId
		)
			throw new Error("Invalid Vercel deployment receipt.");
		return value;
	}
	return {
		async sourceState(id, commit, target) {
			const value = await read(id);
			const actualTarget =
				value.target === null || value.target === undefined
					? "preview"
					: value.target;
			if (
				!object(value.meta) ||
				value.meta.hoboSourceCommit !== commit ||
				actualTarget !== target
			)
				return "ERROR";
			return typeof value.readyState === "string"
				? value.readyState
				: "UNKNOWN";
		},
		async canRollback(id) {
			const value = await read(id);
			return value.target === "production" && value.readyState === "READY";
		},
		async inspect(id) {
			const value = await read(id);
			if (!object(value.meta))
				throw new Error("Invalid Vercel deployment receipt.");
			return {
				deploymentId: id,
				commit:
					typeof value.meta.hoboSourceCommit === "string"
						? value.meta.hoboSourceCommit
						: "",
				ready: value.readyState === "READY" && value.target === "production",
				staged: value.meta.hoboStagedProduction === "true",
			};
		},
		async current() {
			const response = await api(
				"GET",
				`/v4/aliases/${encodeURIComponent(origin.hostname)}?projectId=${encodeURIComponent(input.projectId)}`,
			);
			const value = await readBoundedJsonResponse(response);
			if (
				!object(value) ||
				value.projectId !== input.projectId ||
				value.alias !== origin.hostname ||
				typeof value.deploymentId !== "string" ||
				!/^dpl_[A-Za-z0-9]+$/u.test(value.deploymentId)
			)
				throw new Error("The production alias has no verified deployment.");
			return value.deploymentId;
		},
		async promote(id) {
			const response = await api(
				"POST",
				`/v10/projects/${encodeURIComponent(input.projectId)}/promote/${deployment(id)}`,
			);
			await response.body?.cancel().catch(() => {});
		},
		async rollback(id) {
			const response = await api(
				"POST",
				`/v1/projects/${encodeURIComponent(input.projectId)}/rollback/${deployment(id)}`,
			);
			await response.body?.cancel().catch(() => {});
		},
		async probe(commit) {
			try {
				const request = (path: string) =>
					http(`${origin.origin}${path}`, {
						method: "GET",
						redirect: "error",
						signal: AbortSignal.timeout(requestTimeout()),
					});
				const [health, ready] = await Promise.all([
					request("/healthz"),
					request("/readyz"),
				]);
				if (!health.ok || !ready.ok) {
					await Promise.all([
						health.body?.cancel().catch(() => {}),
						ready.body?.cancel().catch(() => {}),
					]);
					return false;
				}
				const value = await readBoundedJsonResponse(health);
				await ready.body?.cancel().catch(() => {});
				return object(value) && value.commit === commit;
			} catch {
				return false;
			}
		},
	};
}
