import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	DEPLOYMENT_PLAN_SCHEMA,
	type DeploymentPlan,
	deploymentPlanned,
	hashDeploymentPlan,
	type IacProgram,
	type ResourcePlan,
} from "@hobo/cloud";
import {
	createResolverRegistry,
	type HttpTransport,
	RESOLVER_CONTRACT,
	type ResolveOutcome,
	type ResolveRequest,
	ResolverError,
	type ResourceResolver,
	type TransportResponse,
} from "@hobo/core";
import {
	CLOUDFLARE_KV_PRODUCT_ID,
	cloudflareResolverRegistry,
	guardedCloudflareTransport,
} from "@hobo/provider-cloudflare";
import { VERCEL_PROJECT_PRODUCT_ID } from "@hobo/provider-vercel";
import {
	createManualClock,
	createRuntimeLocalEventStore,
	type RuntimeLocalEventStore,
} from "@hobo/runtime-local";
import { afterEach, describe, expect, it } from "vitest";
import { selectIacProvider } from "../src/compose.js";
import type { JsonObject, JsonValue } from "../src/json.js";
import type { PulumiAutomationAdapter } from "../src/pulumi-iac-provider.js";
import {
	createResolverBackedIacProvider,
	RESOLVER_PREVIEW_UNDETERMINED,
	ResolverIacError,
	type ResolverIacRegistry,
} from "../src/resolver-iac-provider.js";

// What this test proves and what it does not.
//
// PROVEN: the composed deploy path recovers each resource's desired state from a
// REAL `deployment.Planned` fact on a REAL durable event store, routes it to the
// REAL `@hobo/provider-cloudflare` KV resolver through the REAL Cloudflare
// transport guard, and converges — apply twice yields one namespace and one
// physical id. Every request/response shape is the resolver's own.
//
// NOT PROVEN: nothing here touches api.cloudflare.com. The transport is an
// injected fake modelling an account; there is no live deploy, no real
// credential, and no network egress in this file.

const ACCOUNT_ID = "acct-0123456789";
// Long enough to trip the resolvers' token-shaped redaction, so the leak
// assertions below are meaningful rather than vacuous.
const FAKE_TOKEN = "cf-test-token-abcdefghijklmnop";
const DEPLOYMENT_ID = "dep-resolver-1";
const CREDENTIAL_REF = "hobo-token://cloudflare/api-token";
const BLIND_PRODUCT_ID = "blind.thing/v1";
const STEERED_PRODUCT_ID = "steered.thing/v1";

// Every path that must not touch the network gets this: reaching it is the
// failure, not an exception to be handled.
const unreachableTransport: HttpTransport = async () => {
	throw new Error("the transport must not be reached on this path");
};

let openStores: RuntimeLocalEventStore[] = [];
afterEach(() => {
	for (const store of openStores) store.close();
	openStores = [];
});

function newStore(): RuntimeLocalEventStore {
	const store = createRuntimeLocalEventStore({
		dataDir: mkdtempSync(join(tmpdir(), "hobo-resolver-iac-")),
		clock: createManualClock(),
	});
	openStores.push(store);
	return store;
}

function planOf(resources: readonly ResourcePlan[]): DeploymentPlan {
	return {
		schema: DEPLOYMENT_PLAN_SCHEMA,
		resources: [...resources],
		dependencyOrder: resources.map((entry) => entry.name),
		objective: "min-cost",
	};
}

async function storeWithPlan(
	resources: readonly ResourcePlan[],
	deploymentId = DEPLOYMENT_ID,
): Promise<RuntimeLocalEventStore> {
	const store = newStore();
	const plan = planOf(resources);
	await store.append(
		`deployment:${deploymentId}`,
		[
			deploymentPlanned({
				deploymentId,
				planHash: hashDeploymentPlan(plan),
				plan,
			}),
		],
		{
			expectedSeq: 0,
			actor: { kind: "system", id: "test" },
			tenant: "hobo-dev",
		},
	);
	return store;
}

function program(
	resourceId: string,
	action: IacProgram["action"] = "apply",
	deploymentId = DEPLOYMENT_ID,
): IacProgram {
	return {
		programId: `prog-${resourceId}`,
		deploymentId,
		resourceId,
		provider: "cloudflare",
		driver: "resolver",
		action,
		stackName: `${deploymentId}/${resourceId}`,
	};
}

// ---------------------------------------------------------------------------
// The injected fake: a Cloudflare account that only knows KV namespaces.
// ---------------------------------------------------------------------------

interface RecordedCall {
	readonly method: string;
	readonly path: string;
	readonly body: string | undefined;
}

interface FakeAccount {
	readonly transport: HttpTransport;
	readonly calls: RecordedCall[];
	readonly namespaces: Map<string, { id: string; title: string }>;
	/** Error text the next call answers with, instead of the modelled state. */
	failWith?: string;
}

