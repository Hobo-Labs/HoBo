import { execFileSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as pause } from "node:timers/promises";
import { SqliteCiStore } from "@hobo/ci/sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
	createLocalRunnerMeshNode,
	LOCAL_RUNNER_MESH_REPORT,
	type LocalRunnerJitRequest,
	runLocalRunnerSession,
} from "../src/local-runner.js";
import { parseMeshNodeReports } from "../src/mesh-records.js";

const scratch: string[] = [];
const closers: Array<() => void> = [];
afterEach(() => {
	for (const close of closers.splice(0)) close();
	for (const path of scratch.splice(0))
		rmSync(path, { recursive: true, force: true });
});

/**
 * A runner archive whose `run.sh` behaves as the official runner does around
 * one job: it waits, is given a job (a worker log appears in `_diag`), and
 * exits. Each step waits for the test to ask for it.
 */
function fixture(exitCode = 0) {
	const directory = mkdtempSync(join(tmpdir(), "hobo-local-mesh-test-"));
	scratch.push(directory);
	const source = join(directory, "source");
	const state = join(directory, "state");
	const signals = join(directory, "signals");
	for (const folder of [source, state, signals]) mkdirSync(folder);
	writeFileSync(
		join(source, "run.sh"),
		`#!/bin/sh
set -eu
: > '${signals}/waiting'
while [ ! -f '${signals}/assign' ]; do sleep 0.02; done
mkdir -p _diag
: > _diag/Worker_20261110-030000-utc.log
: > '${signals}/assigned'
while [ ! -f '${signals}/finish' ]; do sleep 0.02; done
exit ${exitCode}
`,
		{ mode: 0o755 },
	);
	const archive = join(directory, "fixture.tar.gz");
	execFileSync("tar", ["czf", archive, "-C", source, "run.sh"]);
	const api = async (
		method: "GET" | "POST" | "DELETE",
		_path: string,
		_body?: LocalRunnerJitRequest,
	) => {
		if (method === "GET") return { full_name: "owner/repo", private: true };
		if (method === "POST")
			return { runner: { id: 41 }, encoded_jit_config: "c2VjcmV0" };
		return null;
	};
	const reached = async (name: string) => {
		for (let tries = 0; tries < 500; tries += 1) {
			if (existsSync(join(signals, name))) return;
			await pause(20);
		}
		throw new Error(`the runner never reached "${name}"`);
	};
	const ask = (name: string) => writeFileSync(join(signals, name), "");
	return { state, archive, api, reached, ask, signals };
}

async function meshNode(state: string, env: Record<string, string> = {}) {
	const journal = new SqliteCiStore(join(state, "mesh-node.sqlite"));
	closers.push(() => journal.close());
	const node = await createLocalRunnerMeshNode({
		env,
		state,
		hostname: "dev box.local",
		journal,
	});
	return node;
}

const report = (state: string) =>
	parseMeshNodeReports(
		readFileSync(join(state, LOCAL_RUNNER_MESH_REPORT), "utf8"),
	);

