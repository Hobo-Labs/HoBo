import { spawnSync } from "node:child_process";
import {
	chmodSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const script = fileURLToPath(
	new URL("./ensure-integration-built.mts", import.meta.url),
);

it.skipIf(process.platform === "win32")(
	"builds integration prerequisites outside Turbo and propagates failures",
	() => {
		const directory = mkdtempSync(join(tmpdir(), "hobo-alchemy-pretest-"));
		const binary = join(directory, "pnpm");
		const calls = join(directory, "calls.json");
		try {
			writeFileSync(
				binary,
				'#!/usr/bin/env node\nrequire("node:fs").writeFileSync(process.env.HOBO_TEST_CALLS, JSON.stringify(process.argv.slice(2)));\nprocess.exit(Number(process.env.HOBO_TEST_EXIT));\n',
			);
			chmodSync(binary, 0o755);
			const env = {
				...process.env,
				PATH: `${directory}${delimiter}${process.env.PATH ?? ""}`,
				TURBO_HASH: "",
				HOBO_TEST_CALLS: calls,
				HOBO_TEST_EXIT: "17",
			};
			const result = spawnSync(
				process.execPath,
				["--experimental-strip-types", script],
				{ env },
			);
			expect(result.status).toBe(17);
			const args: string[] = JSON.parse(readFileSync(calls, "utf8"));
			expect(args.slice(0, 3)).toEqual(["exec", "turbo", "run"]);
			expect(args).toContain("build");
			expect(args).toContain("--filter=@hobo/broker");
			expect(args).toContain("--filter=@hobo/dispatcher");
			expect(args).toContain("--filter=@hobo/pricing");
			rmSync(calls);
			const underTurbo = spawnSync(
				process.execPath,
				["--experimental-strip-types", script],
				{
					env: { ...env, TURBO_HASH: "already-scheduled" },
				},
			);
			expect(underTurbo.status).toBe(0);
			expect(() => readFileSync(calls)).toThrow();
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	},
);
