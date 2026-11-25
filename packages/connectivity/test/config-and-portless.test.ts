/**
 * Two small, unglamorous modules that decide a lot.
 *
 * `parseConnectivityConfig` is the boundary where a user's YAML becomes typed
 * configuration. Its whole job is to be total: any input at all, including
 * hostile or half-written input, has to produce a usable config rather than an
 * object with undefined fields that fails somewhere far away. The interesting
 * cases are all the ones where a field is present but wrong — a string where a
 * list belongs, an unrecognised provider name, a boolean spelled as text — and
 * they are exactly the cases a well-formed fixture never reaches.
 *
 * `probePortless` decides whether the local path can offer named HTTPS URLs. It
 * must never throw, because a missing optional binary is the normal state on
 * most machines, and it must respect an explicit off switch even when the binary
 * is present. Its `enabled` field folds three inputs — the mode, the binary's
 * presence, and the env — and each combination is a branch worth naming.
 */
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
		// A config file that failed to parse must still start the system with a
		// working default rather than crashing at first use.
		for (const raw of [null, undefined, "text", 42, true]) {
			expect(parseConnectivityConfig(raw)).toEqual(DEFAULT_CONNECTIVITY_CONFIG);
		}
	});

	test("an empty object yields the defaults", () => {
		expect(parseConnectivityConfig({})).toEqual(DEFAULT_CONNECTIVITY_CONFIG);
	});

	test("an array is treated as an object and yields the defaults", () => {
		// `typeof [] === "object"`, so this takes the object path; every field
		// lookup misses and the defaults fill in. Pinned so the behaviour is
		// deliberate rather than incidental.
		expect(parseConnectivityConfig([])).toEqual(DEFAULT_CONNECTIVITY_CONFIG);
	});

	test("a partially-specified section keeps the defaults for the rest", () => {
		// Someone setting one field must not silently blank out its neighbours.
		const config = parseConnectivityConfig({
			naming: { defaultEnv: "staging" },
		});
		expect(config.naming.defaultEnv).toBe("staging");
		expect(config.naming.localTld).toBe("localhost");
		expect(config.naming.overlayTld).toBe("test");
	});

	test("a section of the wrong type falls back rather than throwing", () => {
		// `overlay: "tailscale"` is a plausible mistake — a string where an object
		// belongs. Indexing into it yields undefined for every field, which the
		// defaults absorb.
		expect(() =>
			parseConnectivityConfig({ overlay: "tailscale", dns: 42, naming: null }),
		).not.toThrow();
	});
});

