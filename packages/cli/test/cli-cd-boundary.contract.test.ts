import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseManifest } from "@hobo/bindles";
import { type CampId, ReconcileStatus, SetOrigin } from "@hobo/cd";
import {
	createInProcessCredentialBroker,
	createInProcessExecutor,
	createRegistryFromProviders,
	type IacProvider,
} from "@hobo/cloud";
import { createInMemoryActorHost } from "@hobo/data";
import { createCloudflareProvider } from "@hobo/provider-cloudflare";
import {
	createManualClock,
	createRuntimeLocalEventStore,
	type RuntimeLocalEventStore,
} from "@hobo/runtime-local";
import { afterEach, describe, expect, it } from "vitest";
import { createYardClient, type YardClient } from "../src/cloud/yard-client.js";
import { createFixtureSession } from "../src/index.js";
import { isJsonObject, type JsonObject, type JsonValue } from "../src/json.js";
import {
	createFakeDelivery,
	type FakeDelivery,
	fakeFreightManifestCodec,
} from "./cd-delivery-fakes.js";

// Consumer pact pinning the `hobo up`/`down` -> @hobo/cd port boundary (plan
// 0024 D13): which ports the yard-client seam calls, with which request
// shapes, and which response fields it relies on. The real @hobo/cd modules
// (WP1/WP3/WP4/WP6/WP7) are the provider; WP18 composes them.

const pactPath = join(
	dirname(fileURLToPath(import.meta.url)),
	"..",
	"contracts",
	"cli-cd-boundary.pact.json",
);

type Interaction = Readonly<{
	description: string;
	request: Readonly<{ port: string; contents: JsonObject }>;
	response: Readonly<{ contents: JsonObject }>;
	matchingRules: Readonly<Record<string, string>>;
}>;

// SAFETY: the pact file is a checked-in JSON fixture read at the test boundary.
const pact = JSON.parse(readFileSync(pactPath, "utf8")) as {
	consumer: { name: string };
	provider: { name: string };
	interactions: Interaction[];
};

const BINDLE = parseManifest({
	schema: "hobo.manifest/v1",
	componentHost: { kind: "wasmtime", version: "1.0.0" },
	resources: {
		service: {
			type: "component.v1",
			image: "oci://registry.example.com/hello-bindle@sha256:abc123",
			runtime: "wasm",
			exports: ["wasi:http/incoming-handler"],
			bind: ["sessions"],
		},
		sessions: { type: "data.v1", port: "kv" },
	},
});

const BINDLE_V2 = parseManifest({
	schema: "hobo.manifest/v1",
	componentHost: { kind: "wasmtime", version: "1.0.0" },
	resources: { sessions: { type: "data.v1", port: "kv" } },
});

const DEPLOYMENT = "pact-cd";
// SAFETY: `hobo up` uses the deployment id as the deployment Camp id by default.
const CAMP = DEPLOYMENT as CampId;

let stores: RuntimeLocalEventStore[] = [];
afterEach(() => {
	for (const store of stores) store.close();
	stores = [];
});

type Seam = Readonly<{ client: YardClient; fake: FakeDelivery }>;

function seam(): Seam {
	const store = createRuntimeLocalEventStore({
		dataDir: join(
			tmpdir(),
			`hobo-cli-cd-pact-${Math.random().toString(36).slice(2)}`,
		),
		clock: createManualClock(),
	});
	stores.push(store);
	const iac: IacProvider = {
		id: "mock",
		async preview() {
			return { summary: "preview", changes: 1 };
		},
		async apply(program) {
			return { endpoint: `${program.resourceId}.local` };
		},
		async destroy() {},
		async refresh() {
			return { drift: false, observed: {} };
		},
	};
	const base = {
		store,
		actorHost: createInMemoryActorHost(),
		executor: createInProcessExecutor({ iac }),
		broker: createInProcessCredentialBroker(),
		registry: createRegistryFromProviders([createCloudflareProvider()]),
	};
	const fake = createFakeDelivery({
		store,
		registry: base.registry,
		orchestrator: base,
		tenant: "hobo-dev",
	});
	return {
		fake,
		client: createYardClient({
			...base,
			delivery: {
				cd: fake.cd,
				freightManifest: fakeFreightManifestCodec,
				now: () => 1_700_000_000_000,
			},
		}),
	};
}

function interaction(description: string): Interaction {
	const found = pact.interactions.find(
		(item) => item.description === description,
	);
	if (!found) throw new Error(`missing pact interaction: ${description}`);
	return found;
}

function valueAt(
	root: JsonValue | undefined,
	dotted: string,
): JsonValue | undefined {
	let cursor = root;
	for (const key of dotted.split(".")) {
		if (!isJsonObject(cursor)) return undefined;
		cursor = cursor[key];
	}
	return cursor;
}

