/* oxlint-disable no-unused-vars -- contract commit: entry-point stubs keep their final signatures until a lane implements them. */
/**
 * `@hobo/fleet/assignment` (L05): the one-active assignment register, moved
 * from `packages/backend-fleet/src/{assignment,ephemeral-replica}.ts` at
 * 62dbc5d4c with the names of §7.3, plus membership epochs and the one-active
 * loop (§6.10).
 *
 * Contract commit: the constants are final; every function body throws
 * `FleetNotImplemented`; L05 replaces them.
 */
import type { EphemeralStatePort } from "@hobo/core";
import { FleetNotImplemented } from "../errors.js";
import type { MemberName } from "../ids.js";
import type {
	AssignmentEntry,
	AssignmentOverride,
	AssignmentProposal,
	AssignmentProposalOutcome,
	AssignmentRegister,
	AssignmentReplica,
	AssignmentReply,
	AssignmentResolution,
	EphemeralAssignmentReplica,
	EphemeralAssignmentReplicaOptions,
	FailureClassifier,
	OneActiveDeps,
	OneActiveTick,
	Outcome,
	RejoinOutcome,
} from "../ports.js";

export const FIRST_ASSIGNMENT_EPOCH = 1;
export const ASSIGNMENT_ACCEPT_OUTCOMES = [
	"accepted",
	"duplicate",
	"conflict",
	"gap",
	"busy",
] as const;
export const ASSIGNMENT_LOG_MAX_ENTRIES = 32;
// public-contract: unchanged stored key
export const DEFAULT_ASSIGNMENT_LOG_KEY = "hobo:fleet:assignment";

/** Today parseFleetAssignment. */
export function parseAssignmentEntry(input: AssignmentEntry): AssignmentEntry {
	throw new FleetNotImplemented("parseAssignmentEntry");
}

/** assignment.ts:125 */
export function assignmentKey(entry: AssignmentEntry): string {
	throw new FleetNotImplemented("assignmentKey");
}

/** assignment.ts:139 */
export function fleetMajority(count: number): number {
	throw new FleetNotImplemented("fleetMajority");
}

/** `members` is who was asked; the majority is counted over decidingSet(newest entry), or over `members` for an entry without one. assignment.ts:250 */
export function resolveAssignment(
	members: readonly MemberName[],
	replies: readonly AssignmentReply[],
): AssignmentResolution {
	throw new FleetNotImplemented("resolveAssignment");
}

/** assignment.ts:295 */
export function parseAssignmentRegister(
	replicas: readonly AssignmentReplica[],
	options?: Readonly<{ classify?: FailureClassifier }>,
): AssignmentRegister {
	throw new FleetNotImplemented("parseAssignmentRegister");
}

/** assignment.ts:316 */
export function readAssignmentReplies(
	register: AssignmentRegister,
	limit?: number,
): Promise<readonly AssignmentReply[]> {
	throw new FleetNotImplemented("readAssignmentReplies");
}

/** assignment.ts:344 */
export function readCurrentAssignment(
	register: AssignmentRegister,
): Promise<AssignmentResolution> {
	throw new FleetNotImplemented("readCurrentAssignment");
}

/** assignment.ts:497 */
export function proposeAssignment(
	register: AssignmentRegister,
	proposal: AssignmentProposal,
): Promise<AssignmentProposalOutcome> {
	throw new FleetNotImplemented("proposeAssignment");
}

/** assignment.ts:528 */
export function bootstrapAssignment(
	register: AssignmentRegister,
	active: MemberName,
): Promise<AssignmentProposalOutcome> {
	throw new FleetNotImplemented("bootstrapAssignment");
}

/** assignment.ts:553 */
export function completeAssignment(
	register: AssignmentRegister,
): Promise<AssignmentResolution> {
	throw new FleetNotImplemented("completeAssignment");
}

/** assignment.ts:588 */
export function overrideAssignment(
	register: AssignmentRegister,
	override: AssignmentOverride,
): Promise<AssignmentProposalOutcome> {
	throw new FleetNotImplemented("overrideAssignment");
}

/** New. Exactly one of `pin`, `add`, `remove`. `pin` writes the sorted configured set after a decided entry that has none; `add` and `remove` change one name of the decided entry's set and refuse (`stale`) when that entry has none (§6.10 item 2). */
export function proposeMembership(
	register: AssignmentRegister,
	change: Readonly<{
		pin?: readonly MemberName[];
		add?: MemberName;
		remove?: MemberName;
		expectedEpoch: number;
		decidedBy: string;
		nowMs: number;
	}>,
): Promise<AssignmentProposalOutcome> {
	throw new FleetNotImplemented("proposeMembership");
}

/** The set that decides `entry` (§6.10 item 2), or undefined for an entry without members (decided by the configured set). */
export function decidingSet(
	entry: AssignmentEntry,
): readonly MemberName[] | undefined {
	throw new FleetNotImplemented("decidingSet");
}

/** Format 1 (today's bytes) while no entry has members; format 2 otherwise. ephemeral-replica.ts:126 */
export function encodeAssignmentLog(
	entries: readonly AssignmentEntry[],
): string {
	throw new FleetNotImplemented("encodeAssignmentLog");
}

/** Reads formats 1 and 2; refuses members under format 1. ephemeral-replica.ts:143 */
export function decodeAssignmentLog(value: string): AssignmentEntry[] {
	throw new FleetNotImplemented("decodeAssignmentLog");
}

/** ephemeral-replica.ts:183 */
export function ephemeralAssignmentReplica(
	state: EphemeralStatePort,
	id: MemberName,
	options?: EphemeralAssignmentReplicaOptions,
): EphemeralAssignmentReplica {
	throw new FleetNotImplemented("ephemeralAssignmentReplica");
}

/** ephemeral-replica.ts:263 */
export function ephemeralAssignmentRegister(
	replicas: readonly EphemeralAssignmentReplica[],
	options?: Readonly<{ classify?: FailureClassifier }>,
): AssignmentRegister &
	Readonly<{ replicas: readonly EphemeralAssignmentReplica[] }> {
	throw new FleetNotImplemented("ephemeralAssignmentRegister");
}

/** ephemeral-replica.ts:284. Takes any register; a replica without `seed` is left alone, as an answering replica with entries is today. */
export function rejoinAssignmentReplicas(
	register: AssignmentRegister,
	replies?: readonly AssignmentReply[],
): Promise<readonly RejoinOutcome[]> {
	throw new FleetNotImplemented("rejoinAssignmentReplicas");
}

export function createOneActiveFleet(deps: OneActiveDeps): Readonly<{
	active(): Promise<Outcome<MemberName>>;
	tick(): Promise<OneActiveTick>;
	activate(epoch: number): Promise<void>;
}> {
	throw new FleetNotImplemented("createOneActiveFleet");
}
