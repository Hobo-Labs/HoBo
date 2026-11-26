import { type InterfaceId, parseInterfaceId } from "@hobo/core";

export const RESOLVER_WIT_PACKAGE = "hobo:resolver@0.1.0" as const;
export const RESOLVER_WIT_WORLD =
	"hobo:resolver/resolver-component@0.1.0" as const;

export const RESOLVER_EXPORT: InterfaceId = parseInterfaceId(
	"hobo:resolver/resolver@0.1.0",
);
export const RESOLVER_HOST_IMPORT: InterfaceId = parseInterfaceId(
	"hobo:resolver/host@0.1.0",
);
export const WASI_HTTP_OUTGOING: InterfaceId = parseInterfaceId(
	"wasi:http/outgoing-handler@0.2.0",
);

export const RESOLVER_OPERATIONS = Object.freeze([
	"describe",
	"reconcile",
	"read",
	"delete",
	"instances",
] as const);
export type ResolverOperation = (typeof RESOLVER_OPERATIONS)[number];
