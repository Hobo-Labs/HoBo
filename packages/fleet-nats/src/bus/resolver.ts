/**
 * Pushing an account JWT to the full resolver (`$SYS.REQ.CLAIMS.UPDATE`),
 * as the system-account user derived from the operator signing seed.
 */
import { credsAuthenticator } from "@nats-io/transport-node";
import { NATS, type NatsClients } from "./nats-client.js";
import { systemCredentials } from "./nats-jwt.js";

const encoder = new TextEncoder();

type ResolverAnswer = { error?: { description?: string } };

export async function pushAccount(
	servers: readonly string[],
	operatorSigningSeed: string,
	accountJwt: string,
	clients: Pick<NatsClients, "open"> = NATS,
): Promise<void> {
	const system = await clients.open({
		servers,
		authenticator: credsAuthenticator(
			encoder.encode(await systemCredentials(operatorSigningSeed)),
		),
		name: "hobo-fleet-provision",
		persistent: false,
	});
	try {
		const reply = await system.request(
			"$SYS.REQ.CLAIMS.UPDATE",
			encoder.encode(accountJwt),
			{ timeout: 10_000 },
		);
		const answer: ResolverAnswer = reply.json();
		if (answer.error !== undefined)
			throw new Error(
				`the resolver refused the account: ${answer.error.description ?? "unknown"}`,
			);
	} finally {
		await system.close();
	}
}
