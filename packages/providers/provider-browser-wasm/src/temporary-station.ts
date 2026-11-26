import {
	TEMPORARY_STATION_TTL_MS,
	type TemporaryEnvironmentStationResult,
	temporaryStationExpiresAt,
	temporaryStationTtlSeconds,
} from "@hobo/core";
import { PROVIDER_TARGET } from "./options.js";

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
	const transport =
		input.transport ??
		({
			async provision({ stationId }) {
				const slug =
					stationId.replace(/[^a-z0-9-]/giu, "").slice(-20) || "anon";
				return {
					stationUrl: `https://${slug}.${PROVIDER_TARGET}.hobo.localhost`,
					claimUrl: `https://claim.hobo.localhost/${PROVIDER_TARGET}/${slug}`,
				};
			},
		} satisfies LocalTempTransport);
	const deployed = await transport.provision({ stationId: input.stationId });
	const expiresAt = temporaryStationExpiresAt(TEMPORARY_STATION_TTL_MS);
	return {
		stationId: input.stationId,
		stationUrl: deployed.stationUrl,
		primaryUrl: deployed.stationUrl,
		claimUrl: deployed.claimUrl,
		expiresAt,
		ttlSeconds: temporaryStationTtlSeconds(),
		providerId: PROVIDER_TARGET,
		anonymous: true,
		temporary: true,
	};
}
