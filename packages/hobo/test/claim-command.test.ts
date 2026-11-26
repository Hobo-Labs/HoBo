import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { CliContext } from "@hobo/cli";
import type { RuntimeLocalEventStore } from "@hobo/runtime-local";
import { afterEach, describe, expect, it } from "vitest";

import {
	createClaimCommand,
	createComposedHoboCli,
	createDefaultYardRuntime,
} from "../src/index.js";

// `hobo claim` binds an anonymous deployment to an account by appending a
// `deployment.Claimed` fact — rebinding ownership on the authoritative log while
// carrying every provisioned fact forward. These deploy for real, then claim the
// SAME runtime and assert the rebind + state preservation.

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

let openStores: RuntimeLocalEventStore[] = [];
afterEach(() => {
	for (const store of openStores) store.close();
	openStores = [];
});

async function withProject(
	callback: (cwd: string) => Promise<void>,
): Promise<void> {
	const dir = await mkdtemp(path.join(tmpdir(), "hobo-claim-"));
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

describe("createClaimCommand", () => {
	it("binds an anonymous deployment to an account, preserving state", async () => {
		await withProject(async (cwd) => {
			const runtime = createDefaultYardRuntime();
			// SAFETY: assertion required at this I/O or test boundary.
			openStores.push(runtime.store as RuntimeLocalEventStore);
			const cli = createComposedHoboCli({ yardRuntime: runtime });

			const up = envelope((await cli.run(["up", "--json"], { cwd })).stdout);
			expect(up.status).toBe("deployed");

			const claim = envelope(
				(await cli.run(["claim", "acme", "--json"], { cwd })).stdout,
			);
			expect(claim.code).not.toBe("HOBO_CLI_STUB");
			expect(claim.ok).toBe(true);
			expect(claim.status).toBe("claimed");
			expect(claim.data.owner).toEqual({ kind: "user", id: "acme" });
			// The rebind preserves every provisioned fact: still deployed, same 2 resources.
			expect(claim.data.deploymentStatus).toBe("deployed");
			expect(Object.keys(claim.data.resources).sort()).toEqual([
				"service",
				"sessions",
			]);

			// inspect now reflects the new owner (folded from the same log).
			const inspect = envelope(
				(await cli.run(["inspect", "--json"], { cwd })).stdout,
			);
			expect(inspect.status).toBe("deployed");
		});
	});

	it("is idempotent when the deployment is already owned by the account", async () => {
		await withProject(async (cwd) => {
			const runtime = createDefaultYardRuntime();
			// SAFETY: assertion required at this I/O or test boundary.
			openStores.push(runtime.store as RuntimeLocalEventStore);
			const cli = createComposedHoboCli({ yardRuntime: runtime });
			await cli.run(["up", "--json"], { cwd });

			await cli.run(["claim", "acme", "--json"], { cwd });
			const again = envelope(
				(await cli.run(["claim", "acme", "--json"], { cwd })).stdout,
			);
			expect(again.ok).toBe(true);
			expect(again.status).toBe("already_claimed");
		});
	});

	it("requires an account argument", async () => {
		await withProject(async (cwd) => {
			const runtime = createDefaultYardRuntime();
			// SAFETY: assertion required at this I/O or test boundary.
			openStores.push(runtime.store as RuntimeLocalEventStore);
			const cli = createComposedHoboCli({ yardRuntime: runtime });
			await cli.run(["up", "--json"], { cwd });

			const claim = envelope(
				(await cli.run(["claim", "--json"], { cwd })).stdout,
			);
			expect(claim.ok).toBe(false);
			expect(claim.code).toBe("HOBO_CLAIM_NO_ACCOUNT");
		});
	});

	it("reports no deployment when nothing has been deployed", async () => {
		await withProject(async (cwd) => {
			const runtime = createDefaultYardRuntime();
			// SAFETY: assertion required at this I/O or test boundary.
			openStores.push(runtime.store as RuntimeLocalEventStore);
			const cli = createComposedHoboCli({ yardRuntime: runtime });

			const claim = envelope(
				(await cli.run(["claim", "acme", "--json"], { cwd })).stdout,
			);
			expect(claim.ok).toBe(false);
			expect(claim.code).toBe("HOBO_CLAIM_NO_DEPLOYMENT");
		});
	});

	it("reports unavailable when no runtime is wired", async () => {
		const result = await createClaimCommand().run({
			// SAFETY: assertion required at this I/O or test boundary.
			context: { cwd: "/tmp", projectDir: "/tmp" } as CliContext,
			// SAFETY: assertion required at this I/O or test boundary.
			flags: { cwd: "/tmp", to: null } as never,
			args: ["acme"],
			verb: "claim",
			emitProgress: () => {},
		});
		expect(result.ok).toBe(false);
		expect(result.code).toBe("HOBO_NO_RUNTIME");
	});
});
