import type { TenantId } from "@hobo/core";
import { MemberState, Role } from "@hobo/fleet";
import {
	type ClaimsData,
	createCurve,
	createOperator,
	createServer,
	createUser,
	decode,
	encode,
	type User,
} from "@nats-io/jwt";
import { describe, expect, it } from "vitest";
import { answerCallout, type CalloutDeps } from "../src/bus/callout.js";
import { mintConnectToken } from "../src/bus/connect-token.js";
import { tenantKeys, verifyJwt } from "../src/bus/nats-jwt.js";
import { createTenant, type Tenant } from "./support/fixture.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

type Server = ReturnType<typeof serverOf>;

type ConnectOptions = { protocol: number; auth_token?: string };

function connectOptions(token: string | undefined): ConnectOptions {
	const options: ConnectOptions = { protocol: 1 };
	if (token !== undefined) options.auth_token = token;
	return options;
}

function serverOf() {
	const identity = createServer();
	const xkey = createCurve();
	return {
		identity,
		xkey,
		async request(token: string | undefined, nonce = "n-1", signer = identity) {
			const jwt = await encode(
				// SAFETY: the jwt package's algorithm enum value for v2 JWTs.
				"ed25519-nkey" as Parameters<typeof encode>[0],
				{
					aud: "nats-authorization-request",
					jti: "r1",
					iat: 1,
					iss: signer.getPublicKey(),
					name: "",
					sub: identity.getPublicKey(),
					nats: {
						server_id: { id: identity.getPublicKey(), name: "n1", host: "h" },
						user_nkey: createUser().getPublicKey(),
						client_info: { nonce },
						connect_opts: connectOptions(token),
						type: "authorization_request",
						version: 2,
					},
				},
				signer,
			);
			return jwt;
		},
	};
}

type TestDeps = CalloutDeps &
	Readonly<{ account: string; executorKey: string }>;

// SAFETY: a literal tenant id for the test, matching the TenantId pattern.
const TENANT = "acme" as TenantId;

function depsOf(tenant: Tenant, logged: string[]): TestDeps {
	const keys = tenantKeys(decoder.decode(createOperator().getSeed()), TENANT);
	return {
		account: keys.account.getPublicKey(),
		executorKey: keys.scoped.executor.getPublicKey(),
		xkey: keys.xkey,
		accountPublicKey: keys.account.getPublicKey(),
		scopedSeeds: {
			observer: decoder.decode(keys.scoped.observer.getSeed()),
			executor: decoder.decode(keys.scoped.executor.getSeed()),
			dispatcher: decoder.decode(keys.scoped.dispatcher.getSeed()),
		},
		registry: tenant.bus.registry,
		replay: tenant.bus.replay,
		incarnation: 3,
		now: tenant.now,
		log: (event, fields) =>
			logged.push(
				event === "hobo_fleet_bus_status"
					? `${event} ${String(fields.component)} ${String(fields.status)} ${String(fields.member)} ${String(fields.template)}`
					: `${event} ${String(fields.check)}`,
			),
	};
}

async function exchange(server: Server, deps: CalloutDeps, request: string) {
	const sealed = server.xkey.seal(
		encoder.encode(request),
		deps.xkey.getPublicKey(),
	);
	const answer = await answerCallout(sealed, server.xkey.getPublicKey(), deps);
	if (answer === undefined) return undefined;
	const opened = server.xkey.open(answer, deps.xkey.getPublicKey());
	if (opened === null)
		throw new Error("the response is not sealed to the server");
	const response = decoder.decode(opened);
	expect(verifyJwt(response)).toBe(true);
	const claims: ClaimsData<{
		jwt?: string;
		error?: string;
		issuer_account?: string;
	}> = decode(response);
	return claims;
}

describe("the auth callout exchange", () => {
	it("answers an executor with a sealed user JWT from the executor scoped key", async () => {
		const tenant = await createTenant();
		const logged: string[] = [];
		const deps = depsOf(tenant, logged);
		const server = serverOf();
		const keys = await tenant.device({ roles: [Role.EXECUTOR] });
		const token = await mintConnectToken(keys, await tenant.ticket(keys));
		const answer = await exchange(server, deps, await server.request(token));
		expect(answer?.aud).toBe(server.identity.getPublicKey());
		expect(answer?.nats.error).toBeUndefined();
		expect(answer?.nats.issuer_account).toBe(deps.account);
		const user: ClaimsData<User> = decode(answer?.nats.jwt ?? "");
		expect(user.name).toBe(keys.memberId);
		expect(user.iss).toBe(deps.executorKey);
		// The allowed decision is reported once, for the status feed (L27).
		expect(logged).toEqual([
			`hobo_fleet_bus_status callout authorised ${keys.memberId} executor`,
		]);
	});

	it("answers a refusal with the failed check and logs it", async () => {
		const tenant = await createTenant();
		const logged: string[] = [];
		const deps = depsOf(tenant, logged);
		const server = serverOf();
		const keys = await tenant.device({ state: MemberState.REVOKED });
		const token = await mintConnectToken(keys, await tenant.ticket(keys));
		const answer = await exchange(server, deps, await server.request(token));
		expect(answer?.nats.jwt).toBeUndefined();
		expect(answer?.nats.error).toBe("refused: not-active");
		expect(logged).toEqual(["hobo_fleet_callout_refused not-active"]);
		const forged = await exchange(
			server,
			deps,
			await server.request(token, "n", createServer()),
		);
		expect(forged?.nats.error).toBe("refused: request-signature");
		const none = await exchange(server, deps, await server.request(undefined));
		expect(none?.nats.error).toBe("refused: ticket");
	});

	it("answers nothing to a request it cannot open", async () => {
		const tenant = await createTenant();
		const logged: string[] = [];
		const deps = depsOf(tenant, logged);
		const server = serverOf();
		const request = encoder.encode(await server.request(undefined));
		expect(await answerCallout(request, undefined, deps)).toBeUndefined();
		expect(
			await answerCallout(request, server.xkey.getPublicKey(), deps),
		).toBeUndefined();
		const wrongKey = createCurve().seal(request, deps.xkey.getPublicKey());
		expect(
			await answerCallout(wrongKey, server.xkey.getPublicKey(), deps),
		).toBeUndefined();
		expect(logged).toHaveLength(3);
	});
});
