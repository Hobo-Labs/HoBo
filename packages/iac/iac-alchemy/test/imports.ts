// Resolve the adapter's real peer dependencies from its package, while the
// integration test composes the host at the repository boundary.
export * as RivetCloud from "@alchemy.run/rivet/Cloud";
export * as Rivet from "@alchemy.run/rivet";
export { create } from "@bufbuild/protobuf";
export { inMemoryState, Resource, Stack } from "alchemy";
export * as Alchemist from "alchemy/Alchemist";
export * as Output from "alchemy/Output";
export * as Provider from "alchemy/Provider";
export * as Effect from "effect/Effect";
export * as Layer from "effect/Layer";
