/**
 * Service installers (L10). Signature frozen by the fleet contract commit (ADR-0182).
 */
import { FleetNotImplemented, type Outcome } from "@hobo/fleet";

/** Installs `hobo fleet run` as a systemd unit, launchd agent or Windows service. */
export function installService(
	platform: NodeJS.Platform,
	argv: readonly string[],
): Promise<Outcome<string>> {
	void platform;
	void argv;
	throw new FleetNotImplemented("installService");
}
