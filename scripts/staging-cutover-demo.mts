/**
 * Phase-5 staging demo: the budget-pressured zero-downtime backend swap on a
 * real edge — the same control loop + progressive cutover that passes the
 * loopback E2E, with ONLY the adapter binding changed (transparency is proven
 * by swapping adapters, not code).
 *
 * Providers:
 *   --provider=simple      loopback rehearsal (always available; self-hosts
 *                          two HTTP backends and a routing proxy)
 *   --provider=vercel      Vercel Rolling Release canary (credential-gated)
 *   --provider=cloudflare  Cloudflare LB pools (credential-gated)
 *
 * The run drives an external uptime probe (default 1 req/s) against the
 * public URL for the whole swap window, injects `budget.ThresholdCrossed`,
 * ramps 10 → 50 → 100 with a health gate between steps, and requires 100%
 * probe success. Evidence (event trace + probe log + verdict) is archived as
 * JSON for docs/design/live-provider-matrix.md.
 *
 * Credential gates (fail closed, exit 2 — nothing is stubbed or simulated):
 *   vercel:      VERCEL_TOKEN, VERCEL_PROJECT, VERCEL_DEPLOYMENT_A/B,
 *                HOBO_STAGING_PROBE_URL
 *   cloudflare:  CLOUDFLARE_API_TOKEN, CLOUDFLARE_ZONE_ID,
 *                CLOUDFLARE_ACCOUNT_ID, HOBO_STAGING_BACKEND_A/B,
 *                HOBO_STAGING_PROBE_URL
 *
 * Usage:
 *   node --import tsx scripts/staging-cutover-demo.mts --provider=simple
 *   node --import tsx scripts/staging-cutover-demo.mts --provider=vercel
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import process from "node:process";

import {
	createCloudflareTrafficRouting,
	createSimpleTrafficRouting,
	createVercelTrafficRouting,
} from "../packages/connectivity/src/index.js";
import {
	allowDecision,
	type PolicyDecision,
	parseTenantId,
	type RoutingPlan,
	type RoutingPlanId,
	type TrafficRoutingPort,
} from "../packages/core/src/index.js";
import {
	createRoutingControlLoop,
	type RoutingTopology,
	synthesizeRoutingPlan,
} from "../packages/stations/src/index.js";

interface CliOptions {
	provider: "simple" | "vercel" | "cloudflare";
	probeIntervalMs: number;
	evidenceDir: string;
}

function parseCli(): CliOptions {
	const args = new Map<string, string>();
	for (const raw of process.argv.slice(2)) {
		const match = /^--([^=]+)(?:=(.*))?$/u.exec(raw);
		const flag = match?.[1];
		if (match !== null && flag !== undefined)
			args.set(flag, match[2] ?? "true");
	}
	// SAFETY: assertion to `t("provider") ?? process.env.HOBO_STAGING_PROVIDER ?? "simple") as CliOptions["provider"]; if (!` is required at this boundary.
	const provider = (args.get("provider") ??
		process.env.HOBO_STAGING_PROVIDER ??
		"simple") as CliOptions["provider"];
	if (!["simple", "vercel", "cloudflare"].includes(provider)) {
		fail(`unknown --provider=${provider} (simple | vercel | cloudflare)`, 1);
	}
	return {
		provider,
		probeIntervalMs: Number(args.get("probe-interval-ms") ?? "1000"),
		evidenceDir:
			args.get("evidence-dir") ??
			path.join("docs", "design", "instances", "staging-cutover"),
	};
}

function fail(message: string, code: number): never {
	console.error(`staging-cutover-demo: ${message}`);
	process.exit(code);
}

function requireEnv(name: string, gate: string[]): string {
	const value = process.env[name]?.trim();
	if (!value) gate.push(name);
	return value ?? "";
}

const tenantId = parseTenantId("tenant-staging");

function policyDecision(service: string): PolicyDecision {
	return allowDecision("staging-policy", {
		subject: { identity: "staging-operator", tenantId, tags: [] },
		action: "routing.plan",
		resource: { kind: "service", id: service, tenantId },
	});
}

interface ProbeSample {
	at: string;
	status: number | "error";
	ms: number;
	body?: string;
}

function startUptimeProbe(url: string, intervalMs: number) {
	const samples: ProbeSample[] = [];
	let running = true;
	const worker = (async () => {
		while (running) {
			const startedAt = Date.now();
			try {
				const response = await fetch(url, { redirect: "follow" });
				const body = (await response.text()).slice(0, 40);
				samples.push({
					at: new Date(startedAt).toISOString(),
					status: response.status,
					ms: Date.now() - startedAt,
					body,
				});
			} catch {
				samples.push({
					at: new Date(startedAt).toISOString(),
					status: "error",
					ms: Date.now() - startedAt,
				});
			}
			const elapsed = Date.now() - startedAt;
			if (elapsed < intervalMs) {
				await new Promise((resolve) =>
					setTimeout(resolve, intervalMs - elapsed),
				);
			}
		}
	})();
	return {
		stop: async () => {
			running = false;
			await worker;
			return samples;
		},
	};
}

function listen(server: Server): Promise<string> {
	return new Promise((resolve) => {
		server.listen(0, "127.0.0.1", () => {
			// SAFETY: assertion to `ddress() as AddressInfo; res` is required at this boundary.
			const { port } = server.address() as AddressInfo;
			resolve(`http://127.0.0.1:${port}`);
		});
	});
}

interface ProviderBinding {
	port: TrafficRoutingPort;
	topology: RoutingTopology;
	probeUrl: string;
	fromBackendId: string;
	toBackendId: string;
	healthGate: () => Promise<boolean>;
	cleanup: () => Promise<void>;
}

/** Loopback rehearsal: self-hosted backends + a routing proxy. */
async function bindSimple(_cli: CliOptions): Promise<ProviderBinding> {
	const backendA = createServer((_req, res) => res.end("A"));
	const backendB = createServer((_req, res) => res.end("B"));
	const backendAUrl = await listen(backendA);
	const backendBUrl = await listen(backendB);

	const port = createSimpleTrafficRouting();
	let activePlanId: RoutingPlanId | undefined;
	const routedPort: TrafficRoutingPort & {
		select: typeof port.select;
	} = {
		...port,
		apply: async (plan: RoutingPlan) => {
			const result = await port.apply(plan);
			activePlanId = plan.planId;
			return result;
		},
		status: port.status.bind(port),
		revoke: port.revoke.bind(port),
		select: port.select.bind(port),
	};

	const proxy = createServer(async (req, res) => {
		try {
			if (!activePlanId) throw new Error("no active routing plan");
			const backend = port.select(activePlanId, req.url ?? "/");
			if (!backend?.endpoint) throw new Error("no routable backend");
			const upstream = await fetch(backend.endpoint);
			res.statusCode = upstream.status;
			res.end(await upstream.text());
		} catch (error) {
			res.statusCode = 502;
			res.end(String(error));
		}
	});
	const probeUrl = await listen(proxy);

	const topology: RoutingTopology = {
		service: "staging-site",
		tenantId,
		stationId: "station:staging",
		backends: [
			{
				id: "backend:a",
				service: "staging-site",
				endpoint: backendAUrl,
				healthy: true,
			},
			{
				id: "backend:b",
				service: "staging-site",
				endpoint: backendBUrl,
				healthy: true,
			},
		],
	};

	// Seed 100% on the incumbent.
	const seed = synthesizeRoutingPlan({
		topology: {
			...topology,
			backends: topology.backends
				.filter((backend) => backend.id === "backend:a")
				.map((backend) => ({ ...backend, weight: 100 })),
		},
		policyDecision: policyDecision(topology.service),
		planId: "plan:staging-site:seed",
		weightStrategy: "static",
	});
	if (seed.kind !== "plan") fail("seed plan denied", 1);
	await routedPort.apply(seed.plan);

	return {
		port: routedPort,
		topology,
		probeUrl,
		fromBackendId: "backend:a",
		toBackendId: "backend:b",
		healthGate: async () => {
			const probe = await fetch(backendBUrl);
			return probe.status === 200;
		},
		cleanup: async () => {
			for (const server of [proxy, backendA, backendB]) {
				await new Promise((resolve) => server.close(resolve));
			}
		},
	};
}