const KV_PATH = `/client/v4/accounts/${ACCOUNT_ID}/storage/kv/namespaces`;

function ok(payload: JsonValue): TransportResponse {
	return {
		status: 200,
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ success: true, errors: [], result: payload }),
	};
}

function createFakeCloudflareAccount(): FakeAccount {
	const namespaces = new Map<string, { id: string; title: string }>();
	const calls: RecordedCall[] = [];
	let nextId = 1;
	const account: FakeAccount = {
		calls,
		namespaces,
		transport: async (request) => {
			const url = new URL(request.url);
			calls.push({
				method: request.method,
				path: url.pathname,
				body: request.body,
			});
			if (account.failWith !== undefined) {
				return {
					status: 403,
					headers: { "content-type": "application/json" },
					body: JSON.stringify({
						success: false,
						errors: [{ code: 10000, message: account.failWith }],
						result: null,
					}),
				};
			}
			if (request.method === "GET" && url.pathname === KV_PATH) {
				return {
					status: 200,
					headers: { "content-type": "application/json" },
					body: JSON.stringify({
						success: true,
						errors: [],
						result: [...namespaces.values()],
						result_info: { total_pages: 1 },
					}),
				};
			}
			if (request.method === "POST" && url.pathname === KV_PATH) {
				// SAFETY: assertion required at this I/O or test boundary.
				const title = (JSON.parse(request.body ?? "{}") as { title: string })
					.title;
				const record = { id: `ns-${nextId}`, title };
				nextId += 1;
				namespaces.set(record.id, record);
				return ok(record);
			}
			if (
				request.method === "DELETE" &&
				url.pathname.startsWith(`${KV_PATH}/`)
			) {
				const id = decodeURIComponent(url.pathname.slice(`${KV_PATH}/`.length));
				if (!namespaces.delete(id)) {
					return { status: 404, headers: {}, body: notFoundBody() };
				}
				return ok(null);
			}
			return { status: 404, headers: {}, body: notFoundBody() };
		},
	};
	return account;
}

function notFoundBody(): string {
	return JSON.stringify({
		success: false,
		errors: [{ code: 10009, message: "not found" }],
		result: null,
	});
}

// The registry the driver routes on: the REAL Cloudflare resolvers, with this
// test standing in for the host that resolves the locator to material. The
// driver itself never sees the token.
function cloudflareRegistry(): ResolverIacRegistry {
	return cloudflareResolverRegistry({
		accountId: ACCOUNT_ID,
		resolveCredential: async (ref: string): Promise<string> => {
			if (ref !== CREDENTIAL_REF) {
				throw new Error(`unknown credential locator ${JSON.stringify(ref)}`);
			}
			return FAKE_TOKEN;
		},
	});
}

function kvNode(
	name: string,
	realizationParameters?: JsonObject,
): ResourcePlan {
	return {
		name,
		port: "kv",
		provider: "cloudflare",
		deps: [],
		productId: CLOUDFLARE_KV_PRODUCT_ID,
		...(realizationParameters !== undefined
			? { realizationParameters }
			: undefined),
	};
}

function driverFor(
	store: RuntimeLocalEventStore,
	account: FakeAccount,
): ReturnType<typeof createResolverBackedIacProvider> {
	return createResolverBackedIacProvider({
		store,
		registry: cloudflareRegistry(),
		transport: guardedCloudflareTransport(account.transport),
		credentialRef: CREDENTIAL_REF,
	});
}

describe("resolver-backed IacProvider: apply and convergence", () => {
	it("apply creates the resource and reports the resolver's outcome", async () => {
		const store = await storeWithPlan([kvNode("sessions")]);
		const account = createFakeCloudflareAccount();
		const outputs = await driverFor(store, account).apply(program("sessions"));

		expect(account.namespaces.size).toBe(1);
		expect(outputs["hobo.resolver.action"]).toBe("create");
		expect(outputs["hobo.resolver.contract"]).toBe(RESOLVER_CONTRACT);
		expect(outputs["hobo.resolver.physicalId"]).toBe("ns-1");
		expect(outputs.title).toBe("sessions");
		expect(outputs.namespaceId).toBe("ns-1");
	});

	it("applying twice reconciles to the SAME physicalId and creates no second resource", async () => {
		const store = await storeWithPlan([kvNode("sessions")]);
		const account = createFakeCloudflareAccount();
		const driver = driverFor(store, account);

		const first = await driver.apply(program("sessions"));
		const second = await driver.apply(program("sessions"));

		expect(account.namespaces.size).toBe(1);
		expect(second["hobo.resolver.physicalId"]).toBe(
			first["hobo.resolver.physicalId"],
		);
		expect(first["hobo.resolver.action"]).toBe("create");
		// This driver holds no state, so the second run honestly reports that it
		// found a resource it did not create rather than claiming a verified noop.
		expect(second["hobo.resolver.action"]).toBe("adopt");
		expect(account.calls.filter((call) => call.method === "POST")).toHaveLength(
			1,
		);
	});

	it("surfaces resolver diagnostics rather than swallowing them", async () => {
		const store = await storeWithPlan([kvNode("sessions", { ttlSeconds: 60 })]);
		const account = createFakeCloudflareAccount();
		const outputs = await driverFor(store, account).apply(program("sessions"));

		const diagnostics = outputs["hobo.resolver.diagnostics"];
		expect(diagnostics).toBeDefined();
		expect(diagnostics).toContain("ttlSeconds is declared but not applied");
	});
});

