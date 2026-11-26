import type * as HoboSdk from "../generated/sdk.js";
import type * as Workflow from "../generated/interfaces/hobo-sdk-workflow.js";

export type GeneratedSdkWorld = typeof HoboSdk;
export type GeneratedWorkflowImport = typeof Workflow;

export const importedInterfaces = [
  "workflow",
  "actor",
  "saga",
  "agent",
  "command",
  "subscribe",
  "capability",
  "data",
] as const;

export function buildTrivialGuest(world: GeneratedSdkWorld): "guest-builds" {
  void world;
  return "guest-builds";
}
