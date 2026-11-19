import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInMemoryActorHost, defineAggregate } from "@hobo/data";
import { expect, it, vi } from "vitest";
import { createComposedHoboCli } from "../src/cli.js";
import { createDefaultYardRuntime } from "../src/compose.js";

it("surfaces real quarantine incidents and resumes the operator report", async () => {
	const directory = mkdtempSync(join(tmpdir(), "hobo-quarantine-diagnostics-"));
	writeFileSync(join(directory, "hobo.bindle.json"), "{}\n");
	const runtime = createDefaultYardRuntime({
		dataDir: join(directory, "events"),
		env: {},
	});
	const { store } = runtime;
	vi.stubEnv("HOBO_HOME", directory);
	vi.stubEnv("HOBO_TENANT", "workspace");
	const context = {
		actor: { kind: "user", id: "operator" } as const,
		tenant: "workspace",
	};
	try {
		await store.append(
			"items",
			Array.from({ length: 101 }, () => ({ type: "item.Invalid", data: {} })),
			{ ...context, expectedSeq: 0 },
		);
		const aggregate = defineAggregate<number, "noop">({
			name: "items",
			initialState: 0,
			evolve() {
				throw new Error("bad item");
			},
			decide() {},
		});
		await aggregate.execute(
			{ store, actorHost: createInMemoryActorHost() },
			"items",
			"noop",
			context,
		);
		const shell = createComposedHoboCli({ yardRuntime: runtime });
		const doctor = await shell.run(["doctor", "--json"], { cwd: directory });
		const doctorEnvelope = JSON.parse(doctor.stdout);
		expect(doctor.exitCode).toBe(0);
		expect(doctorEnvelope.data.quarantine.available).toBe(true);
		expect(doctorEnvelope.data.quarantine.report.findings).toHaveLength(100);
		expect(doctorEnvelope.data.quarantine.report.complete).toBe(false);
		expect(doctorEnvelope.remediation).toEqual(
			expect.arrayContaining([
				expect.stringContaining("Investigate quarantined events"),
				expect.stringContaining("Continue quarantine inspection"),
			]),
		);
		const position = doctorEnvelope.data.quarantine.report.nextPosition;
		const inspect = await shell.run(
			["inspect", "quarantines", position, "--json"],
			{ cwd: directory },
		);
		const inspected = JSON.parse(inspect.stdout);
		expect(inspect.exitCode).toBe(0);
		expect(inspected.data.report.complete).toBe(true);
		expect(inspected.data.report.findings).toHaveLength(1);
		expect(inspected.data.report.findings[0]).toMatchObject({
			sourceStreamId: "items",
			offendingSeq: "101",
			fold: "items",
			reason: "bad item",
			severity: "incident",
		});
		const badPosition = await shell.run(["inspect", "quarantines", "invalid"], {
			cwd: directory,
		});
		expect(badPosition.exitCode).toBe(2);
	} finally {
		if ("close" in store && store.close instanceof Function) store.close();
		vi.unstubAllEnvs();
		rmSync(directory, { recursive: true, force: true });
	}
});
