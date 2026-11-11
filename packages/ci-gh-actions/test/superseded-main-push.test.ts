import { expect, it } from "vitest";
import {
	newestMainFabricPushRunId,
	supersededMainFabricPushRunIds,
} from "../src/isolated-worker/github-job-poller.js";

const fabric = ".github/workflows/hobo-ci.yml";

it("names the newest in-flight main Fabric push", () => {
	const newest = newestMainFabricPushRunId([
		{
			id: 100,
			event: "push",
			head_branch: "main",
			path: fabric,
			status: "in_progress",
			run_started_at: "2026-11-11T03:50:00Z",
		},
		{
			id: 101,
			event: "push",
			head_branch: "main",
			path: fabric,
			status: "queued",
			run_started_at: "2026-11-11T03:55:00Z",
		},
	]);
	expect(newest).toBe(101);
});

it("marks older in-flight main Fabric pushes as superseded", () => {
	const superseded = supersededMainFabricPushRunIds([
		{
			id: 100,
			event: "push",
			head_branch: "main",
			path: fabric,
			status: "in_progress",
			run_started_at: "2026-11-11T03:50:00Z",
		},
		{
			id: 101,
			event: "push",
			head_branch: "main",
			path: fabric,
			status: "in_progress",
			run_started_at: "2026-11-11T03:55:00Z",
		},
	]);
	expect([...superseded]).toEqual([100]);
});

it("ignores pull requests and other workflows", () => {
	const superseded = supersededMainFabricPushRunIds([
		{
			id: 200,
			event: "pull_request",
			head_branch: "main",
			path: fabric,
			status: "in_progress",
			run_started_at: "2026-11-11T03:50:00Z",
		},
		{
			id: 201,
			event: "push",
			head_branch: "main",
			path: fabric,
			status: "in_progress",
			run_started_at: "2026-11-11T03:55:00Z",
		},
	]);
	expect(superseded.size).toBe(0);
});
