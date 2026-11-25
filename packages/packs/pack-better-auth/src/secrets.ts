import {
	type BetterAuthSecretRef,
	betterAuthSecretRefScheme,
} from "@hobo/adapter-better-auth";
import { parseSecretRef } from "@hobo/bindings";
import { requireNoPlaintextConformance, type SecretsPort } from "@hobo/identity";

import { BetterAuthBundlePlanError } from "./errors.js";
import type { BetterAuthBundlePlan } from "./plan.js";

export interface BetterAuthSigningSecretWire {
	readonly secretRef: BetterAuthSecretRef;
	readonly secretScheme: string;
	readonly secretsPortId: string;
	readonly resolvedAtIso: string;
}

const MIN_SIGNING_SECRET_LENGTH = 32;

function refuse(
	code: BetterAuthBundlePlanError["code"],
	message: string,
	remediation: string,
): never {
	throw new BetterAuthBundlePlanError(code, message, remediation);
}

export function campSecretNameFromBetterAuthRef(ref: BetterAuthSecretRef): string {
	const parsed = parseSecretRef(ref);
	const segments = parsed.path.filter((segment) => segment.length > 0);
	if (segments.length === 0) {
		refuse(
			"BETTER_AUTH_BUNDLE_PORT_INVALID",
			"signing secret locator path is empty",
			"use a hobo-secret locator with a non-empty path, e.g. hobo-secret://camp-prod/auth/better-auth-signing-key",
		);
	}
	return segments.join("/");
}

export async function wireBetterAuthSigningSecret(
	bundlePlan: BetterAuthBundlePlan,
	secretsPort: SecretsPort,
	options?: { readonly now?: string },
): Promise<BetterAuthSigningSecretWire> {
	const ref = bundlePlan.config.secretRef;
	if (bundlePlan.ports.signingSecretRef !== ref) {
		refuse(
			"BETTER_AUTH_BUNDLE_PORT_INVALID",
			"bundle ports.signingSecretRef does not match config.secretRef",
			"align BetterAuthBundlePortRefs.signingSecretRef with the parsed config locator before broker resolution",
		);
	}
	const name = campSecretNameFromBetterAuthRef(ref);
	const access = await secretsPort.access(name);
	if (access.status !== "ok") {
		refuse(
			"BETTER_AUTH_SIGNING_SECRET_UNRESOLVED",
			`camp secrets port could not resolve signing secret ${name}`,
			`deposit a signing secret into custody under that name through the camp secrets port, or fix the locator in secretRef`,
		);
	}
	const material = access.material;
	if (!material || material.length < MIN_SIGNING_SECRET_LENGTH) {
		refuse(
			"BETTER_AUTH_SIGNING_SECRET_WEAK",
			"brokered signing secret is missing or shorter than the minimum entropy floor",
			`provision at least ${MIN_SIGNING_SECRET_LENGTH} bytes of signing material in custody; never author the value inline`,
		);
	}
	const wire = Object.freeze({
		secretRef: ref,
		secretScheme: betterAuthSecretRefScheme(ref),
		secretsPortId: secretsPort.id,
		resolvedAtIso: options?.now ?? new Date().toISOString(),
	});
	requireNoPlaintextConformance({
		agentContext: wire,
		events: {
			type: "auth.SigningSecretBrokered",
			secretRef: ref,
			secretsPortId: secretsPort.id,
		},
		allowSubstrings: [ref, secretsPort.id],
	});
	return wire;
}