import { mkdtempSync, readFileSync } from "node:fs";
import { parseJsonValue, type JsonValue } from "../src/json.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type ManifestV1, parseManifest } from "@hobo/bindles";

import type { EventEnvelope } from "@hobo/core";
import { createInMemoryActorHost } from "@hobo/data";
import { createCloudflareProvider } from "@hobo/provider-cloudflare";
import {
	createManualClock,
	createRuntimeLocalEventStore,
	type RuntimeLocalEventStore,
} from "@hobo/runtime-local";
import { afterEach, describe, expect, it } from "vitest";

import {
	createRegistryFromProviders,
	deploy,
	deploymentStreamId,
	deploymentViewProjection,
	type GatewayDeps,
	UnauthorizedCommandError,
} from "../src/index.js";

const HELLO_BINDLE_PLAN_HASH =
	"sha256:30eb585558f0614fac037fa5ada935eaad03e86f35c39110af21b2c58bdaf5b6";

let stores: RuntimeLocalEventStore[] = [];
function freshStore(): RuntimeLocalEventStore {
	const dir = mkdtempSync(join(tmpdir(), "hobo-cloud-"));
	const s = createRuntimeLocalEventStore({
		dataDir: dir,
		clock: createManualClock(),
	});
	stores.push(s);
	return s;
}
afterEach(() => {
	for (const s of stores) s.close();
	stores = [];
});

function fixture(name: string): JsonValue {
	return parseJsonValue(
		readFileSync(
			fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)),
			"utf8",
		),
	);
}
function helloBindle(): ManifestV1 {
	return parseManifest(fixture("hello-bindle.manifest.json"));
}
function deps(store: RuntimeLocalEventStore): GatewayDeps {
	return {
		store,
		actorHost: createInMemoryActorHost(),
		registry: createRegistryFromProviders([createCloudflareProvider()]),
	};
}
const actor = { kind: "user", id: "operator-1" } as const;

async function drain(store: RuntimeLocalEventStore, streamId: string) {
	const events: EventEnvelope[] = [];
	for await (const event of store.read(streamId)) events.push(event);
	return events;
}

describe("Gateway: Deploy command -> events -> DeploymentView projection", () => {
	it("round-trips a Deploy to a queryable planned projection", async () => {
		const store = freshStore();
		const result = await deploy(
			deps(store),
			{ deploymentId: "hello-1", bindle: helloBindle() },
			{ tenant: "tenant-a", actor, correlationId: "deploy:hello-1" },
		);

		expect(result.status).toBe("planned");
		if (result.status !== "planned") return;
		expect(result.planHash).toBe(HELLO_BINDLE_PLAN_HASH);

		const streamId = deploymentStreamId("hello-1");
		const events = await drain(store, streamId);
		expect(events.map((e) => e.type)).toEqual([
			"deployment.Requested",
			"match.Decided",
			"match.Decided",
			"match.Decided",
			"deployment.Planned",
		]);

		const view = await deploymentViewProjection.rebuildFromZero(
			store,
			streamId,
		);
		const row = deploymentViewProjection.get(view, "hello-1");
		expect(row?.status).toBe("planned");
		expect(row?.planHash).toBe(HELLO_BINDLE_PLAN_HASH);
		expect(row?.decisions.map((d) => d.resource)).toEqual([
			"assets",
			"service",
			"sessions",
		]);
		expect(row?.plan?.dependencyOrder).toEqual([
			"assets",
			"sessions",
			"service",
		]);
	});

	it("rebuilds the projection from zero byte-identically to the live fold", async () => {
		const store = freshStore();
		await deploy(
			deps(store),
			{ deploymentId: "hello-2", bindle: helloBindle() },
			{ tenant: "tenant-a", actor },
		);
		const streamId = deploymentStreamId("hello-2");
		const events = await drain(store, streamId);

		// Live: fold each growing prefix as events arrive on the wire.
		let live = deploymentViewProjection.fold(events.slice(0, 1));
		for (let i = 2; i <= events.length; i += 1) {
			live = deploymentViewProjection.fold(events.slice(0, i));
		}
		// Rebuild: drop the sink, replay the whole stream from the log.
		const rebuilt = await deploymentViewProjection.rebuildFromZero(
			store,
			streamId,
		);

		expect(JSON.stringify(rebuilt)).toBe(JSON.stringify(live));
		expect(rebuilt.seq).toBe(events.length);
	});

	it("rejects a system principal with a typed authorization error", async () => {
		const store = freshStore();
		await expect(
			deploy(
				deps(store),
				{ deploymentId: "hello-3", bindle: helloBindle() },
				{ tenant: "tenant-a", actor: { kind: "system", id: "runtime" } },
			),
		).rejects.toBeInstanceOf(UnauthorizedCommandError);
	});
});

describe("Gateway: unsatisfiable deploy -> deployment.PlanRejected projection", () => {
	it("projects a rejected deployment carrying machine-readable remediation", async () => {
		const store = freshStore();
		const manifest = parseManifest(fixture("unsatisfiable.manifest.json"));
		const result = await deploy(
			deps(store),
			{ deploymentId: "reject-9", bindle: manifest },
			{ tenant: "tenant-a", actor },
		);
		expect(result.status).toBe("rejected");

		const streamId = deploymentStreamId("reject-9");
		const events = await drain(store, streamId);
		expect(events.map((e) => e.type)).toEqual([
			"deployment.Requested",
			"deployment.PlanRejected",
		]);

		const view = await deploymentViewProjection.rebuildFromZero(
			store,
			streamId,
		);
		const row = deploymentViewProjection.get(view, "reject-9");
		expect(row?.status).toBe("rejected");
		expect(row?.rejection?.remediations[0]?.resource).toBe("ledger");
		expect(row?.rejection?.remediations[0]?.code).toBe(
			"capability.port-unavailable",
		);
	});
});
