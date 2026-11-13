/**
 * `@hobo/fleet/assignment` (L05): the one-active assignment register, moved
 * from `packages/backend-fleet/src/{assignment,ephemeral-replica}.ts` at
 * 62dbc5d4c with the names of §7.3, plus membership epochs and the one-active
 * loop (§6.10). Exactly the entry points of §7.3; everything else in this
 * directory is private.
 *
 * The re-exports below keep the fleet-wave-0 order on purpose (functions in
 * declaration order, then the constants, as TypeScript bound the stubs):
 * `scripts/emit-fleet-contracts.mts` emits names in barrel order, so the
 * committed `contracts/api.snapshot.d.ts` depends on it. Do not sort them.
 */
// biome-ignore-all assist/source/organizeImports: export order is the fleet-wave-0 snapshot order (see above).
export { parseAssignmentEntry } from "./register.js";
export { assignmentKey } from "./register.js";
export { fleetMajority } from "./register.js";
export { resolveAssignment } from "./register.js";
export { parseAssignmentRegister } from "./register.js";
export { readAssignmentReplies } from "./register.js";
export { readCurrentAssignment } from "./register.js";
export { proposeAssignment } from "./register.js";
export { bootstrapAssignment } from "./register.js";
export { completeAssignment } from "./register.js";
export { overrideAssignment } from "./register.js";
export { proposeMembership } from "./register.js";
export { decidingSet } from "./register.js";
export { encodeAssignmentLog } from "./log.js";
export { decodeAssignmentLog } from "./log.js";
export { ephemeralAssignmentReplica } from "./replica.js";
export { ephemeralAssignmentRegister } from "./replica.js";
export { rejoinAssignmentReplicas } from "./replica.js";
export { createOneActiveFleet } from "./one-active.js";
export { FIRST_ASSIGNMENT_EPOCH } from "./register.js";
export { ASSIGNMENT_ACCEPT_OUTCOMES } from "./register.js";
export { ASSIGNMENT_LOG_MAX_ENTRIES } from "./replica.js";
export { DEFAULT_ASSIGNMENT_LOG_KEY } from "./replica.js";
