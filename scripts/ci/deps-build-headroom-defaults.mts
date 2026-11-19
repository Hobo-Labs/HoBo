import { depsBuildDockerReserve } from "../../packages/ci-gh-actions/src/isolated-worker/deps-build-docker-reserve.js";

const reserve = depsBuildDockerReserve();
process.stdout.write(
	`${reserve.dockerDataRoot} ${reserve.dockerDataRootBytes}\n`,
);
