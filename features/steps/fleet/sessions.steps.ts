/**
 * Steps for features/fleet/sessions.feature (§6.12): the authority grants a
 * shell session to a member of a fleet the person may reach; the acceptor
 * authorises the grant against the registry; both ends derive the session
 * keys from their SEAL keys and frame the stream. A purpose the fleet does
 * not allow, a grant the trust record's keys did not sign, and a genuine
 * grant presented by another peer are refused.
 */
import assert from "node:assert/strict";
import { Then, When } from "@cucumber/cucumber";
import {
	authoriseSession,
	create,
	createMemoryKeyStore,
	frameStream,
	fromBinary,
	heldKey,
	SESSION_GRANT_CONTEXT,
	SessionGrantSchema,
	SessionPartySchema,
	SessionPurpose,
	SessionRequestSchema,
	type SignedEnvelope,
	sessionKeys,
	signEnvelope,
	streamPair,
} from "../../../packages/fleet-authority/acceptance/index.js";
import { device, fleet, world } from "./state.js";

const CLI_IDENTITY = "cli-dev-laptop";
const encoder = new TextEncoder();
const decoder = new TextDecoder();
let grant: SignedEnvelope | undefined;
let presented: SignedEnvelope | undefined;
let cli: Awaited<ReturnType<ReturnType<typeof createMemoryKeyStore>["open"]>> | undefined;

async function ask(purpose: SessionPurpose, port = 0) {
	const w = world();
	cli = await createMemoryKeyStore().open();
	const self = await device().keys.open();
	const { caller } = await w.person("dev");
	return w.authority.grantSession(
		create(SessionRequestSchema, {
			peer: self.memberId,
			purpose,
			port,
			initiator: create(SessionPartySchema, { transportIdentity: CLI_IDENTITY, sealPublicKey: cli.sealPublicKey }),
			ttlSeconds: 600,
		}),
		caller,
	);
}

When("the developer asks the authority for a shell session to the device", async () => {
	const answered = await ask(SessionPurpose.SHELL);
	assert.ok(answered.ok, answered.ok ? "" : `${answered.error.code}: ${answered.error.message}`);
	grant = answered.value;
});

When("the developer asks the authority for a forward session to the device", async () => {
	const answered = await ask(SessionPurpose.FORWARD, 8080);
	fleet.refusal = answered.ok ? undefined : answered.error.code;
	const shell = await ask(SessionPurpose.SHELL);
	assert.ok(shell.ok);
	grant = shell.value;
});

Then("the authority refuses it as fleet-policy", () => {
	assert.equal(fleet.refusal, "fleet-policy");
});

async function authorise(peer: string, envelope: SignedEnvelope | undefined) {
	const w = world();
	assert.ok(envelope !== undefined);
	const self = await device().keys.open();
	return authoriseSession(peer, envelope, { self: self.memberId, registry: w.bus.registry, nowMs: w.now() });
}

Then("the device authorises the grant from the developer's CLI", async () => {
	const authorised = await authorise(CLI_IDENTITY, grant);
	assert.ok(authorised.ok, authorised.ok ? "" : `${authorised.error.code}: ${authorised.error.message}`);
	assert.equal(authorised.value.initiator?.principal, "user:dev");
});

Then("a shell command and its output cross the session encrypted end to end", async () => {
	assert.ok(grant !== undefined && cli !== undefined);
	const self = await device().keys.open();
	const session = fromBinary(SessionGrantSchema, grant.payload);
	// Each end agrees with the other's SEAL key as the grant names it.
	const acceptorSecret = await self.agree(session.initiator?.sealPublicKey ?? "");
	const initiatorSecret = await cli.agree(session.acceptor?.sealPublicKey ?? "");
	assert.deepEqual(acceptorSecret, initiatorSecret);
	const keys = sessionKeys(initiatorSecret, session.sessionId);
	const [rawInitiator, rawAcceptor] = streamPair(CLI_IDENTITY, self.memberId);
	const initiator = frameStream(rawInitiator, { send: keys.initiatorToAcceptor, receive: keys.acceptorToInitiator });
	const acceptor = frameStream(rawAcceptor, { send: keys.acceptorToInitiator, receive: keys.initiatorToAcceptor });

	const shell = (async () => {
		for await (const chunk of acceptor.read()) {
			const command = decoder.decode(chunk);
			await acceptor.write(encoder.encode(command === "echo ready\n" ? "ready\n" : "sh: unknown\n"));
			return command;
		}
		return "";
	})();
	await initiator.write(encoder.encode("echo ready\n"));
	const reader = initiator.read()[Symbol.asyncIterator]();
	const output = await reader.next();
	assert.equal(await shell, "echo ready\n");
	assert.equal(decoder.decode(output.value), "ready\n");
	await initiator.close();
});

When("a shell grant is signed by a key the trust record does not name", async () => {
	assert.ok(grant !== undefined);
	presented = await signEnvelope(heldKey("authority#9").signer, SESSION_GRANT_CONTEXT, grant.payload);
});

When("the developer's genuine shell grant is presented by another peer", () => {
	presented = grant;
	fleet.notes.set("peer", "cli-of-someone-else");
});

Then("the device refuses that grant", async () => {
	const refused = await authorise(fleet.notes.get("peer") ?? CLI_IDENTITY, presented);
	assert.equal(refused.ok ? "ok" : "refused", "refused");
});
