import { describe, expect, test } from "vitest";

import {
	DEFAULT_CONNECTIVITY_CONFIG,
	parseConnectivityConfig,
} from "../src/config.js";
import {
	probePortless,
	registerPortlessRoute,
	resolvePortlessMode,
} from "../src/local/portless.js";

describe("parseConnectivityConfig: totality", () => {
	test("a null, undefined or non-object input yields the defaults", () => {
		for (const raw of [null, undefined, "text", 42, true]) {
			expect(parseConnectivityConfig(raw)).toEqual(DEFAULT_CONNECTIVITY_CONFIG);
		}
	});

	test("an empty object yields the defaults", () => {
		expect(parseConnectivityConfig({})).toEqual(DEFAULT_CONNECTIVITY_CONFIG);
	});

	test("an array is treated as an object and yields the defaults", () => {
		expect(parseConnectivityConfig([])).toEqual(DEFAULT_CONNECTIVITY_CONFIG);
	});

	test("a partially-specified section keeps the defaults for the rest", () => {
		const config = parseConnectivityConfig({
			naming: { defaultEnv: "staging" },
		});
		expect(config.naming.defaultEnv).toBe("staging");
		expect(config.naming.localTld).toBe("localhost");
		expect(config.naming.overlayTld).toBe("test");
	});

	test("non-overlay sections of the wrong type keep their defaults", () => {
		expect(() =>
			parseConnectivityConfig({ dns: 42, naming: null }),
		).not.toThrow();
	});
});

describe("parseConnectivityConfig: overlay", () => {
	test("uses the default for an omitted provider and accepts supported providers", () => {
		expect(parseConnectivityConfig({ overlay: {} }).overlay.provider).toBe(
			"wireguard",
		);
		for (const provider of ["wireguard", "tailscale", "netbird"]) {
			expect(
				parseConnectivityConfig({ overlay: { provider } }).overlay.provider,
			).toBe(provider);
		}
	});

	test("rejects invalid providers and malformed overlay sections", () => {
		for (const provider of ["", "unknown", 42, null]) {
			expect(() => parseConnectivityConfig({ overlay: { provider } })).toThrow(
				"overlay.provider must be wireguard, tailscale, or netbird",
			);
		}
		for (const overlay of [null, "tailscale", 42, []]) {
			expect(() => parseConnectivityConfig({ overlay })).toThrow(
				"overlay must be an object",
			);
		}
	});

	test("magicDnsDomains keeps only strings", () => {
		const config = parseConnectivityConfig({
			overlay: { magicDnsDomains: ["a.test", 42, null, "b.test"] },
		});
		expect(config.overlay.magicDnsDomains).toEqual(["a.test", "b.test"]);
	});

	test("a non-array magicDnsDomains falls back to the defaults", () => {
		expect(
			parseConnectivityConfig({ overlay: { magicDnsDomains: "a.test" } })
				.overlay.magicDnsDomains,
		).toEqual(DEFAULT_CONNECTIVITY_CONFIG.overlay.magicDnsDomains);
	});

	test("an explicitly empty magicDnsDomains list is respected", () => {
		expect(
			parseConnectivityConfig({ overlay: { magicDnsDomains: [] } }).overlay
				.magicDnsDomains,
		).toEqual([]);
	});

	test("enableFunnel is on unless explicitly false", () => {
		expect(parseConnectivityConfig({ overlay: {} }).overlay.enableFunnel).toBe(
			true,
		);
		expect(
			parseConnectivityConfig({ overlay: { enableFunnel: false } }).overlay
				.enableFunnel,
		).toBe(false);
		expect(
			parseConnectivityConfig({ overlay: { enableFunnel: "false" } }).overlay
				.enableFunnel,
		).toBe(true);
	});
});

