import type {
	BindleRuntimeContext,
	ConnectionClient,
	ConnectorBinding,
} from "@hobo/bindles";

/**
 * Station-owned resolution seam between a Bindle connector declaration and a
 * durable Connection. Implementations may select a personal, team, or
 * organization-authorized Connection according to Station policy.
 */
export interface StationConnectionResolver {
	resolve(input: {
		readonly stationId: string;
		readonly target: string;
		readonly origin: string;
		readonly authDiscovery: string;
		readonly audience?: string;
		readonly capabilities: readonly string[];
	}): ConnectionClient;
}

/**
 * Runtime context supplied when a Station instantiates a Bindle entrypoint.
 *
 * The returned ConnectionClient is broker-backed. Calling token() therefore
 * asks the Station/identity broker for a short-lived credential; no provider
 * token is read from Bindle env/config or connector-package state.
 */
export function createStationBindleRuntimeContext(input: {
	readonly stationId: string;
	readonly connections: StationConnectionResolver;
}): BindleRuntimeContext {
	return Object.freeze({
		connector(binding: ConnectorBinding): ConnectionClient {
			const definition = binding.definition;
			return input.connections.resolve({
				stationId: input.stationId,
				target: definition.id,
				origin: definition.origin,
				authDiscovery: definition.auth.discovery,
				...(definition.audience
					? { audience: definition.audience }
					: undefined),
				capabilities: Object.freeze([...binding.declaredAllow]),
			});
		},
	});
}
