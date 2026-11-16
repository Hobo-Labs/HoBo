import { parseSecretRef } from "@hobo/bindings";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	createInfisicalClient,
	createInfisicalSecretsPort,
	oidcAuth,
	parseInfisicalBinding,
} from "../src/index.js";
import {
	createFakeInfisical,
	type FakeInfisical,
	fakeJwt,
} from "./support/fake-infisical.js";

const scope = {
	projectId: "proj-1",
	environment: "prod",
	secretPath: "/relay",
};
const JWT = fakeJwt("relay");
let fake: FakeInfisical;
let server: { url: string; close: () => Promise<void> };

beforeEach(async () => {
	fake = createFakeInfisical();
	fake.identities.push(
		{ kind: "oidc", identityId: "relay-id", jwt: JWT, access: "read" },
		{ kind: "oidc", identityId: "deploy-id", jwt: JWT, access: "write" },
	);
	server = await fake.listen();
});

afterEach(async () => {
	await server.close();
});

function port(identityId: string) {
	return createInfisicalSecretsPort({
		client: createInfisicalClient({
			binding: parseInfisicalBinding({ siteUrl: server.url, ...scope }),
			auth: oidcAuth({ identityId, jwt: async () => JWT }),
			sleep: async () => {},
		}),
	});
}

describe("the infisical SecretsPort", () => {
	it("has the infisical kind and a reference-only valueRef", async () => {
		fake.seed(scope, "HOBO_CI_WEBHOOK_SECRET", "w".repeat(40));
		const relay = port("relay-id");
		expect(relay.kind).toBe("infisical");
		const result = await relay.access("HOBO_CI_WEBHOOK_SECRET");
		expect(result).toEqual({
			status: "ok",
			valueRef: "infisical://proj-1/prod/relay/HOBO_CI_WEBHOOK_SECRET",
			material: "w".repeat(40),
			versionId: "1",
			source: "provider-federation",
		});
		if (result.status === "ok") {
			expect(parseSecretRef(result.valueRef).scheme).toBe("infisical");
			expect(result.valueRef).not.toContain(result.material ?? "-");
		}
	});

	it("denies instead of throwing on a read failure", async () => {
		expect(await port("relay-id").access("MISSING")).toMatchObject({
			status: "denied",
			code: "secret-not-found",
		});
		fake.fail(() => true, { status: 403, body: {} });
		expect(await port("relay-id").access("X")).toMatchObject({
			status: "denied",
			code: "infisical-login-denied",
		});
	});

	it("writes with a write identity and reads versions back", async () => {
		const deploy = port("deploy-id");
		expect(await deploy.put("K", "one")).toEqual({ versionId: "1" });
		expect(await deploy.put("K", "two")).toEqual({ versionId: "2" });
		expect(await deploy.accessVersion("K", "1")).toMatchObject({
			material: "one",
			versionId: "1",
		});
		expect(await deploy.listVersions("K")).toEqual(["2"]);
		expect(await deploy.accessVersion("K", "v1")).toMatchObject({
			status: "denied",
			code: "secret-version-not-found",
		});
	});

	it("cannot write through the relay's read-only identity", async () => {
		await expect(port("relay-id").put("K", "v")).rejects.toMatchObject({
			code: "forbidden",
		});
	});
});
