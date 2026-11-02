import { describe, expect, it } from "vitest";
import { dockerSocketMountCreateArgs } from "../src/isolated-worker/cli-docker-driver.js";

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
