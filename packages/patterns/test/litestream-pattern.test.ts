import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { expect, it } from "vitest";
import { loadPatternCatalog, renderPattern } from "../src/index.js";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const runner = resolve(packageRoot, "test/fixtures/litestream-runner.mjs");

function withPattern(run: (root: string, source: string) => void): void {
	const root = mkdtempSync(join(tmpdir(), "hobo-litestream-pattern-"));
	try {
		const catalog = loadPatternCatalog();
		const pattern = catalog.patterns.find(
			(candidate) => candidate.id === "storage.litestream",
		);
		if (!pattern) throw new Error("Litestream pattern missing");
		const file = renderPattern({
			catalog,
			pattern,
			params: { name: "corpus-db" },
		}).files[0];
		if (!file) throw new Error("Litestream source missing");
		const source = join(root, "storage.ts");
		writeFileSync(join(root, "package.json"), '{"type":"module"}\n');
		writeFileSync(source, file.contents);
		run(root, source);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

it("renders a typed SQLite store with explicit replication and restore commands", () => {
	withPattern((root, source) => {
		execFileSync(resolve(packageRoot, "../../node_modules/.bin/tsc"), [
			"--noEmit",
			"--ignoreConfig",
			"--skipLibCheck",
			"--module",
			"NodeNext",
			"--moduleResolution",
			"NodeNext",
			"--target",
			"ES2022",
			"--typeRoots",
			resolve(packageRoot, "../../node_modules/@types"),
			"--types",
			"node",
			source,
		]);
		const executable = join(root, "litestream");
		const log = join(root, "calls");
		writeFileSync(
			executable,
			`#!/usr/bin/env node\nimport { appendFileSync, readFileSync, statSync } from 'node:fs'; import { dirname } from 'node:path'; const args = process.argv.slice(2); const index = args.indexOf('-config') + 1; const configPath = args[index]; const config = JSON.parse(readFileSync(configPath)); const mode = statSync(configPath).mode & 0o777; const directoryMode = statSync(dirname(configPath)).mode & 0o777; args[index] = '<config>'; appendFileSync(process.env.CALL_LOG, JSON.stringify({ args, config, mode, directoryMode, configPath }) + '\\n'); if (args[0] === 'restore') process.exit(42);\n`,
		);
		chmodSync(executable, 0o700);
		const database = join(root, "corpus.db");
		const replica = pathToFileURL(join(root, "replica")).href;
		const result = execFileSync(
			process.execPath,
			[
				"--experimental-strip-types",
				runner,
				source,
				database,
				replica,
				executable,
				"contract",
				log,
			],
			{
				encoding: "utf8",
				env: {
					...process.env,
					HOBO_HOME: join(root, "home"),
					HOBO_LITESTREAM_REPLICA: undefined,
					CALL_LOG: log,
				},
			},
		);
		const calls = JSON.parse(result);
		expect(calls.map(({ args }: { args: string[] }) => args)).toEqual([
			["replicate", "-config", "<config>"],
			["replicate", "-once", "-config", "<config>"],
			["replicate", "-once", "-config", "<config>"],
			["restore", "-config", "<config>", "-o", database, database],
		]);
		expect(calls.map(({ config }: { config: unknown }) => config)).toEqual([
			{ dbs: [{ path: database, replica: { url: replica } }] },
			{ dbs: [{ path: database, replica: { url: replica } }] },
			{
				dbs: [
					{
						path: database,
						replica: {
							url: "nats://localhost:4222/bucket",
							creds: "/tmp/nats.creds",
						},
					},
				],
			},
			{ dbs: [{ path: database, replica: { url: replica } }] },
		]);
		expect(
			calls.every(
				({ mode, directoryMode }: { mode: number; directoryMode: number }) =>
					mode === 0o600 && directoryMode === 0o700,
			),
		).toBe(true);
	});
});

const litestream = process.env.HOBO_LITESTREAM_BIN;
const natsReplica = process.env.HOBO_NATS_REPLICA_URL;

for (const target of ["file", "nats"] as const) {
	it.runIf(Boolean(litestream && (target === "file" || natsReplica)))(
		`replicates and restores SQLite changes through ${target}`,
		() =>
			withPattern((root, source) => {
				const database = join(root, "corpus.db");
				const replica = target === "file" ? "default" : natsReplica;
				if (!replica || !litestream)
					throw new Error("live replica configuration missing");
				const output = execFileSync(
					process.execPath,
					[
						"--experimental-strip-types",
						runner,
						source,
						database,
						replica,
						litestream,
						"live",
					],
					{
						encoding: "utf8",
						timeout: 70000,
						env: {
							...process.env,
							HOBO_HOME: join(root, "home"),
							HOBO_LITESTREAM_REPLICA: undefined,
						},
					},
				);
				expect(output).toBe("replicated and restored");
			}),
		75000,
	);
}
