import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { createComposedHoboCli } from "../src/index.js";

// `hobo logs` boots the offline Camp and returns the component-host event tail
// mirrored through the Streamer.

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
	const dir = await mkdtemp(path.join(tmpdir(), "hobo-logs-"));
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

describe("hobo logs", () => {
	it("tails the runtime-local Camp stream (not a stub)", async () => {
		await withProject(async (cwd) => {
			const cli = createComposedHoboCli();
			const logs = envelope(
				(await cli.run(["logs", "--json"], { cwd })).stdout,
			);

			expect(logs.code).not.toBe("HOBO_CLI_STUB");
			expect(logs.ok).toBe(true);
			expect(logs.status).toBe("tailed");
			expect(logs.data.runtime).toBe("runtime-local");
			expect(logs.data.offline).toBe(true);
			// The component host produced events, mirrored as streamed frames.
			expect(Array.isArray(logs.data.events)).toBe(true);
			expect(logs.data.events.length).toBeGreaterThan(0);
			expect(logs.data.streamedFrames).toBeGreaterThan(0);
			expect(logs.data.served.status).toBe(200);
		});
	});
});
