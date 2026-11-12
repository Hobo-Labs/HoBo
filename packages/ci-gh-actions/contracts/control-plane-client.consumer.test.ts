import { readFileSync } from "node:fs";
import { create, fromJsonString, toJsonString } from "@bufbuild/protobuf";
import { AccountSchema, LeaseSchema, ReconcileRequestSchema } from "@hobo/ci";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { OnboardingOperationSchema } from "../src/_generated/onboarding_pb.js";
import { CiRelayClientError, createCiRelayClient } from "../src/client.js";

const ORIGIN = "https://relay.example";
const TOKEN = "control-tenant-token-with-at-least-32-characters";
const ID = "00000000-0000-4000-8000-000000000001";
const Interaction = z.object({
	description: z.string(),
	request: z.object({
		method: z.enum(["GET", "PUT", "POST"]),
		path: z.string(),
		headers: z.record(z.string(), z.string()),
		body: z.json().optional(),
	}),
	response: z.object({ status: z.number(), body: z.json() }),
});
const pact = z
	.object({ interactions: z.array(Interaction) })
	.parse(
		JSON.parse(
			readFileSync(
				new URL("./control-plane-boundary.pact.json", import.meta.url),
				"utf8",
			),
		),
	);
type Client = ReturnType<typeof createCiRelayClient>;
function invoke(client: Client, interaction: z.infer<typeof Interaction>) {
	const { path, method, body, headers } = interaction.request;
	if (method === "PUT")
		return client.putPolicy(
			fromJsonString(AccountSchema, JSON.stringify(body)),
			{ revision: Number(headers["If-Match"]?.replaceAll('"', "")) },
		);
	if (method === "POST")
		return client.reconcileLease(
			path.split("/").at(-2) ?? "",
			fromJsonString(ReconcileRequestSchema, JSON.stringify(body)).hostRunId,
		);
	if (path.endsWith("/policy")) return client.getPolicy();
	if (path.endsWith("/installations")) return client.getInstallations();
	if (path.endsWith("/leases")) return client.getLeases();
	if (path === "/v1/mesh/nodes") return client.getMeshNodes();
	return client.getSetup(path.split("/").at(-1) ?? "");
}

