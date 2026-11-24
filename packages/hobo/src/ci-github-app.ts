import type { CredentialResolver } from "@hobo/cd";
import type { CommandResult } from "@hobo/cli";
import { githubAppInstallationRef } from "@hobo/core";

// public-contract: the GitHub REST origin `hobo ci` reads Actions history from.
export const GITHUB_REST_ORIGIN = "https://api.github.com";

const REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_BYTES = 16 * 1024 * 1024;

export class GithubAppNeeded extends Error {
	constructor() {
		super("No GitHub App installation token is available");
	}
}

export class GithubApiError extends Error {
	constructor(
		readonly kind: "timeout" | "failed",
		readonly httpStatus?: number,
	) {
		super("GitHub REST request failed");
	}
}

export type GithubBody = Readonly<{ text: string; truncated: boolean }>;

export type GithubAppReader = Readonly<{
	token(): Promise<string>;
	read(path: string, maxBytes?: number): Promise<string>;
	log(path: string, maxBytes: number): Promise<GithubBody>;
	post(path: string): Promise<void>;
}>;

export const GITHUB_APP_NEEDED_REFUSAL = Object.freeze({
	ok: false,
	status: "unauthenticated",
	code: "HOBO_CI_GITHUB_APP_NEEDED",
	message:
		"HoBo reads GitHub Actions only through its GitHub App, and no installation token for this repository could be minted.",
	remediation: [
		"Connect the owner's secret store through HoBo MCP's choose_secret_store.",
		"Install HoBo's GitHub App (hobo ci app create) on the repository with Actions read permission, and Actions write permission for hobo ci rerun.",
	],
} satisfies CommandResult);

async function boundedBody(
	response: Response,
	maxBytes: number,
): Promise<GithubBody> {
	if (response.body === null) return { text: "", truncated: false };
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done)
			return { text: Buffer.concat(chunks).toString("utf8"), truncated: false };
		const room = maxBytes - size;
		if (value.byteLength > room) {
			chunks.push(value.subarray(0, room));
			await reader.cancel();
			return { text: Buffer.concat(chunks).toString("utf8"), truncated: true };
		}
		chunks.push(value);
		size += value.byteLength;
	}
}

async function guarded<T>(work: () => Promise<T>): Promise<T> {
	try {
		return await work();
	} catch (error) {
		if (error instanceof GithubApiError) throw error;
		throw error instanceof DOMException &&
			(error.name === "TimeoutError" || error.name === "AbortError")
			? new GithubApiError("timeout")
			: new GithubApiError("failed");
	}
}

export function githubAppReader(
	input: Readonly<{
		credentials: CredentialResolver | undefined;
		repository: string;
		fetch: typeof fetch;
		scope: string;
	}>,
): GithubAppReader {
	let minted: Promise<string> | undefined;
	const token = (): Promise<string> => {
		minted ??= (async () => {
			if (input.credentials === undefined) throw new GithubAppNeeded();
			let resolved: Record<string, string>;
			try {
				resolved = await input.credentials.resolve(
					githubAppInstallationRef(input.repository),
					input.scope,
				);
			} catch {
				throw new GithubAppNeeded();
			}
			const value = resolved.token;
			if (value === undefined || value === "") throw new GithubAppNeeded();
			return value;
		})();
		return minted;
	};
	const send = async (
		path: string,
		method: "GET" | "POST",
		redirect: RequestRedirect,
	): Promise<Response> => {
		const authorization = `Bearer ${await token()}`;
		return guarded(() =>
			input.fetch(`${GITHUB_REST_ORIGIN}/${path}`, {
				method,
				headers: {
					authorization,
					accept: "application/vnd.github+json",
					"x-github-api-version": "2022-11-28",
				},
				redirect,
				signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
			}),
		);
	};
	const accepted = (response: Response): Response => {
		if (!response.ok) throw new GithubApiError("failed", response.status);
		return response;
	};
	const bodyOf = (response: Response, maxBytes: number): Promise<GithubBody> =>
		guarded(() => boundedBody(accepted(response), maxBytes));
	return {
		token,
		async read(path, maxBytes = DEFAULT_MAX_BYTES) {
			const body = await bodyOf(await send(path, "GET", "error"), maxBytes);
			if (body.truncated) throw new GithubApiError("failed");
			return body.text;
		},
		async log(path, maxBytes) {
			const first = await send(path, "GET", "manual");
			if (first.status < 300 || first.status >= 400)
				return bodyOf(first, maxBytes);
			const location = first.headers.get("location");
			if (location === null || !location.startsWith("https://"))
				throw new GithubApiError("failed", first.status);
			const blob = await guarded(() =>
				input.fetch(location, {
					method: "GET",
					redirect: "error",
					signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
				}),
			);
			return bodyOf(blob, maxBytes);
		},
		async post(path) {
			accepted(await send(path, "POST", "error"));
		},
	};
}
