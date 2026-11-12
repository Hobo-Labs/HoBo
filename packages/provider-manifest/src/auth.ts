/**
 * Auth section -> resolved, preference-ordered flows.
 *
 * Flow type names are the ones the Capability Manifest design already uses
 * (docs/design/ai-native-agent-auth.md §6.1); this module only maps the
 * manifest's structured variants onto them.
 */
import { authMdDocumentUrl, protectedResourceMetadataUrl } from "@hobo/auth-md";
import type {
	AuthFlow,
	AuthMdFlow,
} from "./_generated/provider_manifest_pb.js";
import type { ParsedProviderManifest } from "./parse.js";

/**
 * Keyless first, static secrets last. A flow type missing from this list (an
 * `x-` extension) sorts after every known one: HoBo cannot broker it.
 */
export const AUTH_FLOW_PREFERENCE = [
	"oidc-federation",
	"oauth2-xaa",
	"oauth2-obo",
	"auth-md",
	"oauth2-authorization-code",
	"device-code",
	"oauth2-client-credentials",
	"api-key",
] as const;

const OAUTH2_GRANT_TYPES = new Map([
	["authorization-code", "oauth2-authorization-code"],
	["client-credentials", "oauth2-client-credentials"],
	["device-code", "device-code"],
	["token-exchange", "oauth2-obo"],
	["jwt-bearer", "oauth2-xaa"],
]);

/** Flows that leave a long-lived secret in someone's custody. */
const STATIC_SECRET_TYPES = new Set(["api-key", "oauth2-client-credentials"]);

export type AuthMdTargets = {
	readonly resource: string;
	readonly protectedResourceMetadataUrl: string;
	readonly authMdUrl: string;
};

/** Where an agent discovers an auth.md flow, per `@hobo/auth-md` discovery. */
export function authMdTargets(flow: AuthMdFlow): AuthMdTargets {
	return {
		resource: flow.resource,
		protectedResourceMetadataUrl: protectedResourceMetadataUrl(flow.resource),
		authMdUrl:
			flow.documentUrl === ""
				? authMdDocumentUrl(flow.resource)
				: flow.documentUrl,
	};
}

export function authFlowType(flow: AuthFlow): string {
	const variant = flow.flow;
	switch (variant.case) {
		case "oauth2":
			return OAUTH2_GRANT_TYPES.get(variant.value.grant) ?? "oauth2";
		case "authMd":
			return "auth-md";
		case "oidcFederation":
			return "oidc-federation";
		case "apiKey":
			return "api-key";
		case "extension":
			return variant.value.type;
		default:
			return "unknown";
	}
}

export type ResolvedAuthFlow = {
	readonly id: string;
	readonly type: string;
	readonly scopes: readonly string[];
	readonly staticSecret: boolean;
	/** False for extension flows: declared and published, never brokered. */
	readonly supported: boolean;
	readonly flow: AuthFlow;
};

const PREFERENCE: readonly string[] = AUTH_FLOW_PREFERENCE;

function preference(type: string): number {
	const index = PREFERENCE.indexOf(type);
	return index === -1 ? PREFERENCE.length : index;
}

/** The manifest's flows, most-preferred first; declaration order breaks ties. */
export function resolveAuthFlows(
	manifest: ParsedProviderManifest,
): readonly ResolvedAuthFlow[] {
	const flows = manifest.auth?.flows ?? [];
	return flows
		.map((flow, index) => {
			const type = authFlowType(flow);
			return {
				index,
				resolved: {
					id: flow.id,
					type,
					scopes: flow.scopes.map((scope) => scope.name),
					staticSecret: STATIC_SECRET_TYPES.has(type),
					supported: flow.flow.case !== "extension",
					flow,
				},
			};
		})
		.sort(
			(left, right) =>
				preference(left.resolved.type) - preference(right.resolved.type) ||
				left.index - right.index,
		)
		.map((entry) => entry.resolved);
}