/** Vercel Rolling Release: weighted canary between two mapped deployments. */
async function bindVercel(): Promise<ProviderBinding> {
	const gate: string[] = [];
	const token = requireEnv("VERCEL_TOKEN", gate);
	const project = requireEnv("VERCEL_PROJECT", gate);
	const deploymentA = requireEnv("VERCEL_DEPLOYMENT_A", gate);
	const deploymentB = requireEnv("VERCEL_DEPLOYMENT_B", gate);
	const probeUrl = requireEnv("HOBO_STAGING_PROBE_URL", gate);
	if (gate.length > 0) {
		fail(
			`vercel staging lane is credential-gated; missing env: ${gate.join(", ")}`,
			2,
		);
	}
	const teamId = process.env.VERCEL_TEAM_ID?.trim();
	const deployments = {
		"backend:a": deploymentA,
		"backend:b": deploymentB,
	};
	const port = createVercelTrafficRouting(
		teamId !== undefined && teamId !== ""
			? {
					token,
					projectIdOrName: project,
					teamId,
					deploymentIdsByBackend: deployments,
				}
			: {
					token,
					projectIdOrName: project,
					deploymentIdsByBackend: deployments,
				},
	);
	const topology: RoutingTopology = {
		service: "staging-site",
		tenantId,
		stationId: "station:staging",
		backends: [
			{
				id: "backend:a",
				service: "staging-site",
				endpoint: probeUrl,
				healthy: true,
			},
			{
				id: "backend:b",
				service: "staging-site",
				endpoint: probeUrl,
				healthy: true,
			},
		],
	};
	return {
		port,
		topology,
		probeUrl,
		fromBackendId: "backend:a",
		toBackendId: "backend:b",
		healthGate: async () => {
			const probe = await fetch(probeUrl, { redirect: "follow" });
			return probe.status === 200;
		},
		cleanup: async () => {},
	};
}

