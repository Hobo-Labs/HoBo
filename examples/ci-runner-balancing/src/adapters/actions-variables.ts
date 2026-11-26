/**
 * GitHub Actions repository-variables adapter — the execution adapter
 * behind the dispatcher (the only place a decision becomes an effect).
 * Reads are best-effort (missing variable → undefined); writes PATCH the
 * variable and fall back to POST when it does not exist yet, so the first
 * apply pass bootstraps the routed variables. Write failures throw:
 * apply mode must never pretend a flip landed.
 */

import { isJsonObject, isJsonString, parseJsonValue } from "../parse.js";
import type { FetchLike } from "./github-billing.js";

export interface ActionsVariablesOptions {
	owner: string;
	repo: string;
	token: string;
	apiBase?: string;
	fetchImpl?: FetchLike;
}

export class ActionsVariablesError extends Error {
	readonly status: number;

	constructor(message: string, status: number) {
		super(message);
		this.name = "ActionsVariablesError";
		this.status = status;
	}
}

export interface VariablesPort {
	get(name: string): Promise<string | undefined>;
	set(name: string, value: string): Promise<void>;
}

export function actionsVariables(
	options: ActionsVariablesOptions,
): VariablesPort {
	const apiBase = options.apiBase ?? "https://api.github.com";
	const fetchImpl = options.fetchImpl ?? fetch;
	const base = `${apiBase}/repos/${options.owner}/${options.repo}/actions/variables`;
	const headers = {
		Authorization: `Bearer ${options.token}`,
		Accept: "application/vnd.github+json",
		"X-GitHub-Api-Version": "2022-11-28",
		"User-Agent": "hobo-example-ci-runner-balancing",
	};

	return {
		async get(name: string): Promise<string | undefined> {
			try {
				const response = await fetchImpl(`${base}/${name}`, { headers });
				if (response.status === 404) return undefined;
				if (!response.ok) return undefined;
				const body = parseJsonValue(await response.json());
				return isJsonObject(body) && isJsonString(body.value)
					? body.value
					: undefined;
			} catch {
				return undefined;
			}
		},
		async set(name: string, value: string): Promise<void> {
			const payload = JSON.stringify({ name, value });
			const patch = await fetchImpl(`${base}/${name}`, {
				method: "PATCH",
				headers: { ...headers, "Content-Type": "application/json" },
				body: payload,
			});
			if (patch.ok) return;
			if (patch.status !== 404) {
				throw new ActionsVariablesError(
					`PATCH ${name} failed with ${patch.status}`,
					patch.status,
				);
			}
			const post = await fetchImpl(base, {
				method: "POST",
				headers: { ...headers, "Content-Type": "application/json" },
				body: payload,
			});
			if (!post.ok) {
				throw new ActionsVariablesError(
					`POST ${name} failed with ${post.status}`,
					post.status,
				);
			}
		},
	};
}
