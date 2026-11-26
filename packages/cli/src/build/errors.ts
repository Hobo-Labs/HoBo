import { isJsonNumber, type JsonObject } from "../json.js";
import { CliError } from "../shell/errors.js";

export type BuildErrorCode =
	| "HOBO_BUILD_USAGE"
	| "HOBO_BUILD_CODEGEN_DRIFT"
	| "HOBO_BUILD_CODEGEN_FAILED"
	| "HOBO_BUILD_NO_SERVICES"
	| "HOBO_BUILD_SERVICE_INVALID"
	| "HOBO_BUILD_RUNTIME_INVALID"
	| "HOBO_BUILD_PATH_INVALID"
	| "HOBO_BUILD_SOURCE_MISSING"
	| "HOBO_BUILD_SOURCE_PARSE"
	| "HOBO_BUILD_COMPONENTIZE_FAILED"
	| "HOBO_BUILD_COMPONENTIZE_TOOLCHAIN"
	| "HOBO_BUILD_INTERNAL";

export class BuildError extends Error {
	readonly code: BuildErrorCode;
	readonly detail: JsonObject;

	constructor(code: BuildErrorCode, message: string, detail: JsonObject = {}) {
		super(message);
		this.name = "BuildError";
		this.code = code;
		this.detail = detail;
	}
}

export class BuildCliError extends CliError {
	constructor(error: BuildError) {
		const exitCode = isJsonNumber(error.detail.exitCode)
			? error.detail.exitCode
			: error.code === "HOBO_BUILD_USAGE"
				? 2
				: 1;
		super(error.message, exitCode, error.code, remediationFor(error));
		this.name = "BuildCliError";
	}
}

export function remediationFor(error: BuildError): readonly string[] {
	switch (error.code) {
		case "HOBO_BUILD_CODEGEN_DRIFT":
			return ["Run `hobo codegen` to refresh `src/_generated/`."];
		case "HOBO_BUILD_NO_SERVICES":
			return ["Declare at least one service in `hobo.bindle.json`."];
		case "HOBO_BUILD_USAGE":
			return ["Run `hobo build --help` for supported flags."];
		case "HOBO_BUILD_COMPONENTIZE_TOOLCHAIN":
			return [
				"Install @bytecodealliance/componentize-js (pinned toolchain). Product builds require real componentization; synthetic componentizers are available only through explicitly injected library fixtures.",
			];
		default:
			return error.code === "HOBO_BUILD_COMPONENTIZE_FAILED"
				? ["Fix the reported service source and re-run `hobo build`."]
				: ["Re-run with `--json` for machine-readable detail."];
	}
}
