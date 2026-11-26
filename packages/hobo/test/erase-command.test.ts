import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { CliContext } from "@hobo/cli";
import { first } from "@hobo/core/total-access";
import type { RuntimeLocalEventStore } from "@hobo/runtime-local";
import { afterEach, describe, expect, it } from "vitest";
import {
	createComposedHoboCli,
	createDefaultYardRuntime,
	createEraseCommand,
} from "../src/index.js";
import { isJsonString } from "../src/json.js";

// `hobo erase <subject>` appends a crypto-shred erasure request (HOBO-295) —
// history is never rewritten — and projections redact the subject on rebuild.
// The key test proves the observable effect: `hobo attest` masks the erased
// subject in its OCSF credential chain after erase, while the deployment stands.

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
	const dir = await mkdtemp(path.join(tmpdir(), "hobo-erase-"));
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

// Collect every svidSubject that appears in an attest export's credential chains.
// biome-ignore lint/suspicious/noExplicitAny: test-only shape.
function subjectsIn(attest: any): string[] {
	const subjects: string[] = [];
	for (const batch of attest.data.batches) {
		for (const record of batch.records) {
			const s = record.hobo.credential_chain.svidSubject;
			if (isJsonString(s)) subjects.push(s);
		}
	}
	return subjects;
}

describe("createEraseCommand", () => {
	it("redacts an erased subject from the attest evidence, history intact", async () => {
		await withProject(async (cwd) => {
			const runtime = createDefaultYardRuntime();
			// SAFETY: assertion required at this I/O or test boundary.
			openStores.push(runtime.store as RuntimeLocalEventStore);
			const cli = createComposedHoboCli({ yardRuntime: runtime });

			await cli.run(["up", "--json"], { cwd });

			// The deploy actor (svidSubject) appears in the pre-erase evidence.
			const before = envelope(
				(await cli.run(["attest", "--json"], { cwd })).stdout,
			);
			const subjects = subjectsIn(before);
			expect(subjects.length).toBeGreaterThan(0);
			const subject = first(subjects);
			expect(subject.startsWith("[erased:")).toBe(false);

			// Erase that subject.
			const erase = envelope(
				(await cli.run(["erase", subject, "--json"], { cwd })).stdout,
			);
			expect(erase.code).not.toBe("HOBO_CLI_STUB");
			expect(erase.ok).toBe(true);
			expect(erase.status).toBe("erasure_requested");
			// History was not rewritten — the deployment still stands.
			expect(erase.data.deploymentStatus).toBe("deployed");
			expect(erase.data.historyPreserved).toBe(true);

			// After erase, the subject is redacted in the rebuilt evidence.
			const after = envelope(
				(await cli.run(["attest", "--json"], { cwd })).stdout,
			);
			const afterSubjects = subjectsIn(after);
			expect(afterSubjects).not.toContain(subject);
			expect(afterSubjects.every((s) => s.startsWith("[erased:"))).toBe(true);
			// Same record count — nothing deleted, only redacted.
			expect(after.data.records).toBe(before.data.records);
		});
	});

	it("is idempotent when the subject is already erased", async () => {
		await withProject(async (cwd) => {
			const runtime = createDefaultYardRuntime();
			// SAFETY: assertion required at this I/O or test boundary.
			openStores.push(runtime.store as RuntimeLocalEventStore);
			const cli = createComposedHoboCli({ yardRuntime: runtime });
			await cli.run(["up", "--json"], { cwd });

			await cli.run(["erase", "subject-x", "--json"], { cwd });
			const again = envelope(
				(await cli.run(["erase", "subject-x", "--json"], { cwd })).stdout,
			);
			expect(again.ok).toBe(true);
			expect(again.status).toBe("already_erased");
		});
	});

	it("requires a subject argument", async () => {
		await withProject(async (cwd) => {
			const runtime = createDefaultYardRuntime();
			// SAFETY: assertion required at this I/O or test boundary.
			openStores.push(runtime.store as RuntimeLocalEventStore);
			const cli = createComposedHoboCli({ yardRuntime: runtime });
			await cli.run(["up", "--json"], { cwd });

			const erase = envelope(
				(await cli.run(["erase", "--json"], { cwd })).stdout,
			);
			expect(erase.ok).toBe(false);
			expect(erase.code).toBe("HOBO_ERASE_NO_SUBJECT");
		});
	});

	it("reports unavailable when no runtime is wired", async () => {
		const result = await createEraseCommand().run({
			// SAFETY: assertion required at this I/O or test boundary.
			context: { cwd: "/tmp", projectDir: "/tmp" } as CliContext,
			// SAFETY: assertion required at this I/O or test boundary.
			flags: { cwd: "/tmp", target: null } as never,
			args: ["subject-x"],
			verb: "erase",
			emitProgress: () => {},
		});
		expect(result.ok).toBe(false);
		expect(result.code).toBe("HOBO_NO_RUNTIME");
	});
});
