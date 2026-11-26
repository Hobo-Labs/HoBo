/**
 * The kubectl read probes (`version`, `cluster-info`) are bounded.
 *
 * A probe answers "is this cluster reachable?". With no kubeconfig,
 * `kubectl cluster-info` retries discovery against localhost:8080 for longer
 * than a caller may wait, so a probe that does not return has to come back as
 * 503 within `probeTimeoutMs`, not after the write paths' 120 s limit.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createProcessKubectlTransport } from "../src/kubectl-transport.js";

const dirs: string[] = [];

afterEach(() => {
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});

/** A stand-in `kubectl` script in its own folder; returns its path. */
function stubKubectl(lines: readonly string[]): string {
	const dir = mkdtempSync(join(tmpdir(), "hobo-kubectl-probe-"));
	dirs.push(dir);
	const bin = join(dir, "kubectl");
	writeFileSync(bin, ["#!/usr/bin/env node", ...lines].join("\n"), {
		mode: 0o755,
	});
	return bin;
}

describe("kubectl read probes", () => {
	it("answer 503 within the probe bound when kubectl does not return", async () => {
		const transport = createProcessKubectlTransport({
			kubectlBin: stubKubectl(["setTimeout(() => {}, 60_000);"]),
			env: { PATH: process.env.PATH ?? "" },
			probeTimeoutMs: 500,
		});
		const started = Date.now();
		const cluster = await transport.handle({
			method: "GET",
			path: "/kubectl/cluster-info",
		});
		const version = await transport.handle({
			method: "GET",
			path: "/kubectl/version",
		});
		expect(cluster.status).toBe(503);
		expect(cluster.body).toMatchObject({ ok: false, reachable: false });
		expect(version.status).toBe(503);
		expect(Date.now() - started).toBeLessThan(5_000);
	});

	it("bound the cluster-info API request as well as the process", async () => {
		const dir = mkdtempSync(join(tmpdir(), "hobo-kubectl-argv-"));
		dirs.push(dir);
		const log = join(dir, "argv.json");
		const transport = createProcessKubectlTransport({
			kubectlBin: stubKubectl([
				`require("node:fs").writeFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)));`,
			]),
			env: { PATH: process.env.PATH ?? "" },
		});
		const response = await transport.handle({
			method: "GET",
			path: "/kubectl/cluster-info",
		});
		expect(response.status).toBe(200);
		expect(JSON.parse(readFileSync(log, "utf8"))).toEqual([
			"cluster-info",
			"--request-timeout=2s",
		]);
	});
});
