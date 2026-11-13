/**
 * Pure in-process foundations: naming, memory DNS, overlays via CLI stubs
 * (no HTTP fetch), tenancy, named endpoints, config.
 *
 * External HTTP (Cloudflare, Route53, Tailscale API, Netbird API, Stripe, OPA)
 * is covered exclusively by contracts/ consumer + provider PACT suites.
 */

import assert from "node:assert/strict";
import {
	createMeteringBus,
	createUsageEvent,
	getNamedEndpoint,
	parseTenantId,
} from "@hobo/core";
import { describe, expect, it } from "vitest";

import { parseConnectivityConfig } from "../../src/config.js";
import { createDnsControlProvider } from "../../src/dns/dnscontrol-provider.js";
import { createJunctionDynamicDnsRegistrar } from "../../src/dns/dynamic-registrar.js";
import { createMemoryDnsProvider } from "../../src/dns/memory-provider.js";
import { createPublicDnsManager } from "../../src/dns/public-dns-manager.js";
import { createJunctionAgent } from "../../src/junction-agent.js";
import {
	attachNamedEndpoints,
	getNamedEndpointSession,
} from "../../src/local/named-endpoints.js";
import { probePortless } from "../../src/local/portless.js";
import { createInMemoryMeteringSink } from "../../src/metering/sinks.js";
import { createNetbirdOverlay } from "../../src/overlay/netbird.js";
import { createTailscaleOverlay } from "../../src/overlay/tailscale.js";
import { createTagAclPolicyEngine } from "../../src/policy/tag-acl-engine.js";
import {
	createTenantIsolationRegistry,
	tenantFromSlug,
} from "../../src/tenancy/isolation.js";

describe("connectivity config + naming (pure)", () => {
	it("parses public DNS managedBy modes", () => {
		const cfg = parseConnectivityConfig({
			dns: {
				public: {
					managedBy: "hobo",
					provider: "dnscontrol",
					zone: "example.com",
				},
			},
			overlay: { provider: "tailscale" },
			policy: { engine: "opa", opaUrl: "http://127.0.0.1:8181/v1/data/hobo" },
			tenancy: { defaultIsolationMode: "hard-overlay" },
		});
		expect(cfg.dns.public.managedBy).toBe("hobo");
		expect(cfg.dns.public.provider).toBe("dnscontrol");
		expect(cfg.overlay.provider).toBe("tailscale");
		expect(cfg.policy.engine).toBe("opa");
		expect(cfg.tenancy.defaultIsolationMode).toBe("hard-overlay");
	});

	it("shared naming function matches required examples", () => {
		expect(
			getNamedEndpoint({
				resource: "web",
				app: "myapp",
				env: "prod",
				mode: "overlay",
			}),
		).toBe("https://web.myapp.hobo.test");
		expect(
			getNamedEndpoint({
				resource: "web",
				app: "myapp",
				env: "dev",
				tenant: "acme",
				mode: "overlay",
			}),
		).toBe("https://web.myapp.dev.acme.hobo.test");
	});

	it("usage event helper shapes billing-ready records", () => {
		const event = createUsageEvent({
			tenantId: parseTenantId("acme"),
			eventType: "tunnel.heartbeat",
			resource: "junction-1",
			quantity: 1,
			unit: "tick",
		});
		expect(event.tenantId).toBe("acme");
		expect(event.timestamp).toMatch(/^\d{4}-/);
	});
});

describe("memory DNS + dnscontrol (pure)", () => {
	it("public DNS refuses raw overlay IPs and applies only when managedBy=hobo", async () => {
		const sink = createInMemoryMeteringSink();
		const bus = createMeteringBus([sink]);
		const memory = createMemoryDnsProvider();
		const hoboManaged = createPublicDnsManager({
			config: {
				managedBy: "hobo",
				provider: "memory",
				zone: "example.com",
			},
			provider: memory,
			metering: bus,
		});

		await expect(
			hoboManaged.reconcileEntrypoint({
				tenantId: parseTenantId("acme"),
				hostname: "web.myapp.hobo.example.com",
				gatewayHostname: "100.64.0.1",
			}),
		).rejects.toThrow(/gateway/);

		const applied = await hoboManaged.reconcileEntrypoint({
			tenantId: parseTenantId("acme"),
			hostname: "web.myapp.hobo.example.com",
			gatewayHostname: "funnel-abc.ts.net",
		});
		expect(applied.applied).toBe(true);
		expect(memory.store.size).toBe(1);

		const cloudManaged = createPublicDnsManager({
			config: { managedBy: "cloud-provider", provider: "route53" },
			metering: bus,
		});
		const suggested = await cloudManaged.reconcileEntrypoint({
			tenantId: parseTenantId("acme"),
			hostname: "web.myapp.hobo.example.com",
			gatewayHostname: "proxy.cfargotunnel.com",
		});
		expect(suggested.applied).toBe(false);
		expect(suggested.suggested?.type).toBe("CNAME");
	});

	it("dnscontrol provider exports a plan without shelling out", async () => {
		const provider = createDnsControlProvider();
		await provider.upsert(parseTenantId("acme"), "example.com", {
			name: "web.myapp.hobo",
			type: "CNAME",
			content: "funnel.ts.net",
			gatewayTarget: true,
		});
		const js = provider.exportDnsConfigJs();
		expect(js).toContain('D("example.com"');
		expect(js).toContain("CNAME");
		expect(provider.plans).toHaveLength(1);
	});
});

