import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import {
	ContentsFileSchema,
	type MailboxDocument,
	MailboxDocumentSchema,
	NativeArtifactSchema,
	NativeJobsSchema,
	NativeRunSchema,
	PublicArtifactSchema,
	type VerifiedPublicArtifact,
} from "./artifact-contracts.mts";
import { createConditionalGithubFetch } from "./conditional-fetch.mts";

const exec = promisify(execFile);
const nativeSend = createConditionalGithubFetch();
const REPOSITORY = "Hobo-Labs/HoBo";
const PREFIX = `/repos/${REPOSITORY}/`;
const HEADERS = {
	Accept: "application/vnd.github+json",
	"X-GitHub-Api-Version": "2022-11-28",
	"Content-Type": "application/json",
};
function token(): string {
	const value = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;
	if (!value) throw new Error("configured GitHub identity unavailable");
	return value;
}

/** Uses the existing configured connector for ordinary first-party repository operations. */
export function createNativeGithubTransport() {
	return {
		async request(
			_installationId: number,
			path: string,
			method = "GET",
			body?: string,
			ifNoneMatch?: string,
		): Promise<Response> {
			if (
				(path !== PREFIX.slice(0, -1) && !path.startsWith(PREFIX)) ||
				Array.from(path).some(
					(character) =>
						character === "\\" ||
						character.charCodeAt(0) <= 32 ||
						character.charCodeAt(0) === 127,
				)
			)
				throw new Error("GitHub repository scope denied");
			const url = new URL(path, "https://api.github.com");
			if (
				url.origin !== "https://api.github.com" ||
				/%(?:2f|5c)/iu.test(url.pathname) ||
				(url.pathname !== PREFIX.slice(0, -1) &&
					!url.pathname.startsWith(PREFIX))
			)
				throw new Error("GitHub origin denied");
			const headers = new Headers(HEADERS);
			headers.set("Authorization", `Bearer ${token()}`);
			if (ifNoneMatch) headers.set("If-None-Match", ifNoneMatch);
			const init: RequestInit = {
				method,
				headers,
				redirect: "error",
				signal: AbortSignal.timeout(20000),
			};
			if (method !== "GET" && body !== undefined) init.body = body;
			return nativeSend(url, init);
		},
	};
}

/** Reads a bounded data file from the dedicated operational mailbox branch. */
export async function readContents(
	branch: string,
	path: string,
): Promise<MailboxDocument | undefined> {
	if (
		!/^ops\/ci-runner-mailbox-5636332-[a-f0-9]{8}$/.test(branch) ||
		!/^(?:controllers\/[0-9]+\/[A-Za-z0-9_./-]+|workers\/[a-f0-9-]+\/(?:delivery|start)\.json)$/.test(
			path,
		) ||
		path.includes("..")
	)
		throw new Error("mailbox scope denied");
	const response = await createNativeGithubTransport().request(
		0,
		`${PREFIX}contents/${path}?ref=${encodeURIComponent(branch)}`,
	);
	if (response.status === 404) return undefined;
	if (!response.ok)
		throw new Error(`GitHub mailbox read failed HTTP ${response.status}`);
	const result = ContentsFileSchema.parse(await response.json());
	return MailboxDocumentSchema.parse(
		JSON.parse(Buffer.from(result.content, "base64").toString()),
	);
}

/** Creates one immutable mailbox message; existing differing content is refused. */
export async function writeContents(
	branch: string,
	path: string,
	value: MailboxDocument,
): Promise<void> {
	const text = JSON.stringify(MailboxDocumentSchema.parse(value));
	if (Buffer.byteLength(text) > 900000)
		throw new Error("mailbox message too large");
	for (let attempt = 0; attempt < 5; attempt++) {
		const existing = await readContents(branch, path);
		if (existing !== undefined) {
			if (JSON.stringify(existing) !== text)
				throw new Error("mailbox message identity changed");
			return;
		}
		let response: Response | undefined;
		try {
			response = await createNativeGithubTransport().request(
				0,
				`${PREFIX}contents/${path}`,
				"PUT",
				JSON.stringify({
					message: "HoBo bounded runner control message",
					branch,
					content: Buffer.from(text).toString("base64"),
				}),
			);
		} catch {
			/* Reconcile this immutable file after a lost publication acknowledgement. */
		}
		if (response?.ok) return;
		if (
			response &&
			![409, 422, 429, 500, 502, 503, 504].includes(response.status)
		)
			throw new Error(`GitHub mailbox write failed HTTP ${response.status}`);
		await new Promise((resolve) => setTimeout(resolve, 300 * 2 ** attempt));
	}
	const reconciled = await readContents(branch, path);
	if (JSON.stringify(reconciled) !== text)
		throw new Error("GitHub mailbox publication outcome uncertain");
}

async function downloadNativeArtifact(artifactId: number): Promise<Uint8Array> {
	const download = await fetch(
		`https://api.github.com${PREFIX}actions/artifacts/${artifactId}/zip`,
		{
			headers: { ...HEADERS, Authorization: `Bearer ${token()}` },
			redirect: "follow",
			signal: AbortSignal.timeout(30000),
		},
	);
	if (!download.ok) throw new Error("GitHub artifact download failed");
	return new Uint8Array(await download.arrayBuffer());
}

