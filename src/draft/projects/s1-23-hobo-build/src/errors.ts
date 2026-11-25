import { type JsonObject } from "./json.js";
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
