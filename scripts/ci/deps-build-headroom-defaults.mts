/**
 * Emits measured deps-build Docker headroom floors for `build-deps.sh`.
 * Single source: `depsBuildDockerReserve` in `@hobo/ci-gh-actions`.
 */
import { depsBuildDockerReserve } from "../../packages/ci-gh-actions/src/isolated-worker/deps-build-docker-reserve.js";

const reserve = depsBuildDockerReserve();
process.stdout.write(
	`${reserve.dockerDataRoot} ${reserve.dockerDataRootBytes}\n`,
);