/** Downloads one immutable run-bound public-key/status artifact and verifies its native archive digest. */
export async function readVerifiedArtifact({
	runId,
	runAttempt,
	name,
	sourceSha,
	fileName,
	role,
	workflowId,
	expectedDisplayTitle,
	client = createNativeGithubTransport(),
	downloadArchive = downloadNativeArtifact,
}: {
	runId: number;
	runAttempt: number;
	name: string;
	sourceSha: string;
	fileName: string;
	role: "controller" | "worker";
	workflowId: number;
	expectedDisplayTitle?: string;
	client?: ReturnType<typeof createNativeGithubTransport>;
	downloadArchive?: (artifactId: number) => Promise<Uint8Array>;
}): Promise<VerifiedPublicArtifact | null> {
	const runResponse = await client.request(
		0,
		`${PREFIX}actions/runs/${runId}/attempts/${runAttempt}`,
	);
	if (!runResponse.ok) throw new Error("GitHub run identity unavailable");
	const run = NativeRunSchema.parse(await runResponse.json());
	if (
		run.id !== runId ||
		run.run_attempt !== runAttempt ||
		run.head_sha !== sourceSha ||
		run.repository?.id !== 1274791462 ||
		run.event !== "workflow_dispatch" ||
		run.head_branch !== "ops/ci-runner-bootstrap-5636332" ||
		run.path !== ".github/workflows/hobo-ci-acceptance.yml" ||
		run.workflow_id !== workflowId ||
		!run.display_title?.startsWith(`hobo-bootstrap-${role}-`) ||
		(role === "controller" &&
			(!expectedDisplayTitle || run.display_title !== expectedDisplayTitle))
	)
		throw new Error("GitHub artifact run identity mismatch");
	const response = await client.request(
		0,
		`${PREFIX}actions/runs/${runId}/artifacts?per_page=100`,
	);
	if (!response.ok) throw new Error("GitHub artifact listing failed");
	const list = z
		.object({
			total_count: z.number().int().nonnegative().max(100),
			artifacts: z.array(NativeArtifactSchema.extend({ expired: z.boolean() })),
		})
		.parse(await response.json());
	const matches = list.artifacts.filter((artifact) => artifact.name === name);
	if (matches?.length === 0) return null;
	if (matches?.length !== 1) throw new Error("ambiguous GitHub artifact");
	const artifact = NativeArtifactSchema.parse(matches[0]);
	const jobsResponse = await client.request(
		0,
		`${PREFIX}actions/runs/${runId}/attempts/${runAttempt}/jobs?per_page=100`,
	);
	if (!jobsResponse.ok)
		throw new Error("GitHub artifact job identity unavailable");
	const jobs = NativeJobsSchema.parse(await jobsResponse.json()).jobs;
	const active = jobs?.filter((job) => job.name === `bootstrap-${role}`);
	const inactive = jobs?.filter(
		(job) =>
			job.name ===
			`bootstrap-${role === "controller" ? "worker" : "controller"}`,
	);
	const activeJob = active[0];
	const inactiveJob = inactive[0];
	if (
		active?.length !== 1 ||
		inactive?.length !== 1 ||
		!activeJob ||
		!inactiveJob ||
		inactiveJob.conclusion !== "skipped" ||
		(role === "controller" && activeJob.status !== "in_progress")
	)
		throw new Error("GitHub artifact role identity mismatch");
	if (
		role === "controller" &&
		(jobs.some(
			(job) =>
				job.name !== "bootstrap-controller" && job.conclusion !== "skipped",
		) ||
			!activeJob.steps.some(
				(step) =>
					step.name === "Publish controller public-key artifact" &&
					step.conclusion === "success",
			))
	)
		throw new Error("GitHub controller artifact upload is not authenticated");
	if (
		artifact.expired ||
		artifact.workflow_run?.id !== runId ||
		artifact.workflow_run?.head_sha !== sourceSha ||
		!/^sha256:[a-f0-9]{64}$/.test(artifact.digest) ||
		artifact.size_in_bytes > 1048576
	)
		throw new Error("GitHub artifact provenance invalid");
	const bytes = Buffer.from(await downloadArchive(artifact.id));
	if (
		bytes.length > 1048576 ||
		`sha256:${createHash("sha256").update(bytes).digest("hex")}` !==
			artifact.digest
	)
		throw new Error("GitHub artifact digest mismatch");
	const directory = await mkdtemp(join(tmpdir(), "hobo-ci-artifact-"));
	try {
		const archive = join(directory, "artifact.zip");
		await writeFile(archive, bytes, { mode: 0o600 });
		const listing = await exec("unzip", ["-Z1", archive], { maxBuffer: 16384 });
		if (listing.stdout.trim() !== fileName)
			throw new Error("GitHub artifact file shape mismatch");
		const content = await exec("unzip", ["-p", archive, fileName], {
			maxBuffer: 262144,
		});
		return {
			artifact,
			value: PublicArtifactSchema.parse(JSON.parse(content.stdout)),
		};
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}
