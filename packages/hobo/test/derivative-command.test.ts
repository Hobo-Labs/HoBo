import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { HoboCli } from "@hobo/cli";
import type { RuntimeLocalEventStore } from "@hobo/runtime-local";
import { expect, it } from "vitest";
import {
	createComposedHoboCli,
	createDefaultYardRuntime,
} from "../src/index.js";

async function withCli(
	callback: (cwd: string, cli: HoboCli) => Promise<void>,
): Promise<void> {
	const cwd = await mkdtemp(path.join(tmpdir(), "hobo-derivative-"));
	const runtime = createDefaultYardRuntime();
	try {
		await callback(cwd, createComposedHoboCli({ yardRuntime: runtime }));
	} finally {
		(runtime.store as RuntimeLocalEventStore).close();
		await rm(cwd, { recursive: true, force: true });
	}
}

it("reads the current descriptor through the composed CLI", async () => {
	await withCli(async (cwd, cli) => {
		const descriptor = { name: "acme-hobo", version: "0.1.0" };
		const file = path.join(cwd, "derivative.json");
		await writeFile(file, JSON.stringify(descriptor));
		const schema = fileURLToPath(
			new URL("../data-models/composition.cue", import.meta.url),
		);
		const checked = spawnSync(
			"cue",
			["vet", schema, file, "-d", "#DerivativeDescriptor"],
			{
				encoding: "utf8",
			},
		);
		expect(checked.status, checked.stderr).toBe(0);
		for (const args of [["derivative"], ["derivative", "read"]]) {
			const result = await cli.run([...args, "--json"], { cwd });
			expect(JSON.parse(result.stdout)).toMatchObject({
				ok: true,
				data: { subcommand: "read", descriptor },
			});
		}
	});
});

it("reports missing or invalid descriptor fields", async () => {
	await withCli(async (cwd, cli) => {
		const file = path.join(cwd, "derivative.json");
		const schema = fileURLToPath(
			new URL("../data-models/composition.cue", import.meta.url),
		);
		const missing = await cli.run(["derivative", "--json"], { cwd });
		expect(JSON.parse(missing.stdout)).toMatchObject({
			ok: false,
			code: "HOBO_DERIVATIVE_NO_DESCRIPTOR",
		});
		for (const descriptor of [
			null,
			{ name: " ", version: "0.1.0" },
			{ name: "acme", version: "" },
			{ name: "acme", version: "0.1.0", unexpected: true },
		]) {
			await writeFile(file, JSON.stringify(descriptor));
			expect(
				spawnSync("cue", ["vet", schema, file, "-d", "#DerivativeDescriptor"])
					.status,
			).not.toBe(0);
			const result = await cli.run(["derivative", "read", "--json"], { cwd });
			expect(JSON.parse(result.stdout)).toMatchObject({
				ok: false,
				code: "HOBO_DERIVATIVE_NO_DESCRIPTOR",
			});
		}
	});
});

it("rejects unsupported derivative subcommands", async () => {
	await withCli(async (cwd, cli) => {
		const result = await cli.run(["derivative", "change", "--json"], { cwd });
		expect(JSON.parse(result.stdout)).toMatchObject({
			ok: false,
			code: "HOBO_DERIVATIVE_USAGE",
		});
	});
});