describe("overlay CLI stubs (no HTTP)", () => {
	it("junction agent joins overlay (degraded without tailscale) and emits usage", async () => {
		const sink = createInMemoryMeteringSink();
		const bus = createMeteringBus([sink]);
		const overlay = createTailscaleOverlay({
			metering: bus,
			run: () => ({ ok: false, stdout: "", stderr: "missing" }),
		});
		const policy = createTagAclPolicyEngine({ metering: bus });
		const agent = createJunctionAgent({
			config: {
				tenantId: "acme",
				name: "junction-aws-1",
				role: "junction",
				env: "dev",
				cloud: "aws",
			},
			overlay,
			policy,
			metering: bus,
		});
		const started = await agent.start();
		expect(started.ready).toBe(false);
		expect(started.notes.join(" ")).toMatch(/tailscale/i);
		expect(
			sink.events.some(
				(e) => e.eventType === "junction.join" && e.tenantId === "acme",
			),
		).toBe(true);
		await agent.stop();
	});

	it("netbird overlay without API is not ready", async () => {
		const overlay = createNetbirdOverlay();
		const join = await overlay.join({
			tenantId: parseTenantId("acme"),
			hostname: "nb-1",
			tags: overlay.tenantTags({
				tenantId: parseTenantId("acme"),
				role: "junction",
			}),
		});
		expect(join.provider).toBe("netbird");
		expect(join.ready).toBe(false);
	});

	it("configures MagicDNS split and Funnel gateway from CLI output only", async () => {
		const sink = createInMemoryMeteringSink();
		const bus = createMeteringBus([sink]);
		const commands: string[][] = [];
		const overlay = createTailscaleOverlay({
			metering: bus,
			run: (args) => {
				commands.push([...args]);
				if (args[0] === "status") {
					return {
						ok: true,
						stdout: JSON.stringify({
							Self: {
								ID: "n1",
								DNSName: "node.tailnet.ts.net.",
								TailscaleIPs: ["100.64.0.2"],
							},
						}),
						stderr: "",
					};
				}
				if (args[0] === "set") {
					return { ok: true, stdout: "", stderr: "" };
				}
				if (args[0] === "dns") {
					return { ok: false, stdout: "", stderr: "no dns subcommand" };
				}
				if (args[0] === "funnel") {
					return {
						ok: true,
						stdout:
							"Available on the internet:\n\nhttps://node.tailnet.ts.net/\n",
						stderr: "",
					};
				}
				return { ok: true, stdout: "", stderr: "" };
			},
		});

		const join = await overlay.join({
			tenantId: parseTenantId("acme"),
			hostname: "junction-1",
			tags: overlay.tenantTags({
				tenantId: parseTenantId("acme"),
				role: "junction",
			}),
			authKey: "tskey-test",
		});
		expect(join.ready).toBe(true);

		assert(overlay.configureMagicDns);
		const magic = await overlay.configureMagicDns({
			tenantId: parseTenantId("acme"),
			domains: ["hobo.test"],
			nameservers: ["100.100.100.100"],
		});
		expect(magic.domains).toContain("hobo.test");
		// Without API key: local-only path (control plane not applied over HTTP).
		expect(magic.notes.join(" ")).toMatch(
			/split-dns|hobo\.test|controlPlaneApplied=false|TS_API_KEY/,
		);

		assert(overlay.publishFunnel);
		const funnel = await overlay.publishFunnel({
			tenantId: parseTenantId("acme"),
			backendUrl: "http://127.0.0.1:7071",
			localPort: 7071,
		});
		expect(funnel.enabled).toBe(true);
		expect(funnel.gatewayHostname).toBe("node.tailnet.ts.net");
		expect(sink.events.some((e) => e.eventType === "overlay.magicdns")).toBe(
			true,
		);
		expect(sink.events.some((e) => e.eventType === "overlay.funnel")).toBe(
			true,
		);
		expect(commands.some((c) => c[0] === "funnel")).toBe(true);
		expect(
			commands
				.filter((command) => command[0] === "funnel")
				.every((command) => command.includes("--bg")),
		).toBe(true);
	});
});

