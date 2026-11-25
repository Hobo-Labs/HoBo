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

export type LocalTempTransport = {
	provision(input: {
		readonly stationId: string;
	}): Promise<{ stationUrl: string; claimUrl: string }>;
};

export type LocalTemporaryStationInput = {
	readonly stationId: string;
	readonly transport?: LocalTempTransport;
};

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
