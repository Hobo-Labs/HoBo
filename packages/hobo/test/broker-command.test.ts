import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BrokerCatalog } from "@hobo/broker";
import { initStation } from "@hobo/stations";
import { beforeAll, describe, expect, it } from "vitest";
import { createBrokerCommand } from "../src/broker-command.js";
import type { JsonObject } from "../src/json.js";

const catalog: BrokerCatalog = {
	catalogHash: "sha256:catalog-cli",
	definitions: () => [
		{
			id: "@hobo/provider-cheap:hobo:http-service",
			providerId: "@hobo/provider-cheap",
			port: "hobo:http-service",
			features: [],
			regions: ["us-east-1"],
			cost: { sku: "cheap-svc", unit: "hour", marginalPrice: "0.01" },
			satisfies: (req) =>
				req.port === "hobo:http-service" ? { kind: "full" } : { kind: "none" },
		},
	],
};

const policies = {
	schemaVersion: "hobo.broker/v1",
	brokerId: "broker:cli-yard",
	placementPolicies: [
		{ id: "pp-bindle", scopeKind: "bindle", objective: "min-cost" },
	],
	billing: {
		quota: "deployments/day",
		quotaUsed: 0,
		quotaLimit: 10,
		budgetUsd: 100,
		spendCapUsd: 50,
	},
	delivery: { engine: "in-proc", syncMode: "manual" },
};

let dir: string;
let policiesPath: string;

beforeAll(async () => {
	dir = await mkdtemp(join(tmpdir(), "hobo-broker-cli-"));
	policiesPath = join(dir, "policies.json");
	await writeFile(policiesPath, JSON.stringify(policies));
	initStation({ hoboHome: dir, name: "local", tenant: "t1" });
});

function stationFlags(hoboHome: string) {
	const { stationId } = initStation({
		hoboHome,
		name: "local",
		tenant: "t1",
	});
	return { home: hoboHome, station: stationId };
}

function runContext(
	flags: Record<string, string>,
	args: string[] = ["resolve"],
) {
	// SAFETY: assertion required at this I/O or test boundary.
	return {
		args,
		flags: { ...stationFlags(dir), ...flags },
		context: { cwd: dir },
		emitProgress: () => {},
	} as never;
}