describe("resolver-backed IacProvider: destroy", () => {
	it("removes the resource", async () => {
		const store = await storeWithPlan([kvNode("sessions")]);
		const account = createFakeCloudflareAccount();
		const driver = driverFor(store, account);

		await driver.apply(program("sessions"));
		expect(account.namespaces.size).toBe(1);

		await driver.destroy(program("sessions", "destroy"));
		expect(account.namespaces.size).toBe(0);
	});

	it("destroying an absent resource succeeds", async () => {
		const store = await storeWithPlan([kvNode("sessions")]);
		const account = createFakeCloudflareAccount();

		await expect(
			driverFor(store, account).destroy(program("sessions", "destroy")),
		).resolves.toBeUndefined();
		expect(account.namespaces.size).toBe(0);
	});
});

describe("resolver-backed IacProvider: fail-closed refusals", () => {
	it("refuses a plan node with no productId and names the remediation", async () => {
		const store = await storeWithPlan([
			{ name: "sessions", port: "kv", provider: "cloudflare", deps: [] },
		]);
		const account = createFakeCloudflareAccount();

		const error = await driverFor(store, account)
			.apply(program("sessions"))
			.catch((cause: unknown) => cause);

		expect(error).toBeInstanceOf(ResolverIacError);
		// SAFETY: assertion required at this I/O or test boundary.
		const typed = error as ResolverIacError;
		expect(typed.code).toBe("RESOLVER_IAC_PRODUCT_UNDECIDED");
		expect(typed.message).toContain("productId");
		expect(typed.remediation).toContain("Yard binding authority");
		// The remediation must not suggest guessing a product from the port.
		expect(typed.remediation).toContain("ADR-0144");
		// Nothing was sent: an undecided product never reaches the provider.
		expect(account.calls).toHaveLength(0);
	});

	it("refuses an unregistered productId and names the product", async () => {
		const store = await storeWithPlan([
			{
				name: "sessions",
				port: "kv",
				provider: "cloudflare",
				deps: [],
				productId: "nowhere.thing/v1",
			},
		]);
		const account = createFakeCloudflareAccount();

		const error = await driverFor(store, account)
			.apply(program("sessions"))
			.catch((cause: unknown) => cause);

		expect(error).toBeInstanceOf(ResolverIacError);
		// SAFETY: assertion required at this I/O or test boundary.
		const typed = error as ResolverIacError;
		expect(typed.code).toBe("RESOLVER_IAC_PRODUCT_UNREGISTERED");
		expect(typed.message).toContain("nowhere.thing/v1");
		expect(typed.remediation).toContain(CLOUDFLARE_KV_PRODUCT_ID);
		expect(account.calls).toHaveLength(0);
	});

	it("refuses a deployment with no stored plan rather than silently no-opping a destroy", async () => {
		const store = newStore();
		const account = createFakeCloudflareAccount();

		const error = await driverFor(store, account)
			.destroy(program("sessions", "destroy"))
			.catch((cause: unknown) => cause);

		expect(error).toBeInstanceOf(ResolverIacError);
		// SAFETY: assertion required at this I/O or test boundary.
		expect((error as ResolverIacError).code).toBe("RESOLVER_IAC_PLAN_MISSING");
	});

	it("refuses a capability port outside the slot vocabulary", async () => {
		const store = await storeWithPlan([
			{
				name: "sessions",
				port: "ledger",
				provider: "cloudflare",
				deps: [],
				productId: CLOUDFLARE_KV_PRODUCT_ID,
			},
		]);
		const account = createFakeCloudflareAccount();

		const error = await driverFor(store, account)
			.apply(program("sessions"))
			.catch((cause: unknown) => cause);

		expect(error).toBeInstanceOf(ResolverIacError);
		// SAFETY: assertion required at this I/O or test boundary.
		expect((error as ResolverIacError).code).toBe(
			"RESOLVER_IAC_SLOT_UNDECIDED",
		);
	});
});

