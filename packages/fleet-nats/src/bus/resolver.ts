/**
 * The full resolver, as the system-account user derived from the operator
 * signing seed: pushing an account JWT (`$SYS.REQ.CLAIMS.UPDATE`) and reading
 * the one it holds (`$SYS.REQ.ACCOUNT.<account>.CLAIMS.LOOKUP`, which answers
 * the JWT, or nothing for an account it does not hold).
 */
import { credsAuthenticator } from "@nats-io/transport-node";
import { type BusConnection, NATS, type NatsClients } from "./nats-client.js";
import { systemCredentials } from "./nats-jwt.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const TIMEOUT_MS = 10_000;

type ResolverAnswer = { error?: { description?: string } };

async function asSystem<T>(
	servers: readonly string[],
	operatorSigningSeed: string,
	clients: Pick<NatsClients, "open">,
	run: (system: BusConnection) => Promise<T>,
): Promise<T> {
	const system = await clients.open({
		servers,
		authenticator: credsAuthenticator(
			encoder.encode(await systemCredentials(operatorSigningSeed)),
		),
		name: "hobo-fleet-provision",
		persistent: false,
	});
	try {
		return await run(system);
	} finally {
		await system.close();
	}
}

async function push(system: BusConnection, accountJwt: string): Promise<void> {
	const reply = await system.request(
		"$SYS.REQ.CLAIMS.UPDATE",
		encoder.encode(accountJwt),
		{ timeout: TIMEOUT_MS },
	);
	const answer: ResolverAnswer = reply.json();
	if (answer.error !== undefined)
		throw new Error(
			`the resolver refused the account: ${answer.error.description ?? "unknown"}`,
		);
}

export function pushAccount(
	servers: readonly string[],
	operatorSigningSeed: string,
	accountJwt: string,
	clients: Pick<NatsClients, "open"> = NATS,
): Promise<void> {
	return asSystem(servers, operatorSigningSeed, clients, (system) =>
		push(system, accountJwt),
	);
}

/**
 * Reads the account JWT the resolver holds for `account` (undefined when it
 * holds none), mints the JWT to push from it, and pushes that, on one
 * connection. A lookup the resolver does not answer fails the whole call, so
 * nothing is pushed on a guess.
 */
export function pushAccountOver(
	servers: readonly string[],
	operatorSigningSeed: string,
	account: string,
	mint: (published: string | undefined) => Promise<string>,
	clients: Pick<NatsClients, "open"> = NATS,
): Promise<void> {
	return asSystem(servers, operatorSigningSeed, clients, async (system) => {
		const reply = await system.request(
			`$SYS.REQ.ACCOUNT.${account}.CLAIMS.LOOKUP`,
			new Uint8Array(),
			{ timeout: TIMEOUT_MS },
		);
		const published = decoder.decode(reply.data).trim();
		await push(system, await mint(published === "" ? undefined : published));
	});
}