describe("a local runner as a mesh node", () => {
	it("reports itself to disk with no mesh configured, so status works offline", async () => {
		const { state } = fixture();
		const node = await meshNode(state);
		expect(node.settings).toBeUndefined();
		await node.beat();
		const written = report(state);
		expect(written.mesh).toBe("not-configured");
		expect(written.nodes).toHaveLength(1);
		const [self] = written.nodes;
		expect(self).toMatchObject({
			// The host name, with what a node id cannot hold replaced.
			id: "local-dev-box-local",
			state: "live",
			healthy: true,
			trust: "trusted",
			totalSlots: 1,
			// No runner is waiting for a job yet.
			freeSlots: 0,
			labels: ["hobo-local-host"],
			platform: { os: process.platform, arch: process.arch },
			reliability: 1,
			delivered: 0,
			dropped: 0,
		});
		expect(self?.freeDiskMb).toBeGreaterThan(0);
		expect(self?.freeMemoryMb).toBeGreaterThan(0);
		expect(self?.publicKey).toMatch(/^[A-Za-z0-9_-]{43}$/);
		expect(written.capacity).toMatchObject({ nodes: 1, totalSlots: 1 });

		// The identity key is beside the node's journal, private to its owner,
		// and no part of it is in the report.
		const key = join(state, "mesh-node.key");
		expect(statSync(key).mode & 0o777).toBe(0o600);
		expect(statSync(join(state, LOCAL_RUNNER_MESH_REPORT)).mode & 0o777).toBe(
			0o600,
		);
		const secret = readFileSync(key, "utf8").split("\n")[1] ?? "";
		expect(secret.length).toBeGreaterThan(20);
		expect(
			readFileSync(join(state, LOCAL_RUNNER_MESH_REPORT), "utf8"),
		).not.toContain(secret);
	});

	it("names the node as told, and reports a controller that cannot run jobs as unhealthy", async () => {
		const { state } = fixture();
		const node = await meshNode(state, { HOBO_CI_MESH_NODE_ID: "laptop-1" });
		node.setHealthy(false);
		await node.beat();
		expect(report(state).nodes[0]).toMatchObject({
			id: "laptop-1",
			state: "unhealthy",
		});
	});

	it("offers its slot while a runner waits, not once a job is assigned, and counts the session", async () => {
		const f = fixture();
		const node = await meshNode(f.state);
		const slots = () => node.node.self().freeSlots;
		expect(slots()).toBe(0);
		const session = runLocalRunnerSession({
			repository: "owner/repo",
			state: f.state,
			archive: f.archive,
			api: f.api,
			env: { PATH: process.env.PATH },
			observer: node.observer,
		});
		await f.reached("waiting");
		// Registered and waiting for GitHub to assign a job: one free slot.
		expect(slots()).toBe(1);
		f.ask("assign");
		await f.reached("assigned");
		// The runner started a worker for its job: the slot is taken.
		expect(slots()).toBe(0);
		f.ask("finish");
		await session;
		expect(slots()).toBe(0);
		expect(node.node.self()).toMatchObject({
			reliability: 1,
			samples: { delivered: 1, dropped: 0 },
		});
	});

	it("counts a session whose runner failed as dropped, and keeps the count across a restart", async () => {
		const f = fixture(1);
		const first = await meshNode(f.state);
		const session = runLocalRunnerSession({
			repository: "owner/repo",
			state: f.state,
			archive: f.archive,
			api: f.api,
			env: { PATH: process.env.PATH },
			observer: first.observer,
		});
		await f.reached("waiting");
		f.ask("assign");
		f.ask("finish");
		await expect(session).rejects.toThrow();
		expect(first.node.self().samples).toEqual({ delivered: 0, dropped: 1 });
		// One drop behind four imaginary deliveries.
		expect(first.node.self().reliability).toBeCloseTo(4 / 5, 3);

		// The controller stops and starts again: same key, same record.
		for (const close of closers.splice(0)) close();
		const restarted = await meshNode(f.state);
		expect(restarted.node.publicKey).toBe(first.node.publicKey);
		expect(restarted.node.self().samples).toEqual({ delivered: 0, dropped: 1 });
		expect(restarted.node.self().reliability).toBeCloseTo(4 / 5, 3);
	});

	it("counts nothing for a session that was stopped on request", async () => {
		const f = fixture();
		const node = await meshNode(f.state);
		const stopping = new AbortController();
		const session = runLocalRunnerSession({
			repository: "owner/repo",
			state: f.state,
			archive: f.archive,
			api: f.api,
			env: { PATH: process.env.PATH },
			observer: node.observer,
			signal: stopping.signal,
		});
		await f.reached("waiting");
		stopping.abort();
		await session.catch(() => undefined);
		expect(node.node.self().samples).toEqual({ delivered: 0, dropped: 0 });
		expect(node.node.self().freeSlots).toBe(0);
	});
});
