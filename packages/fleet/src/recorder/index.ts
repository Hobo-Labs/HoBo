/**
 * The recorder and the registry projection (L31): bus envelopes into
 * `fleet-work-*` and `fleet-session-*` events, work status and logs,
 * reliability, and the signed registry and views. Re-exported by
 * `@hobo/fleet/membership`. These two are the only emitters of the four
 * fleet usage types (D40).
 */
import type {
	ReliabilitySamples,
	WorkLogs,
	WorkStatus,
} from "../_generated/fleet_pb.js";
import type { MemberId } from "../ids.js";
import type { AuthorityDeps, Outcome } from "../ports.js";
import { projection } from "./projection.js";
import { recorder } from "./recorder.js";

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
	return recorder(deps);
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
	return projection(deps);
}
