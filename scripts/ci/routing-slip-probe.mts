#!/usr/bin/env node
/**
 * Proves the Git Data API calls the routing slip rests on (ADR-0181, decision 2),
 * against the live repository or a fake one.
 *
 *   node scripts/ci/routing-slip-probe.mts --repository owner/name
 *       Read only (the default). Reads `refs/hobo/routing-slip` and judges
 *       what it finds, then proves the two read calls on the default branch's
 *       head (`GET /git/ref/heads/<branch>`, `GET /git/commits/<sha>`).
 *
 *   node scripts/ci/routing-slip-probe.mts --repository owner/name --write
 *       Also writes a probe slip the way the relay will: a one-file tree
 *       (`POST /git/trees`), a parentless commit whose message is the slip
 *       (`POST /git/commits`), and the ref (`PATCH /git/refs/...` with
 *       `force: true`, or `POST /git/refs` the first time). It writes only
 *       `refs/hobo/routing-slip-probe` (never the live slip), reads it back,
 *       and deletes it. Needs a token with `contents: write`.
 *
 * The token is `GITHUB_TOKEN` (a credential, not routing). Nothing here
 * chooses a runner.
 */
import { pathToFileURL } from "node:url";
import {
	asObject,
	asText,
	githubHeaders,
	type JsonValue,
	judgeRoutingSlip,
	parseJson,
	ROUTING_SLIP_LIFETIME_MS,
	ROUTING_SLIP_REF,
	type RoutingSlipRead,
	readRoutingSlip,
} from "./runner-routing.mts";

/** The only ref the probe writes. */
export const PROBE_REF = "refs/hobo/routing-slip-probe";
/** The one file of the slip's tree; the slip itself is the commit message. */
export const SLIP_TREE_PATH = "README.md";
export const SLIP_TREE_CONTENT =
	"This ref holds HoBo's routing slip (ADR-0181). The slip is the commit message.\n";

type Fetch = typeof fetch;
type Call = Readonly<{ method: string; path: string; status: number }>;

async function call(
	input: Readonly<{ apiUrl: string; token: string; fetch: Fetch }>,
	calls: Call[],
	method: string,
	path: string,
	body?: JsonValue,
): Promise<{ status: number; json: JsonValue | undefined }> {
	const headers = githubHeaders(input.token);
	const init: RequestInit = {
		method,
		headers,
		signal: AbortSignal.timeout(10_000),
	};
	if (body !== undefined) {
		headers.set("content-type", "application/json");
		init.body = JSON.stringify(body);
	}
	const response = await input.fetch(
		`${input.apiUrl.replace(/\/$/u, "")}${path}`,
		init,
	);
	calls.push({ method, path, status: response.status });
	return { status: response.status, json: parseJson(await response.text()) };
}

function shaOf(json: JsonValue | undefined): string | undefined {
	return asText(asObject(json)?.sha);
}

/**
 * Writes `message` as the slip at `ref` the way the relay will. Reuses
 * `treeSha` when given; otherwise creates the one-file tree.
 */
