import { describe, expect, it } from "vitest";
import {
	DEPS_BUILD_MEASURED_DOCKER_INODES,
	DEPS_BUILD_VOLATILITY_INODES,
	depsBuildDockerReserve,
} from "../src/isolated-worker/deps-build-budget.js";

describe("deps build budget", () => {
	it("applies volatility on measured peaks", () => {
		const reserve = depsBuildDockerReserve();
		expect(reserve.dockerDataRoot).toBe(
			Math.ceil(
				DEPS_BUILD_MEASURED_DOCKER_INODES * DEPS_BUILD_VOLATILITY_INODES,
			),
		);
	});

	it("raises the reserve when telemetry reports a higher peak", () => {
		const reserve = depsBuildDockerReserve({ peakDockerInodes: 250_000 });
		expect(reserve.dockerDataRoot).toBe(
			Math.ceil(250_000 * DEPS_BUILD_VOLATILITY_INODES),
		);
	});
});
