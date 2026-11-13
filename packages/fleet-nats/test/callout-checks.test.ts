import { create, toBinary } from "@bufbuild/protobuf";
import {
	ConnectProofSchema,
	ConnectTokenSchema,
	MemberState,
	NATS_CONNECT_CONTEXT,
	Role,
} from "@hobo/fleet";
import { createMemoryKeyStore, signEnvelope } from "@hobo/fleet/keys";
import { describe, expect, it } from "vitest";
import {
	type CalloutInput,
	checkConnect,
	TICKET_REPLAY_SCOPE,
} from "../src/bus/callout-checks.js";
import {
	decodeConnectToken,
	encodeConnectToken,
	mintConnectToken,
} from "../src/bus/connect-token.js";
import { createTenant, type Tenant } from "./support/fixture.js";

const NONCE = "server-nonce-1";
const encoder = new TextEncoder();

function inputOf(
	tenant: Tenant,
	token: string | undefined,
	overrides: Partial<CalloutInput> = {},
): CalloutInput {
	return {
		requestVerified: true,
		token,
		serverNonce: NONCE,
		registry: tenant.bus.registry,
		replay: tenant.bus.replay,
		incarnation: 3,
		now: tenant.now,
		...overrides,
	};
}

describe("connect token", () => {
	it("round-trips and refuses garbage", async () => {
		const tenant = await createTenant();
		const keys = await tenant.device();
		const text = await mintConnectToken(keys, await tenant.ticket(keys));
		const token = decodeConnectToken(text);
		expect(token?.ticket?.context).toBe("hobo-fleet/session-ticket/v1");
		expect(token?.proof?.context).toBe(NATS_CONNECT_CONTEXT);
		expect(encodeConnectToken(token ?? create(ConnectTokenSchema))).toBe(text);
		expect(decodeConnectToken("not base64url!")).toBeUndefined();
		expect(decodeConnectToken("")).toBeUndefined();
	});
});

describe("the callout's seven checks (§6.7)", () => {
	it("admits an active device with its highest template, binding the nonce", async () => {
		const tenant = await createTenant();
		const keys = await tenant.device({
			roles: [Role.OBSERVER, Role.DISPATCHER],
		});
		const token = await mintConnectToken(
			keys,
			await tenant.ticket(keys),
			encoder.encode(NONCE),
		);
		const verdict = await checkConnect(inputOf(tenant, token));
		expect(verdict).toMatchObject({
			ok: true,
			memberId: keys.memberId,
			template: "dispatcher",
		});
		// A nonce-bound proof may reconnect with the same ticket on a new nonce only by a new proof.
		expect(
			await checkConnect(inputOf(tenant, token, { serverNonce: "other" })),
		).toMatchObject({
			ok: false,
			check: "nonce",
		});
	});

	it("1. refuses a request whose server signature does not verify", async () => {
		const tenant = await createTenant();
		const keys = await tenant.device();
		const token = await mintConnectToken(keys, await tenant.ticket(keys));
		expect(
			await checkConnect(inputOf(tenant, token, { requestVerified: false })),
		).toMatchObject({ ok: false, check: "request-signature" });
	});

	it("2. refuses a missing, forged, expired or stale-incarnation ticket", async () => {
		const tenant = await createTenant();
		const keys = await tenant.device();
		expect(await checkConnect(inputOf(tenant, undefined))).toMatchObject({
			check: "ticket",
		});
		const forged = await mintConnectToken(
			keys,
			await tenant.ticket(keys, { signer: keys.sign }),
		);
		expect(await checkConnect(inputOf(tenant, forged))).toMatchObject({
			check: "ticket",
		});
		const expired = await mintConnectToken(
			keys,
			await tenant.ticket(keys, { expiresInMs: -1 }),
		);
		expect(await checkConnect(inputOf(tenant, expired))).toMatchObject({
			check: "ticket",
		});
		const stale = await mintConnectToken(
			keys,
			await tenant.ticket(keys, { incarnation: 2 }),
		);
		expect(await checkConnect(inputOf(tenant, stale))).toMatchObject({
			check: "ticket",
		});
	});

	it("3. refuses a proof that names another ticket", async () => {
		const tenant = await createTenant();
		const keys = await tenant.device();
		const proof = await signEnvelope(
			keys.sign,
			NATS_CONNECT_CONTEXT,
			toBinary(
				ConnectProofSchema,
				create(ConnectProofSchema, { ticketId: "someone-else" }),
			),
		);
		const token = encodeConnectToken(
			create(ConnectTokenSchema, { ticket: await tenant.ticket(keys), proof }),
		);
		expect(await checkConnect(inputOf(tenant, token))).toMatchObject({
			check: "proof-ticket",
		});
	});

	it("4. refuses a proof not signed by the device's registered SIGN key", async () => {
		const tenant = await createTenant();
		const keys = await tenant.device();
		const thief = await createMemoryKeyStore().open();
		const ticket = await tenant.ticket(keys);
		const stolen = await mintConnectToken(
			{ ...thief, memberId: keys.memberId },
			ticket,
		);
		expect(await checkConnect(inputOf(tenant, stolen))).toMatchObject({
			check: "proof-signature",
		});
		const unknown = await mintConnectToken(thief, await tenant.ticket(thief));
		expect(await checkConnect(inputOf(tenant, unknown))).toMatchObject({
			check: "proof-signature",
		});
	});

	it("5. refuses another connection's nonce and a second use of a nonce-free ticket", async () => {
		const tenant = await createTenant();
		const keys = await tenant.device();
		const ticket = await tenant.ticket(keys);
		const wrong = await mintConnectToken(
			keys,
			ticket,
			encoder.encode("old-nonce"),
		);
		expect(await checkConnect(inputOf(tenant, wrong))).toMatchObject({
			check: "nonce",
		});
		const once = await mintConnectToken(keys, ticket);
		expect(await checkConnect(inputOf(tenant, once))).toMatchObject({
			ok: true,
		});
		expect(await checkConnect(inputOf(tenant, once))).toMatchObject({
			check: "nonce",
		});
		expect(TICKET_REPLAY_SCOPE).toBe("nats-ticket");
	});

	it("6. refuses a device that is not active or holds no role", async () => {
		const tenant = await createTenant();
		const suspended = await tenant.device({ state: MemberState.SUSPENDED });
		const token = await mintConnectToken(
			suspended,
			await tenant.ticket(suspended),
		);
		expect(await checkConnect(inputOf(tenant, token))).toMatchObject({
			check: "not-active",
		});
		const roleless = await tenant.device({ roles: [] });
		const second = await mintConnectToken(
			roleless,
			await tenant.ticket(roleless),
		);
		expect(await checkConnect(inputOf(tenant, second))).toMatchObject({
			check: "not-active",
		});
	});

	it("7. refuses a ticket for another tenant", async () => {
		const tenant = await createTenant();
		const keys = await tenant.device();
		const token = await mintConnectToken(
			keys,
			await tenant.ticket(keys, { tenant: "other" }),
		);
		expect(await checkConnect(inputOf(tenant, token))).toMatchObject({
			check: "tenant",
		});
	});
});
