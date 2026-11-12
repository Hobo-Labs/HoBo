/* oxlint-disable no-unused-vars -- contract commit: entry-point stubs keep their final signatures until a lane implements them. */
/**
 * `@hobo/fleet/client` (L07): the typed HTTP client of the authority's API,
 * one method per non-browser route of `FleetApi`.
 *
 * Contract commit: the body throws `FleetNotImplemented`; L07 replaces it.
 */
import { FleetNotImplemented } from "../errors.js";
import type { FleetClient, PublicJwk, Signer } from "../ports.js";

export function createFleetClient(
	options: Readonly<{
		origin: string;
		fetch: typeof fetch;
		auth:
			| Readonly<{
					token(): Promise<string>;
					signer: Signer;
					publicJwk: PublicJwk;
			  }>
			| undefined;
	}>,
): FleetClient {
	throw new FleetNotImplemented("createFleetClient");
}
