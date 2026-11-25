import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { CliContext } from "@hobo/cli";
import { createBoundaryContract } from "@hobo/contracts";
import { describe, expect, it } from "vitest";

import { createCanDeployCommand } from "../src/index.js";

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
	writeManifest = true,
): Promise<void> {
	const dir = await mkdtemp(path.join(tmpdir(), "hobo-cando-"));
	if (writeManifest) {
		await writeFile(
			path.join(dir, "hobo.bindle.json"),
			`${JSON.stringify(HELLO_BINDLE, null, 2)}\n`,
		);
	}
	try {
		await callback(dir);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

function runInput(cwd: string) {
	return {
		context: { cwd, projectDir: cwd } as CliContext,
		flags: { cwd } as never,
		args: [] as readonly string[],
		verb: "can-deploy",
		emitProgress: () => {},
	};
}

const CHANNEL = "orders.http";
const deployed = createBoundaryContract({
	id: "orders",
	version: "1.0.0",
	edge: {
		kind: "event",
		producer: "orders-api@1.0.0",
		consumer: "worker@1.0.0",
		channel: CHANNEL,
		operation: "order.created",
	},
	["requiredShape"]: {
		format: "json-schema",
		requiredFields: ["id", "tenantId"],
		providedFields: ["id", "tenantId"],
	},
});
const breakingCandidate = createBoundaryContract({
	id: "orders",
	version: "2.0.0",
	edge: {
		kind: "event",
		producer: "orders-api@2.0.0",
		consumer: "worker@1.0.0",
		channel: CHANNEL,
		operation: "order.created",
	},
	["requiredShape"]: {
		format: "json-schema",
		requiredFields: ["id"],
		providedFields: ["id"],
	},
});

describe("createCanDeployCommand", () => {
	it("is compatible by construction when no contracts are declared", async () => {
		await withProject(async (cwd) => {
			const result = await createCanDeployCommand().run(runInput(cwd));
			expect(result.code).not.toBe("HOBO_CLI_STUB");
			expect(result.ok).toBe(true);
			expect(result.status).toBe("compatible");
			expect(result.data).toMatchObject({ compatible: true });
		});
	});

	it("introducing a new channel (no prior consumer) is compatible", async () => {
		await withProject(async (cwd) => {
			const result = await createCanDeployCommand({
				candidateContracts: [deployed],
			}).run(runInput(cwd));
			expect(result.ok).toBe(true);
			expect(result.status).toBe("compatible");
		});
	});

	it("detects a breaking producer change against the deployed contract", async () => {
		await withProject(async (cwd) => {
			const result = await createCanDeployCommand({
				deployedContracts: [deployed],
				candidateContracts: [breakingCandidate],
			}).run(runInput(cwd));

			expect(result.ok).toBe(false);
			expect(result.status).toBe("breaking");
			expect(result.code).toBe("HOBO_CANNOT_DEPLOY");
			expect(
				(result.data as { reasons: unknown[] }).reasons.length,
			).toBeGreaterThan(0);
			expect(Array.isArray(result.remediation)).toBe(true);
		});
	});

	it("errors when there is no Bindle", async () => {
		await withProject(async (cwd) => {
			const result = await createCanDeployCommand().run(runInput(cwd));
			expect(result.ok).toBe(false);
			expect(result.code).toBe("HOBO_NO_BINDLE");
		}, false);
	});
});
