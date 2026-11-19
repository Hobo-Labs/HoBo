export {
	type Capability,
	type CowTier,
	detectCapability,
	probeHardlink,
	probeOverlayfs,
	probeReflink,
	removeCopyOnWriteTree,
} from "./capability.js";
export { RiftRegistryError } from "./errors.js";
export {
	appendEvent,
	journalPath,
	projectWorkspaces,
	readEvents,
	type WorkspaceEvent,
} from "./journal.js";
export * from "./names.js";
export * from "./wire.js";
export {
	createWorkspace,
	entriesToClone,
	execCommand,
	initRoot,
	REGENERABLE,
	RIFT_DIR,
	readRegistry,
	removeWorkspace,
	runInWorkspace,
	type WorkspaceRecord,
} from "./workspace.js";
