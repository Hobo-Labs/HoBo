/**
 * An in-memory stand-in for the Bitwarden SDK's `client.secrets()`, and the
 * same store answering the pact's pseudo-HTTP requests
 * (`POST /sdk/secrets.<method>`) in the provider verification.
 */

import type { JsonValue } from "@bufbuild/protobuf";
import type {
	BitwardenSdkClient,
	BitwardenSecret,
} from "../../src/sdk-port.js";

export type FakeRequest = Readonly<{
	method: string;
	path: string;
	body?: JsonValue | undefined;
}>;

export type FakeResponse = { status: number; body?: unknown };

class NotFound extends Error {}

export function createFakeBitwarden() {
	const secrets = new Map<string, BitwardenSecret>();
	const calls: string[] = [];
	let next = 0x44444443;
	const newId = () => {
		next += 1;
		const hex = next.toString(16);
		return `${hex}-4444-4444-8444-444444444444`;
	};
	let clock = Date.parse("2026-11-12T00:00:00Z");
	const stamp = () => {
		clock += 1000;
		return new Date(clock).toISOString();
	};
	const client: BitwardenSdkClient = {
		secrets: () => ({
			async list(organizationId) {
				calls.push("secrets.list");
				return {
					data: [...secrets.values()]
						.filter((secret) => secret.organizationId === organizationId)
						.map(({ id, key }) => ({ id, key, organizationId })),
				};
			},
			async get(id) {
				calls.push("secrets.get");
				const secret = secrets.get(id);
				if (!secret) throw new NotFound("secret not found");
				return { ...secret };
			},
			async create(organizationId, key, value, note, projectIds) {
				calls.push("secrets.create");
				const secret: BitwardenSecret = {
					id: newId(),
					key,
					value,
					note,
					organizationId,
					projectId: projectIds[0] ?? null,
					revisionDate: stamp(),
				};
				secrets.set(secret.id, secret);
				return { ...secret };
			},
			async update(organizationId, id, key, value, note, projectIds) {
				calls.push("secrets.update");
				if (!secrets.has(id)) throw new NotFound("secret not found");
				const secret: BitwardenSecret = {
					id,
					key,
					value,
					note,
					organizationId,
					projectId: projectIds[0] ?? null,
					revisionDate: stamp(),
				};
				secrets.set(id, secret);
				return { ...secret };
			},
		}),
	};
	return {
		client,
		calls,
		secrets,
		seed(secret: BitwardenSecret) {
			secrets.set(secret.id, { ...secret });
		},
		async handle(request: FakeRequest): Promise<FakeResponse> {
			// The pact's request bodies are the SDK calls' arguments, as JSON.
			const b: {
				organizationId: string;
				id: string;
				key: string;
				value: string;
				note: string;
				projectIds: string[];
			} = JSON.parse(JSON.stringify(request.body ?? {}));
			const api = client.secrets();
			try {
				switch (request.path) {
					case "/sdk/secrets.list":
						return { status: 200, body: await api.list(b.organizationId) };
					case "/sdk/secrets.get":
						return { status: 200, body: await api.get(b.id) };
					case "/sdk/secrets.create":
						return {
							status: 200,
							body: await api.create(
								b.organizationId,
								b.key,
								b.value,
								b.note,
								b.projectIds,
							),
						};
					case "/sdk/secrets.update":
						return {
							status: 200,
							body: await api.update(
								b.organizationId,
								b.id,
								b.key,
								b.value,
								b.note,
								b.projectIds,
							),
						};
					default:
						return { status: 404, body: { error: "no such SDK call" } };
				}
			} catch (error) {
				if (error instanceof NotFound)
					return { status: 404, body: { error: "secret not found" } };
				throw error;
			}
		},
	};
}
