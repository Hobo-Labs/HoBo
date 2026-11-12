// Barrel of @hobo/fleet-authority (coordinator-owned): re-exports only.
export {
	backup,
	type OpsContext,
	type RotatableKey,
	restore,
	rotateKey,
	runCeremony,
} from "./ops/index.js";
export { createStatusFeed } from "./status/index.js";
