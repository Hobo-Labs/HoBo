import assert from "node:assert/strict";
import { test } from "node:test";
import type { z } from "zod";
import type {
	NativeArtifactSchema,
	NativeJobsSchema,
	NativeRunSchema,
} from "./artifact-contracts.mts";
import {
	createNativeGithubTransport,
	readVerifiedArtifact,
} from "./github-io.mts";

type NativeRun = z.infer<typeof NativeRunSchema>;
type NativeJobs = z.infer<typeof NativeJobsSchema>;
type NativeArtifact = z.infer<typeof NativeArtifactSchema>;

test("repository transport rejects foreign resources and encoded traversal before authentication", async () => {
	const client = createNativeGithubTransport();
	for (const path of [
		"/user",
		"/repos/another/repository/actions/runs",
		"/repos/Hobo-Labs/HoBo/contents/%2f..%2fuser",
		"/repos/Hobo-Labs/HoBo/contents/%5C..%5Cuser",
	])
		await assert.rejects(client.request(0, path), /scope denied|origin denied/);
});
const sourceSha = "a".repeat(40);
const expectedDisplayTitle = "hobo-bootstrap-controller-fixture";
const input = {
	runId: 101,
	runAttempt: 1,
	name: "hobo-controller-ready-101-1",
	sourceSha,
	fileName: "controller.json",
	role: "controller",
	workflowId: 99,
	expectedDisplayTitle,
} satisfies Parameters<typeof readVerifiedArtifact>[0];

function fixture() {
	const run: NativeRun = {
		id: 101,
		run_attempt: 1,
		head_sha: sourceSha,
		workflow_id: 99,
		head_branch: "ops/ci-runner-bootstrap-5636332",
		path: ".github/workflows/hobo-ci-acceptance.yml",
		display_title: expectedDisplayTitle,
		event: "workflow_dispatch",
		repository: { id: 1274791462 },
	};
	const controllerJob: NativeJobs["jobs"][number] = {
		name: "bootstrap-controller",
		status: "in_progress",
		conclusion: null,
		steps: [
			{
				name: "Publish controller public-key artifact",
				conclusion: "success",
			},
		],
	};
	const workerJob: NativeJobs["jobs"][number] = {
		name: "bootstrap-worker",
		status: "completed",
		conclusion: "skipped",
		steps: [],
	};
	const artifact: NativeArtifact = {
		id: 7,
		name: input.name,
		expired: false,
		digest: `sha256:${"b".repeat(64)}`,
		size_in_bytes: 24,
		workflow_run: { id: run.id, head_sha: sourceSha },
	};
	const requests: string[] = [];
	const downloads: number[] = [];
	const client: ReturnType<typeof createNativeGithubTransport> = {
		async request(_installationId, path) {
			requests.push(path);
			if (path.endsWith("/attempts/1")) return Response.json(run);
			if (path.endsWith("/artifacts?per_page=100"))
				return Response.json({ total_count: 1, artifacts: [artifact] });
			if (path.endsWith("/attempts/1/jobs?per_page=100"))
				return Response.json({ jobs: [controllerJob, workerJob] });
			throw new Error("unexpected artifact fixture request");
		},
	};
	const downloadArchive = async (artifactId: number): Promise<Uint8Array> => {
		downloads.push(artifactId);
		return Buffer.from("tampered artifact archive");
	};
	return {
		run,
		controllerJob,
		workerJob,
		artifact,
		requests,
		downloads,
		read: () => readVerifiedArtifact({ ...input, client, downloadArchive }),
	};
}

test("worker-run artifacts cannot become App-key controller recipients", async () => {
	const f = fixture();
	f.run.display_title = "hobo-bootstrap-worker-fixture";
	await assert.rejects(f.read(), /run identity mismatch/);
	assert.equal(f.requests.length, 1);
	assert.deepEqual(f.downloads, []);
});

test("native job roles must authenticate the controller artifact producer", async () => {
	const f = fixture();
	f.controllerJob.status = "completed";
	f.controllerJob.conclusion = "skipped";
	f.workerJob.status = "in_progress";
	f.workerJob.conclusion = null;
	await assert.rejects(f.read(), /role identity mismatch/);
	assert.deepEqual(f.downloads, []);
});

test("a completed controller cannot receive a new sealed App key", async () => {
	const f = fixture();
	f.controllerJob.status = "completed";
	f.controllerJob.conclusion = "success";
	await assert.rejects(f.read(), /role identity mismatch/);
	assert.deepEqual(f.downloads, []);
});

test("an authenticated controller still requires the native archive digest", async () => {
	const f = fixture();
	await assert.rejects(f.read(), /digest mismatch/);
	assert.deepEqual(f.downloads, [f.artifact.id]);
	assert.equal(f.requests.length, 3);
});
