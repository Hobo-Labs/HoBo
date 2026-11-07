import {
	chmod,
	mkdir,
	mkdtemp,
	readFile,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
	createLakebedAnonymousCliTransport,
	LAKEBED_CLI_VERSION,
	provisionTemporaryEnvironmentStation,
} from "../src/temporary-station.js";

describe("Lakebed anonymous child process", () => {
	it("refuses bound capsules and symlink sources before launching any provider process", async () => {
		const folder = await mkdtemp(
			path.join(tmpdir(), "hobo-lakebed-ownership-test-"),
		);
		try {
			const bound = path.join(folder, "bound");
			await mkdir(bound);
			await writeFile(
				path.join(bound, "lakebed.json"),
				JSON.stringify({ deployId: "existing-claimed-project" }),
			);
			const transport = createLakebedAnonymousCliTransport();
			await expect(
				transport.deployAnonymous({ stationId: "test", capsuleDir: bound }),
			).rejects.toThrow("existing ownership metadata");
			const linked = path.join(folder, "linked");
			await mkdir(linked);
			await symlink(
				path.join(bound, "lakebed.json"),
				path.join(linked, "server.ts"),
			);
			await expect(
				transport.deployAnonymous({ stationId: "test", capsuleDir: linked }),
			).rejects.toThrow("symlinks");
		} finally {
			await rm(folder, { recursive: true, force: true });
		}
	});
	it("pins the CLI and isolates ambient account credentials without changing the parent", async () => {
		const folder = await mkdtemp(
			path.join(tmpdir(), "hobo-lakebed-process-test-"),
		);
		const originalPath = process.env.PATH;
		const originalToken = process.env.LAKEBED_TOKEN;
		const originalHome = process.env.HOME;
		const capture = path.join(folder, "captured.json");
		try {
			await writeFile(
				path.join(folder, "npx"),
				`#!/usr/bin/env node
const fs=require('node:fs');
fs.writeFileSync(${JSON.stringify(capture)},JSON.stringify({argv:process.argv.slice(2),home:process.env.HOME,token:process.env.LAKEBED_TOKEN,config:process.env.XDG_CONFIG_HOME}));
console.log(JSON.stringify({deployId:'actual-process',url:'https://actual-process.lakebed.app',claimUrl:'https://api.lakebed.dev/claim/actual-process/provider-issued',expiresAt:'2030-01-01T00:00:00.000Z'},null,2));
`,
			);
			await chmod(path.join(folder, "npx"), 0o700);
			process.env.PATH = `${folder}${path.delimiter}${originalPath}`;
			process.env.LAKEBED_TOKEN = "ambient-account-must-not-be-used";
			const receipt = await provisionTemporaryEnvironmentStation({
				stationId: "actual-process",
				clock: () => Date.parse("2029-12-31T23:00:00Z"),
			});
			const captured = JSON.parse(await readFile(capture, "utf8"));
			expect(captured.argv).toEqual([
				"--yes",
				`lakebed@${LAKEBED_CLI_VERSION}`,
				"deploy",
				"--json",
			]);
			expect(captured.token).toBeUndefined();
			expect(captured.home).not.toBe(originalHome);
			expect(captured.config).toBe(path.join(captured.home, "config"));
			expect(process.env.HOME).toBe(originalHome);
			expect(process.env.LAKEBED_TOKEN).toBe(
				"ambient-account-must-not-be-used",
			);
			expect(receipt.expiresAt).toBe("2030-01-01T00:00:00.000Z");
			expect(receipt.ttlSeconds).toBe(3600);
			await expect(
				readFile(path.join(captured.home, ".lakebed")),
			).rejects.toThrow();
		} finally {
			if (originalPath === undefined) delete process.env.PATH;
			else process.env.PATH = originalPath;
			if (originalToken === undefined) delete process.env.LAKEBED_TOKEN;
			else process.env.LAKEBED_TOKEN = originalToken;
			await rm(folder, { recursive: true, force: true });
		}
	});
});
