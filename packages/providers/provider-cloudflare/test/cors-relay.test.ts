import { describe, expect, it } from "vitest";

import {
	bootstrapCorsRelayViaTemporaryAccounts,
	materializeCorsRelayModule,
} from "../src/bootstrap-cors-relay.js";
import {
	assertCorsRelayIsAnonymousOnly,
	CORS_RELAY_WORKER_MODULE,
} from "../src/cors-relay-source.js";
import type { TemporaryAccountTransport } from "../src/temporary-station.js";

describe("CORS relay Temporary Accounts bootstrap", () => {
	it("ships anonymous-only CORS relay template", () => {
		expect(() =>
			assertCorsRelayIsAnonymousOnly(CORS_RELAY_WORKER_MODULE),
		).not.toThrow();
		expect(CORS_RELAY_WORKER_MODULE).toContain("access-control-allow-origin");
		expect(CORS_RELAY_WORKER_MODULE).toContain("__HOBO_TEMP_API_TOKEN__");
		expect(CORS_RELAY_WORKER_MODULE).not.toContain("CLOUDFLARE_API_TOKEN");
	});

	it("materializes Temporary Account credentials into the module", () => {
		const source = materializeCorsRelayModule({
			accountId: "acct_abc",
			apiToken: "temp_tok_secret",
			claimUrl: "https://dash.cloudflare.com/claim/x",
		});
		expect(source).toContain("acct_abc");
		expect(source).toContain("temp_tok_secret");
		expect(source).not.toContain("__HOBO_TEMP_");
	});

	it("bootstraps relay via mocked Temporary Accounts transport", async () => {
		const transport: TemporaryAccountTransport = {
			async requestChallenge() {
				return {
					challengeToken: "tok",
					seed: Buffer.alloc(32, 2).toString("base64url"),
					k: 1,
					g: 1,
				};
			},
			async createPreviewAccount() {
				return {
					accountId: "acct_relay",
					apiToken: "temp_tok_must_not_leak",
					claimUrl: "https://dash.cloudflare.com/claim/relay",
				};
			},
			async deployWorkerScript({ scriptName, moduleSource }) {
				expect(moduleSource).toContain("acct_relay");
				expect(moduleSource).toContain("temp_tok_must_not_leak");
				expect(moduleSource).not.toContain("__HOBO_TEMP_");
				return {
					workersDevUrl: `https://${scriptName}.preview.workers.dev`,
				};
			},
		};

		const result = await bootstrapCorsRelayViaTemporaryAccounts({ transport });
		expect(result.anonymous).toBe(true);
		expect(result.relayUrl).toMatch(/\.workers\.dev$/);
		expect(JSON.stringify(result)).not.toContain("temp_tok_must_not_leak");
	});
});