describe("parseConnectivityConfig: overlay", () => {
	test("netbird is recognised and anything else falls back to tailscale", () => {
		// An unrecognised overlay name must not become the literal string — the
		// value is used to select an adapter, and an unknown one has no adapter.
		expect(
			parseConnectivityConfig({ overlay: { provider: "netbird" } }).overlay
				.provider,
		).toBe("netbird");
		for (const provider of ["wireguard", "", 42, null, undefined]) {
			expect(
				parseConnectivityConfig({ overlay: { provider } }).overlay.provider,
			).toBe("tailscale");
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
		// Distinct from absent: an operator who wrote `[]` meant none, and
		// falling back to the defaults there would re-enable domains they removed.
		expect(
			parseConnectivityConfig({ overlay: { magicDnsDomains: [] } }).overlay
				.magicDnsDomains,
		).toEqual([]);
	});

	test("enableFunnel is on unless explicitly false", () => {
		// Opt-out rather than opt-in, so a config that omits it keeps working.
		// Only the boolean `false` disables — the string "false" does not, which
		// is worth pinning because it is a plausible YAML mistake.
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
		// The provider name selects a DNS adapter. An unknown one that reached the
		// config would fail at the point of use, far from the typo.
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
		// Callers branch on `"zone" in config`; an explicit undefined would make
		// that check answer true for a zone nobody configured.
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
		// A credential map with a nested object or number in it would be passed
		// to a provider SDK that expects strings.
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
		// This list is a security boundary — it constrains which gateway
		// hostnames DNS records may point at — so a non-string sneaking in would
		// be a suffix nothing can match rather than a rejected config.
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
		// Multi-tenancy changes how every name is scoped. A truthy string turning
		// it on would silently reshape every hostname in the deployment.
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
		// An unknown sink name would be handed to a dispatcher with no handler,
		// silently dropping usage events.
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
		// Falling back to `soft` rather than to a hard mode is the right default
		// for a misconfiguration: it fails toward working, and the operator who
		// wanted hard isolation will notice it is not in effect. Silently
		// selecting a hard mode from a typo would break connectivity instead.
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
		// The two fields are parsed independently. Worth pinning: a config that
		// names a URL but leaves the engine at its default does not silently
		// switch engines, and does not lose the URL either.
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
		// Operators write these differently and all of them have to work, because
		// an off switch that silently fails to switch off is worse than none.
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
		// Auto is the safe reading of a value nobody understands: probe for the
		// binary and behave accordingly, rather than forcing a mode.
		for (const raw of ["maybe", "2", ""]) {
			expect(resolvePortlessMode({ HOBO_PORTLESS: raw })).toBe("auto");
		}
	});

	test("HOBO_NAMED_ENDPOINTS is honoured as an alias", () => {
		expect(resolvePortlessMode({ HOBO_NAMED_ENDPOINTS: "off" })).toBe("off");
	});

	test("HOBO_PORTLESS wins over the alias", () => {
		// One name has to take precedence or a machine with both set behaves
		// unpredictably.
		expect(
			resolvePortlessMode({ HOBO_PORTLESS: "on", HOBO_NAMED_ENDPOINTS: "off" }),
		).toBe("on");
	});
});

describe("probePortless", () => {
	/** A probe runner that reports the binary as present with a version. */
	const found = () => ({ ok: true, stdout: "1.2.3 (build abc)" });
	/** A probe runner that reports the binary as absent. */
	const missing = () => ({ ok: false, stdout: "" });

	test("a present binary in auto mode is available and enabled", () => {
		const probe = probePortless({ env: {}, runVersion: found });
		expect(probe.available).toBe(true);
		expect(probe.enabled).toBe(true);
		expect(probe.mode).toBe("auto");
		expect(probe.hint).toBeNull();
	});

	test("a missing binary in auto mode is unavailable and hints how to fix it", () => {
		// This is the normal state on most machines, so the hint has to name both
		// the tool and the way to silence it — otherwise it becomes noise people
		// learn to ignore.
		const probe = probePortless({ env: {}, runVersion: missing });
		expect(probe.available).toBe(false);
		expect(probe.enabled).toBe(false);
		expect(probe.hint).toContain("portless");
		expect(probe.hint).toContain("HOBO_PORTLESS=0");
	});

	test("off mode disables it even when the binary is present", () => {
		// An explicit off switch that a present binary could override would not
		// be an off switch.
		const probe = probePortless({
			env: { HOBO_PORTLESS: "off" },
			runVersion: found,
		});
		expect(probe.available).toBe(true);
		expect(probe.enabled).toBe(false);
	});

	test("off mode silences the hint", () => {
		// Having asked for it off, the operator should not keep being told about
		// it — that is what the documented opt-out is for.
		expect(
			probePortless({ env: { HOBO_PORTLESS: "off" }, runVersion: missing })
				.hint,
		).toBeNull();
	});

	test("on mode still cannot enable a binary that is not there", () => {
		// Forcing the mode does not conjure the tool. Reporting enabled here
		// would make the local serve path promise named URLs it cannot deliver.
		const probe = probePortless({
			env: { HOBO_PORTLESS: "on" },
			runVersion: missing,
		});
		expect(probe.available).toBe(false);
		expect(probe.enabled).toBe(false);
		expect(probe.hint).toContain("portless");
	});

	test("the version is the first whitespace-delimited token", () => {
		// `portless --version` prints extra build detail on some builds; the
		// version field should be comparable, not a whole line.
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
		// The `existsSync` guard. A path-shaped candidate that is not there gets
		// skipped before any spawn, which is why a stale HOBO_PORTLESS_BIN
		// pointing at an old install does not cost a failed process launch on
		// every probe — the bare name is tried instead.
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
		// `process.execPath` is a real file, so it survives the existence check
		// and becomes the first candidate — which is the behaviour an operator
		// pointing at a specific install is relying on.
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
		// Each candidate costs a process spawn; continuing past a working one
		// would be pure waste on the common path.
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
		// An unset variable often arrives as an empty string; spawning it would
		// be a wasted failure on every probe.
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
		// A probe for an optional tool must not be able to take down the caller.
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
		// The portless CLI surface varies by version, so the shapes are tried in
		// order; continuing past a success would run the same registration twice.
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
		// Best-effort: the local serve path keeps working without the proxy
		// binding, so this must not throw — but the note is what tells the user
		// why their named URL is not resolving.
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
		// A mangled hostname would register a route nothing resolves to.
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
