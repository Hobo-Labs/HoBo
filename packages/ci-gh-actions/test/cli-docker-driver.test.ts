import { describe, expect, it } from "vitest";
import {
	builderPruneArgs,
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