/** Cloudflare LB pools with per-step pool health observation. */
async function bindCloudflare(): Promise<ProviderBinding> {
	const gate: string[] = [];
	const apiToken = requireEnv("CLOUDFLARE_API_TOKEN", gate);
	const zoneId = requireEnv("CLOUDFLARE_ZONE_ID", gate);
	const accountId = requireEnv("CLOUDFLARE_ACCOUNT_ID", gate);
	const backendA = requireEnv("HOBO_STAGING_BACKEND_A", gate);
	const backendB = requireEnv("HOBO_STAGING_BACKEND_B", gate);
	const probeUrl = requireEnv("HOBO_STAGING_PROBE_URL", gate);
	if (gate.length > 0) {
		fail(
			`cloudflare staging lane is credential-gated; missing env: ${gate.join(", ")}`,
			2,
		);
	}
	const port = createCloudflareTrafficRouting({
		apiToken,
		zoneId,
		accountId,
		healthChecksConfigured: true,
	});
	const topology: RoutingTopology = {
		service: "staging-site",
		tenantId,
		stationId: "station:staging",
		backends: [
			{
				id: "backend:a",
				service: "staging-site",
				endpoint: backendA,
				healthy: true,
			},
			{
				id: "backend:b",
				service: "staging-site",
				endpoint: backendB,
				healthy: true,
			},
		],
	};
	return {
		port,
		topology,
		probeUrl,
		fromBackendId: "backend:a",
		toBackendId: "backend:b",
		healthGate: async () => {
			const probe = await fetch(probeUrl, { redirect: "follow" });
			return probe.status === 200;
		},
		cleanup: async () => {},
	};
}