describe("typed account control-plane client consumer", () => {
	it("stops reading and cancels a finite multi-chunk response at the byte cap", async () => {
		let pulls = 0;
		let cancelled = false;
		const client = createCiRelayClient({
			origin: ORIGIN,
			accountToken: () => TOKEN,
			fetch: async () =>
				new Response(
					new ReadableStream<Uint8Array>({
						pull(controller) {
							if (++pulls > 16) controller.close();
							else controller.enqueue(new Uint8Array(1024 * 1024).fill(32));
						},
						cancel() {
							cancelled = true;
						},
					}),
				),
		});
		await expect(client.getPolicy()).rejects.toEqual(
			new CiRelayClientError(200, "invalid protobuf relay response"),
		);
		expect(cancelled).toBe(true);
		expect(pulls).toBeLessThan(16);
	});
	it.each([
		"http",
		"cross-origin",
		"oversized",
	])("refuses %s responses even when body cancellation never settles", async (kind) => {
		let cancelled = false;
		const response = new Response(
			new ReadableStream<Uint8Array>({
				start(controller) {
					if (kind === "oversized")
						controller.enqueue(new Uint8Array(2 * 1024 * 1024 + 1));
				},
				cancel() {
					cancelled = true;
					return new Promise<void>(() => {});
				},
			}),
			{ status: kind === "http" ? 503 : 200 },
		);
		if (kind === "cross-origin")
			Object.defineProperty(response, "url", {
				value: "https://other.example/policy",
			});
		const client = createCiRelayClient({
			origin: ORIGIN,
			accountToken: () => TOKEN,
			fetch: async () => response,
		});
		await expect(client.getPolicy()).rejects.toBeInstanceOf(CiRelayClientError);
		expect(cancelled).toBe(true);
	}, 1000);
	it("bounds response bytes and rejects malformed UTF-8 without exposing bodies", async () => {
		for (const payload of [
			new Uint8Array(2 * 1024 * 1024 + 1).fill(32),
			new Uint8Array([0xc3, 0x28]),
		]) {
			const client = createCiRelayClient({
				origin: ORIGIN,
				accountToken: () => TOKEN,
				fetch: async () => new Response(payload),
			});
			await expect(client.getPolicy()).rejects.toEqual(
				new CiRelayClientError(200, "invalid protobuf relay response"),
			);
		}
	});
	it("matches all 13 SDK-reachable Pact requests and parses responses or sanitized errors", async () => {
		// Seven malformed wire cases have no SDK method: missing auth (on the policy
		// and on the mesh's node list), missing CAS, account query override, unknown
		// policy/setup fields and a client-authored apply body. Their real HTTP
		// rejection is independently verified by the provider Pact suite.
		const reachable = new Set([1, 3, 4, 5, 8, 9, 10, 11, 14, 15, 16, 17, 19]);
		expect(pact.interactions).toHaveLength(20);
		let exercised = 0;
		for (const [index, interaction] of pact.interactions.entries()) {
			if (!reachable.has(index)) continue;
			let calls = 0;
			const send: typeof fetch = async (url, init) => {
				calls++;
				expect(String(url)).toBe(`${ORIGIN}${interaction.request.path}`);
				expect(init?.method).toBe(interaction.request.method);
				expect(init?.redirect).toBe("error");
				expect(init?.signal?.aborted).toBe(false);
				expect(Object.fromEntries(new Headers(init?.headers))).toEqual(
					Object.fromEntries(new Headers(interaction.request.headers)),
				);
				if (interaction.request.body !== undefined)
					expect(JSON.parse(String(init?.body))).toEqual(
						interaction.request.body,
					);
				else expect(init?.body).toBeUndefined();
				return Response.json(interaction.response.body, {
					status: interaction.response.status,
				});
			};
			const auth = interaction.request.headers.Authorization ?? "";
			const client = createCiRelayClient({
				origin: ORIGIN,
				accountToken: async () => auth.slice(7),
				fetch: send,
			});
			if (interaction.response.status >= 400) {
				await expect(invoke(client, interaction)).rejects.toMatchObject({
					name: "CiRelayClientError",
					status: interaction.response.status,
					message: `relay request failed (${interaction.response.status})`,
				});
			} else {
				const result = await invoke(client, interaction);
				expect(result).toMatchObject(
					z.record(z.string(), z.json()).parse(interaction.response.body),
				);
				expect(result.$typeName).toMatch(/^hobo\.ci\./);
			}
			expect(calls).toBe(1);
			exercised++;
		}
		expect(exercised).toBe(13);
	});

	it("uses generated setup and lease messages on every remaining public method", async () => {
		const operation = create(OnboardingOperationSchema, {
			id: ID,
			status: "planned",
		});
		const lease = create(LeaseSchema, {
			id: ID,
			accountId: "tenant",
			state: "completed",
		});
		const expected = [
			{
				path: "repositories/prepare",
				method: "POST",
				body: { repository: "org/repo", trustedRepositoryAcknowledged: true },
				response: toJsonString(OnboardingOperationSchema, operation),
			},
			{
				path: `repositories/${ID}`,
				method: "GET",
				response: toJsonString(OnboardingOperationSchema, operation),
			},
			{
				path: `repositories/${ID}/apply`,
				method: "POST",
				response: toJsonString(OnboardingOperationSchema, operation),
			},
			{
				path: `repositories/${ID}/connect`,
				method: "POST",
				match: '"8"',
				response: toJsonString(OnboardingOperationSchema, operation),
			},
			{
				path: `leases/${ID}`,
				method: "GET",
				response: toJsonString(LeaseSchema, lease),
			},
			{
				path: `leases/${ID}/reconcile`,
				method: "POST",
				body: { hostRunId: 22 },
				response: toJsonString(LeaseSchema, lease),
			},
		];
		let calls = 0;
		const send: typeof fetch = async (url, init) => {
			const item = expected[calls++];
			if (!item) throw new Error("unexpected extra request");
			expect(String(url)).toBe(`${ORIGIN}/v1/accounts/self/${item.path}`);
			expect(init?.method).toBe(item.method);
			expect(new Headers(init?.headers).get("authorization")).toBe(
				`Bearer ${TOKEN}`,
			);
			expect(new Headers(init?.headers).get("if-match")).toBe(
				item.match ?? null,
			);
			if (item.body) expect(JSON.parse(String(init?.body))).toEqual(item.body);
			else expect(init?.body).toBeUndefined();
			return new Response(item.response, {
				status: item.path.endsWith("/prepare")
					? 201
					: item.path.endsWith("/apply")
						? 202
						: 200,
			});
		};
		const client = createCiRelayClient({
			origin: ORIGIN,
			accountToken: () => TOKEN,
			fetch: send,
		});
		expect(
			await client.prepareRepository({
				repository: "org/repo",
				trustedRepositoryAcknowledged: true,
			}),
		).toEqual(operation);
		expect(await client.getSetup(ID)).toEqual(operation);
		expect(await client.applySetup(ID)).toEqual(operation);
		expect(await client.connectSetup(ID, { revision: 8 })).toEqual(operation);
		expect(await client.getLease(ID)).toEqual(lease);
		expect(await client.reconcileLease(ID, 22)).toEqual(lease);
		expect(calls).toBe(6);
	});

	it.each([
		"http://relay.example",
		"https://user:password@relay.example",
		"https://relay.example/path",
		"https://relay.example?x=1",
		"https://relay.example/#token",
		"file:///tmp/relay",
		"invalid",
		"https://relay.example\\@other.example",
	])("rejects invalid origin before credentials: %s", (value) => {
		let credentials = 0;
		expect(() =>
			createCiRelayClient({
				origin: value,
				accountToken: () => {
					credentials++;
					return TOKEN;
				},
			}),
		).toThrow(CiRelayClientError);
		expect(credentials).toBe(0);
	});
	it.each([
		"http://127.0.0.1:9000",
		"http://localhost:9000",
	])("requires explicit loopback development opt-in: %s", async (value) => {
		expect(() =>
			createCiRelayClient({ origin: value, accountToken: () => TOKEN }),
		).toThrow(/HTTPS/);
		const send: typeof fetch = async () => Response.json({});
		await expect(
			createCiRelayClient({
				origin: value,
				allowInsecureLoopback: true,
				accountToken: () => TOKEN,
				fetch: send,
			}).getLeases(),
		).resolves.toMatchObject({ $typeName: "hobo.ci.v1.Snapshot" });
		expect(() =>
			createCiRelayClient({
				origin: "http://external.example",
				allowInsecureLoopback: true,
				accountToken: () => TOKEN,
			}),
		).toThrow(/HTTPS/);
	});
	it("validates path IDs, revisions and run IDs before looking up credentials or sending", () => {
		let credentials = 0;
		let calls = 0;
		const send: typeof fetch = async () => {
			calls++;
			return Response.json({});
		};
		const client = createCiRelayClient({
			origin: ORIGIN,
			accountToken: () => {
				credentials++;
				return TOKEN;
			},
			fetch: send,
		});
		for (const id of [
			"../policy",
			"https://other.example",
			`${ID}?other=tenant`,
			"",
			"not-a-uuid",
		]) {
			expect(() => client.getSetup(id)).toThrow(CiRelayClientError);
			expect(() => client.applySetup(id)).toThrow(CiRelayClientError);
			expect(() => client.getLease(id)).toThrow(CiRelayClientError);
			expect(() => client.reconcileLease(id, 22)).toThrow(CiRelayClientError);
		}
		for (const value of [
			-1,
			0.5,
			Number.NaN,
			Number.POSITIVE_INFINITY,
			2 ** 32,
		]) {
			expect(() =>
				client.putPolicy({ id: "tenant" }, { revision: value }),
			).toThrow(/revision/);
			expect(() => client.connectSetup(ID, { revision: value })).toThrow(
				/revision/,
			);
		}
		for (const value of [-1, 0, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1])
			expect(() => client.reconcileLease(ID, value)).toThrow(/run identifier/);
		expect(credentials).toBe(0);
		expect(calls).toBe(0);
	});
	it("rejects missing credentials without transmitting an unauthenticated request", async () => {
		let calls = 0;
		const send: typeof fetch = async () => {
			calls++;
			return Response.json({});
		};
		await expect(
			createCiRelayClient({
				origin: ORIGIN,
				accountToken: () => "",
				fetch: send,
			}).getPolicy(),
		).rejects.toMatchObject({ status: 0 });
		expect(calls).toBe(0);
	});
	it("obtains fresh credentials for each operation", async () => {
		let issued = 0;
		const send: typeof fetch = async (_url, init) => {
			expect(new Headers(init?.headers).get("authorization")).toBe(
				`Bearer token-${issued}`,
			);
			return Response.json({});
		};
		const client = createCiRelayClient({
			origin: ORIGIN,
			accountToken: async () => `token-${++issued}`,
			fetch: send,
		});
		await client.getPolicy();
		await client.getLeases();
		expect(issued).toBe(2);
	});
	it.each([
		401, 403, 409, 503,
	])("sanitizes HTTP %i without including private error bodies", async (status) => {
		let cancelled = false;
		const send: typeof fetch = async () =>
			new Response(
				new ReadableStream({
					start(controller) {
						controller.enqueue(
							new TextEncoder().encode(`private account policy ${TOKEN}`),
						);
					},
					cancel() {
						cancelled = true;
					},
				}),
				{ status },
			);
		const client = createCiRelayClient({
			origin: ORIGIN,
			accountToken: () => TOKEN,
			fetch: send,
		});
		await expect(client.getPolicy()).rejects.toEqual(
			new CiRelayClientError(status, `relay request failed (${status})`),
		);
		expect(cancelled).toBe(true);
	});
	it("sanitizes token lookup and network errors", async () => {
		const secret = `private error ${TOKEN}`;
		await expect(
			createCiRelayClient({
				origin: ORIGIN,
				accountToken: () => {
					throw new Error(secret);
				},
			}).getPolicy(),
		).rejects.toEqual(
			new CiRelayClientError(0, "account credentials unavailable"),
		);
		const send: typeof fetch = async (_url, init) => {
			expect(init?.redirect).toBe("error");
			throw new Error(secret);
		};
		await expect(
			createCiRelayClient({
				origin: ORIGIN,
				accountToken: () => TOKEN,
				fetch: send,
			}).getPolicy(),
		).rejects.toEqual(
			new CiRelayClientError(
				0,
				"relay transport failed; operation outcome may be unconfirmed",
			),
		);
	});
	it.each([
		"https://other.example/v1/accounts/self/policy",
		"https://relay.example/redirected",
	])("rejects redirected or cross-origin responses: %s", async (url) => {
		let cancelled = false;
		const send: typeof fetch = async () => {
			const response = new Response(
				new ReadableStream({
					cancel() {
						cancelled = true;
					},
				}),
			);
			Object.defineProperty(response, "url", { value: url });
			Object.defineProperty(response, "redirected", {
				value: url.startsWith(`${ORIGIN}/`),
			});
			return response;
		};
		await expect(
			createCiRelayClient({
				origin: ORIGIN,
				accountToken: () => TOKEN,
				fetch: send,
			}).getPolicy(),
		).rejects.toThrow(/crossed origin or redirected/);
		expect(cancelled).toBe(true);
	});
	it.each([
		{ unknownPrivateField: "private" },
		{ revision: -1 },
		{ revision: "not-an-integer" },
		{ status: "wrong protobuf message" },
	])("rejects malformed or mismatched protobuf response %#", async (body) => {
		const send: typeof fetch = async () => Response.json(body);
		await expect(
			createCiRelayClient({
				origin: ORIGIN,
				accountToken: () => TOKEN,
				fetch: send,
			}).getPolicy(),
		).rejects.toEqual(
			new CiRelayClientError(200, "invalid protobuf relay response"),
		);
	});
});
