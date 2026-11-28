import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type MergeGroupLiveness =
	| { readonly kind: "not-merge-group" }
	| { readonly kind: "live"; readonly ref: string }
	| { readonly kind: "landed"; readonly ref: string; readonly base: string }
	| { readonly kind: "left-queue"; readonly ref: string }
	| {
			readonly kind: "superseded";
			readonly ref: string;
			readonly queueSha: string;
	  }
	| { readonly kind: "unknown"; readonly ref: string; readonly reason: string };

export type GitHubResponse = { readonly status: number; readonly body: string };

export type GitHubGet = (url: string, token: string) => Promise<GitHubResponse>;

export type MergeGroupEnv = {
	readonly GITHUB_EVENT_NAME?: string;
	readonly GITHUB_REF?: string;
	readonly GITHUB_SHA?: string;
	readonly GITHUB_REPOSITORY?: string;
	readonly GITHUB_API_URL?: string;
	readonly GITHUB_TOKEN?: string;
};

export const STALE_EXIT_CODE = 3;

const LOOKUP_TIMEOUT_MS = 15_000;
const QUEUE_REF = /^refs\/heads\/gh-readonly-queue\/(.+)\/pr-\d+-[0-9a-f]{40}$/u;

function apiBase(env: MergeGroupEnv): string {
	return (env.GITHUB_API_URL ?? "https://api.github.com").replace(/\/+$/u, "");
}

function encodePath(path: string): string {
	return path.split("/").map(encodeURIComponent).join("/");
}

export function mergeGroupRefUrl(
	apiUrl: string,
	repository: string,
	ref: string,
): string {
	return `${apiUrl.replace(/\/+$/u, "")}/repos/${repository}/git/ref/${encodePath(ref.replace(/^refs\//u, ""))}`;
}

export function mergeGroupBase(ref: string): string | undefined {
	return QUEUE_REF.exec(ref)?.[1];
}

type JsonValue =
	| null
	| boolean
	| number
	| string
	| readonly JsonValue[]
	| JsonObject;
interface JsonObject {
	readonly [key: string]: JsonValue;
}

const tagOf = Object.prototype.toString;

function parseBody(body: string): JsonValue | undefined {
	try {
		// SAFETY: a JSON document is a JsonValue by construction.
		return JSON.parse(body) as JsonValue;
	} catch {
		return undefined;
	}
}

function member(
	value: JsonValue | undefined,
	key: string,
): JsonValue | undefined {
	// SAFETY: the tag check proves a plain object, which JSON.parse only produces as a JsonObject.
	return tagOf.call(value) === "[object Object]"
		? (value as JsonObject)[key]
		: undefined;
}

function text(value: JsonValue | undefined): string | undefined {
	// SAFETY: the tag check proves a string primitive.
	return tagOf.call(value) === "[object String]"
		? (value as string)
		: undefined;
}

async function goneGroup(
	env: MergeGroupEnv,
	get: GitHubGet,
	ref: string,
	sha: string,
	repository: string,
): Promise<MergeGroupLiveness> {
	const base = mergeGroupBase(ref);
	if (!base) {
		return { kind: "unknown", ref, reason: "the ref is not a merge-queue ref" };
	}
	let response: GitHubResponse;
	try {
		response = await get(
			`${apiBase(env)}/repos/${repository}/compare/${encodePath(base)}...${sha}`,
			env.GITHUB_TOKEN ?? "",
		);
	} catch (error) {
		return {
			kind: "unknown",
			ref,
			reason: error instanceof Error ? error.message : String(error),
		};
	}
	if (response.status !== 200) {
		return { kind: "unknown", ref, reason: `compare answered HTTP ${response.status}` };
	}
	const status = text(member(parseBody(response.body), "status"));
	if (status === "identical" || status === "behind") {
		return { kind: "landed", ref, base };
	}
	if (status === "ahead" || status === "diverged") {
		return { kind: "left-queue", ref };
	}
	return { kind: "unknown", ref, reason: "compare carried no status" };
}

export async function mergeGroupLiveness(
	env: MergeGroupEnv,
	get: GitHubGet,
): Promise<MergeGroupLiveness> {
	if (env.GITHUB_EVENT_NAME !== "merge_group") {
		return { kind: "not-merge-group" };
	}
	const ref = env.GITHUB_REF ?? "";
	const sha = env.GITHUB_SHA ?? "";
	const repository = env.GITHUB_REPOSITORY ?? "";
	if (!ref.startsWith("refs/heads/") || !sha || !repository) {
		return {
			kind: "unknown",
			ref,
			reason: "the run's ref, SHA or repository is unset",
		};
	}
	let response: GitHubResponse;
	try {
		response = await get(
			mergeGroupRefUrl(apiBase(env), repository, ref),
			env.GITHUB_TOKEN ?? "",
		);
	} catch (error) {
		return {
			kind: "unknown",
			ref,
			reason: error instanceof Error ? error.message : String(error),
		};
	}
	if (response.status === 404) {
		return goneGroup(env, get, ref, sha, repository);
	}
	if (response.status !== 200) {
		return { kind: "unknown", ref, reason: `HTTP ${response.status}` };
	}
	const queueSha = text(
		member(member(parseBody(response.body), "object"), "sha"),
	);
	if (queueSha === undefined) {
		return { kind: "unknown", ref, reason: "the ref response carried no SHA" };
	}
	if (queueSha !== sha) return { kind: "superseded", ref, queueSha };
	return { kind: "live", ref };
}

export const fetchGitHub: GitHubGet = async (url, token) => {
	const accept = {
		accept: "application/vnd.github+json",
		"x-github-api-version": "2022-11-28",
	};
	const headers = token
		? { ...accept, authorization: `Bearer ${token}` }
		: accept;
	const response = await fetch(url, {
		headers,
		signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS),
	});
	return { status: response.status, body: await response.text() };
};

export function livenessExitCode(
	liveness: MergeGroupLiveness,
): 0 | typeof STALE_EXIT_CODE {
	return liveness.kind === "left-queue" || liveness.kind === "superseded"
		? STALE_EXIT_CODE
		: 0;
}

export function livenessMessage(
	liveness: MergeGroupLiveness,
	sha: string,
): string | undefined {
	switch (liveness.kind) {
		case "not-merge-group":
			return undefined;
		case "live":
			return `Merge group ${liveness.ref} is still queued at ${sha}`;
		case "landed":
			return `Merge group ${liveness.ref} landed on ${liveness.base}; the job finishes the run`;
		case "left-queue":
			return `::error::Merge group ${liveness.ref} left the merge queue without landing; this run gates nothing, so it stops before taking the runner`;
		case "superseded":
			return `::error::Merge group ${liveness.ref} now points at ${liveness.queueSha}, not ${sha}; this run gates nothing, so it stops before taking the runner`;
		case "unknown":
			return `::warning::Could not confirm merge group ${liveness.ref} is still queued (${liveness.reason}); the job continues`;
	}
}

async function runCli(): Promise<void> {
	const liveness = await mergeGroupLiveness(process.env, fetchGitHub);
	const message = livenessMessage(liveness, process.env.GITHUB_SHA ?? "");
	if (message) console.log(message);
	process.exitCode = livenessExitCode(liveness);
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : undefined;
if (invokedPath === fileURLToPath(import.meta.url)) {
	await runCli();
}
