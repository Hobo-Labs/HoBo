// The hobo:resolver@0.1.0 WIT surface, as constants the host and the
// conformance kit share. The WIT text itself lives in `wit/resolver.wit`.
import { type InterfaceId, parseInterfaceId } from "@hobo/core";

// public-contract: the WIT package every resolver component targets.
export const RESOLVER_WIT_PACKAGE = "hobo:resolver@0.1.0" as const;
// public-contract: the world a resolver component's bytes must declare.
export const RESOLVER_WIT_WORLD =
	"hobo:resolver/resolver-component@0.1.0" as const;

// public-contract: the exported interface every component implements.
export const RESOLVER_EXPORT: InterfaceId = parseInterfaceId(
	"hobo:resolver/resolver@0.1.0",
);
// public-contract: host imports (log, authorized-fetch).
export const RESOLVER_HOST_IMPORT: InterfaceId = parseInterfaceId(
	"hobo:resolver/host@0.1.0",
);
// public-contract: host-mediated unauthenticated egress.
export const WASI_HTTP_OUTGOING: InterfaceId = parseInterfaceId(
	"wasi:http/outgoing-handler@0.2.0",
);

// public-contract: the five exported operations of `hobo:resolver/resolver`.
export const RESOLVER_OPERATIONS = Object.freeze([
	"describe",
	"reconcile",
	"read",
	"delete",
	"instances",
] as const);
export type ResolverOperation = (typeof RESOLVER_OPERATIONS)[number];
