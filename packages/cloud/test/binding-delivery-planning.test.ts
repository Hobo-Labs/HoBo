import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalManifestHash, parseManifest } from "@hobo/bindles";
import { createInMemoryActorHost } from "@hobo/data";
import { createCloudflareProvider } from "@hobo/provider-cloudflare";
import {
	createManualClock,
	createRuntimeLocalEventStore,
} from "@hobo/runtime-local";
import { expect, it } from "vitest";
import {
	createRegistryFromProviders,
	deploy,
	deploymentPlanned,
	deploymentRequested,
	deploymentStreamId,
	plan,
} from "../src/index.js";

const actor = { kind: "user", id: "operator" } as const;
const registry = createRegistryFromProviders([createCloudflareProvider()]);

function manifest(env: Record<string, string>) {
	return parseManifest({
		schema: "hobo.manifest/v1",
		componentHost: { kind: "wasmtime", version: "1.0.0" },
		resources: {
			api: {
				type: "component.v1",
				image: "oci://example.test/api",
				runtime: "wasm",
				exports: ["wasi:http/incoming-handler"],
				env,
			},
		},
	});
}

it("rejects credentials in authored resource environments without echoing values", () => {
	for (const env of [
		{ API_KEY: "private-key" },
		{ SECRET: "private-key" },
		{ connectionstrings__db: "external-value" },
		{ DATABASE_URL: "postgres://user:private-password@example.test/db" },
		{ SERVICE_ENDPOINT: "postgres://user:private-password@example.test/db" },
		{ SERVICE_ENDPOINT: "https://private-token@example.test/api" },
		{ ConnectionStrings__db: "external-value" },
	]) {
		const result = plan(manifest(env), { deploymentId: "test" }, registry);
		expect(result.ok).toBe(false);
		if (result.ok) continue;
		expect(
			result.remediations.some((item) =>
				item.code.startsWith("binding-delivery:"),
			),
		).toBe(true);
		expect(JSON.stringify(result)).not.toMatch(
			/private-key|private-password|private-token/,
		);
	}
	expect(
		plan(manifest({ LOG_LEVEL: "info" }), { deploymentId: "safe" }, registry)
			.ok,
	).toBe(true);
});

it("rejects before budget authority access and records only sanitized facts", async () => {
	const dir = mkdtempSync(join(tmpdir(), "hobo-binding-gate-"));
	const store = createRuntimeLocalEventStore({
		dataDir: dir,
		clock: createManualClock(),
	});
	try {
		const unsafe = manifest({ API_KEY: "private-key" });
		const result = await deploy(
			{ store, actorHost: createInMemoryActorHost(), registry },
			{
				deploymentId: "unsafe",
				bindle: unsafe,
				config: { budgetId: "budget-a" },
			},
			{ actor, tenant: "tenant-a" },
		);
		expect(result.status).toBe("rejected");
		if (result.status !== "rejected") throw new Error("expected refusal");
		expect(result.remediations[0]?.code).toBe(
			"binding-delivery:secret-env-key",
		);
		const events = [];
		for await (const event of store.read(deploymentStreamId("unsafe")))
			events.push(event);
		expect(events.map((event) => event.type)).toEqual([
			"deployment.Requested",
			"deployment.PlanRejected",
		]);
		expect(JSON.stringify(events)).not.toContain("private-key");
	} finally {
		store.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

it("rechecks a previously planned deployment and replays its new refusal", async () => {
	const dir = mkdtempSync(join(tmpdir(), "hobo-binding-replay-"));
	const store = createRuntimeLocalEventStore({
		dataDir: dir,
		clock: createManualClock(),
	});
	try {
		const unsafe = manifest({ API_KEY: "private-key" });
		const safe = plan(
			manifest({ LOG_LEVEL: "info" }),
			{ deploymentId: "legacy" },
			registry,
		);
		if (!safe.ok) throw new Error("expected safe plan");
		const streamId = deploymentStreamId("legacy");
		await store.append(
			streamId,
			[
				deploymentRequested({
					deploymentId: "legacy",
					bindleHash: canonicalManifestHash(unsafe),
					tenant: "tenant-a",
					config: {},
				}),
				deploymentPlanned({
					deploymentId: "legacy",
					planHash: safe.planHash,
					plan: safe.plan,
				}),
			],
			{ actor, tenant: "tenant-a", expectedSeq: 0 },
		);
		const deps = { store, actorHost: createInMemoryActorHost(), registry };
		const command = { deploymentId: "legacy", bindle: unsafe };
		const context = { actor, tenant: "tenant-a" };
		const denied = await deploy(deps, command, context);
		expect(denied.status).toBe("rejected");
		const repeated = await deploy(deps, command, context);
		expect(repeated).toEqual(denied);
		const events = [];
		for await (const event of store.read(streamId)) events.push(event);
		expect(events.map((event) => event.type)).toEqual([
			"deployment.Requested",
			"deployment.Planned",
			"deployment.Requested",
			"deployment.PlanRejected",
		]);
		expect(JSON.stringify(events)).not.toContain("private-key");
	} finally {
		store.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

it("rejects malformed environments and credential-bearing connection strings", () => {
	for (const env of [null, [], 1, { LOG_LEVEL: 3 }]) {
		expect(() =>
			parseManifest({
				schema: "hobo.manifest/v1",
				componentHost: { kind: "wasmtime", version: "1.0.0" },
				resources: { api: { type: "component.v1", env } },
			}),
		).toThrow(/resources\.api\.env/);
	}
	const unsafe = parseManifest({
		schema: "hobo.manifest/v1",
		componentHost: { kind: "wasmtime", version: "1.0.0" },
		resources: {
			api: {
				type: "component.v1",
				connectionString: "postgres://user:private-password@example.test/db",
			},
		},
	});
	const result = plan(unsafe, { deploymentId: "unsafe-connection" }, registry);
	expect(result.ok).toBe(false);
	if (result.ok) throw new Error("expected refusal");
	expect(result.remediations[0]?.code).toBe(
		"binding-delivery:secret-connection-string",
	);
	expect(JSON.stringify(result)).not.toContain("private-password");
});
