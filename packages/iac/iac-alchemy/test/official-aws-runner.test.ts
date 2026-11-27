import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, posix } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import {
	dockerBindSource,
	emulatorScratchParent,
	HOST_VISIBLE_JOB_MOUNT,
} from "./official-aws-docker-path.mts";

it("keeps emulator scratch on a path the host Docker daemon can mount", () => {
	expect(emulatorScratchParent({}, "/tmp")).toBe("/tmp");
	expect(
		emulatorScratchParent({ HOBO_CI_HOST_JOB_DIRECTORY: "" }, "/tmp"),
	).toBe("/tmp");
	expect(
		emulatorScratchParent({ HOBO_CI_HOST_JOB_DIRECTORY: "/host/job" }, "/tmp"),
	).toBe(HOST_VISIBLE_JOB_MOUNT);
	const executable = posix.join(
		HOST_VISIBLE_JOB_MOUNT,
		"hobo-official-aws-x/package/opt/aws-emulator/bin/aws-emulator",
	);
	expect(dockerBindSource(executable, {})).toBe(executable);
	expect(
		dockerBindSource(executable, { HOBO_CI_HOST_JOB_DIRECTORY: "/host/job" }),
	).toBe(
		"/host/job/hobo-official-aws-x/package/opt/aws-emulator/bin/aws-emulator",
	);
	expect(() =>
		dockerBindSource("/tmp/hobo-official-aws-x/aws-emulator", {
			HOBO_CI_HOST_JOB_DIRECTORY: "/host/job",
		}),
	).toThrow(/outside the host-visible job directory/u);
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
						HOBO_CI_HOST_JOB_DIRECTORY: "",
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