async function main(): Promise<void> {
	const cli = parseCli();
	const binding =
		cli.provider === "simple"
			? await bindSimple(cli)
			: cli.provider === "vercel"
				? await bindVercel()
				: await bindCloudflare();

	const facts: { type: string; data: unknown }[] = [];
	const loop = createRoutingControlLoop({
		topology: binding.topology,
		policyDecision: policyDecision(binding.topology.service),
		costModel: [
			{ backendId: binding.fromBackendId, listUnitCost: 0.05 },
			{ backendId: binding.toBackendId, listUnitCost: 0.01 },
		],
		port: binding.port,
		stability: { cooldownSeconds: 300 },
		incumbentBackendId: binding.fromBackendId,
		units: 100,
		cutover: {
			rampSteps: [10, 50, 100],
			healthGate: async () => {
				// Let live probe traffic interleave with every ramp stage.
				await new Promise((resolve) =>
					setTimeout(resolve, Math.max(cli.probeIntervalMs * 2, 100)),
				);
				return binding.healthGate();
			},
		},
		onFact: (fact) => {
			facts.push({ type: fact.type, data: fact.data });
			console.log(`  fact: ${fact.type}`);
		},
	});

	console.log(
		`staging-cutover-demo: provider=${cli.provider} probe=${binding.probeUrl} interval=${cli.probeIntervalMs}ms`,
	);
	const probe = startUptimeProbe(binding.probeUrl, cli.probeIntervalMs);
	// Establish a pre-swap baseline window.
	await new Promise((resolve) =>
		setTimeout(resolve, Math.max(cli.probeIntervalMs * 3, 150)),
	);

	const startedAt = new Date().toISOString();
	const outcome = await loop.handleSignal({
		kind: "budget",
		fact: {
			type: "budget.ThresholdCrossed",
			data: { tenantId: "tenant-staging", thresholdFraction: 0.8, cycle: 1 },
		},
	});
	// Post-swap observation window.
	await new Promise((resolve) =>
		setTimeout(resolve, Math.max(cli.probeIntervalMs * 3, 150)),
	);
	const samples = await probe.stop();
	await binding.cleanup();

	const failures = samples.filter((sample) => sample.status !== 200);
	const verdict = {
		provider: cli.provider,
		startedAt,
		finishedAt: new Date().toISOString(),
		outcome: outcome.action,
		incumbent: loop.incumbent(),
		probe: {
			url: binding.probeUrl,
			intervalMs: cli.probeIntervalMs,
			total: samples.length,
			failed: failures.length,
			successRate:
				samples.length === 0
					? 0
					: (samples.length - failures.length) / samples.length,
		},
		facts,
		samples,
	};

	mkdirSync(cli.evidenceDir, { recursive: true });
	const evidencePath = path.join(
		cli.evidenceDir,
		`${startedAt.replace(/[:.]/gu, "-")}-${cli.provider}.json`,
	);
	writeFileSync(evidencePath, `${JSON.stringify(verdict, null, "\t")}\n`);
	console.log(`evidence: ${evidencePath}`);
	console.log(
		`probe: ${verdict.probe.total} samples, ${verdict.probe.failed} failed (${(verdict.probe.successRate * 100).toFixed(2)}%)`,
	);

	if (outcome.action !== "reapplied") {
		fail(`swap did not complete: ${outcome.action}`, 3);
	}
	if (failures.length > 0) {
		fail(
			`${failures.length}/${samples.length} probe samples failed during the swap`,
			4,
		);
	}
	console.log(
		`staging-cutover-demo: SUCCESS — ${loop.incumbent()} now serves 100% with zero probe failures`,
	);
}

await main();