describe("parseConnectivityConfig: dns", () => {
	test("managedBy accepts only its three known values", () => {
		for (const value of ["hobo", "cloud-provider", "none"]) {
			expect(
				parseConnectivityConfig({ dns: { public: { managedBy: value } } }).dns
					.public.managedBy,
			).toBe(value);
		}
		for (const value of ["terraform", "", 42, null]) {
			expect(
				parseConnectivityConfig({ dns: { public: { managedBy: value } } }).dns
					.public.managedBy,
			).toBe("none");
		}
	});

	test("an unrecognised provider falls back to none rather than passing through", () => {
		expect(
			parseConnectivityConfig({ dns: { public: { provider: "cloudflare" } } })
				.dns.public.provider,
		).toBe("cloudflare");
		expect(
			parseConnectivityConfig({ dns: { public: { provider: "digitalocean" } } })
				.dns.public.provider,
		).toBe("none");
	});

	test("every documented provider name is accepted", () => {
		for (const provider of [
			"cloudflare",
			"route53",
			"azure",
			"google",
			"dnscontrol",
			"octodns",
			"memory",
			"none",
		]) {
			expect(
				parseConnectivityConfig({ dns: { public: { provider } } }).dns.public
					.provider,
			).toBe(provider);
		}
	});

	test("an absent zone is omitted rather than set undefined", () => {
		const config = parseConnectivityConfig({ dns: { public: {} } });
		expect("zone" in config.dns.public).toBe(false);
	});

	test("a non-string zone is dropped", () => {
		expect(
			"zone" in
				parseConnectivityConfig({ dns: { public: { zone: 42 } } }).dns.public,
		).toBe(false);
	});

	test("credentials keep only string values", () => {
		const config = parseConnectivityConfig({
			dns: {
				public: {
					credentials: { token: "abc", retries: 3, nested: { a: 1 } },
				},
			},
		});
		expect(config.dns.public.credentials).toEqual({ token: "abc" });
	});

	test("a non-object credentials field is omitted entirely", () => {
		for (const credentials of ["abc", 42, null]) {
			const config = parseConnectivityConfig({
				dns: { public: { credentials } },
			});
			expect("credentials" in config.dns.public).toBe(false);
		}
	});

	test("allowedGatewaySuffixes keeps only strings and is omitted when absent", () => {
		const config = parseConnectivityConfig({
			dns: { public: { allowedGatewaySuffixes: [".hobo.dev", 42, null] } },
		});
		expect(config.dns.public.allowedGatewaySuffixes).toEqual([".hobo.dev"]);
		expect(
			"allowedGatewaySuffixes" in
				parseConnectivityConfig({ dns: { public: {} } }).dns.public,
		).toBe(false);
	});

	test("a non-array allowedGatewaySuffixes is omitted, not coerced", () => {
		expect(
			"allowedGatewaySuffixes" in
				parseConnectivityConfig({
					dns: { public: { allowedGatewaySuffixes: ".hobo.dev" } },
				}).dns.public,
		).toBe(false);
	});
});

describe("parseConnectivityConfig: naming, metering, tenancy, policy", () => {
	test("multiTenant requires the boolean true", () => {
		expect(
			parseConnectivityConfig({ naming: { multiTenant: true } }).naming
				.multiTenant,
		).toBe(true);
		for (const value of ["true", 1, {}]) {
			expect(
				parseConnectivityConfig({ naming: { multiTenant: value } }).naming
					.multiTenant,
			).toBe(false);
		}
	});

	test("non-string naming fields fall back to their defaults", () => {
		const config = parseConnectivityConfig({
			naming: { defaultEnv: 42, localTld: null, overlayTld: [] },
		});
		expect(config.naming.defaultEnv).toBe("prod");
		expect(config.naming.localTld).toBe("localhost");
		expect(config.naming.overlayTld).toBe("test");
	});

	test("metering is enabled unless explicitly false", () => {
		expect(parseConnectivityConfig({ metering: {} }).metering.enabled).toBe(
			true,
		);
		expect(
			parseConnectivityConfig({ metering: { enabled: false } }).metering
				.enabled,
		).toBe(false);
	});

	test("metering sinks keep only the three known names", () => {
		const config = parseConnectivityConfig({
			metering: { sinks: ["memory", "kafka", "log", 42, "billing"] },
		});
		expect(config.metering.sinks).toEqual(["memory", "log", "billing"]);
	});

	test("a non-array sinks field falls back to the defaults", () => {
		expect(
			parseConnectivityConfig({ metering: { sinks: "memory" } }).metering.sinks,
		).toEqual(["memory", "billing"]);
	});

	test("an explicitly empty sinks list is respected", () => {
		expect(
			parseConnectivityConfig({ metering: { sinks: [] } }).metering.sinks,
		).toEqual([]);
	});

	test("the isolation mode accepts its two hard values and defaults to soft", () => {
		for (const mode of ["hard-overlay", "hard-control-plane"]) {
			expect(
				parseConnectivityConfig({ tenancy: { defaultIsolationMode: mode } })
					.tenancy.defaultIsolationMode,
			).toBe(mode);
		}
		for (const mode of ["hard", "strict", 42, null]) {
			expect(
				parseConnectivityConfig({ tenancy: { defaultIsolationMode: mode } })
					.tenancy.defaultIsolationMode,
			).toBe("soft");
		}
	});

	test("the policy engine is opa only when named exactly", () => {
		expect(
			parseConnectivityConfig({ policy: { engine: "opa" } }).policy.engine,
		).toBe("opa");
		for (const engine of ["OPA", "rego", "", null]) {
			expect(
				parseConnectivityConfig({ policy: { engine } }).policy.engine,
			).toBe("tag-acl");
		}
	});

	test("the opa url is carried through when a string and omitted otherwise", () => {
		expect(
			parseConnectivityConfig({
				policy: { engine: "opa", opaUrl: "http://opa:8181" },
			}).policy.opaUrl,
		).toBe("http://opa:8181");
		expect(
			"opaUrl" in
				parseConnectivityConfig({ policy: { engine: "opa", opaUrl: 42 } })
					.policy,
		).toBe(false);
	});

	test("an opa url is kept even when the engine is tag-acl", () => {
		const config = parseConnectivityConfig({
			policy: { opaUrl: "http://opa:8181" },
		});
		expect(config.policy.engine).toBe("tag-acl");
		expect(config.policy.opaUrl).toBe("http://opa:8181");
	});
});

