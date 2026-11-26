import type { ResourceId } from "./types.js";

export interface ResolvedBinding {
  readonly value: string;
  readonly source: "runtime-local";
}

export interface BindingResolverPort {
  resolve(resourceId: ResourceId, property: string): Promise<ResolvedBinding>;
}