describe("hobo broker — the Conductor on the CLI", () => {
	it("resolves a request to a receipt through the real pipeline", async () => {
		const requestPath = join(dir, "request.json");
		await writeFile(
			requestPath,
			JSON.stringify({
				schemaVersion: "hobo.broker/v1",
				requestId: "req-cli-1",
				scope: { bindleId: "bindle:site" },
				requirements: [{ resourceId: "api", port: "hobo:http-service" }],
				spendEstimateUsd: 5,
			}),
		);
		const command = createBrokerCommand({ catalog });
		const result = await command.run(
			runContext({ policies: policiesPath, request: requestPath }),
		);
		expect(result.ok).toBe(true);
		expect(result.code).toBe("HOBO_BROKER_RESOLVED");
		// SAFETY: assertion required at this I/O or test boundary.
		const receipt = (result.data as { receipt: { placements: unknown[] } })
			.receipt;
		expect(receipt.placements).toHaveLength(1);
	});

	it("surfaces cataloged rejections with remediations and ok=false", async () => {
		const requestPath = join(dir, "request-over.json");
		await writeFile(
			requestPath,
			JSON.stringify({
				schemaVersion: "hobo.broker/v1",
				requestId: "req-cli-2",
				scope: { bindleId: "bindle:site" },
				requirements: [{ resourceId: "api", port: "hobo:http-service" }],
				spendEstimateUsd: 500,
			}),
		);
		const command = createBrokerCommand({ catalog });
		const result = await command.run(
			runContext({ policies: policiesPath, request: requestPath }),
		);
		expect(result.ok).toBe(false);
		expect(result.code).toBe("HOBO_BROKER_REJECTED");
		expect(result.message).toContain("billing:spend-cap-exceeded");
		expect(result.remediation?.[0]).toContain("spend cap");
	});

	it("broker up with no cloud config registers this machine as a local provider host", async () => {
		const bare = await mkdtemp(join(tmpdir(), "hobo-broker-bare-"));
		const command = createBrokerCommand({ catalog });
		// SAFETY: assertion required at this I/O or test boundary.
		const result = await command.run({
			args: ["up"],
			flags: { cwd: bare, ...stationFlags(bare) },
			context: { cwd: bare },
			emitProgress: () => {},
		} as never);
		expect(result.ok).toBe(true);
		expect(result.code).toBe("HOBO_BROKER_UP");
		// SAFETY: assertion required at this I/O or test boundary.
		const data = result.data as {
			catalog: string;
			receipt: {
				placements: Array<{ providerId: string; marginalPrice: string }>;
			};
			ticket: { engine: string };
			events: Array<{ type: string }>;
		};
		// The running machine IS the provider — zero-cost local catalog.
		expect(data.catalog).toBe("local-host");
		expect(data.receipt.placements[0]?.providerId).toBe(
			"@hobo/provider-local-host",
		);
		expect(data.receipt.placements[0]?.marginalPrice).toBe("0.00");
		expect(data.ticket.engine).toBe("in-proc");
		const types = data.events.map((event) => event.type);
		expect(types).toContain("broker.Resolved");
		expect(types).toContain("broker.ScaleRequested");
		expect(types).toContain("broker.DeliverySubmitted");
	});

	it("broker up derives requirements from the project's bindle manifest", async () => {
		const project = await mkdtemp(join(tmpdir(), "hobo-broker-proj-"));
		await writeFile(
			join(project, "hobo.bindle.json"),
			JSON.stringify({
				schema: "hobo.manifest/v1",
				componentHost: { kind: "wasmtime", version: "1.0.0" },
				resources: {
					api: {
						type: "component.v1",
						image: "oci://registry.example.com/api@sha256:abc123",
						runtime: "wasm",
						exports: ["wasi:http/incoming-handler"],
						bind: ["media"],
					},
					media: { type: "data.v1", port: "kv" },
				},
			}),
		);
		const command = createBrokerCommand({ catalog });
		// SAFETY: assertion required at this I/O or test boundary.
		const result = await command.run({
			args: ["up"],
			flags: { cwd: project, ...stationFlags(project) },
			context: { cwd: project, projectDir: project },
			emitProgress: () => {},
		} as never);
		expect(result.ok).toBe(true);
		const receipt =
			// SAFETY: assertion required at this I/O or test boundary.
			(
				result.data as {
					receipt: { placements: Array<{ resourceId: string }> };
				}
			).receipt;
		expect(receipt.placements.map((p) => p.resourceId).sort()).toEqual([
			"api",
			"media",
		]);
	});

	it("broker config --init scaffolds, then config validates and summarizes", async () => {
		const project = await mkdtemp(join(tmpdir(), "hobo-broker-cfg-"));
		const command = createBrokerCommand({ catalog });
		// SAFETY: assertion required at this I/O or test boundary.
		const init = await command.run({
			args: ["config"],
			flags: { cwd: project, init: true },
			context: { cwd: project, projectDir: project },
			emitProgress: () => {},
		} as never);
		expect(init.ok).toBe(true);
		expect(init.code).toBe("HOBO_BROKER_CONFIG_INIT");

		// SAFETY: assertion required at this I/O or test boundary.
		const summary = await command.run({
			args: ["config"],
			flags: { cwd: project },
			context: { cwd: project, projectDir: project },
			emitProgress: () => {},
		} as never);
		expect(summary.ok).toBe(true);
		expect(summary.status).toBe("config_valid");
		// SAFETY: assertion required at this I/O or test boundary.
		const config = (summary.data as { config: JsonObject }).config;
		expect(config.catalog).toBe("local-host");
		expect(config.policyEngine).toBe("builtin");
		expect(String(config.policyHash)).toMatch(/^sha256:/);

		// A second --init refuses to clobber the existing config.
		// SAFETY: assertion required at this I/O or test boundary.
		const again = await command.run({
			args: ["config"],
			flags: { cwd: project, init: true },
			context: { cwd: project, projectDir: project },
			emitProgress: () => {},
		} as never);
		expect(again.ok).toBe(false);
		expect(again.code).toBe("HOBO_BROKER_CONFIG_EXISTS");
	});

	it("broker config wires OPA/Cedar engines and connectors from the config file", async () => {
		const project = await mkdtemp(join(tmpdir(), "hobo-broker-opa-"));
		await writeFile(
			join(project, "hobo.broker.json"),
			JSON.stringify({
				...policies,
				requiredConnectorKinds: ["cloudflare"],
				connectors: [
					{
						id: "conn-cf",
						kind: "cloudflare",
						displayName: "Cloudflare",
						settings: { accountId: "acct-1" },
					},
				],
				policyEngine: { kind: "opa", endpoint: "http://opa.local:8181" },
			}),
		);
		// The injected fetch plays a Rego deny — proving the configured engine
		// is actually on the resolve path.
		const command = createBrokerCommand({
			catalog,
			fetchFn: async () => ({
				status: 200,
				json: async () => ({
					result: {
						effect: "deny",
						reasons: [
							{
								code: "policy-denied",
								message: "frozen by Rego",
								plane: "policy",
							},
						],
					},
				}),
			}),
		});
		// SAFETY: assertion required at this I/O or test boundary.
		const summary = await command.run({
			args: ["config"],
			flags: { cwd: project },
			context: { cwd: project, projectDir: project },
			emitProgress: () => {},
		} as never);
		expect(summary.status).toBe("config_valid");
		expect(
			// SAFETY: assertion required at this I/O or test boundary.
			(summary.data as { config: { policyEngine: string } }).config
				.policyEngine,
		).toBe("opa");

		// SAFETY: assertion required at this I/O or test boundary.
		const up = await command.run({
			args: ["up"],
			flags: { cwd: project, ...stationFlags(project) },
			context: { cwd: project, projectDir: project },
			emitProgress: () => {},
		} as never);
		expect(up.ok).toBe(false);
		expect(up.message).toContain("policy:policy-denied");
	});

	it("prints the rejection matrix and rejects unknown subcommands", async () => {
		const command = createBrokerCommand({ catalog });
		const matrix = await command.run(runContext({}, ["matrix"]));
		expect(matrix.ok).toBe(true);
		expect(
			// SAFETY: assertion required at this I/O or test boundary.
			(matrix.data as { matrix: unknown[] }).matrix.length,
		).toBeGreaterThan(10);

		const unknown = await command.run(runContext({}, ["conduct"]));
		expect(unknown.ok).toBe(false);
		expect(unknown.code).toBe("HOBO_BROKER_USAGE");

		const missing = await command.run(runContext({}));
		expect(missing.ok).toBe(false);
		expect(missing.status).toBe("missing_inputs");
	});
});
