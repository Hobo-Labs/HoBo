// The operations' configuration, and the frozen entry points' answers when
// the configuration or the deployment is not usable.
import { describe, expect, it } from "vitest";
import { parseOpsConfig } from "../../src/ops/config.js";
import {
	backup,
	restore,
	rotateKey,
	runCeremony,
} from "../../src/ops/index.js";
import { opsFixture } from "./support.js";

describe("parseOpsConfig", () => {
	it("defaults the standalone profile, the secret prefix and the data directory", () => {
		const parsed = parseOpsConfig(
			JSON.stringify({ tenant: "acme" }),
			"/etc/hobo",
		);
		if (!parsed.ok) throw new Error(parsed.error.message);
		expect(parsed.value).toMatchObject({
			tenant: "acme",
			profile: "standalone",
			secretPrefix: "hobo-fleet/acme",
			dataDir: "/etc/hobo/data",
			natsCredentialsSecret: "hobo-fleet/acme/nats-authority",
		});
	});

	it("ignores the authority's own keys and reads natsUrls", () => {
		const parsed = parseOpsConfig(
			JSON.stringify({
				tenant: "acme",
				issuer: "https://fleet.example",
				profile: "high-availability",
				natsUrls: ["nats://a:4222", "nats://b:4222"],
				dataDir: "/var/lib/fleet",
			}),
			"/etc/hobo",
		);
		if (!parsed.ok) throw new Error(parsed.error.message);
		expect(parsed.value.natsUrls).toEqual(["nats://a:4222", "nats://b:4222"]);
		expect(parsed.value.dataDir).toBe("/var/lib/fleet");
	});

	it.each([
		["not JSON", "{"],
		["no tenant", JSON.stringify({})],
		["an unknown profile", JSON.stringify({ tenant: "acme", profile: "huge" })],
		[
			"high availability without NATS",
			JSON.stringify({ tenant: "acme", profile: "high-availability" }),
		],
		["natsUrls not strings", JSON.stringify({ tenant: "acme", natsUrls: [1] })],
	])("refuses %s", (_name, text) => {
		const parsed = parseOpsConfig(text, "/");
		expect(parsed.ok ? "" : parsed.error.code).toBe("invalid-request");
	});
});

describe("the frozen entry points", () => {
	it("answer invalid-request for a missing configuration file", async () => {
		const fixture = await opsFixture();
		const context = {
			...fixture.context,
			configPath: `${fixture.dir}/none.json`,
		};
		for (const outcome of [
			await runCeremony(context),
			await rotateKey(context, "witness"),
			await backup(context, `${fixture.dir}/a.backup`),
			await restore(context, `${fixture.dir}/a.backup`),
		])
			expect(outcome.ok ? "" : outcome.error.code).toBe("invalid-request");
	});

	it("answer invalid-request when the NATS credentials are not in the secret store", async () => {
		const fixture = await opsFixture({ natsUrls: ["nats://127.0.0.1:1"] });
		const outcome = await backup(fixture.context, `${fixture.dir}/a.backup`);
		expect(outcome.ok ? "" : outcome.error.code).toBe("invalid-request");
	});

	it("answer unavailable when the bus cannot be reached", async () => {
		const fixture = await opsFixture({ natsUrls: ["nats://127.0.0.1:1"] });
		await fixture.secrets.put(`${fixture.prefix}/nats-authority`, "");
		const outcome = await restore(fixture.context, `${fixture.dir}/a.backup`);
		expect(outcome.ok ? "" : outcome.error.code).toBe("unavailable");
	});
});