describe("resolver-backed IacProvider: preview never mutates and never lies", () => {
	it("preview issues only read calls", async () => {
		const store = await storeWithPlan([kvNode("sessions")]);
		const account = createFakeCloudflareAccount();

		await driverFor(store, account).preview(program("sessions", "preview"));

		expect(account.calls.length).toBeGreaterThan(0);
		for (const call of account.calls) {
			expect(call.method).toBe("GET");
		}
		expect(account.namespaces.size).toBe(0);
	});

	it("preview reports a create when the resource is absent", async () => {
		const store = await storeWithPlan([kvNode("sessions")]);
		const account = createFakeCloudflareAccount();

		const diff = await driverFor(store, account).preview(
			program("sessions", "preview"),
		);
		expect(diff.changes).toBe(1);
		expect(diff.summary).toContain("absent at the provider");
	});

	it("preview reports UNDETERMINED, not zero, for declared parameters read() cannot observe", async () => {
		const store = await storeWithPlan([kvNode("sessions", { ttlSeconds: 60 })]);
		const account = createFakeCloudflareAccount();
		const driver = driverFor(store, account);
		await driver.apply(program("sessions"));

		const diff = await driver.preview(program("sessions", "preview"));
		expect(diff.changes).toBe(RESOLVER_PREVIEW_UNDETERMINED);
		expect(diff.changes).not.toBe(0);
		expect(diff.summary).toContain("UNDETERMINED");
		// Diagnostics reach the diff, not just the outputs.
		expect(diff.summary).toContain("ttlSeconds is declared but not applied");
	});

	it("preview reports UNDETERMINED when the resolver implements no read()", async () => {
		const store = await storeWithPlan([
			{
				name: "sessions",
				port: "kv",
				provider: "blind",
				deps: [],
				productId: BLIND_PRODUCT_ID,
			},
		]);
		const driver = createResolverBackedIacProvider({
			store,
			registry: createResolverRegistry([blindResolver()]),
			transport: unreachableTransport,
			credentialRef: CREDENTIAL_REF,
		});

		const diff = await driver.preview(program("sessions", "preview"));
		expect(diff.changes).toBe(RESOLVER_PREVIEW_UNDETERMINED);
		expect(diff.summary).toContain("no read()");
		expect(diff.summary).toContain('This is not "no changes"');
	});

	it("preview reports zero only when every declared parameter was observed and matched", async () => {
		// `title` is a declared parameter the KV resolver echoes back, so this is
		// the one branch where a zero is an observation rather than an assumption.
		const store = await storeWithPlan([
			kvNode("sessions", { title: "sessions" }),
		]);
		const account = createFakeCloudflareAccount();
		const driver = driverFor(store, account);
		await driver.apply(program("sessions"));

		const diff = await driver.preview(program("sessions", "preview"));
		expect(diff.changes).toBe(0);
		expect(diff.summary).toContain("every declared parameter matches");
	});

	it("preview leaves out the parameters the resolver names as directives, and says so", async () => {
		const store = await storeWithPlan([
			steeredNode({ title: "sessions", purgeOnDelete: true }),
		]);
		const driver = steeredDriver(store, ["purgeOnDelete"]);

		const diff = await driver.preview(program("sessions", "preview"));
		expect(diff.changes).toBe(0);
		expect(diff.summary).toContain(
			"every compared declared parameter matches what the provider reports",
		);
		expect(diff.summary).not.toContain("every declared parameter matches");
		expect(diff.summary).toContain("Not compared: purgeOnDelete");
	});

	it("preview compares a directive that read() reports, so naming a state key as one hides no drift", async () => {
		const store = await storeWithPlan([steeredNode({ size: 3 })]);
		const driver = steeredDriver(store, ["size"], { size: 2 });

		const diff = await driver.preview(program("sessions", "preview"));
		expect(diff.changes).toBe(1);
		expect(diff.summary).toContain("declared parameter(s) differ (size)");
		expect(diff.summary).not.toContain("Not compared");

		const report = await driver.refresh(program("sessions"));
		expect(report.drift).toBe(true);
		expect(report.observed["hobo.resolver.drift.determined"]).toBe("true");
		expect(report.observed["hobo.resolver.drift.reason"]).toContain(
			"differ from what the provider reports: size",
		);
		// Compared, so not listed as left out.
		expect(report.observed).not.toHaveProperty(
			"hobo.resolver.drift.notCompared",
		);
	});

	it("preview reports a reported directive that matches as compared, not as left out", async () => {
		const store = await storeWithPlan([steeredNode({ size: 2 })]);
		const driver = steeredDriver(store, ["size"], { size: 2 });

		const diff = await driver.preview(program("sessions", "preview"));
		expect(diff.changes).toBe(0);
		expect(diff.summary).toContain(
			"every declared parameter matches what the provider reports",
		);
		expect(diff.summary).not.toContain("Not compared");
	});

	it("preview still counts a declared parameter the resolver does not name as a directive", async () => {
		const store = await storeWithPlan([
			steeredNode({ title: "sessions", purgeOnDelete: true }),
		]);
		const driver = steeredDriver(store, []);

		const diff = await driver.preview(program("sessions", "preview"));
		expect(diff.changes).toBe(RESOLVER_PREVIEW_UNDETERMINED);
		expect(diff.summary).toContain("(purgeOnDelete) have no counterpart");
	});

	it("preview counts the declared parameters that actually differ", async () => {
		const store = await storeWithPlan([kvNode("sessions", { title: "other" })]);
		const account = createFakeCloudflareAccount();
		const driver = driverFor(store, account);
		await driver.apply(program("sessions"));

		const diff = await driver.preview(program("sessions", "preview"));
		expect(diff.changes).toBe(1);
		expect(diff.summary).toContain("declared parameter(s) differ (title)");
	});
});

