/**
 * An in-memory stand-in for the 1Password SDK's `client.items`, and the same
 * store answering the pact's pseudo-HTTP requests (`POST /sdk/items.<method>`)
 * in the provider verification, so the unit tests and the pact cannot drift.
 */

import type { JsonValue } from "@bufbuild/protobuf";
import type {
	OnePasswordItem,
	OnePasswordItemCreateParams,
	OnePasswordSdkClient,
} from "../../src/sdk-port.js";

export type FakeRequest = Readonly<{
	method: string;
	path: string;
	body?: JsonValue | undefined;
}>;

export type FakeResponse = { status: number; body?: unknown };

class NotFound extends Error {}

export function createFake1Password(vaultId: string) {
	const items = new Map<string, OnePasswordItem>();
	const calls: string[] = [];
	let next = 0;
	const id = (): string => {
		let candidate = "";
		do candidate = `item${String(++next).padStart(22, "a")}`;
		while (items.has(candidate));
		return candidate;
	};
	const client: OnePasswordSdkClient = {
		items: {
			async list(vault) {
				calls.push("items.list");
				return [...items.values()]
					.filter((item) => item.vaultId === vault)
					.map(({ id: itemId, title }) => ({
						id: itemId,
						title,
						vaultId: vault,
					}));
			},
			async get(vault, itemId) {
				calls.push("items.get");
				const item = items.get(itemId);
				if (!item || item.vaultId !== vault)
					throw new NotFound("item not found");
				return structuredClone(item);
			},
			async create(params) {
				calls.push("items.create");
				const item: OnePasswordItem = {
					id: id(),
					title: params.title,
					category: params.category,
					vaultId: params.vaultId,
					fields: structuredClone(params.fields),
					version: 1,
				};
				items.set(item.id, item);
				return structuredClone(item);
			},
			async put(item) {
				calls.push("items.put");
				const stored = items.get(item.id);
				if (!stored) throw new NotFound("item not found");
				const updated = {
					...structuredClone(item),
					version: stored.version + 1,
				};
				items.set(item.id, updated);
				return structuredClone(updated);
			},
		},
	};
	return {
		vaultId,
		client,
		calls,
		items,
		seed(item: OnePasswordItem) {
			items.set(item.id, structuredClone(item));
		},
		async handle(request: FakeRequest): Promise<FakeResponse> {
			// The pact's request bodies are the SDK calls' arguments, as JSON.
			const ids: { vaultId: string; itemId: string } = JSON.parse(
				JSON.stringify(request.body ?? {}),
			);
			try {
				switch (request.path) {
					case "/sdk/items.list":
						return { status: 200, body: await client.items.list(ids.vaultId) };
					case "/sdk/items.get":
						return {
							status: 200,
							body: await client.items.get(ids.vaultId, ids.itemId),
						};
					case "/sdk/items.create": {
						const params: OnePasswordItemCreateParams = JSON.parse(
							JSON.stringify(request.body ?? {}),
						);
						return { status: 200, body: await client.items.create(params) };
					}
					case "/sdk/items.put": {
						const item: OnePasswordItem = JSON.parse(
							JSON.stringify(request.body ?? {}),
						);
						return { status: 200, body: await client.items.put(item) };
					}
					default:
						return { status: 404, body: { error: "no such SDK call" } };
				}
			} catch (error) {
				if (error instanceof NotFound)
					return { status: 404, body: { error: "item not found" } };
				throw error;
			}
		},
	};
}
