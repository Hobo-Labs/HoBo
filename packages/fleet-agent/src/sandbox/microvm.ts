/**
 * `S3_MICROVM` drivers (design §6.11): a Kata Containers runtime class on
 * Linux with KVM, Apple's `container` tool on macOS 26.
 *
 * Neither runtime is provisioned where this lane is verified (§11.2 step 8),
 * so assumptions A11 and A12 are untested and their fallbacks are taken
 * (§13): a device advertises only the tiers whose self-test passes, and a
 * macOS device provides no `S3`. These drivers therefore run a self-test that
 * looks for the runtime and then fails closed, naming the missing piece: the
 * control endpoint and the egress relay reach an OCI sandbox through its
 * network namespace's loopback (`oci-driver.ts`), which a virtual machine
 * does not share, and the vsock path that would replace it is not built. A
 * later change that builds and tests it lifts the fallback.
 */
import { spawnSync } from "node:child_process";
import type { FleetLog, SandboxDriver } from "@hobo/fleet";
import { SandboxTier } from "@hobo/fleet";

export type MicroVmRuntime = Readonly<{
	/** The binary whose presence the self-test checks first. */
	binary: string;
	/** The assumption whose fallback this driver takes. */
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
