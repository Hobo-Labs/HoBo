/**
 * Sandbox drivers (L38). Signature frozen by the fleet contract commit (ADR-0182).
 */
import {
	type FleetLog,
	FleetNotImplemented,
	type SandboxDriver,
	type SandboxTier,
} from "@hobo/fleet";

/** The drivers whose self-test passed, up to `cap`. */
export function sandboxDrivers(
	options: Readonly<{ cap?: SandboxTier; log: FleetLog }>,
): Promise<readonly SandboxDriver[]> {
	void options;
	throw new FleetNotImplemented("sandboxDrivers");
}