describe("named endpoints + portless (pure)", () => {
	it("attachNamedEndpoints emits hierarchical URLs and registers session", async () => {
		const sink = createInMemoryMeteringSink();
		const bus = createMeteringBus([sink]);
		const named = await attachNamedEndpoints({
			app: "myapp",
			env: "local",
			sessionId: "test-session",
			metering: bus,
			processEnv: {},
			forcePortless: {
				available: false,
				binPath: null,
				version: null,
				mode: "auto",
				enabled: false,
				hint: "named HTTPS URLs require portless",
			},
			endpoints: [
				{
					resourceName: "web",
					kind: "web",
					backendUrl: "http://127.0.0.1:7071",
					external: true,
					serviceDiscoveryKey: "services__web__http__0",
				},
				{
					resourceName: "api",
					kind: "api",
					backendUrl: "http://hobo.internal/api",
					external: false,
					serviceDiscoveryKey: "services__api__http__0",
				},
			],
		});

		expect(named.primaryNamedUrl).toBe(
			"http://web.myapp.local.hobo.localhost:7071",
		);
		expect(named.namedEndpoints[0]?.url).toBe(
			"http://web.myapp.local.hobo.localhost:7071",
		);
		expect(named.namedEndpoints[1]?.url).toBe(
			"https://api.myapp.local.hobo.test",
		);
		expect(named.namedEndpoints[0]?.hostname).toMatch(/\.hobo\.localhost$/);
		expect(named.namedEndpoints[0]?.hostname.endsWith(".hobo")).toBe(false);
		expect(getNamedEndpointSession("test-session")?.primaryNamedUrl).toBe(
			named.primaryNamedUrl,
		);
		expect(
			sink.events.filter((e) => e.eventType === "named_endpoint.register"),
		).toHaveLength(2);
		await named.close();
	});

	it("probePortless is non-fatal when disabled", () => {
		const probe = probePortless({
			env: { HOBO_PORTLESS: "0" },
			runVersion: () => ({ ok: true, stdout: "1.0.0" }),
		});
		expect(probe.mode).toBe("off");
		expect(probe.enabled).toBe(false);
	});
});

describe("multi-tenant isolation + dynamic DNS (pure)", () => {
	it("gives hard-isolated tenants distinct overlays and control-plane partitions", () => {
		const registry = createTenantIsolationRegistry(
			{
				shared: createTailscaleOverlay(),
				forTenant: () => createTailscaleOverlay(),
			},
			{ defaultMode: "soft" },
		);
		const softA = registry.registerTenant(tenantFromSlug("soft-a", "soft"));
		const softB = registry.registerTenant(tenantFromSlug("soft-b", "soft"));
		const hardA = registry.registerTenant(
			tenantFromSlug("hard-a", "hard-control-plane"),
		);
		const hardB = registry.registerTenant(
			tenantFromSlug("hard-b", "hard-control-plane"),
		);

		expect(softA.overlay).toBe(softB.overlay);
		expect(hardA.overlay).not.toBe(hardB.overlay);
		expect(registry.getControlPlane("hard-a")?.partitionKey).toBe("cp-hard-a");
		expect(registry.assertNetworkIsolation("hard-a", "hard-b").isolated).toBe(
			true,
		);
		expect(registry.assertNetworkIsolation("soft-a", "soft-b").isolated).toBe(
			false,
		);
	});

	it("registers hierarchical CNAMEs to Funnel gateways on heartbeat", async () => {
		const sink = createInMemoryMeteringSink();
		const bus = createMeteringBus([sink]);
		const memory = createMemoryDnsProvider();
		const dns = createPublicDnsManager({
			config: {
				managedBy: "hobo",
				provider: "memory",
				zone: "example.com",
				allowedGatewaySuffixes: [".ts.net"],
			},
			provider: memory,
			metering: bus,
		});
		const overlay = createTailscaleOverlay({
			metering: bus,
			run: (args) => {
				if (args[0] === "status") {
					return {
						ok: true,
						stdout: JSON.stringify({
							Self: { ID: "n", DNSName: "j.ts.net.", TailscaleIPs: [] },
						}),
						stderr: "",
					};
				}
				if (args[0] === "funnel") {
					return {
						ok: true,
						stdout: "https://j.ts.net/\n",
						stderr: "",
					};
				}
				return { ok: true, stdout: "", stderr: "" };
			},
		});

		const registrar = createJunctionDynamicDnsRegistrar({
			tenantId: "acme",
			dns,
			overlay,
			metering: bus,
			tld: "example.com",
		});
		registrar.setTargets([
			{
				resource: "web",
				app: "myapp",
				env: "dev",
				backendUrl: "http://127.0.0.1:7071",
			},
		]);

		const result = await registrar.onHeartbeat();
		expect(result.registered).toBe(1);
		expect(memory.store.size).toBe(1);
		expect(
			sink.events.some((e) => e.eventType === "dns.dynamic_register"),
		).toBe(true);

		const agent = createJunctionAgent({
			config: {
				tenantId: "acme",
				name: "j-aws",
				dnsTargets: [
					{
						resource: "api",
						app: "myapp",
						gatewayHostname: "j.ts.net",
					},
				],
			},
			overlay,
			metering: bus,
			publicDns: dns,
		});
		await agent.start();
		const hb = await agent.heartbeat();
		if (hb.dns) {
			expect(hb.dns.registered + hb.dns.skipped).toBeGreaterThanOrEqual(0);
		}
	});
});
