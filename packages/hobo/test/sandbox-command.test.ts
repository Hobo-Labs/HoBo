import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { CliContext, DevRuntime } from "@hobo/cli";
import { describe, expect, it } from "vitest";

import {
	createComposedHoboCli,
	createDefaultDevRuntime,
	createSandboxCommand,
} from "../src/index.js";

// `hobo sandbox` / `hobo test` run the project in a contract-backed isolated
// lane: boot a fresh offline Camp, serve the probe, assert the response
// contract, and exit pass/fail. These drive the real DevRuntime end to end.

const HELLO_BINDLE = {
	schema: "hobo.manifest/v1",
	componentHost: { kind: "wasmtime", version: "1.0.0" },
	resources: {
		service: {
			type: "component.v1",
			image: "oci://registry.example.com/hello-bindle@sha256:abc123",
			runtime: "wasm",
			exports: ["wasi:http/incoming-handler"],
			bind: ["sessions"],
		},
		sessions: { type: "data.v1", port: "kv" },
	},
};

async function withProject(
	callback: (cwd: string) => Promise<void>,
): Promise<void> {
	const dir = await mkdtemp(path.join(tmpdir(), "hobo-sandbox-"));
	await writeFile(
		path.join(dir, "hobo.bindle.json"),
		`${JSON.stringify(HELLO_BINDLE, null, 2)}\n`,
	);
	try {
		await callback(dir);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

// biome-ignore lint/suspicious/noExplicitAny: test-only envelope reader.
function envelope(stdout: string): any {
	return JSON.parse(stdout);
}

describe("hobo sandbox / test (contract-backed isolated lane)", () => {
	it("passes the response contract on the offline hello-bindle", async () => {
		await withProject(async (cwd) => {
			const cli = createComposedHoboCli();
			const sandbox = envelope(
				(await cli.run(["sandbox", "--json"], { cwd })).stdout,
			);
			expect(sandbox.code).not.toBe("HOBO_CLI_STUB");
			expect(sandbox.ok).toBe(true);
			expect(sandbox.status).toBe("passed");
			expect(sandbox.data.isolated).toBe(true);
			expect(sandbox.data.offline).toBe(true);
			expect(sandbox.data.served.status).toBe(200);
			// Every declared contract check passed.
			for (const check of sandbox.data.checks) {
				expect(check.ok).toBe(true);
			}
			expect(
				sandbox.data.checks.map((c: { name: string }) => c.name).sort(),
			).toEqual(["cold-budget", "http-status-200", "non-empty-body"]);
		});
	});

	it("`test` is an alias for the same sandbox lane", async () => {
		await withProject(async (cwd) => {
			const cli = createComposedHoboCli();
			const test = envelope(
				(await cli.run(["test", "--json"], { cwd })).stdout,
			);
			expect(test.status).toBe("passed");
			expect(test.data.command).toBe("sandbox");
		});
	});

	it("isolation: each run boots a fresh Camp (independent event logs)", async () => {
		await withProject(async (cwd) => {
			const cli = createComposedHoboCli();
			const a = envelope(
				(await cli.run(["sandbox", "--json"], { cwd })).stdout,
			);
			const b = envelope(
				(await cli.run(["sandbox", "--json"], { cwd })).stdout,
			);
			// Both pass independently; a fresh runtime each time means neither
			// accumulates the other's served state.
			expect(a.status).toBe("passed");
			expect(b.status).toBe("passed");
			expect(a.data.served.body).toBe(b.data.served.body);
		});
	});

	it("fails the contract when the isolated runtime serves a non-200", async () => {
		// A degraded runtime whose component handler serves HTTP 500 — the sandbox
		// must catch it as a failed contract check (not a passing run).
		function degradedRuntime(): DevRuntime {
			const base = createDefaultDevRuntime();
			const exports = Object.fromEntries(
				Object.keys(base.plan.component.exports).map((iface) => [
					iface,
					{ handle: async () => ({ status: 500, headers: [], body: "" }) },
				]),
			);
			// SAFETY: assertion required at this I/O or test boundary.
			return {
				...base,
				plan: {
					...base.plan,
					component: { ...base.plan.component, exports },
				},
			} as DevRuntime;
		}

		const command = createSandboxCommand({ runtimeFactory: degradedRuntime });
		const result = await command.run({
			// SAFETY: assertion required at this I/O or test boundary.
			context: { cwd: "/tmp", projectDir: "/tmp" } as CliContext,
			// SAFETY: assertion required at this I/O or test boundary.
			flags: { cwd: "/tmp" } as never,
			args: [],
			verb: "sandbox",
			emitProgress: () => {},
		});

		expect(result.ok).toBe(false);
		expect(result.status).toBe("failed");
		expect(result.code).toBe("HOBO_SANDBOX_FAILED");
		// SAFETY: assertion required at this I/O or test boundary.
		const checks = (result.data as { checks: { name: string; ok: boolean }[] })
			.checks;
		expect(checks.find((c) => c.name === "http-status-200")?.ok).toBe(false);
		expect(result.remediation?.some((r) => r.includes("http-status-200"))).toBe(
			true,
		);
	});
});
