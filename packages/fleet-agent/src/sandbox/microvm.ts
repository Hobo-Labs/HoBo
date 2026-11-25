import { spawnSync } from "node:child_process";
import type { FleetLog, SandboxDriver } from "@hobo/fleet";
import { SandboxTier } from "@hobo/fleet";

export type MicroVmRuntime = Readonly<{
	binary: string;
	assumption: "A11" | "A12";
}>;

// public-contract: the runtimes the S3 drivers look for, by platform.
export const KATA_RUNTIME: MicroVmRuntime = {
	binary: "containerd-shim-kata-v2",
	assumption: "A11",
};
// public-contract: Apple's container tool on macOS 26.
export const APPLE_CONTAINER_RUNTIME: MicroVmRuntime = {
	binary: "container",
	assumption: "A12",
};

function present(binary: string): boolean {
	const found = spawnSync("sh", ["-c", 'command -v "$1"', "sh", binary], {
		stdio: "ignore",
	});
	return found.status === 0;
}

export function createMicroVmSandboxDriver(
	runtime: MicroVmRuntime,
	log: FleetLog,
): SandboxDriver {
	return {
		tier: SandboxTier.S3_MICROVM,
		async available() {
			const message = present(runtime.binary)
				? `${runtime.binary} is present, but this agent has no control and egress path into a microVM yet (${runtime.assumption} not tested; fallback taken)`
				: `${runtime.binary} is not installed (${runtime.assumption} not tested; fallback taken)`;
			log("hobo_fleet_sandbox_unavailable", {
				tier: "S3_MICROVM",
				runtime: runtime.binary,
				reason: message,
			});
			return { ok: false, error: { code: "sandbox-inadequate", message } };
		},
		async create() {
			throw new Error(
				`the S3 driver over ${runtime.binary} is not available on this device`,
			);
		},
	};
}