/** Exact contents match plus every `request.*` matching rule. */
function expectRequest(item: Interaction, actual: JsonValue | undefined): void {
	expect(actual).toMatchObject(item.request.contents);
	for (const [path, pattern] of Object.entries(item.matchingRules))
		if (path.startsWith("request."))
			expect(String(valueAt(actual, path.slice("request.".length)))).toMatch(
				new RegExp(pattern),
			);
}

function expectResponse(item: Interaction, actual: JsonObject): void {
	for (const [path, pattern] of Object.entries(item.matchingRules))
		if (path.startsWith("response."))
			expect(String(valueAt(actual, path.slice("response.".length)))).toMatch(
				new RegExp(pattern),
			);
}

const session = createFixtureSession({ subject: "pact" });

describe("CLI <-> CD boundary pact", () => {
	it("names the CLI consumer and the @hobo/cd provider", () => {
		expect(pact.consumer.name).toBe("@hobo/cli");
		expect(pact.provider.name).toBe("@hobo/cd");
		expect(pact.interactions).toHaveLength(6);
	});

	it("hobo up: declaration put, LOCAL_BUILD record, promote, conductor reconcile", async () => {
		const { client, fake } = seam();
		const { result, receipt } = await client.deliver(BINDLE, {
			deploymentId: DEPLOYMENT,
			session,
		});
		expect(result.status).toBe("deployed");

		const put = interaction(
			"hobo up stores the canonical declaration under its own hash",
		);
		const putCall = fake.calls.find((c) => c.port === "artifacts.put");
		expectRequest(put, putCall?.input);

		const record = interaction(
			"hobo up records LOCAL_BUILD Freight for the project's declaration",
		);
		const recordCall = fake.calls.find((c) => c.port === "freight.record");
		expectRequest(record, recordCall?.input);
		expectResponse(record, {
			freightId: receipt?.freightId ?? null,
			alias: receipt?.alias ?? null,
		});

		const promote = interaction(
			"hobo up promotes the Freight into the deployment Camp with intent up",
		);
		const promoteCall = fake.calls.find((c) => c.port === "promotions.promote");
		expectRequest(promote, promoteCall?.input);
		expectResponse(promote, { promotionId: receipt?.promotionId ?? null });

		const conductor = interaction(
			"hobo up converges the Camp with a bounded in-process conductor",
		);
		const created = fake.calls.find((c) => c.port === "createReconciler");
		expectRequest(conductor, created?.input);
		const reconciled = fake.calls.filter((c) => c.port === "reconcileOnce");
		expect(reconciled.at(-1)?.input).toEqual({ campId: DEPLOYMENT });
		const observed = await fake.cd.desired.status(CAMP);
		expect(`RECONCILE_STATUS_${ReconcileStatus[observed?.status ?? 0]}`).toBe(
			valueAt(conductor.response.contents, "reconcileOnce.status"),
		);
	});

	it("hobo down: a teardown Delta (intent down) through promote", async () => {
		const { client, fake } = seam();
		await client.deliver(BINDLE, { deploymentId: DEPLOYMENT, session });
		const { result } = await client.teardown(BINDLE, {
			deploymentId: DEPLOYMENT,
			session,
		});
		expect(result.status).toBe("destroyed");
		const teardown = interaction(
			"hobo down opens a teardown Delta through the same gate",
		);
		const call = fake.calls
			.filter((c) => c.port === "promotions.promote")
			.at(-1);
		expectRequest(teardown, call?.input);
		const current = await fake.cd.desired.current(CAMP);
		expect(`SET_ORIGIN_${SetOrigin[current?.origin ?? 0]}`).toBe(
			teardown.response.contents.setOrigin,
		);
	});

	it("hobo up --rollback: rollback of the Camp to its predecessor Set", async () => {
		const { client, fake } = seam();
		await client.deliver(BINDLE, { deploymentId: DEPLOYMENT, session });
		await client.deliver(BINDLE_V2, { deploymentId: DEPLOYMENT, session });
		const { result } = await client.deliver(BINDLE_V2, {
			deploymentId: DEPLOYMENT,
			session,
			rollback: true,
		});
		expect(result.status).toBe("deployed");
		const rollback = interaction(
			"hobo up --rollback re-applies the predecessor Set",
		);
		const call = fake.calls.find((c) => c.port === "promotions.rollback");
		expectRequest(rollback, call?.input);
		const current = await fake.cd.desired.current(CAMP);
		expect(`SET_ORIGIN_${SetOrigin[current?.origin ?? 0]}`).toBe(
			rollback.response.contents.setOrigin,
		);
	});
});
