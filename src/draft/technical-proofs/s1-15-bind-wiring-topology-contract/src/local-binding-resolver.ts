import type { BindingResolverPort, ResolvedBinding } from "./binding-resolver.js";
import { parseResourceId } from "./types.js";

export function createLocalBindingResolver(
  known: Readonly<Record<string, Readonly<Record<string, string>>>>,
): BindingResolverPort {
  return {
    async resolve(resourceId, property): Promise<ResolvedBinding> {
      const id = parseResourceId(resourceId);
      const value = known[id]?.[property];
      if (!value) {
        throw new Error(`unknown binding ${id}.${property}`);
      }
      return { value, source: "runtime-local" };
    },
  };
}

export const HELLO_BINDLE_LOCAL_ENDPOINTS = Object.freeze({
  db: Object.freeze({
    connectionString: "sqlite://file:hello-bindle.db?mode=memory&cache=shared",
  }),
});
