/**
 * Whether GitHub Pages needs a deploy, decided from what is published.
 *
 * The release gate used to ask "did the commit that triggered this run touch a
 * release path?". That question forgets: a deploy that failed, a run that was
 * cancelled, or a commit that reached `main` in a merge-queue batch behind
 * another was never asked about again, and the site stayed on the last deploy
 * that happened to work. Asking "is `gh-pages` behind this commit?" has no
 * memory to lose, so the next green run on `main` publishes whatever an
 * earlier one missed.
 */
import { setTimeout as delay } from "node:timers/promises";
import {
	isArray,
	isObject,
	isString,
	type Json,
	parseUnknownJson,
} from "./pins-json.ts";
import { anyPathMatchesReleaseHoboFilters } from "./release-hobo-path-filters.mts";

/** GitHub's compare endpoint returns at most this many files. */
export const COMPARE_FILE_LIMIT = 300;

export type PagesComparison =
	| { readonly status: "identical" | "behind" | "diverged" }
	| {
			readonly status: "ahead";
			readonly files: readonly string[];
			/** True when the file list was cut off and cannot rule a path out. */
			readonly truncated: boolean;
	  };

export interface PagesSource {
	/** Subject of the commit `gh-pages` points at; undefined when there is no such branch. */
	deployedMessage(): Promise<string | undefined>;
	/** How `head` relates to `base`; undefined when the repository does not know `base`. */
	compare(base: string, head: string): Promise<PagesComparison | undefined>;
}

export interface PagesDeployDecision {
	readonly deploy: boolean;
	readonly reason: string;
	readonly deployedSha?: string;
}

/**
 * The source commit a `gh-pages` deploy commit names. Both publishers write
 * one: the release workflow (`deploy: <sha>`) and `scripts/deploy-site.mts`
 * (`deploy: site + media @ <short sha>`).
 */
export function parseDeployedSha(message: string): string | undefined {
	const subject = message.split("\n", 1)[0]?.trim() ?? "";
	const match = /^deploy:.*?\b([0-9a-f]{7,64})$/i.exec(subject);
	return match?.[1]?.toLowerCase();
}

export async function decidePagesDeploy(options: {
	readonly head: string;
	readonly filters: readonly string[];
	readonly source: PagesSource;
	/** Publish without asking whether a release path changed. Never rolls back. */
	readonly force?: boolean;
}): Promise<PagesDeployDecision> {
	const { head, filters, source, force = false } = options;
	const message = await source.deployedMessage();
	if (message === undefined) {
		return { deploy: true, reason: "there is no gh-pages branch yet" };
	}
	const deployedSha = parseDeployedSha(message);
	if (!deployedSha) {
		return {
			deploy: true,
			reason: `the gh-pages commit does not name its source commit (${JSON.stringify(message.split("\n", 1)[0] ?? "")})`,
		};
	}
	const comparison = await source.compare(deployedSha, head);
	if (!comparison) {
		return {
			deploy: true,
			deployedSha,
			reason: `gh-pages names ${deployedSha}, which this repository does not have`,
		};
	}
	switch (comparison.status) {
		case "behind":
			// An older run finishing late must not put an older site back.
			return {
				deploy: false,
				deployedSha,
				reason: `gh-pages is already at ${deployedSha}, which is newer than ${head}`,
			};
		case "identical":
			return force
				? {
						deploy: true,
						deployedSha,
						reason: `republishing ${head} on request`,
					}
				: {
						deploy: false,
						deployedSha,
						reason: `gh-pages is already at ${head}`,
					};
		case "diverged":
			return {
				deploy: true,
				deployedSha,
				reason: `gh-pages names ${deployedSha}, which is not in the history of ${head}`,
			};
		case "ahead": {
			if (force) {
				return {
					deploy: true,
					deployedSha,
					reason: `publishing ${head} over ${deployedSha} on request`,
				};
			}
			if (comparison.truncated) {
				return {
					deploy: true,
					deployedSha,
					reason: `gh-pages is at ${deployedSha} and more than ${COMPARE_FILE_LIMIT} files changed since`,
				};
			}
			const relevant = anyPathMatchesReleaseHoboFilters(
				comparison.files,
				filters,
			);
			return relevant
				? {
						deploy: true,
						deployedSha,
						reason: `gh-pages is at ${deployedSha} and release paths changed since`,
					}
				: {
						deploy: false,
						deployedSha,
						reason: `gh-pages is at ${deployedSha} and no release path changed since`,
					};
		}
	}
}

/** One GitHub API answer: the status and the body as it arrived. */
export type PagesApiRequest = (
	url: string,
	headers: Readonly<
		Record<"accept" | "x-github-api-version" | "user-agent", string>
	> & {
		readonly authorization?: string;
	},
) => Promise<{ readonly status: number; readonly text: string }>;

