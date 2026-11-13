export {
	type CdHttpMount,
	type CdHttpRequest,
	type CdHttpResponse,
	type ControlApiServer,
	type ControlApiServerOptions,
	createControlApiServer,
	PayloadTooLargeError,
} from "./server.js";

// public-contract: the package identity consumers and tests assert.
export const HOBO_CONTROL_API_PACKAGE = "@hobo/control-api";
