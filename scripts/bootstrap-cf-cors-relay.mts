#!/usr/bin/env node
/**
 * Bootstrap Cloudflare CORS relay via Temporary Accounts (zero permanent secrets).
 *
 * Usage:
 *   pnpm exec tsx scripts/bootstrap-cf-cors-relay.mts
 *
 * Prints relayUrl + claimUrl. Set Examples data-station-broker / PUBLIC_HOBO_STATION_BROKER_URL
 * to relayUrl. Open claimUrl in a browser to keep the relay past ~60m.
 * Do NOT set CLOUDFLARE_API_TOKEN — Temporary Accounts reject authenticated clients.
 */
import { bootstrapCorsRelayViaTemporaryAccounts } from "../packages/providers/provider-cloudflare/src/bootstrap-cors-relay.ts";

for (const key of [
	"CLOUDFLARE_API_TOKEN",
	"CLOUDFLARE_API_KEY",
	"CF_API_TOKEN",
] as const) {
	if (process.env[key]) {
		console.warn(
			`Unsetting ${key} — Temporary Accounts require an unauthenticated client.`,
		);
		delete process.env[key];
	}
}

const result = await bootstrapCorsRelayViaTemporaryAccounts();
console.log(
	JSON.stringify(
		{
			ok: true,
			relayUrl: result.relayUrl,
			claimUrl: result.claimUrl,
			expiresAt: result.expiresAt,
			scriptName: result.scriptName,
			anonymous: true,
			temporary: true,
			next: "Set PUBLIC_HOBO_STATION_BROKER_URL / data-station-broker to relayUrl. Open claimUrl to keep past ~60m.",
		},
		null,
		2,
	),
);
