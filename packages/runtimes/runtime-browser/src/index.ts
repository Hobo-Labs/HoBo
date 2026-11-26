export {
	type BrowserEventStore,
	createBrowserEventStore,
} from "./browser-store.js";
export { detectBrowserPersistence } from "./detect.js";
export type {
	BrowserPersistenceMode,
	BrowserStorageOpenOptions,
	BrowserStorageRequest,
	BrowserStorageResponse,
} from "./types.js";

export const HOBO_RUNTIME_BROWSER_PACKAGE = "@hobo/runtime-browser";