describe("resolver-backed IacProvider: refresh", () => {
	it("reports drift as UNDETERMINED rather than clean when the resolver has no read()", async () => {
		const store = await storeWithPlan([
			{
				name: "sessions",
				port: "kv",
				provider: "blind",
				deps: [],
				productId: BLIND_PRODUCT_ID,
			},
		]);
		const report = await createResolverBackedIacProvider({
			store,
			registry: createResolverRegistry([blindResolver()]),
			transport: unreachableTransport,
			credentialRef: CREDENTIAL_REF,
		}).refresh(program("sessions"));

		expect(report.observed["hobo.resolver.drift.determined"]).toBe("false");
		expect(report.drift).toBe(true);
		expect(report.observed["hobo.resolver.drift.reason"]).toContain(
			"no read()",
		);
	});

	it("reports a determined clean read when everything declared matches", async () => {
		const store = await storeWithPlan([kvNode("sessions")]);
		const account = createFakeCloudflareAccount();
		const driver = driverFor(store, account);
		await driver.apply(program("sessions"));

		const report = await driver.refresh(program("sessions"));
		expect(report.drift).toBe(false);
		expect(report.observed["hobo.resolver.drift.determined"]).toBe("true");
		expect(report.observed["hobo.resolver.physicalId"]).toBe("ns-1");
	});

	it("reports a determined clean read when the only unobserved parameters are directives", async () => {
		const store = await storeWithPlan([
			steeredNode({ title: "sessions", purgeOnDelete: true }),
		]);

		const report = await steeredDriver(store, ["purgeOnDelete"]).refresh(
			program("sessions"),
		);
		expect(report.drift).toBe(false);
		expect(report.observed["hobo.resolver.drift.determined"]).toBe("true");
		expect(report.observed["hobo.resolver.drift.reason"]).toContain(
			"every compared declared parameter matches what the provider reports. Not compared: purgeOnDelete",
		);
		expect(report.observed["hobo.resolver.drift.notCompared"]).toBe(
			'["purgeOnDelete"]',
		);
	});

	it.each([
		[5, "a number"],
		["purgeOnDelete", "a string"],
		[["purgeOnDelete", "purgeOnDelete"], "a repeated name"],
	])("refuses, as a typed refusal, a registry outside core whose resolver lists %o (%s) as its directives", async (directives: JsonValue, _why: string) => {
		const store = await storeWithPlan([
			steeredNode({ title: "sessions", purgeOnDelete: true }),
		]);
		const resolver = Object.assign(steeredResolver([]), { directives });
		const driver = createResolverBackedIacProvider({
			store,
			// A structural registry, not createResolverRegistry, so nothing
			// checked the resolver on the way in.
			registry: { get: () => resolver, list: () => [resolver] },
			transport: unreachableTransport,
			credentialRef: CREDENTIAL_REF,
		});

		for (const call of [
			driver.preview(program("sessions", "preview")),
			driver.refresh(program("sessions")),
		]) {
			const refusal = await call.then(
				() => undefined,
				(error: Error) => error,
			);
			expect(refusal).toBeInstanceOf(ResolverError);
			expect(refusal instanceof ResolverError ? refusal.code : "").toBe(
				"RESOLVER_PRODUCT_UNSUPPORTED",
			);
		}
	});

	// hobo.resolver.drift.notCompared lists the directives the comparison left
	// out: only those declared AND unreported, never the resolver's whole list,
	// and on every verdict that compared anything.
	describe("hobo.resolver.drift.notCompared", () => {
		const LISTED = ["purgeOnDelete", "retainOnDelete"];

		it("lists only the declared directives left out, on a clean verdict", async () => {
			const store = await storeWithPlan([
				steeredNode({ title: "sessions", purgeOnDelete: true }),
			]);

			const report = await steeredDriver(store, LISTED).refresh(
				program("sessions"),
			);
			expect(report.drift).toBe(false);
			expect(report.observed["hobo.resolver.drift.notCompared"]).toBe(
				'["purgeOnDelete"]',
			);
		});

		it("carries them on a verdict of real differences", async () => {
			const store = await storeWithPlan([
				steeredNode({ title: "other", purgeOnDelete: true }),
			]);

			const report = await steeredDriver(store, LISTED).refresh(
				program("sessions"),
			);
			expect(report.drift).toBe(true);
			expect(report.observed["hobo.resolver.drift.determined"]).toBe("true");
			expect(report.observed["hobo.resolver.drift.notCompared"]).toBe(
				'["purgeOnDelete"]',
			);
		});

		it("carries them on an UNDETERMINED verdict", async () => {
			const store = await storeWithPlan([
				steeredNode({ title: "sessions", ttlSeconds: 60, purgeOnDelete: true }),
			]);

			const report = await steeredDriver(store, LISTED).refresh(
				program("sessions"),
			);
			expect(report.drift).toBe(true);
			expect(report.observed["hobo.resolver.drift.determined"]).toBe("false");
			expect(report.observed["hobo.resolver.drift.notCompared"]).toBe(
				'["purgeOnDelete"]',
			);
		});

		it("is absent when the plan declares none of the directives", async () => {
			const store = await storeWithPlan([steeredNode({ title: "sessions" })]);

			const report = await steeredDriver(store, LISTED).refresh(
				program("sessions"),
			);
			expect(report.drift).toBe(false);
			expect(report.observed).not.toHaveProperty(
				"hobo.resolver.drift.notCompared",
			);
		});
	});

	it("reports drift when the resource the plan describes is gone", async () => {
		const store = await storeWithPlan([kvNode("sessions")]);
		const account = createFakeCloudflareAccount();

		const report = await driverFor(store, account).refresh(program("sessions"));
		expect(report.drift).toBe(true);
		expect(report.observed["hobo.resolver.exists"]).toBe("false");
		expect(report.observed["hobo.resolver.drift.determined"]).toBe("true");
	});
});

