#!/usr/bin/env node
/**
 * Says whether a signed local run covers the commit this job checked out.
 *
 * Runs in the route job, on a GitHub-hosted machine, before the runner is
 * chosen. It reads three things through the GitHub API with the job's token:
 * the tree of the event's base commit, the trusted attestors as they are AT
 * THAT BASE COMMIT, and the attestation published for the checked-out tree on
 * the `ci-attestations` branch. The attestor list in the checkout is never
 * read: it belongs to the pull request under test.
 *
 * It cannot fail a run. No attestation, an API error, a bad signature, an
 * expired key: each one is `attested=false`, and every job runs as before.
 */
import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import {
	ATTESTATION_BRANCH,
	ATTESTORS_PATH,
	type AttestationVerdict,
	asObject,
	asText,
	attestationPath,
	isObjectId,
	type JsonValue,
	parseJson,
	verifyAttestation,
} from "./attestation.mts";

/** Reads one GitHub API path; throws when the answer is not a success. */
export type ApiReader = (path: string) => Promise<JsonValue>;

/** The base commit GitHub tested this event against, from the event payload. */
export function baseShaOf(
	event: string,
	payload: JsonValue,
): string | undefined {
	const body = asObject(payload);
	const sha =
		event === "pull_request"
			? asText(asObject(asObject(body?.pull_request)?.base)?.sha)
			: event === "merge_group"
				? asText(asObject(body?.merge_group)?.base_sha)
				: undefined;
	return sha !== undefined && isObjectId(sha) ? sha : undefined;
}

/** The text of a file the contents API returned. */
function fileText(answer: JsonValue): string {
	const file = asObject(answer);
	const content = asText(file?.content);
	if (content === undefined || asText(file?.encoding) !== "base64")
		throw new Error("the contents API did not return a file");
	return Buffer.from(content, "base64").toString("utf8");
}

const notAttested = (reason: string): AttestationVerdict => ({
	attested: false,
	reason,
});

/**
 * The verdict for one checked-out tree. The attestation is read first: most
 * runs have none, and that is one request.
 */
export async function verifyFromApi(input: {
	read: ApiReader;
	repository: string;
	event: string;
	baseSha: string | undefined;
	tree: string;
	nowMs: number;
}): Promise<AttestationVerdict> {
	const { read, repository, event, baseSha, tree } = input;
	if (baseSha === undefined)
		return notAttested(`${event || "this event"} names no base commit`);
	if (!isObjectId(tree)) return notAttested("the checked-out tree is unknown");
	const repo = `/repos/${repository}`;
	let envelopeText: string;
	try {
		envelopeText = fileText(
			await read(
				`${repo}/contents/${attestationPath(tree)}?ref=${ATTESTATION_BRANCH}`,
			),
		);
	} catch (cause) {
		return notAttested(
			`no attestation could be read for tree ${tree} (${cause instanceof Error ? cause.message : "unknown error"})`,
		);
	}
	let attestorsText: string;
	let baseTree: string | undefined;
	try {
		attestorsText = fileText(
			await read(`${repo}/contents/${ATTESTORS_PATH}?ref=${baseSha}`),
		);
		baseTree = asText(
			asObject(asObject(await read(`${repo}/git/commits/${baseSha}`))?.tree)
				?.sha,
		);
	} catch (cause) {
		return notAttested(
			`the base commit ${baseSha} could not be read (${cause instanceof Error ? cause.message : "unknown error"})`,
		);
	}
	if (baseTree === undefined)
		return notAttested(`the base commit ${baseSha} has no tree`);
	return verifyAttestation({
		envelopeText,
		attestorsText,
		tree,
		baseTree,
		event,
		nowMs: input.nowMs,
	});
}

function githubReader(apiUrl: string, token: string): ApiReader {
	return async (path) => {
		const response = await fetch(`${apiUrl}${path}`, {
			headers: {
				accept: "application/vnd.github+json",
				authorization: `Bearer ${token}`,
				"x-github-api-version": "2022-11-28",
			},
			signal: AbortSignal.timeout(20_000),
		});
		if (!response.ok) throw new Error(`GitHub answered ${response.status}`);
		return parseJson(await response.text());
	};
}

/** The tree of the commit in the working directory; the commit alone says it. */
function checkedOutTree(): string {
	return execFileSync("git", ["show", "-s", "--format=%T", "HEAD"], {
		encoding: "utf8",
	}).trim();
}

export async function main(
	env: NodeJS.ProcessEnv = process.env,
	read?: ApiReader,
	tree?: string,
): Promise<AttestationVerdict> {
	let verdict: AttestationVerdict;
	try {
		const event = env.GITHUB_EVENT_NAME ?? "";
		verdict = await verifyFromApi({
			read:
				read ??
				githubReader(
					env.GITHUB_API_URL ?? "https://api.github.com",
					env.GITHUB_TOKEN ?? "",
				),
			repository: env.GITHUB_REPOSITORY ?? "",
			event,
			baseSha: baseShaOf(
				event,
				parseJson(readFileSync(env.GITHUB_EVENT_PATH ?? "", "utf8")),
			),
			tree: tree ?? checkedOutTree(),
			nowMs: Date.now(),
		});
	} catch (cause) {
		verdict = notAttested(
			`verification did not run (${cause instanceof Error ? cause.message : "unknown error"})`,
		);
	}
	const jobs = verdict.attested ? verdict.jobs : [];
	const line = verdict.attested
		? `attested: a local run signed by ${verdict.attestor} covers ${jobs.join(", ")}`
		: `not attested: ${verdict.reason}`;
	console.log(line);
	if (env.GITHUB_OUTPUT)
		appendFileSync(
			env.GITHUB_OUTPUT,
			`attested=${verdict.attested}\nattested-jobs=${JSON.stringify(jobs)}\n`,
		);
	if (env.GITHUB_STEP_SUMMARY)
		appendFileSync(env.GITHUB_STEP_SUMMARY, `${line}\n`);
	return verdict;
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) await main();
