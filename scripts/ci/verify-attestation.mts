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
	asList,
	asObject,
	asText,
	attestationPath,
	isObjectId,
	type JsonValue,
	omitImpactGroup,
	parseJson,
	SHADOW_PLAN_BLOB,
	SHADOW_PLAN_PATH,
	SHADOW_REQUIRED_PATHS,
	SHADOW_RESOLUTION_PATHS,
	SHADOW_WORKFLOW_BLOB,
	SHADOW_WORKFLOW_PATH,
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

/**
 * The head commit of the event, when it has one: the pull request's own tip.
 * A merge group has none that a local run could have seen.
 */
export function headShaOf(
	event: string,
	payload: JsonValue,
): string | undefined {
	if (event !== "pull_request") return undefined;
	const sha = asText(
		asObject(asObject(asObject(payload)?.pull_request)?.head)?.sha,
	);
	return sha !== undefined && isObjectId(sha) ? sha : undefined;
}

/**
 * One line, whatever went into it. Text from an API answer or an attestation
 * must not be able to start a new log line, where a runner reads commands.
 */
export function oneLine(text: string): string {
	return [...text]
		.map((character) => {
			const code = character.codePointAt(0) ?? 0;
			return code < 0x20 || code === 0x7f ? " " : character;
		})
		.join("");
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

type TreeEntry = Readonly<{ type: string; mode: string; sha: string }>;

function shadowTree(
	answer: JsonValue,
	expected: string,
): Map<string, TreeEntry> {
	const tree = asObject(answer);
	const entries = asList(tree?.tree);
	if (asText(tree?.sha) !== expected || tree?.truncated !== false || !entries)
		throw new Error("incomplete tree");
	const selected = new Set<string>([
		SHADOW_PLAN_PATH,
		SHADOW_WORKFLOW_PATH,
		...SHADOW_REQUIRED_PATHS,
		...SHADOW_RESOLUTION_PATHS,
	]);
	const result = new Map<string, TreeEntry>();
	for (const value of entries) {
		const entry = asObject(value);
		const path = asText(entry?.path);
		if (!path || !selected.has(path)) continue;
		const type = asText(entry?.type);
		const mode = asText(entry?.mode);
		const sha = asText(entry?.sha);
		if (!type || !mode || !sha || !isObjectId(sha) || result.has(path))
			throw new Error("invalid tree entry");
		result.set(path, { type, mode, sha });
	}
	return result;
}

async function shadowPolicyMatches(input: {
	read: ApiReader;
	repo: string;
	baseTree: string;
	tree: string;
}): Promise<boolean> {
	try {
		const [baseAnswer, headAnswer] = await Promise.all([
			input.read(`${input.repo}/git/trees/${input.baseTree}?recursive=1`),
			input.read(`${input.repo}/git/trees/${input.tree}?recursive=1`),
		]);
		const base = shadowTree(baseAnswer, input.baseTree);
		const head = shadowTree(headAnswer, input.tree);
		const regular = (entry: TreeEntry | undefined) =>
			entry?.type === "blob" &&
			(entry.mode === "100644" || entry.mode === "100755");
		for (const [path, expected] of [
			[SHADOW_PLAN_PATH, SHADOW_PLAN_BLOB],
			[SHADOW_WORKFLOW_PATH, SHADOW_WORKFLOW_BLOB],
		] as const) {
			if (
				!regular(base.get(path)) ||
				!regular(head.get(path)) ||
				base.get(path)?.sha !== expected ||
				head.get(path)?.sha !== expected
			)
				return false;
		}
		for (const path of SHADOW_REQUIRED_PATHS) {
			const before = base.get(path);
			const after = head.get(path);
			if (!regular(before) || !regular(after)) return false;
			if (
				before?.sha !== after?.sha ||
				before?.type !== after?.type ||
				before?.mode !== after?.mode
			)
				return false;
		}
		if (
			SHADOW_RESOLUTION_PATHS.some((path) => base.has(path) || head.has(path))
		)
			return false;
		return true;
	} catch {
		return false;
	}
}

/**
 * The verdict for one checked-out tree. The attestation is read first: most
 * runs have none, and that is one request.
 */
export async function verifyFromApi(input: {
	read: ApiReader;
	repository: string;
	event: string;
	baseSha: string | undefined;
	/** The event's head commit; without it, jobs bound to commits are not reported. */
	headSha?: string | undefined;
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
	const verdict = verifyAttestation({
		envelopeText,
		attestorsText,
		tree,
		baseTree,
		event,
		nowMs: input.nowMs,
		head: input.headSha,
		base: baseSha,
	});
	if (!verdict.attested || !verdict.jobs.includes("pr_gate_validation"))
		return verdict;
	return (await shadowPolicyMatches({ read, repo, baseTree, tree }))
		? verdict
		: omitImpactGroup(verdict);
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
		const payload = parseJson(
			readFileSync(env.GITHUB_EVENT_PATH ?? "", "utf8"),
		);
		verdict = await verifyFromApi({
			read:
				read ??
				githubReader(
					env.GITHUB_API_URL ?? "https://api.github.com",
					env.GITHUB_TOKEN ?? "",
				),
			repository: env.GITHUB_REPOSITORY ?? "",
			event,
			baseSha: baseShaOf(event, payload),
			headSha: headShaOf(event, payload),
			tree: tree ?? checkedOutTree(),
			nowMs: Date.now(),
		});
	} catch (cause) {
		verdict = notAttested(
			`verification did not run (${cause instanceof Error ? cause.message : "unknown error"})`,
		);
	}
	const jobs = verdict.attested ? verdict.jobs : [];
	const line = oneLine(
		verdict.attested
			? `attested: a local run signed by ${verdict.attestor} covers ${jobs.join(", ")}`
			: `not attested: ${verdict.reason}`,
	);
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
