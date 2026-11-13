import { describe, expect, it } from "vitest";
import {
	createHarness,
	credentialBody,
	enrollmentBody,
	fleetBody,
	newDevice,
	tokenBody,
} from "./support/harness.js";

describe("the authority service", () => {
	it("enrolls a device end to end over HTTP and issues its SVID", async () => {
		const h = await createHarness();
		const alice = await h.personCaller({ kind: "user", id: "alice" }, [
			"fleet-admin",
		]);
		const defined = await h.send("PUT", "/v1/fleet/fleets/build", {
			caller: alice,
			body: fleetBody("build"),
		});
		expect(defined.status, defined.text).toBe(200);
		await h.runtime.tickOnce();

		const token = await h.send("POST", "/v1/fleet/tokens", {
			caller: alice,
			body: tokenBody("build", "box1"),
		});
		expect(token.status, token.text).toBe(200);
		const bootstrap: string = token.json().token;

		const device = await newDevice(h.now());
		const enrolled = await h.send("POST", "/v1/fleet/members", {
			body: enrollmentBody(
				device,
				"build",
				{ bootstrapToken: bootstrap },
				"box1",
			),
			dpop: device.identityKey,
		});
		expect(enrolled.status, enrolled.text).toBe(200);
		await h.runtime.tickOnce();

		const credentials = await h.send(
			"POST",
			`/v1/fleet/members/${device.keys.memberId}/credentials`,
			{
				body: credentialBody(0),
				dpop: device.signKey,
			},
		);
		expect(credentials.status, credentials.text).toBe(200);
		expect(credentials.json().svid).toEqual(expect.any(String));
	});
});
