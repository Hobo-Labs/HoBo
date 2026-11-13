/**
 * `runBusConformance` on the real bus: the authority's connection to a
 * provisioned tenant on `nats-server` (TLS, operator mode, full resolver).
 */
import { runBusConformance } from "@hobo/fleet/testing";
import { afterAll, beforeAll, describe, it } from "vitest";
import { connectAuthorityBus } from "../src/bus/index.js";
import {
	requireBinary,
	SKIP_INTEGRATION,
	startNats,
	type TestNats,
} from "./support/nats-server.js";

describe.skipIf(SKIP_INTEGRATION)("the bus on nats-server", () => {
	let nats: TestNats | undefined;
	beforeAll(async () => {
		nats = await startNats();
	}, 60_000);
	afterAll(async () => {
		await nats?.stop();
	});

	it("has nats-server", () => {
		requireBinary();
	});

	runBusConformance(async () => {
		if (nats === undefined) throw new Error("nats-server did not start");
		return connectAuthorityBus({
			servers: [nats.url],
			credentials: nats.provisioned.staticCredentials.authority,
			trust: () => {
				throw new Error("no trust record published yet");
			},
			log: () => undefined,
		});
	});
});