describe("resolvePortlessMode", () => {
	test("it defaults to auto with no env set", () => {
		expect(resolvePortlessMode({})).toBe("auto");
	});

	test("every documented off spelling turns it off", () => {
		for (const raw of ["0", "false", "off", "no", "OFF", " off ", "False"]) {
			expect(resolvePortlessMode({ HOBO_PORTLESS: raw })).toBe("off");
		}
	});

	test("every documented on spelling turns it on", () => {
		for (const raw of ["1", "true", "on", "yes", "ON", " yes "]) {
			expect(resolvePortlessMode({ HOBO_PORTLESS: raw })).toBe("on");
		}
	});

	test("an unrecognised value falls back to auto rather than to on", () => {
		for (const raw of ["maybe", "2", ""]) {
			expect(resolvePortlessMode({ HOBO_PORTLESS: raw })).toBe("auto");
		}
	});

	test("HOBO_NAMED_ENDPOINTS is honoured as an alias", () => {
		expect(resolvePortlessMode({ HOBO_NAMED_ENDPOINTS: "off" })).toBe("off");
	});

	test("HOBO_PORTLESS wins over the alias", () => {
		expect(
			resolvePortlessMode({ HOBO_PORTLESS: "on", HOBO_NAMED_ENDPOINTS: "off" }),
		).toBe("on");
	});
});