describe("resolver-backed IacProvider: credential custody", () => {
	it("never puts credential material in outputs", async () => {
		const store = await storeWithPlan([kvNode("sessions")]);
		const account = createFakeCloudflareAccount();
		const outputs = await driverFor(store, account).apply(program("sessions"));

		expect(JSON.stringify(outputs)).not.toContain(FAKE_TOKEN);
	});

	it("never echoes credential material in a provider refusal", async () => {
		const store = await storeWithPlan([kvNode("sessions")]);
		const account = createFakeCloudflareAccount();
		account.failWith = `Authentication error for token ${FAKE_TOKEN}`;

		const error = await driverFor(store, account)
			.apply(program("sessions"))
			.catch((cause: unknown) => cause);

		expect(error).toBeInstanceOf(Error);
		// SAFETY: assertion required at this I/O or test boundary.
		expect((error as Error).message).not.toContain(FAKE_TOKEN);
		// SAFETY: assertion required at this I/O or test boundary.
		expect((error as Error).message).toContain("[redacted]");
	});
});

// ---------------------------------------------------------------------------
// selectIacProvider precedence
// ---------------------------------------------------------------------------

describe("selectIacProvider: exact artifacts for live providers", () => {
	const deps = (env: Record<string, string | undefined>) => ({
		store: newStore(),
		providers: [],
		env,
		resolverTransport: unreachableTransport,
	});

	it("keeps the in-memory Pulumi default when nothing is set", () => {
		expect(selectIacProvider(deps({})).id).toMatch(/^pulumi-backed:/u);
	});

	it("keeps the in-memory Pulumi default when the opt-in is set but no cloud credential is", () => {
		expect(selectIacProvider(deps({ HOBO_DEPLOY_RESOLVERS: "1" })).id).toMatch(
			/^pulumi-backed:/u,
		);
	});

	it("selects exact Cloudflare resources by default", () => {
		expect(
			selectIacProvider(
				deps({
					CLOUDFLARE_API_TOKEN: FAKE_TOKEN,
					CLOUDFLARE_ACCOUNT_ID: ACCOUNT_ID,
				}),
			).id,
		).toMatch(/^resolver-backed:/u);
	});

	it("selects exact Vercel resources by default", () => {
		expect(selectIacProvider(deps({ VERCEL_TOKEN: FAKE_TOKEN })).id).toMatch(
			/^resolver-backed:/u,
		);
	});

	it("selects the resolver-backed provider for Cloudflare under the opt-in", () => {
		expect(
			selectIacProvider(
				deps({
					HOBO_DEPLOY_RESOLVERS: "1",
					CLOUDFLARE_API_TOKEN: FAKE_TOKEN,
					CLOUDFLARE_ACCOUNT_ID: ACCOUNT_ID,
				}),
			).id,
		).toBe(`resolver-backed:${RESOLVER_CONTRACT}`);
	});

	it("selects the resolver-backed provider for Vercel under the opt-in", () => {
		expect(
			selectIacProvider(
				deps({ HOBO_DEPLOY_RESOLVERS: "1", VERCEL_TOKEN: FAKE_TOKEN }),
			).id,
		).toBe(`resolver-backed:${RESOLVER_CONTRACT}`);
	});

	it("leaves an explicit Pulumi adapter override untouched by the opt-in", () => {
		expect(
			selectIacProvider({
				...deps({
					HOBO_DEPLOY_RESOLVERS: "1",
					CLOUDFLARE_API_TOKEN: FAKE_TOKEN,
					CLOUDFLARE_ACCOUNT_ID: ACCOUNT_ID,
				}),
				adapter: stubPulumiAdapter(),
			}).id,
		).toMatch(/^pulumi-backed:/u);
	});
});