// The gate runs on a sparse checkout before any `pnpm install`, so it reads the
// two answers it needs with the built-in JSON readers in pins-json.ts.
function child(value: Json | undefined, key: string, at: string): Json {
	const found = isObject(value) ? value[key] : undefined;
	if (found === undefined) throw new Error(`${at}: missing ${key}`);
	return found;
}

function stringAt(value: Json | undefined, at: string): string {
	if (!isString(value)) throw new Error(`${at}: expected a string`);
	return value;
}

/** `GET /repos/{repo}/branches/{branch}`: the message of the commit it points at. */
export function parseBranchMessage(json: Json | undefined): string {
	const commit = child(
		child(json, "commit", "branch"),
		"commit",
		"branch.commit",
	);
	return stringAt(child(commit, "message", "branch.commit.commit"), "message");
}

const COMPARE_STATUSES = ["ahead", "behind", "identical", "diverged"] as const;
type CompareStatus = (typeof COMPARE_STATUSES)[number];

/** `GET /repos/{repo}/compare/{base}...{head}`: the status and every path listed, renames twice. */
/** What a compare answer says, renames listed under both paths. */
export interface Comparison {
	readonly status: CompareStatus;
	readonly listed: number;
	readonly paths: readonly string[];
}

export function parseComparison(json: Json | undefined): Comparison {
	const reported = child(json, "status", "compare");
	const status = COMPARE_STATUSES.find((known) => known === reported);
	if (!status)
		throw new Error(`compare: unknown status ${JSON.stringify(reported)}`);
	const files = isObject(json) && "files" in json ? json.files : [];
	if (!isArray(files)) throw new Error("compare: files is not a list");
	// A rename moves content out of one path and into another; both count.
	const paths = files.flatMap((file, index) => {
		const filename = stringAt(
			child(file, "filename", `files[${index}]`),
			"filename",
		);
		const previous = isObject(file) ? file.previous_filename : undefined;
		return previous === undefined || previous === null
			? [filename]
			: [filename, stringAt(previous, `files[${index}].previous_filename`)];
	});
	return { status, listed: files.length, paths };
}

const requestOverHttp: PagesApiRequest = async (url, headers) => {
	const response = await fetch(url, {
		headers,
		signal: AbortSignal.timeout(20_000),
	});
	return { status: response.status, text: await response.text() };
};

/** The published branch and the commit graph, read from the GitHub API. */
export function githubPagesSource(options: {
	readonly repository: string;
	readonly token: string;
	readonly apiUrl?: string;
	readonly branch?: string;
	readonly request?: PagesApiRequest;
	readonly attempts?: number;
	readonly sleep?: (ms: number) => Promise<void>;
}): PagesSource {
	const api = (options.apiUrl ?? "https://api.github.com").replace(/\/+$/, "");
	const branch = options.branch ?? "gh-pages";
	const request = options.request ?? requestOverHttp;
	const attempts = options.attempts ?? 3;
	const sleep = options.sleep ?? ((ms: number) => delay(ms));
	const base = {
		accept: "application/vnd.github+json",
		"x-github-api-version": "2022-11-28",
		"user-agent": "hobo-release-pages-gate",
	};
	const headers = options.token
		? { ...base, authorization: `Bearer ${options.token}` }
		: base;

	/** The parsed answer, or undefined for 404. Anything else is retried, then thrown. */
	async function get<T>(
		path: string,
		parse: (json: Json | undefined) => T,
	): Promise<T | undefined> {
		let failure = "";
		for (let attempt = 1; attempt <= attempts; attempt++) {
			try {
				const response = await request(`${api}${path}`, headers);
				if (response.status === 404) return undefined;
				if (response.status >= 200 && response.status < 300) {
					return parse(parseUnknownJson(JSON.parse(response.text)));
				}
				failure = `HTTP ${response.status}`;
			} catch (error) {
				failure = error instanceof Error ? error.message : String(error);
			}
			if (attempt < attempts) await sleep(2000 * attempt);
		}
		throw new Error(`GET ${path}: ${failure}`);
	}

	return {
		async deployedMessage() {
			return get(
				`/repos/${options.repository}/branches/${encodeURIComponent(branch)}`,
				parseBranchMessage,
			);
		},
		async compare(base, head) {
			const found = await get(
				`/repos/${options.repository}/compare/${base}...${head}?per_page=1`,
				parseComparison,
			);
			if (!found) return undefined;
			if (found.status !== "ahead") return { status: found.status };
			return {
				status: "ahead",
				files: found.paths,
				truncated: found.listed >= COMPARE_FILE_LIMIT,
			};
		},
	};
}
