/**
 * Steps for features/fleet/sign-in.feature: a person signs in through the
 * authority's HTTP routes (browser on a loopback redirect, or the device-code
 * flow), and the person credential is bound to the sign-in key.
 */
import assert from "node:assert/strict";
import { Then, When } from "@cucumber/cucumber";
import {
	fingerprintWords,
	generateDpopKey,
	ISSUER,
	jwkThumbprint,
	mintDpopProof,
	signIn,
} from "../../../packages/fleet-authority/acceptance/index.js";
import { world } from "./state.js";

type SignedIn = Awaited<ReturnType<typeof signIn>> & { key: ReturnType<typeof generateDpopKey> };
let signedIn: SignedIn | undefined;

function current(): SignedIn {
	if (signedIn === undefined) throw new Error("nobody has signed in in this scenario");
	return signedIn;
}

When("the developer signs in with a browser on the loopback redirect", async () => {
	const key = generateDpopKey();
	signedIn = { ...(await signIn(world(), "dev", key, "browser")), key };
});

When("the developer signs in with a device code", async () => {
	const key = generateDpopKey();
	signedIn = { ...(await signIn(world(), "dev", key, "device-code")), key };
});

Then("the approval page showed the four fingerprint words of the sign-in key", () => {
	const { page, key } = current();
	const words = fingerprintWords(jwkThumbprint(key.publicJwk));
	assert.equal(words.length, 4);
	for (const word of words) assert.ok(page.includes(word), `the approval page does not show "${word}"`);
});

Then("the person credential authenticates the developer with the sign-in key only", async () => {
	const w = world();
	const { token, key } = current();
	const url = `${ISSUER}/v1/fleet/fleets`;
	const proof = (signer: typeof key) =>
		mintDpopProof(signer.signer, signer.publicJwk, { htm: "GET", htu: url, nowMs: w.now(), accessToken: token });
	const verified = await w.authority.authenticate({ method: "GET", url, authorization: `DPoP ${token}`, dpop: await proof(key) });
	assert.ok(verified.ok, verified.ok ? "" : verified.error.message);
	assert.equal(verified.value.kind, "person");
	if (verified.value.kind === "person") assert.deepEqual(verified.value.principal, { kind: "user", id: "dev" });
	const listed = await w.authority.listFleets({}, verified.value);
	assert.ok(listed.ok, listed.ok ? "" : listed.error.message);
	const stolen = await w.authority.authenticate({
		method: "GET",
		url,
		authorization: `DPoP ${token}`,
		dpop: await proof(generateDpopKey()),
	});
	assert.equal(stolen.ok ? "ok" : "refused", "refused");
});

Then("the poll before approval answered sign-in-pending", () => {
	assert.equal(current().polls[0], "sign-in-pending");
});

Then("polling again after the credential was issued is refused as conflict", async () => {
	const answer = await current().poll();
	assert.notEqual(answer.status, 200);
	assert.equal(current().polls.at(-1), "conflict");
});
