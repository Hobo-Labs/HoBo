// What a platform function needs to host HoBo.CD (`packages/cd-vercel`): the
// CD runtime, the owner's journal fleet, and the CD mount without a server.
// A subpath of its own, so a function imports this and not the whole CLI.

export { type CdHost, cdJson, composeCdHost } from "./cd-host.js";
export {
	type OwnerJournal,
	withOwnerJournalFleet,
} from "./cd-owner-journal.js";
export { type CdRuntime, openCdRuntime } from "./cd-runtime.js";
