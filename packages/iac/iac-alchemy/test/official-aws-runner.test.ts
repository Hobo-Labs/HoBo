import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import {
	awsEmulatorRunArgs,
	prepareAwsEmulatorImage,
} from "./aws-emulator-container.mts";

it("stages the verified emulator for a Docker daemon without the runner's filesystem", () => {
	const directory = mkdtempSync(join(tmpdir(), "hobo-aws-context-test-"));
	try {
		const executable = join(directory, "verified-emulator");
		writeFileSync(executable, "fixture executable");
		const context = prepareAwsEmulatorImage(
			directory,
			executable,
			"base@sha256:abc",
		);
		expect(readFileSync(join(context, "aws-emulator"), "utf8")).toBe(
			"fixture executable",
		);
		expect(readFileSync(join(context, "Dockerfile"), "utf8")).toBe(
			"FROM base@sha256:abc\nCOPY --chmod=0755 aws-emulator /usr/local/bin/aws-emulator\n",
		);
		const args = awsEmulatorRunArgs("hobo-aws-test-fixture");
		expect(args).not.toContain("--mount");
		expect(args).toContain("--read-only");
		expect(args).toContain("--cap-drop");
		expect(args).toContain("ALL");
		expect(args).toContain("no-new-privileges");
		expect(args).toContain("/root:rw,noexec,nosuid,size=128m");
		expect(args).toContain("/tmp:rw,noexec,nosuid,size=128m");
		expect(args).toContain("127.0.0.1::9297");
		expect(args).toContain("hobo-aws-test-fixture");
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

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
