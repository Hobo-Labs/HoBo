#!/usr/bin/env node
/**
 * Create a GitHub Release for a tag when it has none (never edits one).
 *
 * Calls the REST API directly: the release runners have no `gh` CLI (the
 * runner image does not install it), which the jobs used to shell out to.
 */
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

/** One API answer: the status, as it arrived. */
export type ReleaseApiRequest = (
	url: string,
	init: {
		readonly method: "GET" | "POST";
		readonly headers: Readonly<Record<string, string>>;
		readonly body?: string;
	},
) => Promise<{ readonly status: number; readonly text: string }>;

const requestOverHttp: ReleaseApiRequest = async (url, init) => {
	const response = await fetch(url, {
		...init,
		signal: AbortSignal.timeout(30_000),
	});
	return { status: response.status, text: await response.text() };
};

export async function ensureGitHubRelease(options: {
	readonly repository: string;
	readonly token: string;
	readonly tag: string;
	readonly prerelease: boolean;
	readonly apiUrl?: string | undefined;
	readonly request?: ReleaseApiRequest;
	readonly attempts?: number;
	readonly sleep?: (ms: number) => Promise<void>;
}): Promise<"exists" | "created"> {
	const api = (options.apiUrl ?? "https://api.github.com").replace(/\/+$/u, "");
	const request = options.request ?? requestOverHttp;
	const attempts = options.attempts ?? 3;
	const sleep = options.sleep ?? ((ms: number) => delay(ms));
	const headers = {
		accept: "application/vnd.github+json",
		authorization: `Bearer ${options.token}`,
		"content-type": "application/json",
		"user-agent": "hobo-release-tag",
		"x-github-api-version": "2022-11-28",
	};
	const base = `${api}/repos/${options.repository}/releases`;
	let failure = "";
	for (let attempt = 1; attempt <= attempts; attempt++) {
		try {
			const found = await request(
				`${base}/tags/${encodeURIComponent(options.tag)}`,
				{ method: "GET", headers },
			);
			if (found.status === 200) return "exists";
			if (found.status !== 404) {
				failure = `GET release: HTTP ${found.status}`;
			} else {
				const made = await request(base, {
					method: "POST",
					headers,
					body: JSON.stringify({
						tag_name: options.tag,
						name: options.tag,
						prerelease: options.prerelease,
						generate_release_notes: true,
					}),
				});
				if (made.status === 201) return "created";
				// Another run created it between the two calls.
				if (made.status === 422 && made.text.includes("already_exists")) {
					return "exists";
				}
				failure = `POST release: HTTP ${made.status} ${made.text.slice(0, 300)}`;
			}
		} catch (error) {
			failure = error instanceof Error ? error.message : String(error);
		}
		if (attempt < attempts) await sleep(2000 * attempt);
	}
	throw new Error(`GitHub Release ${options.tag}: ${failure}`);
}

function parseArgs(argv: readonly string[]) {
	let tag = "";
	let prerelease = false;
	for (let i = 2; i < argv.length; i++) {
		const arg = argv[i] ?? "";
		if (arg === "--tag") tag = argv[++i] ?? "";
		else if (arg === "--prerelease") prerelease = true;
	}
	if (!tag.trim()) {
		console.error(
			"usage: create-github-release.mts --tag <tag> [--prerelease]",
		);
		process.exit(2);
	}
	return { tag: tag.trim(), prerelease };
}

async function main(): Promise<void> {
	const { tag, prerelease } = parseArgs(process.argv);
	const repository = process.env.GITHUB_REPOSITORY?.trim() ?? "";
	const token = process.env.GITHUB_TOKEN?.trim() ?? "";
	if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository) || !token) {
		throw new Error("GITHUB_REPOSITORY and GITHUB_TOKEN are required");
	}
	const outcome = await ensureGitHubRelease({
		repository,
		token,
		tag,
		prerelease,
		apiUrl: process.env.GITHUB_API_URL,
	});
	console.log(
		outcome === "exists"
			? `GitHub Release ${tag} already exists`
			: `created GitHub Release ${tag}${prerelease ? " (prerelease)" : ""}`,
	);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	try {
		await main();
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exit(1);
	}
}