export async function writeRoutingSlip(
	input: Readonly<{
		apiUrl: string;
		repository: string;
		token: string;
		fetch: Fetch;
		ref: string;
		message: string;
		treeSha?: string | undefined;
	}>,
): Promise<{ commitSha: string; treeSha: string; calls: readonly Call[] }> {
	const calls: Call[] = [];
	const git = `/repos/${input.repository}/git`;
	let treeSha = input.treeSha;
	if (!treeSha) {
		const tree = await call(input, calls, "POST", `${git}/trees`, {
			tree: [
				{
					path: SLIP_TREE_PATH,
					mode: "100644",
					type: "blob",
					content: SLIP_TREE_CONTENT,
				},
			],
		});
		treeSha = tree.status === 201 ? shaOf(tree.json) : undefined;
		if (!treeSha) throw new Error(`POST /git/trees answered ${tree.status}`);
	}
	const commit = await call(input, calls, "POST", `${git}/commits`, {
		message: input.message,
		tree: treeSha,
		parents: [],
	});
	const commitSha = commit.status === 201 ? shaOf(commit.json) : undefined;
	if (!commitSha)
		throw new Error(`POST /git/commits answered ${commit.status}`);
	const short = input.ref.replace(/^refs\//u, "");
	const moved = await call(input, calls, "PATCH", `${git}/refs/${short}`, {
		sha: commitSha,
		force: true,
	});
	if (moved.status !== 200) {
		// GitHub answers 422 ("Reference does not exist") for a missing ref.
		if (moved.status !== 422 && moved.status !== 404)
			throw new Error(`PATCH /git/refs answered ${moved.status}`);
		const created = await call(input, calls, "POST", `${git}/refs`, {
			ref: input.ref,
			sha: commitSha,
		});
		if (created.status !== 201)
			throw new Error(`POST /git/refs answered ${created.status}`);
	}
	return { commitSha, treeSha, calls };
}

export type ProbeReport = Readonly<{
	slip: string;
	readCalls: string;
	write?: string;
}>;

/** The probe itself; `write` adds the write, read-back and delete of `PROBE_REF`. */
export async function probe(
	input: Readonly<{
		apiUrl: string;
		repository: string;
		token: string;
		fetch: Fetch;
		branch: string;
		write: boolean;
		nowMs: number;
	}>,
): Promise<ProbeReport> {
	const labels = new Set([
		"hobo",
		"hobo-trunk",
		"hobo-local-host",
		"ubuntu-24.04",
	]);
	const describe = (read: RoutingSlipRead): string => {
		if (read.kind === "none") return read.why;
		const judgement = judgeRoutingSlip(read.text, {
			repository: input.repository,
			nowMs: input.nowMs,
			labels,
		});
		return judgement.ok
			? `slip from ${judgement.slip.relay.nodeId}@${judgement.slip.relay.commit}`
			: `slip at ${read.sha} refused: ${judgement.why}`;
	};
	const slip = describe(
		await readRoutingSlip({
			...input,
			ref: ROUTING_SLIP_REF,
			timeoutMs: 10_000,
		}),
	);
	const head = await readRoutingSlip({
		...input,
		ref: `refs/heads/${input.branch}`,
		timeoutMs: 10_000,
	});
	const readCalls =
		head.kind === "found"
			? `GET /git/ref and GET /git/commits read ${input.branch} at ${head.sha}`
			: `reading ${input.branch} failed: ${head.why}`;
	if (!input.write) return { slip, readCalls };
	const issuedAt = new Date(input.nowMs).toISOString();
	const message = JSON.stringify({
		version: 1,
		repository: input.repository.toLowerCase(),
		issuedAt,
		expiresAt: new Date(input.nowMs + ROUTING_SLIP_LIFETIME_MS).toISOString(),
		classes: {
			pr: { runner: "hobo", tier: "fleet", reason: "fleet-open" },
			fork: { runner: "hobo", tier: "fleet", reason: "fleet-open" },
			trunk: { runner: "hobo-trunk", tier: "fleet", reason: "fleet-open" },
		},
		relay: { nodeId: "routing-slip-probe", commit: "0000000" },
	});
	const first = await writeRoutingSlip({ ...input, ref: PROBE_REF, message });
	const second = await writeRoutingSlip({
		...input,
		ref: PROBE_REF,
		message,
		treeSha: first.treeSha,
	});
	const back = describe(
		await readRoutingSlip({ ...input, ref: PROBE_REF, timeoutMs: 10_000 }),
	);
	const removed: Call[] = [];
	await call(
		input,
		removed,
		"DELETE",
		`/repos/${input.repository}/git/refs/${PROBE_REF.replace(/^refs\//u, "")}`,
	);
	const trace = [...first.calls, ...second.calls, ...removed]
		.map((entry) => `${entry.method} ${entry.status}`)
		.join(", ");
	return { slip, readCalls, write: `${trace}; read back: ${back}` };
}

function option(argv: readonly string[], name: string): string | undefined {
	const index = argv.indexOf(name);
	return index >= 0 ? argv[index + 1] : undefined;
}

async function main(argv: readonly string[]): Promise<number> {
	const repository =
		option(argv, "--repository") ?? process.env.GITHUB_REPOSITORY ?? "";
	if (!/^[^/\s]+\/[^/\s]+$/u.test(repository)) {
		process.stderr.write(
			"usage: routing-slip-probe.mts --repository owner/name [--write]\n",
		);
		return 2;
	}
	const report = await probe({
		apiUrl: process.env.GITHUB_API_URL ?? "https://api.github.com",
		repository,
		token: process.env.GITHUB_TOKEN ?? "",
		fetch,
		branch: option(argv, "--branch") ?? "main",
		write: argv.includes("--write"),
		nowMs: Date.now(),
	});
	process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
	return report.readCalls.startsWith("reading") ? 1 : 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href)
	process.exitCode = await main(process.argv.slice(2));
