import {
	type BetterAuthSecretRef,
	betterAuthSecretRefScheme,
} from "@hobo/auth-adapter-contract";
import { parseSecretRef } from "@hobo/bindings";
import {
	requireNoPlaintextConformance,
	type SecretsPort,
} from "@hobo/identity";

import { BetterAuthBundlePlanError } from "./errors.js";
import type { BetterAuthBundlePlan } from "./plan.js";

export interface BetterAuthSigningSecretWire {
	readonly secretRef: BetterAuthSecretRef;
	readonly secretScheme: string;
	readonly secretsPortId: string;
	readonly resolvedAtIso: string;
}

const MIN_SIGNING_SECRET_LENGTH = 32;

const CANONICAL_UTC_INSTANT =
	/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/u;

function wireRecordContainsMaterial(
	wire: BetterAuthSigningSecretWire,
	material: string,
): boolean {
	return (
		wire.secretRef.includes(material) ||
		wire.secretScheme.includes(material) ||
		wire.secretsPortId.includes(material) ||
		wire.resolvedAtIso.includes(material)
	);
}

function refuse(
	code: BetterAuthBundlePlanError["code"],
	message: string,
	remediation: string,
): never {
	throw new BetterAuthBundlePlanError(code, message, remediation);
}

export function campSecretNameFromBetterAuthRef(
	ref: BetterAuthSecretRef,
	campAuthority: string,
): string {
	const parsed = parseSecretRef(ref);
	if (
		parsed.scheme !== "hobo-secret" ||
		campAuthority === "" ||
		parsed.authority !== campAuthority ||
		parsed.field !== undefined
	) {
		refuse(
			"BETTER_AUTH_BUNDLE_PORT_INVALID",
			"signing secret locator does not identify this camp's secret port",
			"use an unfragmented hobo-secret locator for the selected camp; other providers require a matching resolver",
		);
	}
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
	options: { readonly campAuthority: string; readonly now?: string },
): Promise<BetterAuthSigningSecretWire> {
	const ref = bundlePlan.config.secretRef;
	if (bundlePlan.ports.signingSecretRef !== ref) {
		refuse(
			"BETTER_AUTH_BUNDLE_PORT_INVALID",
			"bundle ports.signingSecretRef does not match config.secretRef",
			"align BetterAuthBundlePortRefs.signingSecretRef with the parsed config locator before broker resolution",
		);
	}
	if (secretsPort.id.length === 0) {
		refuse(
			"BETTER_AUTH_BUNDLE_PORT_INVALID",
			"camp secrets port id is empty",
			"bind a SecretsPort whose id is a non-empty identifier",
		);
	}
	if (options.now !== undefined && !CANONICAL_UTC_INSTANT.test(options.now)) {
		refuse(
			"BETTER_AUTH_BUNDLE_PORT_INVALID",
			"signing secret wire timestamp is not a canonical UTC instant",
			"omit now, or pass an instant formatted YYYY-MM-DDTHH:mm:ss.sssZ",
		);
	}
	const name = campSecretNameFromBetterAuthRef(ref, options.campAuthority);
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
			"brokered signing secret is missing or shorter than the minimum length",
			`provision at least ${MIN_SIGNING_SECRET_LENGTH} characters of signing material in custody; never author the value inline`,
		);
	}
	const wire = Object.freeze({
		secretRef: ref,
		secretScheme: betterAuthSecretRefScheme(ref),
		secretsPortId: secretsPort.id,
		resolvedAtIso: options.now ?? new Date().toISOString(),
	});
	if (wireRecordContainsMaterial(wire, material)) {
		refuse(
			"BETTER_AUTH_SIGNING_SECRET_EXPOSED",
			"brokered signing material would appear on the locator-only wire record",
			"choose signing material that is absent from the locator, the secrets port id, and the wire timestamp",
		);
	}
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
