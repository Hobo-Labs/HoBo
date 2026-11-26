import {
	assertCorsRelayIsAnonymousOnly,
	CORS_RELAY_SCRIPT_NAME,
	CORS_RELAY_WORKER_MODULE,
} from "./cors-relay-source.js";
import {
	createCloudflareTemporaryAccountTransport,
	solveAndProvisionAccount,
	TEMPORARY_STATION_TTL_MS,
	type TemporaryAccountTransport,
} from "./temporary-station.js";

export type BootstrapCorsRelayInput = {
	readonly fetchImpl?: typeof fetch;
	readonly transport?: TemporaryAccountTransport;
	readonly scriptName?: string;
};

export type BootstrapCorsRelayResult = {
	readonly relayUrl: string;
	readonly claimUrl: string;
	readonly expiresAt: string;
	readonly scriptName: string;
	readonly accountId: string;
	readonly anonymous: true;
	readonly temporary: true;
};

/**
 * Bake Temporary Account credentials into the relay module source.
 * Temporary Accounts Workers reject nested Temporary Accounts and may reject
 * plain_text bindings — inlined constants stay Worker-private (never returned
 * to the browser in JSON responses).
 */
export function materializeCorsRelayModule(input: {
	readonly accountId: string;
	readonly apiToken: string;
	readonly claimUrl: string;
}): string {
	assertCorsRelayIsAnonymousOnly(CORS_RELAY_WORKER_MODULE);
	return CORS_RELAY_WORKER_MODULE.replace(
		"__HOBO_TEMP_ACCOUNT_ID__",
		JSON.stringify(input.accountId).slice(1, -1),
	)
		.replace(
			"__HOBO_TEMP_API_TOKEN__",
			JSON.stringify(input.apiToken).slice(1, -1),
		)
		.replace("__HOBO_CLAIM_URL__", JSON.stringify(input.claimUrl).slice(1, -1));
}

/**
 * Deploy the CORS relay Worker via Cloudflare Temporary Accounts.
 * Zero permanent CLOUDFLARE_API_TOKEN / ACCOUNT_ID.
 */
export async function bootstrapCorsRelayViaTemporaryAccounts(
	input: BootstrapCorsRelayInput = {},
): Promise<BootstrapCorsRelayResult> {
	const scriptName = input.scriptName ?? CORS_RELAY_SCRIPT_NAME;
	const transport =
		input.transport ??
		createCloudflareTemporaryAccountTransport(input.fetchImpl ?? fetch);

	const account = await solveAndProvisionAccount(transport);
	const moduleSource = materializeCorsRelayModule({
		accountId: account.accountId,
		apiToken: account.apiToken,
		claimUrl: account.claimUrl,
	});
	if (
		moduleSource.includes("__HOBO_TEMP_") ||
		!moduleSource.includes(account.accountId)
	) {
		throw new Error(
			"failed to materialize Temporary Account credentials into CORS relay",
		);
	}

	const deployed = await transport.deployWorkerScript({
		accountId: account.accountId,
		apiToken: account.apiToken,
		scriptName,
		moduleSource,
	});

	return {
		relayUrl: deployed.workersDevUrl,
		claimUrl: account.claimUrl,
		expiresAt: new Date(Date.now() + TEMPORARY_STATION_TTL_MS).toISOString(),
		scriptName,
		accountId: account.accountId,
		anonymous: true,
		temporary: true,
	};
}
