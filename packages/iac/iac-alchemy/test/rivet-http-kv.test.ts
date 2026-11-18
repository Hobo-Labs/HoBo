import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DurableObjectResource, Providers } from "@alchemy.run/rivet";
import type { PoolHost } from "@alchemy.run/rivet/Host";
import { inMemoryState, Stack } from "alchemy";
import * as Alchemist from "alchemy/Alchemist";
import * as Provider from "alchemy/Provider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { setup } from "rivetkit";
import { describe, expect, it, vi } from "vitest";
import { alchemyTarget, createAlchemyIacProvider } from "../src/index.js";
import { describeRivetPrimitiveSupport } from "../src/rivet-catalog.js";
import {
	createRivetHttpKvApplication,
	createRivetHttpKvMappers,
} from "../src/rivet-http-kv.js";
import type {
	RivetAsyncKvResult,
	RivetAsyncKvTransportClaim,
} from "../src/rivet-kv.js";
import { createRivetAsyncKvActor } from "../src/rivet-kv-runtime.js";
import {
	routeFixture,
	testOperation,
	testStateOwnership,
} from "./route-fixture.js";

const digest = `sha256:${"a".repeat(64)}`;
const environmentDigest = `sha256:${"d".repeat(64)}`;

function fixture() {
	const storage = createRivetAsyncKvActor({
		actorName: "settings",
		semanticDigest: environmentDigest,
		authorize: () => true,
		verifyIngress: () => true,
	});
	let allowed = true;
	let poolAllowed = true;
	let requests = 0;
	let onFetch = () => {};
	let respond = (_path: string, _init: RequestInit) =>
		new Response("unavailable", { status: 503 });
	let receiptAllowed = true;
	const dispatches: RequestInit[] = [];
	const attestations: RivetAsyncKvTransportClaim[] = [];
	const transport = {
		actorName: storage.actorName,
		actorId: "physical-kv-1",
		actorKey: ["tenant-a", "settings"],
		semanticDigest: storage.semanticDigest,
		fetch: async (path: string, init: RequestInit) => {
			requests++;
			dispatches.push(init);
			onFetch();
			return respond(path, init);
		},
		verifyTransport: (claim: RivetAsyncKvTransportClaim) => {
			attestations.push(claim);
			return claim.phase !== "receipt" || receiptAllowed;
		},
	};
	const trustedFetch = transport.fetch;
	const options = {
		actorName: "web",
		storage,
		transport,
		verifyScope: ({
			scope,
			transport: observed,
		}: {
			scope: {
				actorName: string;
				actorId: string;
				actorKey: readonly string[];
			};
			transport: { fetch: typeof transport.fetch };
		}) =>
			allowed &&
			observed.fetch === trustedFetch &&
			scope.actorName === "settings" &&
			scope.actorId === "physical-kv-1" &&
			scope.actorKey.join("/") === "tenant-a/settings",
		authorize: ({
			actorKey,
			request,
			storage: scope,
		}: {
			actorKey: readonly string[];
			request: { headers: Headers };
			storage: { actorKey: readonly string[] };
		}) =>
			actorKey[0] === scope.actorKey[0] &&
			request.headers.get("authorization") === "tenant-a-token",
		application:
			(client: {
				get: (
					key: string,
				) => Promise<RivetAsyncKvResult<Uint8Array | undefined>>;
			}) =>
			async () => {
				const result = await client.get("greeting");
				return Response.json(result);
			},
	};
	const application = createRivetHttpKvApplication(options);
	const registry = setup({
		use: { web: application.http.actor, settings: storage.actor },
		noWelcome: true,
	});
	const source = {
		main: "/src/http-kv.ts",
		resourceName: "web",
		kind: "web" as const,
		actorName: "web",
		sourceDigest: digest,
		sourceFence: {
			sourceDigest: digest,
			environmentDigest,
			proofRef: "host:shared",
			verify: () => true,
		},
		registry,
		binding: application.http,
		verifySource: () => true,
	};
	const poolHost: PoolHost["Service"] = {
		deployExternal: () => Effect.void,
		deployCrate: () => Effect.void,
	};
	const mapperOptions = {
		application,
		source,
		poolDigest: `sha256:${"b".repeat(64)}`,
		isolationDigest: `sha256:${"c".repeat(64)}`,
		poolHost,
		verifyPool: () => poolAllowed,
	};
	const mapperInput = {
		declaration: {
			name: "web",
			kind: "web",
			stableId: "web:web",
			declaredAllow: [],
			dependsOn: [],
			annotations: [],
		},
		entrypoint: application.http.entrypoint,
		requirements: {},
		bindleName: "app",
		dependencyDeclarations: {},
		dependencies: {},
	};
	return {
		storage,
		transport,
		options,
		application,
		source,
		mapperOptions,
		mapperInput,
		requests: () => requests,
		attestations,
		dispatches,
		reply: (callback: typeof respond) => {
			respond = callback;
		},
		rejectReceipt: () => {
			receiptAllowed = false;
		},
		revoke: () => {
			allowed = false;
		},
		revokePool: () => {
			poolAllowed = false;
		},
		onFetch: (callback: () => void) => {
			onFetch = callback;
		},
	};
}

