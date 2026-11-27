import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, posix } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import {
	dockerBindSource,
	emulatorBindCandidates,
	emulatorRunArgs,
	emulatorScratchParent,
	HOST_VISIBLE_JOB_MOUNT,
	isMissingBindSource,
	mountSourceFor,
} from "./official-aws-docker-path.mts";

it("keeps emulator scratch on a path the host Docker daemon can mount", () => {
	expect(emulatorScratchParent({}, "/tmp")).toBe("/tmp");
	expect(
		emulatorScratchParent({ HOBO_CI_HOST_JOB_DIRECTORY: "" }, "/tmp"),
	).toBe("/tmp");
	expect(emulatorScratchParent({ RUNNER_TEMP: "/runner/tmp" }, "/tmp")).toBe(
		"/runner/tmp",
	);
	expect(
		emulatorScratchParent(
			{
				HOBO_CI_HOST_JOB_DIRECTORY: "/host/job",
				RUNNER_TEMP: "/runner/tmp",
			},
			"/tmp",
		),
	).toBe(HOST_VISIBLE_JOB_MOUNT);
	expect(emulatorBindCandidates({}, "/tmp")).toEqual([
		"/home/runner/_work",
		"/opt/actions-runner/_work",
		"/tmp",
	]);
	expect(
		emulatorBindCandidates(
			{
				RUNNER_TEMP: "/runner/tmp",
				GITHUB_WORKSPACE: "/work/HoBo/HoBo",
			},
			"/tmp",
		),
	).toEqual([
		"/runner/tmp",
		"/home/runner/_work",
		"/opt/actions-runner/_work",
		"/work/HoBo/HoBo",
		"/tmp",
	]);
	expect(
		emulatorBindCandidates(
			{
				HOBO_CI_HOST_JOB_DIRECTORY: "/host/job",
				GITHUB_WORKSPACE: "/work/HoBo/HoBo",
			},
			"/tmp",
		),
	).toEqual([HOST_VISIBLE_JOB_MOUNT]);
	const executable = posix.join(
		HOST_VISIBLE_JOB_MOUNT,
		"hobo-official-aws-x/package/opt/aws-emulator/bin/aws-emulator",
	);
	expect(dockerBindSource(executable, {})).toBe(executable);
	expect(mountSourceFor(executable, {})).toBe(executable);
	expect(
		dockerBindSource(executable, { HOBO_CI_HOST_JOB_DIRECTORY: "/host/job" }),
	).toBe(
		"/host/job/hobo-official-aws-x/package/opt/aws-emulator/bin/aws-emulator",
	);
	expect(
		mountSourceFor("/tmp/hobo-official-aws-x/aws-emulator", {
			HOBO_CI_HOST_JOB_DIRECTORY: "/host/job",
		}),
	).toBeUndefined();
	expect(() =>
		dockerBindSource("/tmp/hobo-official-aws-x/aws-emulator", {
			HOBO_CI_HOST_JOB_DIRECTORY: "/host/job",
		}),
	).toThrow(/outside the host-visible job directory/u);
	const bind = emulatorRunArgs({
		name: "hobo-aws-test",
		image: "debian@sha256:abc",
		bindSource: executable,
	});
	expect(bind).toContain(
		`type=bind,src=${executable},dst=/usr/local/bin/aws-emulator,readonly`,
	);
	const copied = emulatorRunArgs({
		name: "hobo-aws-test",
		image: "hobo-aws-emulator:private",
	});
	expect(copied.join("\n")).not.toContain("type=bind");
	expect(copied).toContain("hobo-aws-emulator:private");
	expect(copied).toContain("/usr/local/bin/aws-emulator");
	expect(
		isMissingBindSource(
			'invalid mount config for type "bind": bind source path does not exist: /tmp/aws-emulator',
		),
	).toBe(true);
	expect(isMissingBindSource("AWS emulator package digest mismatch")).toBe(
		false,
	);
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
						RUNNER_TEMP: "",
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