describe("probePortless", () => {
	const found = () => ({ ok: true, stdout: "1.2.3 (build abc)" });
	const missing = () => ({ ok: false, stdout: "" });

	test("a present binary in auto mode is available and enabled", () => {
		const probe = probePortless({ env: {}, runVersion: found });
		expect(probe.available).toBe(true);
		expect(probe.enabled).toBe(true);
		expect(probe.mode).toBe("auto");
		expect(probe.hint).toBeNull();
	});

	test("a missing binary in auto mode is unavailable and hints how to fix it", () => {
		const probe = probePortless({ env: {}, runVersion: missing });
		expect(probe.available).toBe(false);
		expect(probe.enabled).toBe(false);
		expect(probe.hint).toContain("portless");
		expect(probe.hint).toContain("HOBO_PORTLESS=0");
	});

	test("off mode disables it even when the binary is present", () => {
		const probe = probePortless({
			env: { HOBO_PORTLESS: "off" },
			runVersion: found,
		});
		expect(probe.available).toBe(true);
		expect(probe.enabled).toBe(false);
	});

	test("off mode silences the hint", () => {
		expect(
			probePortless({ env: { HOBO_PORTLESS: "off" }, runVersion: missing })
				.hint,
		).toBeNull();
	});

	test("on mode still cannot enable a binary that is not there", () => {
		const probe = probePortless({
			env: { HOBO_PORTLESS: "on" },
			runVersion: missing,
		});
		expect(probe.available).toBe(false);
		expect(probe.enabled).toBe(false);
		expect(probe.hint).toContain("portless");
	});

	test("the version is the first whitespace-delimited token", () => {
		expect(probePortless({ env: {}, runVersion: found }).version).toBe("1.2.3");
	});

	test("a version with no whitespace is used whole", () => {
		expect(
			probePortless({
				env: {},
				runVersion: () => ({ ok: true, stdout: "2.0.0" }),
			}).version,
		).toBe("2.0.0");
	});

	test("a configured path that does not exist on disk is skipped, not spawned", () => {
		const seen: string[] = [];
		probePortless({
			env: { HOBO_PORTLESS_BIN: "/nonexistent/from/env" },
			binPath: "/nonexistent/explicit/portless",
			runVersion: (bin) => {
				seen.push(bin);
				return { ok: false, stdout: "" };
			},
		});
		expect(seen).toEqual(["portless"]);
	});

	test("an explicit bin path that exists is preferred over the bare name", () => {
		const seen: string[] = [];
		const probe = probePortless({
			env: {},
			binPath: process.execPath,
			runVersion: (bin) => {
				seen.push(bin);
				return { ok: true, stdout: "1.0.0" };
			},
		});
		expect(seen[0]).toBe(process.execPath);
		expect(probe.binPath).toBe(process.execPath);
	});

	test("an existing env bin path is tried before the bare name", () => {
		const seen: string[] = [];
		probePortless({
			env: { HOBO_PORTLESS_BIN: process.execPath },
			runVersion: (bin) => {
				seen.push(bin);
				return { ok: false, stdout: "" };
			},
		});
		expect(seen.indexOf(process.execPath)).toBeLessThan(
			seen.indexOf("portless"),
		);
	});

	test("probing stops at the first candidate that answers", () => {
		const seen: string[] = [];
		const probe = probePortless({
			env: { HOBO_PORTLESS_BIN: process.execPath },
			runVersion: (bin) => {
				seen.push(bin);
				return { ok: true, stdout: "1.0.0" };
			},
		});
		expect(seen).toEqual([process.execPath]);
		expect(probe.binPath).toBe(process.execPath);
	});

	test("an empty bin path in the env is skipped", () => {
		const seen: string[] = [];
		probePortless({
			env: { HOBO_PORTLESS_BIN: "" },
			runVersion: (bin) => {
				seen.push(bin);
				return { ok: false, stdout: "" };
			},
		});
		expect(seen).toEqual(["portless"]);
	});

	test("the probe reports null paths when nothing is found", () => {
		const probe = probePortless({ env: {}, runVersion: missing });
		expect(probe.binPath).toBeNull();
		expect(probe.version).toBeNull();
	});

	test("it never throws, whatever the environment holds", () => {
		expect(() =>
			probePortless({
				env: { HOBO_PORTLESS: "maybe", HOBO_PORTLESS_BIN: "/nonexistent/x" },
				runVersion: missing,
			}),
		).not.toThrow();
	});
});

describe("registerPortlessRoute", () => {
	test("the first CLI shape that works is used", async () => {
		const calls: string[][] = [];
		const result = await registerPortlessRoute({
			hostname: "app.hobo.test",
			backendUrl: "http://127.0.0.1:3000",
			run: (args) => {
				calls.push([...args]);
				return { ok: true, stdout: "", stderr: "" };
			},
		});
		expect(result.registered).toBe(true);
		expect(calls).toEqual([
			["proxy", "set", "app.hobo.test", "http://127.0.0.1:3000"],
		]);
	});

	test("later shapes are tried when earlier ones fail", async () => {
		const calls: string[][] = [];
		const result = await registerPortlessRoute({
			hostname: "app.hobo.test",
			backendUrl: "http://127.0.0.1:3000",
			run: (args) => {
				calls.push([...args]);
				return { ok: args[0] === "add", stdout: "", stderr: "" };
			},
		});
		expect(result.registered).toBe(true);
		expect(calls.map((c) => c[0])).toEqual(["proxy", "set", "add"]);
	});

	test("every shape failing reports unregistered with an explanatory note", async () => {
		const result = await registerPortlessRoute({
			hostname: "app.hobo.test",
			backendUrl: "http://127.0.0.1:3000",
			run: () => ({ ok: false, stdout: "", stderr: "boom" }),
		});
		expect(result.registered).toBe(false);
		expect(result.note).toContain("hierarchical names");
	});

	test("a successful registration carries no note", async () => {
		const result = await registerPortlessRoute({
			hostname: "app.hobo.test",
			backendUrl: "http://127.0.0.1:3000",
			run: () => ({ ok: true, stdout: "", stderr: "" }),
		});
		expect(result.note).toBeUndefined();
	});

	test("the hostname and backend are passed through verbatim", async () => {
		const calls: string[][] = [];
		await registerPortlessRoute({
			hostname: "my-app.tenant.hobo.test",
			backendUrl: "http://127.0.0.1:8080/base",
			run: (args) => {
				calls.push([...args]);
				return { ok: true, stdout: "", stderr: "" };
			},
		});
		expect(calls[0]).toContain("my-app.tenant.hobo.test");
		expect(calls[0]).toContain("http://127.0.0.1:8080/base");
	});
});
