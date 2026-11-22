import { createAccount } from "@nats-io/jwt";
import { credsAuthenticator } from "@nats-io/transport-node";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { open } from "../src/bus/connection.js";
import {
	provisionTopology,
	publishAccountSigningKeys,
} from "../src/bus/index.js";
import { staticCredentials, tenantKeys } from "../src/bus/nats-jwt.js";
import {
	requireBinary,
	SKIP_INTEGRATION,
	startNats,
	type TestNats,
} from "./support/nats-server.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

describe.skipIf(SKIP_INTEGRATION)("account signing keys on nats-server", () => {
	let nats: TestNats | undefined;
	beforeAll(async () => {
		nats = await startNats("rotate");
	}, 60_000);
	afterAll(async () => {
		await nats?.stop();
	});

	it("has nats-server", () => {
		requireBinary();
	});

	const connects = async (credentials: string): Promise<boolean> => {
		try {
			const connection = await open({
				servers: [nats?.url ?? ""],
				authenticator: credsAuthenticator(encoder.encode(credentials)),
				name: "hobo-fleet-rotation-test",
				persistent: false,
			});
			await connection.flush();
			await connection.close();
			return true;
		} catch {
			return false;
		}
	};

	it("adds, publishes and removes an account signing key without touching the provisioned users", async () => {
		if (nats === undefined) throw new Error("nats-server did not start");
		const keys = tenantKeys(nats.operatorSigningSeed, nats.tenant);
		const scoped = {
			observer: [keys.scoped.observer.getPublicKey()],
			executor: [keys.scoped.executor.getPublicKey()],
			dispatcher: [keys.scoped.dispatcher.getPublicKey()],
		};
		const signing = createAccount();
		const signingSeed = decoder.decode(signing.getSeed());
		const signingPublic = signing.getPublicKey();
		const reissued = await staticCredentials(keys, "provisioner", signingSeed);
		const { url, operatorSigningSeed, tenant } = nats;
		const publish = (account: readonly string[]) =>
			publishAccountSigningKeys({
				servers: [url],
				operatorSigningSeed,
				tenant,
				signingKeys: { account, scoped },
			});

		expect(await connects(reissued)).toBe(false);
		expect((await publish([signingPublic])).ok).toBe(true);
		expect(await connects(reissued)).toBe(true);
		expect(await connects(nats.provisioned.staticCredentials.provisioner)).toBe(
			true,
		);
		await provisionTopology({
			servers: [url],
			operatorSigningSeed,
			tenant,
			replicas: 1,
		});
		expect(await connects(reissued)).toBe(true);
		expect((await publish([])).ok).toBe(true);
		expect(await connects(reissued)).toBe(false);
		expect(await connects(nats.provisioned.staticCredentials.authority)).toBe(
			true,
		);
	}, 60_000);
});
