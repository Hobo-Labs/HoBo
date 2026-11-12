import type { Lease } from "@hobo/ci";
import { describe, expect, it, vi } from "vitest";
import type { GithubTransport } from "../src/github.js";
import * as githubModule from "../src/github.js";
import {
	leaseHasLiveContainer,
	resolveGithubLeaseFate,
} from "../src/isolated-worker/github-lease-terminal.js";

// SAFETY: resolveGithubLeaseFate only reads install/repo/run/job identity fields.
const lease = {
	installationId: 10,
	repository: "Org/Repo",
	originalRunId: 430_37573989,
	runAttempt: 1,
	jobId: 130_580_539_807,
	actualJobId: 0,
	runnerName: "hobo-reserved",
} as Lease;

describe("github lease terminal fate", () => {
	it("treats a completed workflow run as terminal", async () => {
		vi.spyOn(githubModule, "getRun").mockResolvedValue({
			id: lease.originalRunId,
			run_attempt: 1,
			event: "pull_request",
			head_sha: "abc",
			head_branch: "cursor/test",
			path: ".github/workflows/ci.yml",
			display_title: "test",
			status: "completed",
			conclusion: "cancelled",
			updated_at: "2026-11-11T14:00:00Z",
			actor: { id: 1 },
			repository: { id: 101, private: true },
			head_repository: { id: 101 },
		});
		vi.spyOn(githubModule, "getJob").mockResolvedValue({
			id: lease.jobId,
			run_id: lease.originalRunId,
			status: "completed",
			labels: ["hobo"],
			runner_name: lease.runnerName,
			run_attempt: 1,
		});
		// SAFETY: getRun/getJob are mocked; the transport surface is never invoked.
		const fate = await resolveGithubLeaseFate({} as GithubTransport, lease);
		expect(fate).toEqual({ kind: "terminal", reason: "run-cancelled" });
	});

	it("keeps an in-progress run active", async () => {
		vi.spyOn(githubModule, "getRun").mockResolvedValue({
			id: lease.originalRunId,
			run_attempt: 1,
			event: "pull_request",
			head_sha: "abc",
			head_branch: "cursor/test",
			path: ".github/workflows/ci.yml",
			display_title: "test",
			status: "in_progress",
			conclusion: null,
			updated_at: "2026-11-11T14:00:00Z",
			actor: { id: 1 },
			repository: { id: 101, private: true },
			head_repository: { id: 101 },
		});
		vi.spyOn(githubModule, "getJob").mockResolvedValue({
			id: lease.jobId,
			run_id: lease.originalRunId,
			status: "queued",
			labels: ["hobo"],
			runner_name: lease.runnerName,
			run_attempt: 1,
		});
		// SAFETY: getRun/getJob are mocked; the transport surface is never invoked.
		const fate = await resolveGithubLeaseFate({} as GithubTransport, lease);
		expect(fate).toEqual({ kind: "active" });
	});

	it("detects live worker containers", () => {
		expect(leaseHasLiveContainer(undefined)).toBe(false);
		expect(leaseHasLiveContainer({ state: "exited" })).toBe(false);
		expect(leaseHasLiveContainer({ state: "running" })).toBe(true);
	});
});
