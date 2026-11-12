import path from "node:path";
import { fileURLToPath } from "node:url";
import type { JsonValue } from "@bufbuild/protobuf";
import {
	checkPactInventory,
	createMockProviderFromPact,
	loadPactDirectory,
	type PactDocument,
	type PactRequest,
} from "@hobo/contract-harness";
import { beforeAll, describe, expect, it } from "vitest";
import {
	type BitwardenSdkClient,
	bitwardenBinding,
	createBitwardenSecretsPort,
} from "../../src/index.js";

// The consumer side of the Bitwarden SDK pact: the adapter drives a client
// whose every SDK call is answered by the pact's mock (each call is a
// pseudo-HTTP request `POST /sdk/<call>` with the call's arguments as the
// body). No SDK and no network is involved.

const contractsDir = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
);
let pact: PactDocument;
const seen: { path: string; matched: boolean }[] = [];

beforeAll(async () => {
	const found = (
		await loadPactDirectory(path.join(contractsDir, "pacts"))
	).find(
		(candidate) => candidate.provider.name === "BitwardenSecretsManagerSdk",
	);
	if (!found) throw new Error("the Bitwarden pact is missing");
	pact = found;
});

class SdkNotFound extends Error {}

async function send(call: string, body: JsonValue) {
	const mock = createMockProviderFromPact(pact);
	// The pact holds JSON: a round trip types the arguments as such.
	const request: PactRequest = {
		method: "POST",
		path: `/sdk/${call}`,
		body: JSON.parse(JSON.stringify(body)),
	};
	const response = await mock.handle(request);
	const matched = !JSON.stringify(response.body ?? "").includes(
		"PACT_NO_INTERACTION",
	);
	seen.push({ path: request.path, matched });
	if (response.status === 404) throw new SdkNotFound("not found");
	if (response.status !== 200) throw new Error("unexpected status");
	return response.body;
}

// SAFETY: the mock answers with the SDK's recorded results.
const client: BitwardenSdkClient = {
	secrets: () => ({
		list: async (organizationId) =>
			(await send("secrets.list", { organizationId })) as never,
		get: async (id) => (await send("secrets.get", { id })) as never,
		create: async (organizationId, key, value, note, projectIds) =>
			(await send("secrets.create", {
				organizationId,
				key,
				value,
				note,
				projectIds,
			})) as never,
		update: async (organizationId, id, key, value, note, projectIds) =>
			(await send("secrets.update", {
				organizationId,
				id,
				key,
				value,
				note,
				projectIds,
			})) as never,
	}),
};
const port = createBitwardenSecretsPort({
	client,
	binding: bitwardenBinding({
		organizationId: "11111111-1111-4111-8111-111111111111",
		projectId: "22222222-2222-4222-8222-222222222222",
	}),
});

describe("the Bitwarden SDK boundary (consumer contract)", () => {
	it("names the adapter as consumer and the SDK as provider", () => {
		expect(pact.consumer.name).toBe("HoboBitwardenAdapter");
		expect(pact.provider.name).toBe("BitwardenSecretsManagerSdk");
	});

	it("reads a secret of the bound project, with a bitwarden:// reference", async () => {
		const result = await port.access("HOBO_CI_VALKEY_URL");
		expect(result).toMatchObject({
			status: "ok",
			valueRef:
				"bitwarden://11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222/33333333-3333-4333-8333-333333333333",
			material: "fixture-value-1",
			versionId: "2026-11-12T00:00:00.000Z",
		});
		expect(seen.splice(0).every((entry) => entry.matched)).toBe(true);
	});

	it("creates a new secret and updates an existing one", async () => {
		await port.put("NEW_SECRET", "fixture-value-2");
		await port.put("HOBO_CI_VALKEY_URL", "fixture-value-3");
		expect(seen.map((entry) => entry.path)).toEqual([
			"/sdk/secrets.list",
			"/sdk/secrets.create",
			"/sdk/secrets.list",
			"/sdk/secrets.get",
			"/sdk/secrets.update",
		]);
		expect(seen.splice(0).every((entry) => entry.matched)).toBe(true);
	});

	it("records no value in a request path", () => {
		for (const interaction of pact.interactions)
			expect(interaction.request.path).not.toMatch(/fixture-value/u);
	});

	it("lists the pact in the inventory", async () => {
		expect(await checkPactInventory(contractsDir)).toEqual({
			ok: true,
			problems: [],
		});
	});
});
