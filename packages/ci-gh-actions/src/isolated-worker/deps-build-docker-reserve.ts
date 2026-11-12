/**
 * Measured peak Docker data-root consumption during a keyed deps build (finding 71).
 * Zod-free so pre-install bash/CI paths can import without node_modules.
 */
export const DEPS_BUILD_MEASURED_DOCKER_INODES = 175_000;
export const DEPS_BUILD_MEASURED_DOCKER_BYTES = 22 * 1024 * 1024 * 1024;
/** Volatility margin applied on top of measured (or telemetry) peaks. */
export const DEPS_BUILD_VOLATILITY_INODES = 1.2;
export const DEPS_BUILD_VOLATILITY_BYTES = 1.1;

export type DepsBuildDockerReserveInput = Readonly<{
	peakDockerInodes?: number | undefined;
	peakDockerBytes?: number | undefined;
}>;

export type DepsBuildDockerReserve = Readonly<{
	dockerDataRoot: number;
	dockerDataRootBytes: number;
}>;

export function depsBuildDockerReserve(
	telemetry?: DepsBuildDockerReserveInput,
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
