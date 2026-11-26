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
	createOnePasswordSecretsPort,
	type OnePasswordItem,
	type OnePasswordSdkClient,
	onePasswordBinding,
} from "../../src/index.js";

// The consumer side of the 1Password SDK pact: the adapter drives a client
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
	).find((candidate) => candidate.provider.name === "OnePasswordSdk");
	if (!found) throw new Error("the 1Password pact is missing");
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
const client: OnePasswordSdkClient = {
	items: {
		list: async (vaultId) => (await send("items.list", { vaultId })) as never,
		get: async (vaultId, itemId) =>
			(await send("items.get", { vaultId, itemId })) as never,
		create: async (params) => (await send("items.create", params)) as never,
		put: async (item: OnePasswordItem) =>
			(await send("items.put", item)) as never,
	},
};
const port = createOnePasswordSecretsPort({
	client,
	binding: onePasswordBinding({
		vaultId: "abcdefghijklmnopqrstuvwxyz",
		authMode: "service-account",
	}),
});

describe("the 1Password SDK boundary (consumer contract)", () => {
	it("names the adapter as consumer and the SDK as provider", () => {
		expect(pact.consumer.name).toBe("HoboOnePasswordAdapter");
		expect(pact.provider.name).toBe("OnePasswordSdk");
	});

	it("reads a secret by its item title, with an op:// reference", async () => {
		const result = await port.access("HOBO_CI_VALKEY_URL");
		expect(result).toMatchObject({
			status: "ok",
			valueRef:
				"op://abcdefghijklmnopqrstuvwxyz/itemaaaaaaaaaaaaaaaaaaaaa1/password",
			material: "fixture-value-1",
			versionId: "1",
		});
		expect(seen.splice(0).every((entry) => entry.matched)).toBe(true);
	});

	it("creates a new secret and updates an existing one", async () => {
		expect(await port.put("NEW_SECRET", "fixture-value-2")).toEqual({
			versionId: "1",
		});
		expect(await port.put("HOBO_CI_VALKEY_URL", "fixture-value-3")).toEqual({
			versionId: "2",
		});
		expect(seen.map((entry) => entry.path)).toEqual([
			"/sdk/items.list",
			"/sdk/items.create",
			"/sdk/items.list",
			"/sdk/items.get",
			"/sdk/items.put",
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
