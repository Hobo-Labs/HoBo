import {
	TEMPORARY_STATION_TTL_MS,
	type TemporaryEnvironmentStationResult,
	temporaryStationExpiresAt,
	temporaryStationTtlSeconds,
} from "@hobo/core";
import { PROVIDER_TARGET } from "./options.js";
import {
	parseWebernetesStationDeployment,
	parseWebernetesStationId,
	WebernetesInputRejectedError,
	type WebernetesStationDeployment,
} from "./parse.js";

export const supportsAnonymousTemporaryDeploy = true as const;

/**
 * The only seam in this package. Whatever stands up the local station — the
 * Examples dev server, a test double, an overlay host — implements this and
 * hands back two URLs, which are then untrusted until they cross the parser.
 */
export type LocalTempTransport = {
	provision(input: {
		readonly stationId: string;
	}): Promise<{ stationUrl: string; claimUrl: string }>;
};

export type LocalTemporaryStationInput = {
	readonly stationId: string;
	readonly transport?: LocalTempTransport;
};

/**
 * Provision a temporary/agent Environment Station on the local yard.
 *
 * The result is anonymous and temporary because the endpoint is local and the
 * lease expires, not because this function says so: `deployment` is the parsed
 * pair, and a transport that returned a public host or a URL with userinfo has
 * already failed by the time this returns.
 */
export async function provisionTemporaryEnvironmentStation(
	input: LocalTemporaryStationInput,
): Promise<TemporaryEnvironmentStationResult> {
	const stationId = parseWebernetesStationId(input.stationId);
	const transport = input.transport;
	if (!transport)
		throw new WebernetesInputRejectedError(
			"transport",
			"a real local station host transport is required; a generated URL does not provision a host",
		);
	const deployment: WebernetesStationDeployment =
		parseWebernetesStationDeployment(await transport.provision({ stationId }));
	const expiresAt = temporaryStationExpiresAt(TEMPORARY_STATION_TTL_MS);
	return {
		stationId,
		stationUrl: deployment.station.url,
		primaryUrl: deployment.station.url,
		claimUrl: deployment.claim.url,
		expiresAt,
		ttlSeconds: temporaryStationTtlSeconds(),
		providerId: PROVIDER_TARGET,
		anonymous: true,
		temporary: true,
	};
}
