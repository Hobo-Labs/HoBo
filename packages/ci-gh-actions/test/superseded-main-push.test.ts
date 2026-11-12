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
			status: "in_progress",
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

it("never starves the running main push for a newer one still waiting its turn", () => {
	// Main pushes queue on one concurrency group: the newer run stays queued
	// until the running one finishes, so it must not mark that one superseded.
	const superseded = supersededMainFabricPushRunIds([
		{
			id: 300,
			event: "push",
			head_branch: "main",
			path: fabric,
			status: "in_progress",
			run_started_at: "2026-11-11T22:00:00Z",
		},
		{
			id: 301,
			event: "push",
			head_branch: "main",
			path: fabric,
			status: "queued",
			run_started_at: "2026-11-11T22:05:00Z",
		},
	]);
	expect(superseded.size).toBe(0);
});

it("still drops a queued older run once a newer one has started", () => {
	const superseded = supersededMainFabricPushRunIds([
		{
			id: 400,
			event: "push",
			head_branch: "main",
			path: fabric,
			status: "queued",
			run_started_at: "2026-11-11T22:00:00Z",
		},
		{
			id: 401,
			event: "push",
			head_branch: "main",
			path: fabric,
			status: "in_progress",
			run_started_at: "2026-11-11T22:05:00Z",
		},
	]);
	expect([...superseded]).toEqual([400]);
});

it("hints prewarm at the started main push, not a newer one still waiting", () => {
	const newest = newestMainFabricPushRunId([
		{
			id: 500,
			event: "push",
			head_branch: "main",
			path: fabric,
			status: "in_progress",
			run_started_at: "2026-11-11T22:00:00Z",
		},
		{
			id: 501,
			event: "push",
			head_branch: "main",
			path: fabric,
			status: "queued",
			run_started_at: "2026-11-11T22:05:00Z",
		},
	]);
	expect(newest).toBe(500);
});