describe("selectIacProvider: the Vercel resolver lane's team", () => {
	// A Vercel account that already holds the project, in the scope each request
	// names: a create would need a durable mutation journal, which
	// selectIacProvider does not hold, so the lane's team is read off its lookup.
	function fakeVercel() {
		const urls: string[] = [];
		const transport: HttpTransport = async (request) => {
			urls.push(request.url);
			const url = new URL(request.url);
			const teamId = url.searchParams.get("teamId");
			return {
				status: 200,
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					id: "prj_lane",
					name: decodeURIComponent(url.pathname.split("/").at(-1) ?? ""),
					...(teamId === null ? undefined : { accountId: teamId }),
				}),
			};
		};
		return { transport, urls };
	}

	async function reconcileWith(env: Record<string, string>) {
		const store = await storeWithPlan([
			{
				name: "web",
				port: "web",
				provider: "vercel",
				deps: [],
				productId: VERCEL_PROJECT_PRODUCT_ID,
			},
		]);
		const vercel = fakeVercel();
		const provider = selectIacProvider({
			store,
			providers: [],
			env: { HOBO_DEPLOY_RESOLVERS: "1", VERCEL_TOKEN: FAKE_TOKEN, ...env },
			resolverTransport: vercel.transport,
		});
		await provider.apply({ ...program("web"), provider: "vercel" });
		return vercel.urls.map(
			(url) => `${new URL(url).pathname}${new URL(url).search}`,
		);
	}

	it("looks the project up, once, in the team VERCEL_TEAM_ID names", async () => {
		const requests = await reconcileWith({ VERCEL_TEAM_ID: " team_acme " });

		expect(requests).toHaveLength(1);
		for (const request of requests) {
			expect(request).toMatch(/\?teamId=team_acme$/u);
		}
	});

	it("falls back to a team_ VERCEL_ORG_ID, and VERCEL_TEAM_ID wins over it", async () => {
		const org = await reconcileWith({ VERCEL_ORG_ID: " team_org " });
		const both = await reconcileWith({
			VERCEL_TEAM_ID: "acme-slug",
			VERCEL_ORG_ID: "team_org",
		});

		for (const request of org) expect(request).toMatch(/\?teamId=team_org$/u);
		for (const request of both) expect(request).toMatch(/\?teamId=acme-slug$/u);
		expect([org.length, both.length]).toEqual([1, 1]);
	});

	it.each([
		"team_",
		" team_ ",
	])("refuses a bare %j VERCEL_ORG_ID before any request", async (orgId) => {
		const vercel = fakeVercel();
		const store = await storeWithPlan([]);

		expect(() =>
			selectIacProvider({
				store,
				providers: [],
				env: {
					HOBO_DEPLOY_RESOLVERS: "1",
					VERCEL_TOKEN: FAKE_TOKEN,
					VERCEL_ORG_ID: orgId,
				},
				resolverTransport: vercel.transport,
			}),
		).toThrow(/^VERCEL_ORG_ID is "team_" with no id after it/u);
		expect(vercel.urls).toEqual([]);
	});

	it("takes a VERCEL_ORG_ID that is not a team_ id (a personal account) as no team", async () => {
		const requests = await reconcileWith({ VERCEL_ORG_ID: "u_abc" });

		expect(requests).toHaveLength(1);
		for (const request of requests) expect(request).not.toContain("?");
	});

	it.each([
		["VERCEL_ORG_ID alone, trimmed", { VERCEL_ORG_ID: " team_x " }, "team_x"],
		[
			"VERCEL_TEAM_ID over VERCEL_ORG_ID",
			{ VERCEL_TEAM_ID: "team_acme", VERCEL_ORG_ID: "team_org" },
			"team_acme",
		],
		[
			"VERCEL_ORG_ID when VERCEL_TEAM_ID is blank",
			{ VERCEL_TEAM_ID: "  ", VERCEL_ORG_ID: "team_org" },
			"team_org",
		],
		// The operator set VERCEL_TEAM_ID on purpose: a slug or any id is taken
		// as given, whatever VERCEL_ORG_ID holds, a bare `team_` included (it is
		// not read).
		[
			"a VERCEL_TEAM_ID that is not a team_ id, over a personal VERCEL_ORG_ID",
			{ VERCEL_TEAM_ID: "acme-slug", VERCEL_ORG_ID: "u_abc" },
			"acme-slug",
		],
		[
			"VERCEL_TEAM_ID, over a bare team_ VERCEL_ORG_ID",
			{ VERCEL_TEAM_ID: "team_acme", VERCEL_ORG_ID: "team_" },
			"team_acme",
		],
	])("takes the team from %s", async (_case, team, teamId) => {
		const requests = await reconcileWith(team);

		expect(requests).toHaveLength(1);
		for (const request of requests) {
			expect(new URL(request, "https://api.vercel.com").search).toBe(
				`?teamId=${teamId}`,
			);
		}
	});

	it("refuses a bare team_ VERCEL_ORG_ID beside a blank VERCEL_TEAM_ID", async () => {
		const vercel = fakeVercel();
		const store = await storeWithPlan([]);

		expect(() =>
			selectIacProvider({
				store,
				providers: [],
				env: {
					VERCEL_TOKEN: FAKE_TOKEN,
					VERCEL_TEAM_ID: " ",
					VERCEL_ORG_ID: "team_",
				},
				resolverTransport: vercel.transport,
			}),
		).toThrow(/^VERCEL_ORG_ID is "team_" with no id after it/u);
		expect(vercel.urls).toEqual([]);
	});

	it.each([
		["unset", {}],
		["empty", { VERCEL_TEAM_ID: "" }],
		["blank", { VERCEL_TEAM_ID: "  " }],
		["blank, VERCEL_ORG_ID too", { VERCEL_TEAM_ID: "", VERCEL_ORG_ID: " " }],
		// A VERCEL_ORG_ID that is not a team_ id is a personal account's, as the
		// Vercel CLI writes it: no team.
		[
			"unset, VERCEL_ORG_ID a user id",
			{ VERCEL_ORG_ID: " 6Qn1jRzOd4H7mDmW5wB2kLpX " },
		],
		[
			"blank, VERCEL_ORG_ID a personal account",
			{ VERCEL_TEAM_ID: " ", VERCEL_ORG_ID: "u_abc" },
		],
		["unset, VERCEL_ORG_ID TEAM_X (case matters)", { VERCEL_ORG_ID: "TEAM_x" }],
	])("with VERCEL_TEAM_ID %s, stays in the token's own scope", async (_case, team) => {
		const requests = await reconcileWith(team);

		expect(requests).toHaveLength(1);
		for (const request of requests) expect(request).not.toContain("?");
	});
});

