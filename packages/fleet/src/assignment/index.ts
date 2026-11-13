/**
 * `@hobo/fleet/assignment` (L05): the one-active assignment register, moved
 * from `packages/backend-fleet/src/{assignment,ephemeral-replica}.ts` at
 * 62dbc5d4c with the names of §7.3, plus membership epochs and the one-active
 * loop (§6.10). Exactly the entry points of §7.3; everything else in this
 * directory is private.
 */
export { decodeAssignmentLog, encodeAssignmentLog } from "./log.js";
export { createOneActiveFleet } from "./one-active.js";
export {
	ASSIGNMENT_ACCEPT_OUTCOMES,
	assignmentKey,
	bootstrapAssignment,
	completeAssignment,
	decidingSet,
	FIRST_ASSIGNMENT_EPOCH,
	fleetMajority,
	overrideAssignment,
	parseAssignmentEntry,
	parseAssignmentRegister,
	proposeAssignment,
	proposeMembership,
	readAssignmentReplies,
	readCurrentAssignment,
	resolveAssignment,
} from "./register.js";
export {
	ASSIGNMENT_LOG_MAX_ENTRIES,
	DEFAULT_ASSIGNMENT_LOG_KEY,
	ephemeralAssignmentRegister,
	ephemeralAssignmentReplica,
	rejoinAssignmentReplicas,
} from "./replica.js";
