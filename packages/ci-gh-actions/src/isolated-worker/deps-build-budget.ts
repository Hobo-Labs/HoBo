/**
 * Admission and telemetry for deps-build Docker headroom.
 */
import { z } from "zod";
import {
	depsBuildDockerReserve as computeDepsBuildDockerReserve,
	DEPS_BUILD_MEASURED_DOCKER_BYTES,
	DEPS_BUILD_MEASURED_DOCKER_INODES,
	DEPS_BUILD_VOLATILITY_BYTES,
	DEPS_BUILD_VOLATILITY_INODES,
	type DepsBuildDockerReserve,
} from "./deps-build-docker-reserve.js";

export type { DepsBuildDockerReserve } from "./deps-build-docker-reserve.js";
export {
	DEPS_BUILD_MEASURED_DOCKER_BYTES,
	DEPS_BUILD_MEASURED_DOCKER_INODES,
	DEPS_BUILD_VOLATILITY_BYTES,
	DEPS_BUILD_VOLATILITY_INODES,
};

export const DepsBuildTelemetrySchema = z
	.object({
		peakDockerInodes: z.number().int().nonnegative().optional(),
		peakDockerBytes: z.number().int().nonnegative().optional(),
		updatedAtMs: z.number().int().nonnegative().optional(),
	})
	.strict();

export type DepsBuildTelemetry = z.infer<typeof DepsBuildTelemetrySchema>;

export function depsBuildDockerReserve(
	telemetry?: DepsBuildTelemetry,
): DepsBuildDockerReserve {
	return computeDepsBuildDockerReserve(telemetry);
}