describe("Rivet HTTP application and async key-value actor", () => {
	it("binds each HTTP key and principal to the exact KV actor scope", async () => {
		const f = fixture();
		const request = (token = "tenant-a-token") =>
			new Request("https://app.test/", { headers: { authorization: token } });
		expect(
			(
				await f.application.http.handle(
					{ name: "web", key: ["tenant-b"], vars: {} },
					request(),
				)
			).status,
		).toBe(403);
		expect(
			(
				await f.application.http.handle(
					{ name: "web", key: ["tenant-a"], vars: {} },
					request("wrong"),
				)
			).status,
		).toBe(403);
		expect(f.requests()).toBe(0);
		const response = await f.application.http.handle(
			{ name: "web", key: ["tenant-a"], vars: {} },
			request(),
		);
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			status: "unknown",
			code: "outcome-unknown",
			operation: {
				requestId: expect.any(String),
				fingerprint: expect.any(String),
			},
		});
		expect(f.requests()).toBe(1);
		expect(f.attestations.map((claim) => claim.phase)).toEqual([
			"dispatch",
			"receipt",
		]);
		for (const claim of f.attestations) {
			expect(claim).toMatchObject({
				actorName: "settings",
				actorId: "physical-kv-1",
				actorKey: ["tenant-a", "settings"],
				singleDispatch: true,
			});
			expect(Object.isFrozen(claim.receiver)).toBe(true);
		}
		expect(f.dispatches[0]?.redirect).toBe("error");
		const body = f.dispatches[0]?.body;
		/* oxlint-disable-next-line anti-slop/no-runtime-typeof -- SAFETY: the test checks the concrete serialized request before hashing it. */
		if (typeof body !== "string") throw new Error("missing request body");
		expect(f.attestations[0]).toMatchObject({
			phase: "dispatch",
			request: {
				method: "POST",
				path: "/get",
				redirect: "error",
				byteLength: Buffer.byteLength(body),
				sha256: `sha256:${createHash("sha256").update(body).digest("hex")}`,
			},
		});
		expect(f.attestations[1]).toMatchObject({
			phase: "receipt",
			response: {
				status: 503,
				byteLength: Buffer.byteLength("unavailable"),
				sha256: `sha256:${createHash("sha256").update("unavailable").digest("hex")}`,
			},
		});
	});

	it.each([
		{
			name: "unavailable before execution",
			decisions: ["unavailable"],
			status: 503,
			execution: "not-started",
			calls: 0,
		},
		{
			name: "denied before execution",
			decisions: ["deny"],
			status: 403,
			execution: undefined,
			calls: 0,
		},
		{
			name: "denied after dispatch",
			decisions: ["allow", "deny"],
			status: 403,
			execution: "possibly-completed",
			calls: 1,
		},
		{
			name: "unavailable after dispatch",
			decisions: ["allow", "unavailable"],
			status: 503,
			execution: "possibly-completed",
			calls: 1,
		},
	])("reports $name explicitly", async ({
		decisions,
		status,
		execution,
		calls,
	}) => {
		const f = fixture();
		let index = 0;
		const application = createRivetHttpKvApplication({
			...f.options,
			authorize: () => {
				const decision = decisions[index++];
				if (decision === "unavailable") throw new Error("unavailable");
				return decision === "allow";
			},
		});
		const response = await application.http.handle(
			{ name: "web", key: ["tenant-a"], vars: {} },
			new Request("https://app.test/", {
				headers: { authorization: "tenant-a-token" },
			}),
		);
		expect(response.status).toBe(status);
		if (execution !== undefined)
			expect(await response.json()).toMatchObject({ execution });
		expect(f.requests()).toBe(calls);
	});

	it("rejects an unobservable authorization thenable without reading it", async () => {
		const f = fixture();
		let traps = 0;
		let calls = 0;
		const unobservable = new Proxy(
			{},
			{
				get() {
					traps++;
					throw new Error("untrusted thenable");
				},
			},
		);
		const application = createRivetHttpKvApplication({
			...f.options,
			authorizationTimeoutMs: 20,
			authorize: () => {
				calls++;
				// oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- SAFETY: exercise an untyped authorizer returning an unsupported result.
				return unobservable as never;
			},
		});
		const response = await application.http.handle(
			{ name: "web", key: ["tenant-a"], vars: {} },
			new Request("https://app.test/"),
		);
		expect(response.status).toBe(503);
		expect(calls).toBe(1);
		expect(traps).toBe(0);
		expect(f.requests()).toBe(0);
	});

	it("rechecks the KV scope after an asynchronous authorization settles", async () => {
		const f = fixture();
		let delaying = false;
		let release: (value: boolean) => void = () => {};
		let entered: () => void = () => {};
		const started = new Promise<void>((resolve) => {
			entered = resolve;
		});
		const decision = new Promise<boolean>((resolve) => {
			release = resolve;
		});
		const application = createRivetHttpKvApplication({
			...f.options,
			authorize: () => {
				if (!delaying) return true;
				entered();
				return decision;
			},
		});
		const vars = {};
		const context = { name: "web", key: ["tenant-a"], vars };
		expect(
			(await application.http.handle(context, new Request("https://app.test/")))
				.status,
		).toBe(200);
		expect(f.requests()).toBe(1);
		delaying = true;
		const pending = application.http.handle(
			context,
			new Request("https://app.test/"),
		);
		await started;
		f.revoke();
		release(true);
		expect((await pending).status).toBe(503);
		expect(f.requests()).toBe(1);
	});

	it("does not start a scope check after authorization has timed out", async () => {
		const f = fixture();
		let release: (value: boolean) => void = () => {};
		let checks = 0;
		let called = false;
		const decision = new Promise<boolean>((resolve) => {
			release = resolve;
		});
		const application = createRivetHttpKvApplication({
			...f.options,
			authorizationTimeoutMs: 20,
			verifyScope: (claim) => {
				checks++;
				return f.options.verifyScope(claim);
			},
			authorize: () => {
				called = true;
				return decision;
			},
		});
		const response = await application.http.handle(
			{ name: "web", key: ["tenant-a"], vars: {} },
			new Request("https://app.test/"),
		);
		expect(response.status).toBe(503);
		expect(called).toBe(true);
		const checksAtTimeout = checks;
		release(true);
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(checks).toBe(checksAtTimeout);
		expect(f.requests()).toBe(0);
	});

	it("uses a precreated failure response after the authorizer changes Response.json", async () => {
		const f = fixture();
		const original = Object.getOwnPropertyDescriptor(Response, "json");
		if (original === undefined) throw new Error("native Response.json missing");
		let checks = 0;
		let traps = 0;
		const application = createRivetHttpKvApplication({
			...f.options,
			authorize: () => {
				checks++;
				if (checks === 2) {
					Object.defineProperty(Response, "json", {
						configurable: true,
						value: () => {
							traps++;
							throw new Error("substituted Response.json");
						},
					});
					return false;
				}
				return true;
			},
		});
		let response: Response;
		try {
			response = await application.http.handle(
				{ name: "web", key: ["tenant-a"], vars: {} },
				new Request("https://app.test/"),
			);
		} finally {
			Object.defineProperty(Response, "json", original);
		}
		expect(response.status).toBe(403);
		expect(await response.json()).toMatchObject({
			error: "authorization-denied",
			execution: "possibly-completed",
		});
		expect(traps).toBe(0);
		expect(f.requests()).toBe(1);
	});

	it("does not expose a reply that the independently trusted receipt verifier refuses", async () => {
		const f = fixture();
		f.reply((_path, init) => {
			const headers = new Headers(init.headers);
			return Response.json({
				requestId: headers.get("x-hobo-kv-request-id"),
				fingerprint: headers.get("x-hobo-kv-fingerprint"),
				semanticDigest: environmentDigest,
				operation: "get",
				value: Buffer.from("secret").toString("base64"),
			});
		});
		f.rejectReceipt();
		const response = await f.application.http.handle(
			{ name: "web", key: ["tenant-a"], vars: {} },
			new Request("https://app.test/", {
				headers: { authorization: "tenant-a-token" },
			}),
		);
		expect(await response.json()).toMatchObject({
			status: "unknown",
			code: "outcome-unknown",
		});
		expect(f.attestations.map((claim) => claim.phase)).toEqual([
			"dispatch",
			"receipt",
		]);
		expect(f.requests()).toBe(1);
	});

	it("does not disclose a result when scope is revoked during KV work", async () => {
		const f = fixture();
		f.onFetch(f.revoke);
		const response = await f.application.http.handle(
			{ name: "web", key: ["tenant-a"], vars: {} },
			new Request("https://app.test/", {
				headers: { authorization: "tenant-a-token" },
			}),
		);
		expect(response.status).toBe(503);
		expect(await response.json()).toMatchObject({
			error: "authorization-unavailable",
			execution: "possibly-completed",
		});
		expect(f.requests()).toBe(1);
		expect(f.attestations[0]).toMatchObject({
			phase: "dispatch",
			requestId: expect.any(String),
			fingerprint: expect.any(String),
		});
	});

	it("does not treat pending response cancellation as stream retirement", async () => {
		const f = fixture();
		let allowed = true;
		let cancellationStarted = false;
		let retire = () => {};
		const pending = new Promise<void>((resolve) => {
			retire = resolve;
		});
		const application = createRivetHttpKvApplication({
			...f.options,
			authorize: () => allowed,
			application: () => async () => {
				allowed = false;
				return new Response(
					new ReadableStream({
						cancel() {
							cancellationStarted = true;
							return pending;
						},
					}),
				);
			},
		});
		try {
			const response = await application.http.handle(
				{ name: "web", key: ["tenant-a"], vars: {} },
				new Request("https://app.test/"),
			);
			expect(response.status).toBe(403);
			expect(await response.json()).toMatchObject({
				execution: "possibly-completed",
			});
			expect(cancellationStarted).toBe(true);
			let retired = false;
			void pending.then(() => {
				retired = true;
			});
			await Promise.resolve();
			expect(retired).toBe(false);
		} finally {
			retire();
			await pending;
		}
	});

	it("does not read response or stream accessors while suppressing disclosure", async () => {
		const f = fixture();
		let allowed = true;
		let traps = 0;
		let cancellations = 0;
		const body = new ReadableStream({
			cancel() {
				cancellations++;
			},
		});
		const undisclosed = new Response(body);
		Object.defineProperty(undisclosed, "body", {
			get() {
				traps++;
				throw new Error("response body accessor");
			},
		});
		Object.defineProperty(body, "cancel", {
			get() {
				traps++;
				throw new Error("stream cancellation accessor");
			},
		});
		const application = createRivetHttpKvApplication({
			...f.options,
			authorize: () => allowed,
			application: () => async () => {
				allowed = false;
				return undisclosed;
			},
		});
		const response = await application.http.handle(
			{ name: "web", key: ["tenant-a"], vars: {} },
			new Request("https://app.test/"),
		);
		expect(response.status).toBe(403);
		expect(await response.json()).toMatchObject({
			execution: "possibly-completed",
		});
		expect(traps).toBe(0);
		expect(cancellations).toBe(1);
	});

	it("bounds stalled pre-effect authorization without starting the application", async () => {
		const f = fixture();
		let checks = 0;
		const application = createRivetHttpKvApplication({
			...f.options,
			authorizationTimeoutMs: 100,
			authorize: () => {
				checks++;
				return new Promise<boolean>(() => {});
			},
		});
		const response = await application.http.handle(
			{ name: "web", key: ["tenant-a"], vars: {} },
			new Request("https://app.test/", {
				headers: { authorization: "tenant-a-token" },
			}),
		);
		expect(response.status).toBe(503);
		expect(await response.json()).toMatchObject({ execution: "not-started" });
		expect(checks).toBe(1);
		expect(f.requests()).toBe(0);
	});

	it("classifies stalled post-effect authorization as possibly completed", async () => {
		const f = fixture();
		let checks = 0;
		const application = createRivetHttpKvApplication({
			...f.options,
			authorizationTimeoutMs: 100,
			authorize: () => {
				checks++;
				return checks === 1 ? true : new Promise<boolean>(() => {});
			},
		});
		const response = await application.http.handle(
			{ name: "web", key: ["tenant-a"], vars: {} },
			new Request("https://app.test/", {
				headers: { authorization: "tenant-a-token" },
			}),
		);
		expect(response.status).toBe(503);
		expect(await response.json()).toMatchObject({
			execution: "possibly-completed",
		});
		expect(f.requests()).toBe(1);
	});

	it("classifies an application failure after KV dispatch as possibly completed", async () => {
		const f = fixture();
		const application = createRivetHttpKvApplication({
			...f.options,
			application: (client) => async () => {
				await client.set("key", new Uint8Array([1]));
				throw new Error("application failed after dispatch");
			},
		});
		const response = await application.http.handle(
			{ name: "web", key: ["tenant-a"], vars: {} },
			new Request("https://app.test/", {
				headers: { authorization: "tenant-a-token" },
			}),
		);
		expect(response.status).toBe(503);
		expect(await response.json()).toMatchObject({
			error: "application-failed",
			execution: "possibly-completed",
		});
		expect(f.requests()).toBe(1);
	});

	it("reauthorizes a later attempt after an uncached application factory failure", async () => {
		const f = fixture();
		let initializations = 0;
		const application = createRivetHttpKvApplication({
			...f.options,
			application: () => {
				initializations++;
				throw new Error("application factory failed");
			},
		});
		const vars = {};
		for (let index = 0; index < 2; index++) {
			const response = await application.http.handle(
				{ name: "web", key: ["tenant-a"], vars },
				new Request("https://app.test/", {
					headers: { authorization: "tenant-a-token" },
				}),
			);
			expect(response.status).toBe(503);
			expect(await response.json()).toMatchObject({
				error: "application-failed",
				execution: "possibly-completed",
			});
		}
		expect(initializations).toBe(2);
	});

	it("classifies a malformed application result without exposing it", async () => {
		const f = fixture();
		const options = { ...f.options };
		Reflect.set(options, "application", () => async () => ({
			secret: "not a response",
		}));
		const application = createRivetHttpKvApplication(options);
		const response = await application.http.handle(
			{ name: "web", key: ["tenant-a"], vars: {} },
			new Request("https://app.test/", {
				headers: { authorization: "tenant-a-token" },
			}),
		);
		expect(response.status).toBe(503);
		expect(await response.json()).toEqual({
			error: "application-failed",
			execution: "possibly-completed",
		});
	});

	it("rejects an asynchronous application factory without an unhandled rejection", async () => {
		const f = fixture();
		const options = { ...f.options };
		Reflect.set(options, "application", () =>
			Promise.reject(new Error("failed factory")),
		);
		const application = createRivetHttpKvApplication(options);
		const response = await application.http.handle(
			{ name: "web", key: ["tenant-a"], vars: {} },
			new Request("https://app.test/", {
				headers: { authorization: "tenant-a-token" },
			}),
		);
		expect(response.status).toBe(503);
		expect(await response.json()).toEqual({
			error: "application-failed",
			execution: "possibly-completed",
		});
		await Promise.resolve();
	});

	it("reauthorizes the original HTTP principal after application request mutation", async () => {
		const f = fixture();
		const observed: (string | null)[] = [];
		const application = createRivetHttpKvApplication({
			...f.options,
			authorize: ({ request }) => {
				observed.push(request.headers.get("authorization"));
				return request.headers.get("authorization") === "tenant-a-token";
			},
			application: (client) => async (request) => {
				request.headers.set("authorization", "other-tenant-token");
				return Response.json(await client.get("greeting"));
			},
		});
		const response = await application.http.handle(
			{ name: "web", key: ["tenant-a"], vars: {} },
			new Request("https://app.test/", {
				headers: { authorization: "tenant-a-token" },
			}),
		);
		expect(response.status).toBe(200);
		expect(observed).toEqual(["tenant-a-token", "tenant-a-token"]);
		expect(f.requests()).toBe(1);
	});

	it("captures the exact transport and authorizer before inputs are mutated", async () => {
		const f = fixture();
		let forged = 0;
		f.transport.actorKey[0] = "tenant-b";
		f.transport.actorId = "different-actor";
		f.transport.fetch = async () => {
			forged++;
			return new Response();
		};
		f.options.authorize = () => {
			forged++;
			return true;
		};
		const response = await f.application.http.handle(
			{ name: "web", key: ["tenant-a"], vars: {} },
			new Request("https://app.test/", {
				headers: { authorization: "tenant-a-token" },
			}),
		);
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({ status: "unknown" });
		expect(f.requests()).toBe(1);
		expect(forged).toBe(0);
	});

	it("binds the exact two-actor registry to an independently verified exclusive pool", () => {
		const f = fixture();
		const mapper = createRivetHttpKvMappers(f.mapperOptions).web;
		expect(() => mapper.validate(f.mapperInput)).not.toThrow();
		const unexpected = setup({
			use: {
				web: f.application.http.actor,
				settings: f.storage.actor,
				extra: f.storage.actor,
			},
			noWelcome: true,
		});
		expect(() =>
			createRivetHttpKvMappers({
				...f.mapperOptions,
				source: { ...f.source, registry: unexpected },
			}),
		).toThrow("RIVET_POOL_UNVERIFIED");
		f.revokePool();
		expect(() => mapper.validate(f.mapperInput)).toThrow(
			"RIVET_POOL_UNVERIFIED",
		);
	});

	it("discloses asynchronous KV limits through the provider capability catalog", () => {
		const f = fixture();
		const support = describeRivetPrimitiveSupport(
			[
				{ factory: "web", allowVerbs: [] },
				{ factory: "kv", allowVerbs: ["get", "set"] },
			],
			createRivetHttpKvMappers(f.mapperOptions),
		);
		expect(support).toEqual([
			expect.objectContaining({
				kind: "web",
				status: "partial",
				resourceTypes: ["Rivet.DurableObject"],
				reason: expect.stringContaining("asynchronous"),
			}),
			expect.objectContaining({
				kind: "kv",
				status: "unsupported",
				reason: expect.stringContaining("WASI"),
			}),
		]);
	});

	it("plans an actual Alchemy Rivet DurableObject for the combined registry", async () => {
		const f = fixture();
		const mapper = createRivetHttpKvMappers(f.mapperOptions).web;
		const providers = Layer.effect(
			Providers,
			Provider.collection([DurableObjectResource]),
		).pipe(
			Layer.provide(
				Provider.succeed(DurableObjectResource, {
					reconcile: () =>
						Effect.succeed({
							name: "web",
							pool: "pool",
							endpoint: "https://rivet.test",
							namespace: "test",
							token: undefined,
						}),
					delete: () => Effect.void,
				}),
			),
		);
		const stack = Stack(
			"App",
			{ providers, state: inMemoryState() },
			mapper.build(f.mapperInput).pipe(Effect.map(() => ({}))),
		);
		const directory = mkdtempSync(join(tmpdir(), "hobo-http-kv-plan-"));
		const previous = process.env.ALCHEMY_HOME;
		process.env.ALCHEMY_HOME = join(directory, "auth");
		try {
			const provider = createAlchemyIacProvider({
				stateOwnership: testStateOwnership,
				stack,
				runtimeLayer: Alchemist.layer(),
				runtimeDirectory: directory,
				composite: {
					proofRef: "host:shared",
					environmentDigest,
					sourceRequirements: [
						{
							resourceId: "web",
							resourceType: "Rivet.DurableObject",
							bindleName: "app",
							applicationName: "web",
							sourceKind: "rivet-http",
							sourcePath: f.source.main,
						},
					],
					verifyEnvironment: () => true,
					verifyPlan: ({ sourceClaims }) =>
						sourceClaims.length === 1 &&
						sourceClaims[0]?.sourcePath === f.source.main,
				},
				target: alchemyTarget({
					targetId: "yard",
					tenantId: "tenant",
					stackName: "App",
					stage: "test",
					programResourceId: "app",
					sourceDigest: digest,
					inventoryEvidenceRef: "inventory:1",
					resources: [
						{
							resourceId: "web",
							resourceType: "Rivet.DurableObject",
							providerId: "rivet",
							providerAccountRef: "account",
							productId: "actor",
						},
					],
				}),
				financial: {
					assess: (inventory) => ({ inventory }),
					admit: async () => {
						throw new Error("unexpected admission");
					},
					revalidate: () => true,
					uncertain: () => {},
				},
			});
			const result = await provider.preview({
				programId: "app",
				deploymentId: "deployment",
				resourceId: "app",
				provider: "rivet",
				driver: "external",
				action: "apply",
				stackName: "App",
			});
			expect(result.changes).toBe(1);
		} finally {
			if (previous === undefined) delete process.env.ALCHEMY_HOME;
			else process.env.ALCHEMY_HOME = previous;
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it("keeps the actual reservation uncertain when combined pool authority is revoked during apply", async () => {
		const f = fixture();
		let effects = 0;
		const providers = Layer.effect(
			Providers,
			Provider.collection([DurableObjectResource]),
		).pipe(
			Layer.provide(
				Provider.succeed(DurableObjectResource, {
					reconcile: () =>
						Effect.sync(() => {
							effects++;
							f.revokePool();
							return {
								name: "web",
								pool: "pool",
								endpoint: "https://rivet.test",
								namespace: "test",
								token: undefined,
							};
						}),
					delete: () => Effect.void,
				}),
			),
		);
		const mapper = createRivetHttpKvMappers(f.mapperOptions).web;
		const stack = Stack(
			"App",
			{ providers, state: inMemoryState() },
			mapper.build(f.mapperInput).pipe(Effect.map(() => ({}))),
		);
		const directory = mkdtempSync(join(tmpdir(), "hobo-http-kv-revoke-"));
		const previous = process.env.ALCHEMY_HOME;
		process.env.ALCHEMY_HOME = join(directory, "auth");
		const base = routeFixture({ inventoryHash: `sha256:${"d".repeat(64)}` });
		const outcomes: string[] = [];
		const route = {
			...base.port,
			async runDirect<T>(...args: Parameters<typeof base.port.runDirect<T>>) {
				return base.port.runDirect(args[0], async (attempt) => {
					const result = await args[1](attempt);
					outcomes.push(result.outcome.status);
					return result;
				});
			},
		};
		const admit = vi.fn(async (requestId: string) => ({
			requestId,
			targetId: "yard",
			status: "admitted",
			code: "",
			message: "",
			budget: { evaluation: "allowed", reservation: "held" },
			reservation: { reservationId: `iac:${requestId}` },
			requestDigest: `sha256:${"c".repeat(64)}`,
			inventoryHash: `sha256:${"d".repeat(64)}`,
			modelHash: `sha256:${"e".repeat(64)}`,
			quoteHash: `sha256:${"f".repeat(64)}`,
		}));
		const uncertain = vi.fn();
		try {
			const provider = createAlchemyIacProvider({
				stateOwnership: testStateOwnership,
				stack,
				runtimeLayer: Alchemist.layer(),
				runtimeDirectory: directory,
				route,
				resolveRoute: async ({ requestId }) => ({
					requestId: requestId ?? "request",
					operation: testOperation,
				}),
				target: alchemyTarget({
					targetId: "yard",
					tenantId: "tenant",
					stackName: "App",
					stage: "test",
					programResourceId: "app",
					sourceDigest: digest,
					inventoryEvidenceRef: "inventory:1",
					resources: [
						{
							resourceId: "web",
							resourceType: "Rivet.DurableObject",
							providerId: "rivet",
							providerAccountRef: "account",
							productId: "actor",
						},
					],
				}),
				composite: {
					proofRef: "host:shared",
					environmentDigest,
					sourceRequirements: [
						{
							resourceId: "web",
							resourceType: "Rivet.DurableObject",
							bindleName: "app",
							applicationName: "web",
							sourceKind: "rivet-http",
							sourcePath: f.source.main,
						},
					],
					verifyEnvironment: () => true,
					verifyPlan: ({ sourceClaims }) =>
						sourceClaims.length === 1 &&
						sourceClaims[0]?.sourcePath === f.source.main,
				},
				financial: {
					assess: (inventory) => ({ inventory }),
					admit,
					revalidate: () => true,
					uncertain,
				},
			});
			const program = {
				programId: "app",
				deploymentId: "d",
				resourceId: "app",
				provider: "rivet",
				driver: "external",
				action: "apply" as const,
				stackName: "App",
				operationGeneration: "generation-1",
			};
			await provider.preview(program);
			await expect(
				provider.applyWithAdmission(program, "request"),
			).rejects.toMatchObject({
				code: "SOURCE_FENCE_UNCERTAIN",
				executionOutcome: "completed",
				requiresReconciliation: true,
				reservationId: "iac:request",
			});
			expect(effects).toBe(1);
			expect(uncertain).toHaveBeenCalledExactlyOnceWith("iac:request");
			expect(outcomes).toEqual(["uncertain"]);
			await expect(
				provider.applyWithAdmission(program, "request"),
			).rejects.toMatchObject({ code: "EXECUTION_ALREADY_CLAIMED" });
			expect(effects).toBe(1);
			expect(admit).toHaveBeenCalledOnce();
		} finally {
			if (previous === undefined) delete process.env.ALCHEMY_HOME;
			else process.env.ALCHEMY_HOME = previous;
			rmSync(directory, { recursive: true, force: true });
		}
	});

	/* oxlint-disable anti-slop/no-runtime-typeof, anti-slop/no-reflect-apply, anti-slop/no-object-parameters -- SAFETY: these tests deliberately replace JavaScript intrinsics at the provider boundary. */
	it("retains every mapper limitation when a pool verifier replaces array iteration", () => {
		const f = fixture();
		const expected = createRivetHttpKvMappers(f.mapperOptions).web.limitations;
		const nativeIterator = Array.prototype[Symbol.iterator];
		let redirected = 0;
		let limitations: readonly string[] | undefined;
		try {
			const mappers = createRivetHttpKvMappers({
				...f.mapperOptions,
				verifyPool: () => {
					Reflect.set(
						Array.prototype,
						Symbol.iterator,
						function (this: string[]) {
							if (
								typeof this[0] === "string" &&
								this[0].startsWith("Only the attested source kind")
							) {
								redirected++;
								return Reflect.apply(nativeIterator, [], []);
							}
							return Reflect.apply(nativeIterator, this, []);
						},
					);
					return true;
				},
			});
			limitations = mappers.web.limitations;
		} finally {
			Reflect.set(Array.prototype, Symbol.iterator, nativeIterator);
		}
		expect(limitations).toEqual(expected);
		expect(redirected).toBe(0);
	});

	it("does not let a substituted WeakMap getter forge an application binding", () => {
		const f = fixture();
		const fake = { http: f.application.http, storage: f.storage };
		const original = Object.getOwnPropertyDescriptor(WeakMap.prototype, "get");
		if (original === undefined) throw new Error("WeakMap.get missing");
		const nativeGet = original.value;
		let traps = 0;
		try {
			Object.defineProperty(WeakMap.prototype, "get", {
				...original,
				value(this: WeakMap<object, unknown>, key: object) {
					if (key === fake) {
						traps++;
						return { ...fake, verify: () => true };
					}
					return Reflect.apply(nativeGet, this, [key]);
				},
			});
			expect(() =>
				createRivetHttpKvMappers({ ...f.mapperOptions, application: fake }),
			).toThrow();
		} finally {
			Object.defineProperty(WeakMap.prototype, "get", original);
		}
		expect(traps).toBe(0);
	});
	/* oxlint-enable anti-slop/no-runtime-typeof, anti-slop/no-reflect-apply, anti-slop/no-object-parameters */

	it("refuses mismatched storage actors and unverified client scopes", () => {
		const f = fixture();
		expect(() =>
			createRivetHttpKvApplication({ ...f.options, storage: { ...f.storage } }),
		).toThrow();
		expect(() =>
			createRivetHttpKvApplication({
				...f.options,
				transport: {
					...f.transport,
					semanticDigest: `sha256:${"e".repeat(64)}`,
				},
			}),
		).toThrow();
		expect(() =>
			createRivetHttpKvApplication({ ...f.options, verifyScope: () => false }),
		).toThrow();
		expect(() =>
			createRivetHttpKvMappers({
				...f.mapperOptions,
				application: { ...f.application },
			}),
		).toThrow();
	});

	it("rejects accessor and Proxy inputs without invoking them", () => {
		const f = fixture();
		let reads = 0;
		const hostile = Object.defineProperty({ ...f.transport }, "actorId", {
			enumerable: true,
			get() {
				reads++;
				return "physical-kv-1";
			},
		});
		const proxy = new Proxy(f.options, {
			getOwnPropertyDescriptor() {
				reads++;
				throw new Error("proxy trap");
			},
		});
		expect(() =>
			createRivetHttpKvApplication({ ...f.options, transport: hostile }),
		).toThrow();
		expect(() => createRivetHttpKvApplication(proxy)).toThrow();
		expect(reads).toBe(0);
	});

	it.each([
		"string",
		"setter",
		"integer",
	] as const)("preserves the complete transport actor key when %s is replaced", (method) => {
		const f = fixture();
		const NativeString = globalThis.String;
		const nativeInteger = Number.isSafeInteger;
		const previous = Object.getOwnPropertyDescriptor(Array.prototype, "0");
		let setterCalls = 0;
		let captured: readonly string[] | undefined;
		const restore = () => {
			Reflect.set(globalThis, "String", NativeString);
			Reflect.set(Number, "isSafeInteger", nativeInteger);
			if (previous) Object.defineProperty(Array.prototype, "0", previous);
			else Reflect.deleteProperty(Array.prototype, "0");
		};
		const options = {
			...f.options,
			verifyScope: ({ scope }: { scope: { actorKey: readonly string[] } }) => {
				captured = scope.actorKey;
				restore();
				return true;
			},
		};
		try {
			if (method === "string")
				Reflect.set(globalThis, "String", (value: number) =>
					value === 1 ? "0" : NativeString(value),
				);
			else if (method === "integer")
				Reflect.set(Number, "isSafeInteger", () => false);
			else
				Object.defineProperty(Array.prototype, "0", {
					configurable: true,
					set() {
						setterCalls++;
					},
				});
			createRivetHttpKvApplication(options);
		} finally {
			restore();
		}
		expect(captured).toEqual(["tenant-a", "settings"]);
		expect(setterCalls).toBe(0);
		expect(Object.getOwnPropertyDescriptor(captured, "0")).toMatchObject({
			value: "tenant-a",
			enumerable: true,
		});
	});

	it("rejects a decorated actor key when reflection is substituted", () => {
		const f = fixture();
		const key = Object.assign(["tenant-a", "settings"], { extra: true });
		const original = Reflect.ownKeys;
		try {
			Reflect.ownKeys = (value) =>
				value === key ? ["0", "1", "length"] : original(value);
			expect(() =>
				createRivetHttpKvApplication({
					...f.options,
					transport: { ...f.transport, actorKey: key },
				}),
			).toThrow("RIVET_SOURCE_INVALID");
		} finally {
			Reflect.ownKeys = original;
		}
	});

	it("rejects a nonstandard actor key prototype when reflection is substituted", () => {
		const f = fixture();
		const key = ["tenant-a", "settings"];
		Object.setPrototypeOf(key, Object.create(Array.prototype));
		const original = Object.getPrototypeOf;
		try {
			Object.getPrototypeOf = (value) =>
				value === key ? Array.prototype : original(value);
			expect(() =>
				createRivetHttpKvApplication({
					...f.options,
					transport: { ...f.transport, actorKey: key },
				}),
			).toThrow("RIVET_SOURCE_INVALID");
		} finally {
			Object.getPrototypeOf = original;
		}
	});

	it("rejects a forged array-like actor key when the array predicate is substituted", () => {
		const f = fixture();
		const key = Object.assign(Object.create(Array.prototype), {
			0: "tenant-a",
			1: "settings",
			length: 2,
		});
		const original = Array.isArray;
		try {
			Array.isArray = (value): value is unknown[] =>
				value === key || original(value);
			expect(() =>
				createRivetHttpKvApplication({
					...f.options,
					transport: { ...f.transport, actorKey: key },
				}),
			).toThrow("RIVET_SOURCE_INVALID");
		} finally {
			Array.isArray = original;
		}
	});

	it("keeps the scope and transport immutable if the global freezer is replaced", () => {
		const f = fixture();
		const frozen: boolean[] = [];
		const original = Object.freeze;
		try {
			Object.freeze = <T>(value: T): Readonly<T> => value;
			createRivetHttpKvApplication({
				...f.options,
				verifyScope: (claim) => {
					frozen.push(
						Object.isFrozen(claim),
						Object.isFrozen(claim.scope),
						Object.isFrozen(claim.scope.actorKey),
						Object.isFrozen(claim.transport),
					);
					return true;
				},
			});
		} finally {
			Object.freeze = original;
		}
		expect(frozen.length).toBeGreaterThan(0);
		expect(frozen.every(Boolean)).toBe(true);
	});

	it.each([
		0,
		60_001,
		1.5,
		Number.NaN,
	])("rejects the invalid authorization timeout %s before starting work", (timeout) => {
		const f = fixture();
		expect(() =>
			createRivetHttpKvApplication({
				...f.options,
				authorizationTimeoutMs: timeout,
			}),
		).toThrow();
		expect(f.requests()).toBe(0);
	});

	it("rejects async scope attestations without treating their result as proof", async () => {
		const f = fixture();
		const options = { ...f.options };
		Object.defineProperty(options, "verifyScope", {
			value: () => Promise.reject(new Error("rejected")),
			enumerable: true,
		});
		expect(() => createRivetHttpKvApplication(options)).toThrow();
		await Promise.resolve();
	});
});
