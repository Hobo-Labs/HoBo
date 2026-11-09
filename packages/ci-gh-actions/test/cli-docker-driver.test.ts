import {
	chmodSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	builderPruneArgs,
	createCliDockerDriver,
	dockerSocketMountCreateArgs,
} from "../src/isolated-worker/cli-docker-driver.js";

describe("cli docker driver socket mount", () => {
	it("adds the socket bind mount and matching --group-add for the socket gid", () => {
		const args = dockerSocketMountCreateArgs({}, () => ({ gid: 998 }));
		expect(args).toEqual([
			"-v",
			"/var/run/docker.sock:/var/run/docker.sock",
			"--group-add",
			"998",
		]);
	});

	it("omits socket flags when HOBO_CI_MOUNT_DOCKER_SOCKET=0", () => {
		expect(
			dockerSocketMountCreateArgs({ HOBO_CI_MOUNT_DOCKER_SOCKET: "0" }),
		).toEqual([]);
	});
});

describe("cli docker driver builder prune", () => {
	it("enforces the storage cap without an age exemption", () => {
		expect(builderPruneArgs("4GB")).toEqual([
			"builder",
			"prune",
			"--force",
			"--keep-storage",
			"4GB",
		]);
	});

	it("rejects invalid cap arguments", () => {
		expect(() => builderPruneArgs("4GB --filter until=24h")).toThrow(
			"invalid builder keep-storage",
		);
	});
});

describe("cli docker container inventory", () => {
	it("lists and strictly parses worker containers by label", async () => {
		const dir = mkdtempSync(join(tmpdir(), "fake-docker-ps-"));
		try {
			const bin = join(dir, "docker");
			const log = join(dir, "args");
			writeFileSync(
				bin,
				`#!/bin/sh\nprintf '%s' "$*" > "${log}"\nprintf '%s\\n' '{"ID":"${"a".repeat(64)}","Names":"hobo-running","State":"running"}' '{"ID":"${"b".repeat(64)}","Names":"hobo-exited","State":"exited"}'\n`,
			);
			chmodSync(bin, 0o755);
			const driver = createCliDockerDriver({ binary: bin, env: {} });

			await expect(driver.list?.("hobo.ci/isolated=1")).resolves.toEqual([
				{
					name: "hobo-running",
					containerId: "a".repeat(64),
					state: "running",
				},
				{
					name: "hobo-exited",
					containerId: "b".repeat(64),
					state: "exited",
				},
			]);
			expect(readFileSync(log, "utf8")).toBe(
				"ps -a --no-trunc --filter label=hobo.ci/isolated=1 --format json",
			);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("rejects malformed container inventory instead of guessing", async () => {
		const dir = mkdtempSync(join(tmpdir(), "fake-docker-ps-invalid-"));
		try {
			const bin = join(dir, "docker");
			writeFileSync(
				bin,
				`#!/bin/sh\nprintf '%s\\n' '{"ID":"short","Names":"hobo-running","State":"running"}'\n`,
			);
			chmodSync(bin, 0o755);
			const driver = createCliDockerDriver({ binary: bin, env: {} });
			await expect(driver.list?.("hobo.ci/isolated=1")).rejects.toThrow();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("counts running containers that mount the pnpm store", async () => {
		const dir = mkdtempSync(join(tmpdir(), "fake-docker-volume-"));
		try {
			const bin = join(dir, "docker");
			const log = join(dir, "args");
			writeFileSync(
				bin,
				`#!/bin/sh\nprintf '%s' "$*" > "${log}"\nprintf '%s\\n' abc def\n`,
			);
			chmodSync(bin, 0o755);
			const driver = createCliDockerDriver({ binary: bin, env: {} });

			await expect(
				driver.containersUsingVolume("/srv/pnpm-store"),
			).resolves.toBe(2);
			expect(readFileSync(log, "utf8")).toBe(
				"ps -q --filter volume=/srv/pnpm-store",
			);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("cli docker memory peaks", () => {
	async function measure(script: string): Promise<number | undefined> {
		const dir = mkdtempSync(join(tmpdir(), "fake-docker-memory-peak-"));
		try {
			const bin = join(dir, "docker");
			writeFileSync(bin, script);
			chmodSync(bin, 0o755);
			const driver = createCliDockerDriver({ binary: bin, env: {} });
			return await driver.memoryPeak?.("hobo-job", "container-1");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	}

	it("parses cgroup v2 bytes and rounds up to MiB", async () => {
		await expect(
			measure(
				"#!/bin/sh\nif [ \"$4\" = /sys/fs/cgroup/memory.peak ]; then printf '2147483649\\n'; exit 0; fi\nexit 1\n",
			),
		).resolves.toBe(2_049);
	});

	it("falls back to the cgroup v1 peak", async () => {
		await expect(
			measure(
				'#!/bin/sh\nif [ "$4" = /sys/fs/cgroup/memory.peak ]; then exit 1; fi\nif [ "$4" = /sys/fs/cgroup/memory/memory.max_usage_in_bytes ]; then printf \'1073741824\\n\'; exit 0; fi\nexit 1\n',
			),
		).resolves.toBe(1_024);
	});

	it("returns undefined for non-numeric output", async () => {
		await expect(
			measure("#!/bin/sh\nprintf 'not-a-number\\n'\n"),
		).resolves.toBeUndefined();
	});
});