function stubPulumiAdapter(): PulumiAutomationAdapter {
	return {
		id: "stub",
		async preview() {
			return { changes: [], dirty: false };
		},
		async apply() {
			return { resources: {} };
		},
		async destroy() {
			return null;
		},
		async refresh() {
			return { drifted: false };
		},
	};
}

function blindResolver(): ResourceResolver {
	return {
		providerId: "blind",
		productId: BLIND_PRODUCT_ID,
		async reconcile(request: ResolveRequest) {
			return {
				contract: RESOLVER_CONTRACT,
				action: "create" as const,
				physicalId: request.ref.logicalId,
				outputs: {},
				diagnostics: [],
			};
		},
		async delete() {
			// nothing to do
		},
	};
}

function steeredNode(realizationParameters: JsonObject): ResourcePlan {
	return {
		name: "sessions",
		port: "kv",
		provider: "steered",
		deps: [],
		productId: STEERED_PRODUCT_ID,
		realizationParameters,
	};
}

/** A driver over {@link steeredResolver}, registered through core's registry. */
function steeredDriver(
	store: RuntimeLocalEventStore,
	directives: readonly string[],
	outputs: JsonObject = { title: "sessions" },
) {
	return createResolverBackedIacProvider({
		store,
		registry: createResolverRegistry([steeredResolver(directives, outputs)]),
		transport: unreachableTransport,
		credentialRef: CREDENTIAL_REF,
	});
}

/** A resolver whose read() reports `outputs` (the title by default), and that reads `directives` as directives. */
function steeredResolver(
	directives: readonly string[],
	outputs: JsonObject = { title: "sessions" },
): ResourceResolver {
	const outcome: ResolveOutcome = {
		contract: RESOLVER_CONTRACT,
		action: "noop",
		physicalId: "steered-1",
		outputs,
		diagnostics: [],
	};
	return {
		providerId: "steered",
		productId: STEERED_PRODUCT_ID,
		directives,
		async reconcile() {
			return outcome;
		},
		async read() {
			return outcome;
		},
		async delete() {
			// nothing to do
		},
	};
}
