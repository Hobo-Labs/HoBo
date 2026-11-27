import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it.skipIf(process.platform !== "linux" || process.arch !== "x64")(
	"rejects an unverified emulator package before invoking Docker",
	() => {
		const directory = mkdtempSync(join(tmpdir(), "hobo-aws-runner-test-"));
		try {
			const archive = join(directory, "invalid.deb");
			const marker = join(directory, "docker-called");
			writeFileSync(archive, "not the pinned package");
			writeFileSync(
				join(directory, "docker"),
				'#!/bin/sh\n: > "$HOBO_TEST_DOCKER_MARKER"\nexit 98\n',
				{ mode: 0o700 },
			);
			const result = spawnSync(
				process.execPath,
				[
					"--experimental-strip-types",
					fileURLToPath(
						new URL("./run-official-aws-emulator.mts", import.meta.url),
					),
				],
				{
					encoding: "utf8",
					env: {
						...process.env,
						PATH: [directory, process.env.PATH ?? ""].join(delimiter),
						HOBO_AWS_EMULATOR_PACKAGE: archive,
						HOBO_TEST_DOCKER_MARKER: marker,
					},
					timeout: 30_000,
				},
			);
			expect(result.status).not.toBe(0);
			expect(result.stderr).toContain("AWS emulator package digest mismatch");
			expect(existsSync(marker)).toBe(false);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	},
);
