/**
 * Measured peak Docker data-root consumption during a keyed deps build (finding 71).
 * Admission and build-deps.sh share these budgets instead of a fixed 400k free-inode gate.
 */
import { z } from "zod";

export const DEPS_BUILD_MEASURED_DOCKER_INODES = 175_000;
export const DEPS_BUILD_MEASURED_DOCKER_BYTES = 22 * 1024 * 1024 * 1024;
/** Volatility margin applied on top of measured (or telemetry) peaks. */
export const DEPS_BUILD_VOLATILITY_INODES = 1.2;
export const DEPS_BUILD_VOLATILITY_BYTES = 1.1;

export const DepsBuildTelemetrySchema = z
	.object({
		peakDockerInodes: z.number().int().nonnegative().optional(),
		peakDockerBytes: z.number().int().nonnegative().optional(),
		updatedAtMs: z.number().int().nonnegative().optional(),
	})
	.strict();

export type DepsBuildTelemetry = z.infer<typeof DepsBuildTelemetrySchema>;

export type DepsBuildDockerReserve = Readonly<{
	dockerDataRoot: number;
	dockerDataRootBytes: number;
}>;

export function depsBuildDockerReserve(
	telemetry?: DepsBuildTelemetry,
): DepsBuildDockerReserve {
	const measuredInodes = Math.max(
		DEPS_BUILD_MEASURED_DOCKER_INODES,
		telemetry?.peakDockerInodes ?? 0,
	);
	const measuredBytes = Math.max(
		DEPS_BUILD_MEASURED_DOCKER_BYTES,
		telemetry?.peakDockerBytes ?? 0,
	);
	return {
		dockerDataRoot: Math.ceil(measuredInodes * DEPS_BUILD_VOLATILITY_INODES),
		dockerDataRootBytes: Math.ceil(measuredBytes * DEPS_BUILD_VOLATILITY_BYTES),
	} satisfies DepsBuildDockerReserve;
}
