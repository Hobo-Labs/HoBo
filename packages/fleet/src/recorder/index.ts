/* oxlint-disable no-unused-vars -- contract commit: entry-point stubs keep their final signatures until a lane implements them. */
/**
 * The recorder and the registry projection (L31): bus envelopes into
 * `fleet-work-*` events, work status and logs, reliability, and the signed
 * registry and views. Re-exported by `@hobo/fleet/membership`.
 *
 * Contract commit: every body throws `FleetNotImplemented`; L31 replaces them.
 */
import type {
	ReliabilitySamples,
	WorkLogs,
	WorkStatus,
} from "../_generated/fleet_pb.js";
import { FleetNotImplemented } from "../errors.js";
import type { MemberId } from "../ids.js";
import type { AuthorityDeps, Outcome } from "../ports.js";

export function createRecorder(
	deps: Pick<
		AuthorityDeps,
		"tenant" | "store" | "bus" | "metering" | "now" | "log"
	>,
): Readonly<{
	start(): void;
	stop(): Promise<void>;
	workStatus(submissionId: string): Promise<Outcome<WorkStatus>>;
	workLogs(submissionId: string): Promise<Outcome<WorkLogs>>;
	reliability(): ReadonlyMap<MemberId, ReliabilitySamples>;
}> {
	throw new FleetNotImplemented("createRecorder");
}

export function createRegistryProjection(
	deps: Pick<
		AuthorityDeps,
		| "tenant"
		| "store"
		| "bus"
		| "recordSigner"
		| "incarnation"
		| "metering"
		| "now"
		| "log"
	> &
		Readonly<{ reliability(): ReadonlyMap<MemberId, ReliabilitySamples> }>,
): Readonly<{ tick(): Promise<void>; caughtUp(): Promise<void> }> {
	throw new FleetNotImplemented("createRegistryProjection");
}
