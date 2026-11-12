/**
 * Overlay credential minters (L39). Signatures frozen by the fleet contract
 * commit (ADR-0182). The authority composes them and enrollment calls them;
 * they make their own provider API calls through `fetch` and do not use or
 * change the existing overlay API clients.
 */
import { FleetNotImplemented, type OverlayCredentialMinter } from "@hobo/fleet";

/** `organisation` is the tailnet for Tailscale and unused by NetBird; `credential` returns the operator's API token from the secret store. */
export type OverlayMinterOptions = Readonly<{
	apiBase: string;
	organisation: string;
	credential: () => Promise<string>;
	fetch: typeof fetch;
}>;

/** Mints a single-use, pre-authorised, ephemeral Tailscale auth key tagged to the member. */
export function createTailscaleCredentialMinter(
	options: OverlayMinterOptions,
): OverlayCredentialMinter {
	void options;
	throw new FleetNotImplemented("createTailscaleCredentialMinter");
}

/** Mints a single-use, ephemeral NetBird setup key for the member. */
export function createNetbirdCredentialMinter(
	options: OverlayMinterOptions,
): OverlayCredentialMinter {
	void options;
	throw new FleetNotImplemented("createNetbirdCredentialMinter");
}
