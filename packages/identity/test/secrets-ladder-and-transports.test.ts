/**
 * `secrets-port.test.ts` covers the memory fixture and the offline branches of
 * the cloud adapters; `secrets-resolution.test.ts` walks a handful of ladder
 * scenarios. What neither reaches is the part that decides *which* source a
 * value may come from — `resolveConfigEntry`'s ranked walk — and the live
 * transport branches of the AWS and Azure adapters.
 *
 * Both matter for the same reason. The ladder is a deny-ceiling: policy hands it
 * a set of allowed ranks, and a bug that ignored that set would silently resolve
 * a sensitive field from a Camp value or a static escape hatch that policy had
 * forbidden. And the transports are where a secret would leak if a response were
 * mishandled — so the tests here assert not only that the right value comes back
 * but that the resolved entry never carries plaintext for a sensitive field.
 */
import { describe, expect, test } from "vitest";

import type { SecretSourceRank } from "../src/config-types.js";
import type { JsonValue } from "../src/json.js";
import {
	asHoboSecretsStore,
	createAwsSecretsManagerPort,
	createAzureKeyVaultPort,
	createCampSecretsPort,
	createLocalStationSecretsPort,
	createMemorySecretsPort,
	createVaultJwtSecretsPort,
	type FetchLike,
	type ResolutionLadderInput,
	resolveConfigEntry,
} from "../src/secrets-port.js";

const ALL_RANKS: readonly SecretSourceRank[] = [
	"bound-resource",
	"provider-federation",
	"camp-value",
	"static-escape",
];

type FetchCall = { url: string; init?: Parameters<FetchLike>[1] };

/** Records calls and replies with a fixed response. */
function stubFetch(response: {
	ok?: boolean;
	status?: number;
	json?: () => Promise<JsonValue>;
}): FetchLike & { calls: FetchCall[] } {
	const calls: FetchCall[] = [];
	// SAFETY: the async implementation matches the package's FetchLike boundary.
	const impl = (async (url: string, init?: Parameters<FetchLike>[1]) => {
		const call: FetchCall = { url };
		if (init !== undefined) call.init = init;
		calls.push(call);
		return {
			ok: response.ok ?? true,
			status: response.status ?? 200,
			json: response.json ?? (async () => ({})),
			text: async () => "",
		};
	}) as FetchLike & { calls: FetchCall[] };
	impl.calls = calls;
	return impl;
}

function ladder(
	overrides: Partial<ResolutionLadderInput> = {},
): ResolutionLadderInput {
	return {
		name: "DATABASE_URL",
		sensitive: true,
		preferredSource: "bound-resource",
		allowedSources: ALL_RANKS,
		...overrides,
	};
}

describe("the resolution ladder's ordering", () => {
	test("it starts at the preferred rank and walks downward", async () => {
		// A bound token exists but federation is preferred, so federation wins —
		// the ladder starts where policy points it, not always at the top.
		const port = createMemorySecretsPort();
		await port.put("DATABASE_URL", "postgres://real");
		const result = await resolveConfigEntry(
			ladder({
				preferredSource: "provider-federation",
				boundToken: async () => "bound-token",
				secretsPort: port,
			}),
		);
		expect(result.status).toBe("resolved");
		expect(result.status === "resolved" && result.entry.source).toBe(
			"provider-federation",
		);
	});

	test("it falls through to the next rank when the preferred one has nothing", async () => {
		// A bound resource that is not attached yet must not dead-end the
		// resolution; the whole point of a ladder is the rung below.
		const port = createMemorySecretsPort();
		await port.put("DATABASE_URL", "postgres://real");
		const result = await resolveConfigEntry(
			ladder({
				preferredSource: "bound-resource",
				boundToken: async () => undefined,
				secretsPort: port,
			}),
		);
		expect(result.status === "resolved" && result.entry.source).toBe(
			"provider-federation",
		);
	});

	test("it wraps around to the ranks above the preferred one", async () => {
		// Preferring camp-value does not forbid the stronger sources; after the
		// weaker rungs are exhausted the walk continues from the top, so a
		// misconfigured preference degrades to something safer rather than
		// failing outright.
		const port = createMemorySecretsPort();
		await port.put("DATABASE_URL", "postgres://real");
		const result = await resolveConfigEntry(
			ladder({
				preferredSource: "camp-value",
				secretsPort: port,
			}),
		);
		expect(result.status === "resolved" && result.entry.source).toBe(
			"provider-federation",
		);
	});

	test("a rank outside the allowed set is never consulted", async () => {
		// This is the deny-ceiling. A secrets port is present and would answer,
		// but policy did not allow federation, so it must not be reached.
		const port = createMemorySecretsPort();
		await port.put("DATABASE_URL", "postgres://real");
		const result = await resolveConfigEntry(
			ladder({
				preferredSource: "bound-resource",
				allowedSources: ["bound-resource"],
				boundToken: async () => undefined,
				secretsPort: port,
			}),
		);
		expect(result.status).toBe("denied");
		expect(result.status === "denied" && result.code).toBe("config-unresolved");
	});

	test("an empty allowed set resolves nothing at all", async () => {
		const port = createMemorySecretsPort();
		await port.put("DATABASE_URL", "postgres://real");
		const result = await resolveConfigEntry(
			ladder({ allowedSources: [], secretsPort: port }),
		);
		expect(result.status).toBe("denied");
	});

	test("an unknown preferred source still walks the whole allowed ladder", async () => {
		// `indexOf` returns -1 for a rank that is not in the list, and the
		// `Math.max(0, …)` clamp is what keeps that from slicing the order into
		// nonsense and resolving nothing.
		const port = createMemorySecretsPort();
		await port.put("DATABASE_URL", "postgres://real");
		const result = await resolveConfigEntry(
			ladder({
				// SAFETY: this deliberately crosses the runtime input boundary to test refusal.
				preferredSource: "not-a-rank" as SecretSourceRank,
				secretsPort: port,
			}),
		);
		expect(result.status === "resolved" && result.entry.source).toBe(
			"provider-federation",
		);
	});

	test("nothing configured at any rank is a denial, not a throw", async () => {
		// An unresolvable config entry is an ordinary outcome — a missing binding
		// during startup — and has to be reportable rather than fatal.
		const result = await resolveConfigEntry(ladder());
		expect(result.status).toBe("denied");
		expect(result.status === "denied" && result.reason).toContain(
			"DATABASE_URL",
		);
	});
});

describe("the ladder's secrecy rules", () => {
	test("a sensitive value never leaves via camp-value", async () => {
		// Camp values are plaintext configuration. Letting a sensitive field
		// resolve from one would put a secret in a non-secret store, so the rung
		// is skipped rather than used.
		const result = await resolveConfigEntry(
			ladder({
				sensitive: true,
				preferredSource: "camp-value",
				campValue: "plaintext-secret",
			}),
		);
		expect(result.status).toBe("denied");
	});

	test("a non-sensitive value resolves from camp-value with its real value", async () => {
		const result = await resolveConfigEntry(
			ladder({
				sensitive: false,
				preferredSource: "camp-value",
				campValue: "us-east-1",
			}),
		);
		expect(result.status === "resolved" && result.entry.value).toBe(
			"us-east-1",
		);
		expect(result.status === "resolved" && result.entry.placeholder).toBe(
			"us-east-1",
		);
		expect(result.status === "resolved" && result.entry.sensitivity).toBe(
			"public",
		);
	});

	test("a camp value of undefined is not a resolution", async () => {
		// `undefined` is the absent case; treating it as a value would resolve
		// every unset field to nothing and call it success.
		const result = await resolveConfigEntry(
			ladder({
				sensitive: false,
				preferredSource: "camp-value",
				allowedSources: ["camp-value"],
			}),
		);
		expect(result.status).toBe("denied");
	});

	test("a falsy but present camp value still resolves", async () => {
		// `0` and `""` are real configuration values. A truthiness check here
		// would silently drop them and fall through to a weaker rung.
		for (const value of [0, "", false]) {
			const result = await resolveConfigEntry(
				ladder({
					sensitive: false,
					preferredSource: "camp-value",
					allowedSources: ["camp-value"],
					campValue: value,
				}),
			);
			expect(result.status === "resolved" && result.entry.value).toBe(value);
		}
	});

	test("a federated secret carries a reference and a placeholder, never material", async () => {
		// The entry is agent-facing. The broker keeps the material; anything on
		// this object may end up in a log or a rendered config view.
		const port = createMemorySecretsPort();
		await port.put("DATABASE_URL", "postgres://super-secret-password@host");
		const result = await resolveConfigEntry(
			ladder({ preferredSource: "provider-federation", secretsPort: port }),
		);
		expect(result.status).toBe("resolved");
		if (result.status !== "resolved") return;
		expect(result.entry.placeholder).toBe(
			"[REDACTED:provider-federation:DATABASE_URL]",
		);
		expect(result.entry.valueRef).toContain("secref://DATABASE_URL/");
		expect(result.entry.value).toBeUndefined();
		expect(JSON.stringify(result.entry)).not.toContain("super-secret-password");
	});

	test("a federated entry is marked sensitive even when the input was not", async () => {
		// Anything that came out of a secrets store is a secret regardless of how
		// the field was declared; trusting the declaration would let a
		// mislabelled field print its own value.
		const port = createMemorySecretsPort();
		await port.put("API_KEY", "sk-live-value");
		const result = await resolveConfigEntry(
			ladder({
				name: "API_KEY",
				sensitive: false,
				preferredSource: "provider-federation",
				secretsPort: port,
			}),
		);
		expect(result.status === "resolved" && result.entry.sensitive).toBe(true);
		expect(result.status === "resolved" && result.entry.sensitivity).toBe(
			"sensitive",
		);
	});

	test("a denied secrets port falls through instead of resolving", async () => {
		// The port answered "not found". Resolving anyway would produce an entry
		// with an empty reference that looks successful.
		const port = createMemorySecretsPort();
		const result = await resolveConfigEntry(
			ladder({
				sensitive: false,
				preferredSource: "provider-federation",
				secretsPort: port,
				campValue: "fallback-value",
			}),
		);
		expect(result.status === "resolved" && result.entry.source).toBe(
			"camp-value",
		);
	});

	test("a sensitive bound resource is redacted but a public one is not", async () => {
		const redacted = await resolveConfigEntry(
			ladder({ sensitive: true, boundToken: async () => "bound-token-value" }),
		);
		expect(redacted.status === "resolved" && redacted.entry.placeholder).toBe(
			"[REDACTED:bound-resource:DATABASE_URL]",
		);
		expect(
			redacted.status === "resolved" && redacted.entry.value,
		).toBeUndefined();

		const plain = await resolveConfigEntry(
			ladder({ sensitive: false, boundToken: async () => "bound-token-value" }),
		);
		expect(plain.status === "resolved" && plain.entry.value).toBe(
			"bound-token-value",
		);
	});

	test("an empty bound token is treated as absent", async () => {
		// A resource that resolved to an empty string is not attached; using it
		// would hand the workload a blank credential and a confusing failure.
		const result = await resolveConfigEntry(
			ladder({
				sensitive: false,
				boundToken: async () => "",
				campValue: "fallback",
			}),
		);
		expect(result.status === "resolved" && result.entry.source).toBe(
			"camp-value",
		);
	});
});

describe("the static escape hatch", () => {
	test("it resolves only when it is the explicitly preferred source", async () => {
		// Static material is the last resort and must be a deliberate choice.
		// Reaching it by falling down the ladder would make it the *default*
		// whenever the better rungs happened to be empty.
		const viaFallthrough = await resolveConfigEntry(
			ladder({
				preferredSource: "bound-resource",
				boundToken: async () => undefined,
				staticMaterial: "static-secret",
			}),
		);
		expect(viaFallthrough.status).toBe("denied");

		const explicit = await resolveConfigEntry(
			ladder({
				preferredSource: "static-escape",
				staticMaterial: "static-secret",
			}),
		);
		expect(explicit.status === "resolved" && explicit.entry.source).toBe(
			"static-escape",
		);
	});

	test("it is refused when policy does not allow the rank", async () => {
		// The deny-ceiling outranks the preference: asking for the hatch does not
		// grant it.
		const result = await resolveConfigEntry(
			ladder({
				preferredSource: "static-escape",
				allowedSources: ["bound-resource", "provider-federation"],
				staticMaterial: "static-secret",
			}),
		);
		expect(result.status).toBe("denied");
	});

	test("it needs actual material to resolve", async () => {
		const result = await resolveConfigEntry(
			ladder({ preferredSource: "static-escape" }),
		);
		expect(result.status).toBe("denied");
	});

	test("the resolved entry redacts the material and stamps a version", async () => {
		// Even the escape hatch does not put plaintext on an agent-facing entry,
		// and the version id is what makes a static value auditable at all.
		const result = await resolveConfigEntry(
			ladder({
				preferredSource: "static-escape",
				staticMaterial: "static-secret-value",
			}),
		);
		expect(result.status).toBe("resolved");
		if (result.status !== "resolved") return;
		expect(result.entry.placeholder).toBe(
			"[REDACTED:static-escape:DATABASE_URL]",
		);
		expect(result.entry.versionId).toMatch(/^static-[0-9a-f]{8}$/);
		expect(result.entry.valueRef).toContain("staticref://DATABASE_URL/");
		expect(JSON.stringify(result.entry)).not.toContain("static-secret-value");
	});
});

describe("the Vault JWT adapter", () => {
	function port(
		overrides: Partial<Parameters<typeof createVaultJwtSecretsPort>[0]> = {},
	) {
		return createVaultJwtSecretsPort({
			vaultAddr: "https://vault.test",
			role: "hobo-test",
			svidJwt: "eyJhbGciOiJFUzI1NiJ9.fixture",
			...overrides,
		});
	}

	test("it derives its identity from the role, not a static token", () => {
		expect(port().id).toBe("secrets:vault-jwt:hobo-test");
		expect(port().kind).toBe("vault-jwt");
		expect(port({ id: "custom" }).id).toBe("custom");
	});

	test("it mints deterministic material for a name it has never stored", async () => {
		// Offline parity: a dev machine with no Vault still gets a usable,
		// repeatable value rather than a failure.
		const a = await port().access("DB");
		const b = await port().access("DB");
		expect(a.status).toBe("ok");
		expect(a.status === "ok" && a.material).toBe(
			b.status === "ok" ? b.material : "different",
		);
		expect(a.status === "ok" && a.versionId).toBe("vv-dynamic");
	});

	test("different roles derive different material for the same name", async () => {
		// The role is part of the derivation root. If it were not, two workloads
		// with different Vault roles would share a credential offline.
		const a = await port({ role: "role-a" }).access("DB");
		const b = await port({ role: "role-b" }).access("DB");
		expect(a.status === "ok" && a.material).not.toBe(
			b.status === "ok" ? b.material : undefined,
		);
	});

	test("a stored value takes over from the minted one", async () => {
		const p = port();
		const before = await p.access("DB");
		await p.put("DB", "seed-1");
		const after = await p.access("DB");
		expect(after.status === "ok" && after.versionId).toBe("vv1");
		expect(after.status === "ok" && after.material).not.toBe(
			before.status === "ok" ? before.material : undefined,
		);
	});

	test("versions accumulate and the latest wins", async () => {
		const p = port();
		await p.put("DB", "seed-1");
		await p.put("DB", "seed-2");
		expect(await p.listVersions("DB")).toEqual(["vv1", "vv2"]);
		const latest = await p.access("DB");
		expect(latest.status === "ok" && latest.versionId).toBe("vv2");
	});

	test("listVersions reports the dynamic version for an unknown name", async () => {
		// Returning an empty list would tell a caller the secret has no versions,
		// when in fact it has a derivable one.
		expect(await port().listVersions("never-stored")).toEqual(["vv-dynamic"]);
	});

	test("accessing a stored version returns that version's material", async () => {
		const p = port();
		await p.put("DB", "seed-1");
		await p.put("DB", "seed-2");
		const first = await p.accessVersion("DB", "vv1");
		const second = await p.accessVersion("DB", "vv2");
		expect(first.status === "ok" && first.material).not.toBe(
			second.status === "ok" ? second.material : undefined,
		);
	});

	test("an unknown version still yields deterministic material rather than a denial", async () => {
		// This adapter's offline mode is derive-anything; pinning it here so the
		// behaviour is a decision on record rather than an accident. A caller
		// that needs "does this version exist" must use listVersions.
		const a = await port().accessVersion("DB", "vv-does-not-exist");
		const b = await port().accessVersion("DB", "vv-does-not-exist");
		expect(a.status).toBe("ok");
		expect(a.status === "ok" && a.material).toBe(
			b.status === "ok" ? b.material : "different",
		);
	});

	test("every access carries an expiry so material is never open-ended", async () => {
		const result = await port().access("DB");
		expect(result.status).toBe("ok");
		if (result.status !== "ok") return;
		expect(Date.parse(String(result.expiresAt))).toBeGreaterThan(Date.now());
	});

	test("the value reference names the vault address and version", async () => {
		const result = await port().access("DB");
		expect(result.status === "ok" && result.valueRef).toBe(
			"vault://https://vault.test/secret/DB@vv-dynamic",
		);
	});
});

describe("the AWS Secrets Manager live transport", () => {
	test("a live read returns the service's version id and material", async () => {
		const fetchImpl = stubFetch({
			json: async () => ({ VersionId: "AWSPREVIOUS", SecretString: "live" }),
		});
		const port = createAwsSecretsManagerPort({
			region: "eu-west-1",
			fetch: fetchImpl,
		});
		const result = await port.access("DB");
		expect(result.status).toBe("ok");
		if (result.status !== "ok") return;
		expect(result.material).toBe("live");
		expect(result.versionId).toBe("AWSPREVIOUS");
		expect(result.valueRef).toBe("aws-sm://eu-west-1/DB@AWSPREVIOUS");
	});

	test("a response with no version id falls back to AWSCURRENT", async () => {
		// The reference has to name *some* version or two reads of different
		// versions would produce the same opaque reference.
		const port = createAwsSecretsManagerPort({
			fetch: stubFetch({ json: async () => ({ SecretString: "live" }) }),
		});
		const result = await port.access("DB");
		expect(result.status === "ok" && result.versionId).toBe("AWSCURRENT");
	});

	test("a non-ok response denies rather than falling back to offline material", async () => {
		// This is the important one: a 403 from the service means *denied*, and
		// quietly minting local material instead would hand the workload a
		// credential the service refused to give it.
		const port = createAwsSecretsManagerPort({
			fetch: stubFetch({ ok: false, status: 403 }),
		});
		const result = await port.access("DB");
		expect(result.status).toBe("denied");
		expect(result.status === "denied" && result.code).toBe("aws-sm-http-error");
		expect(result.status === "denied" && result.reason).toContain("403");
	});

	test("the brokered bearer is attached when present and omitted otherwise", async () => {
		// The adapter never holds a static key; the token is injected per call.
		const withToken = stubFetch({ json: async () => ({ SecretString: "x" }) });
		await createAwsSecretsManagerPort({
			fetch: withToken,
			accessToken: "brokered-session",
		}).access("DB");
		expect(withToken.calls[0]?.init?.headers?.Authorization).toBe(
			"Bearer brokered-session",
		);

		const without = stubFetch({ json: async () => ({ SecretString: "x" }) });
		await createAwsSecretsManagerPort({ fetch: without }).access("DB");
		expect(without.calls[0]?.init?.headers?.Authorization).toBeUndefined();
	});

	test("the request names the secret and targets GetSecretValue", async () => {
		const fetchImpl = stubFetch({ json: async () => ({ SecretString: "x" }) });
		await createAwsSecretsManagerPort({ fetch: fetchImpl }).access("DB");
		expect(fetchImpl.calls[0]?.init?.headers?.["X-Amz-Target"]).toBe(
			"secretsmanager.GetSecretValue",
		);
		expect(JSON.parse(String(fetchImpl.calls[0]?.init?.body))).toEqual({
			SecretId: "DB",
		});
	});

	test("a versioned live read sends the version id", async () => {
		const fetchImpl = stubFetch({
			json: async () => ({ VersionId: "v-7", SecretString: "x" }),
		});
		await createAwsSecretsManagerPort({ fetch: fetchImpl }).accessVersion(
			"DB",
			"v-7",
		);
		expect(JSON.parse(String(fetchImpl.calls[0]?.init?.body))).toEqual({
			SecretId: "DB",
			VersionId: "v-7",
		});
	});

	test("a versioned live read denies on a non-ok status", async () => {
		const port = createAwsSecretsManagerPort({
			fetch: stubFetch({ ok: false, status: 404 }),
		});
		const result = await port.accessVersion("DB", "v-7");
		expect(result.status).toBe("denied");
	});

	test("a write goes through the transport and is mirrored locally", async () => {
		// The local mirror is what keeps listVersions and offline reads working
		// after a live write.
		const fetchImpl = stubFetch({ json: async () => ({}) });
		const port = createAwsSecretsManagerPort({ fetch: fetchImpl });
		const { versionId } = await port.put("DB", "value-1");
		expect(fetchImpl.calls[0]?.init?.headers?.["X-Amz-Target"]).toBe(
			"secretsmanager.PutSecretValue",
		);
		expect(await port.listVersions("DB")).toEqual([versionId]);
	});

	test("a custom endpoint is used verbatim", async () => {
		const fetchImpl = stubFetch({ json: async () => ({ SecretString: "x" }) });
		await createAwsSecretsManagerPort({
			endpoint: "http://localhost:4566",
			fetch: fetchImpl,
		}).access("DB");
		expect(fetchImpl.calls[0]?.url).toBe("http://localhost:4566");
	});

	test("with no transport the offline path is deterministic per access token", async () => {
		// The token is part of the derivation root, so two brokered sessions do
		// not share offline material.
		const a = await createAwsSecretsManagerPort({ accessToken: "t1" }).access(
			"DB",
		);
		const b = await createAwsSecretsManagerPort({ accessToken: "t2" }).access(
			"DB",
		);
		expect(a.status === "ok" && a.material).not.toBe(
			b.status === "ok" ? b.material : undefined,
		);
	});
});

describe("the Azure Key Vault live transport", () => {
	test("a live read maps value, version and expiry", async () => {
		const fetchImpl = stubFetch({
			json: async () => ({
				id: "https://kv.vault.azure.net/secrets/DB/abc123",
				value: "live",
				attributes: { exp: 1893456000 },
			}),
		});
		const port = createAzureKeyVaultPort({ vaultName: "kv", fetch: fetchImpl });
		const result = await port.access("DB");
		expect(result.status).toBe("ok");
		if (result.status !== "ok") return;
		expect(result.material).toBe("live");
		// The version is the trailing path segment of the returned id — Key Vault
		// does not send it as its own field.
		expect(result.versionId).toBe("abc123");
		expect(result.expiresAt).toBe(new Date(1893456000 * 1000).toISOString());
	});

	test("a response with no id falls back to the label 'current'", async () => {
		// `split("/").pop()` on an absent id yields undefined; the `||` is what
		// keeps an unnamed version out of the reference.
		const port = createAzureKeyVaultPort({
			vaultName: "kv",
			fetch: stubFetch({ json: async () => ({ value: "live" }) }),
		});
		const result = await port.access("DB");
		expect(result.status === "ok" && result.versionId).toBe("current");
		expect(result.status === "ok" && result.valueRef).toBe(
			"azure-kv://kv/DB@current",
		);
	});

	test("a response with no expiry attribute still carries a bounded one", async () => {
		// Material without an expiry would be treated as permanent by anything
		// that caches it.
		const port = createAzureKeyVaultPort({
			fetch: stubFetch({ json: async () => ({ value: "live" }) }),
		});
		const result = await port.access("DB");
		expect(result.status).toBe("ok");
		if (result.status !== "ok") return;
		expect(Date.parse(String(result.expiresAt))).toBeGreaterThan(Date.now());
	});

	test("a non-ok response denies rather than minting offline material", async () => {
		const port = createAzureKeyVaultPort({
			fetch: stubFetch({ ok: false, status: 401 }),
		});
		const result = await port.access("DB");
		expect(result.status).toBe("denied");
		expect(result.status === "denied" && result.code).toBe(
			"azure-kv-http-error",
		);
	});

	test("the secret name is percent-escaped into the path", async () => {
		// An unescaped name containing a slash would address a different secret
		// entirely.
		const fetchImpl = stubFetch({ json: async () => ({ value: "x" }) });
		await createAzureKeyVaultPort({ vaultName: "kv", fetch: fetchImpl }).access(
			"a/b",
		);
		expect(fetchImpl.calls[0]?.url).toBe(
			"https://kv.vault.azure.net/secrets/a%2Fb?api-version=7.4",
		);
	});

	test("a versioned read addresses the version segment", async () => {
		const fetchImpl = stubFetch({ json: async () => ({ value: "x" }) });
		const result = await createAzureKeyVaultPort({
			vaultName: "kv",
			fetch: fetchImpl,
		}).accessVersion("DB", "v 7");
		expect(fetchImpl.calls[0]?.url).toBe(
			"https://kv.vault.azure.net/secrets/DB/v%207?api-version=7.4",
		);
		// An explicit version is echoed back rather than re-derived from the id.
		expect(result.status === "ok" && result.versionId).toBe("v 7");
	});

	test("a versioned read denies on a non-ok status", async () => {
		const port = createAzureKeyVaultPort({
			fetch: stubFetch({ ok: false, status: 404 }),
		});
		expect((await port.accessVersion("DB", "v1")).status).toBe("denied");
	});

	test("a write PUTs through the transport and mirrors locally", async () => {
		const fetchImpl = stubFetch({ json: async () => ({}) });
		const port = createAzureKeyVaultPort({ vaultName: "kv", fetch: fetchImpl });
		const { versionId } = await port.put("DB", "value-1");
		expect(fetchImpl.calls[0]?.init?.method).toBe("PUT");
		expect(JSON.parse(String(fetchImpl.calls[0]?.init?.body))).toEqual({
			value: "value-1",
		});
		expect(await port.listVersions("DB")).toEqual([versionId]);
	});

	test("an explicit vault url overrides the derived one", async () => {
		const fetchImpl = stubFetch({ json: async () => ({ value: "x" }) });
		await createAzureKeyVaultPort({
			vaultUrl: "https://custom.example",
			fetch: fetchImpl,
		}).access("DB");
		expect(fetchImpl.calls[0]?.url).toContain(
			"https://custom.example/secrets/DB",
		);
	});

	test("the brokered bearer rides on the request when present", async () => {
		const fetchImpl = stubFetch({ json: async () => ({ value: "x" }) });
		await createAzureKeyVaultPort({
			fetch: fetchImpl,
			accessToken: "brokered",
		}).access("DB");
		expect(fetchImpl.calls[0]?.init?.headers?.Authorization).toBe(
			"Bearer brokered",
		);
	});
});

describe("the Camp-scoped factory", () => {
	test("each backend name produces the matching port kind", () => {
		expect(createCampSecretsPort({ backend: "memory" }).kind).toBe(
			"memory-fixture",
		);
		expect(createCampSecretsPort({ backend: "vault-jwt" }).kind).toBe(
			"vault-jwt",
		);
		expect(createCampSecretsPort({ backend: "aws-sm" }).kind).toBe("aws-sm");
		expect(createCampSecretsPort({ backend: "azure-kv" }).kind).toBe(
			"azure-kv",
		);
	});

	test("vault-jwt takes its address and role from the input", () => {
		const port = createCampSecretsPort({
			backend: "vault-jwt",
			vaultAddr: "https://vault.camp",
			vaultRole: "camp-role",
			svidJwt: "eyJ.fixture",
		});
		expect(port.id).toBe("secrets:vault-jwt:camp-role");
	});

	test("vault-jwt defaults its address, role and SVID when omitted", () => {
		// The defaults keep `hobo dev` working with no Vault configured; without
		// them the factory would throw during local startup.
		expect(createCampSecretsPort({ backend: "vault-jwt" }).id).toBe(
			"secrets:vault-jwt:hobo-workload",
		);
	});

	test("aws-sm carries the region into its id", () => {
		expect(
			createCampSecretsPort({ backend: "aws-sm", region: "ap-south-1" }).id,
		).toBe("secrets:aws-sm:ap-south-1");
	});

	test("azure-kv carries the vault name into its id", () => {
		expect(
			createCampSecretsPort({ backend: "azure-kv", vaultName: "camp-kv" }).id,
		).toBe("secrets:azure-kv:camp-kv");
	});

	test("an injected transport reaches the cloud backends", async () => {
		const fetchImpl = stubFetch({
			json: async () => ({ SecretString: "live" }),
		});
		const port = createCampSecretsPort({
			backend: "aws-sm",
			fetch: fetchImpl,
			accessToken: "brokered",
		});
		const result = await port.access("DB");
		expect(result.status === "ok" && result.material).toBe("live");
		expect(fetchImpl.calls[0]?.init?.headers?.Authorization).toBe(
			"Bearer brokered",
		);
	});
});

describe("the local station port's environment handling", () => {
	test("an explicit env overrides the ambient process env", () => {
		// Reading `process.env` directly would make this untestable and would
		// leak a developer's shell configuration into a Camp's port selection.
		const port = createLocalStationSecretsPort({
			env: { HOBO_LOCAL_SECRETS_BACKEND: "vault-jwt", HOBO_STATION_ID: "st-1" },
		});
		expect(port.kind).toBe("vault-jwt");
		expect(port.id).toBe("secrets:station-vault:st-1");
	});

	test("the vault address and role come from the environment when set", () => {
		const port = createLocalStationSecretsPort({
			env: {
				HOBO_LOCAL_SECRETS_BACKEND: "vault-jwt",
				HOBO_VAULT_ROLE: "env-role",
				HOBO_VAULT_ADDR: "https://vault.env",
			},
			stationId: "st-2",
		});
		// The id is derived from the station, so the role shows up through a read.
		expect(port.id).toBe("secrets:station-vault:st-2");
		return port.access("DB").then((result) => {
			expect(result.status === "ok" && result.valueRef).toContain(
				"https://vault.env",
			);
		});
	});

	test("a non-string SVID in the environment falls back to the fixture", async () => {
		// Env values arrive as unknown at runtime; a non-string would otherwise
		// be concatenated into the derivation root as "undefined".
		const port = createLocalStationSecretsPort({
			env: {
				HOBO_LOCAL_SECRETS_BACKEND: "vault-jwt",
				HOBO_SVID_JWT: undefined,
			},
			stationId: "st-3",
		});
		expect((await port.access("DB")).status).toBe("ok");
	});

	test("an explicit id wins over the derived one for either backend", () => {
		expect(
			createLocalStationSecretsPort({ env: {}, id: "custom-memory" }).id,
		).toBe("custom-memory");
		expect(
			createLocalStationSecretsPort({
				env: { HOBO_LOCAL_SECRETS_BACKEND: "vault-jwt" },
				id: "custom-vault",
			}).id,
		).toBe("custom-vault");
	});

	test("the station id falls back to 'local' when nothing names it", () => {
		expect(createLocalStationSecretsPort({ env: {} }).id).toBe(
			"secrets:station-memory:local",
		);
	});
});

describe("the WIT-shaped store view", () => {
	test("accessVersion throws the denial reason, not a generic failure", async () => {
		// The WIT surface has no result type, so the message is the only channel
		// for telling "no such version" apart from "no such secret".
		const view = asHoboSecretsStore(createMemorySecretsPort());
		await expect(view.accessVersion("DB", "v1")).rejects.toThrow(/not found/);
	});

	test("a version that exists round-trips as bytes", async () => {
		const port = createMemorySecretsPort();
		const { versionId } = await port.put("DB", "value-1");
		await port.put("DB", "value-2");
		const view = asHoboSecretsStore(port);
		expect(
			Buffer.from(await view.accessVersion("DB", versionId)).toString(),
		).toBe("value-1");
	});

	test("access rejects when the port returns ok without material", async () => {
		// A port that resolves to a reference only — no material — cannot satisfy
		// this surface, and returning an empty buffer would look like an empty
		// secret rather than an unusable one.
		const view = asHoboSecretsStore({
			id: "x",
			kind: "memory-fixture",
			put: async () => ({ versionId: "v1" }),
			access: async () => ({
				status: "ok" as const,
				valueRef: "ref://x",
				versionId: "v1",
				source: "provider-federation" as const,
			}),
			accessVersion: async () => ({
				status: "ok" as const,
				valueRef: "ref://x",
				versionId: "v1",
				source: "provider-federation" as const,
			}),
			listVersions: async () => ["v1"],
		});
		await expect(view.access("DB")).rejects.toThrow(/access failed/);
		await expect(view.accessVersion("DB", "v1")).rejects.toThrow(
			/access failed/,
		);
	});

	test("access rejects when the port returns ok without a version id", async () => {
		const view = asHoboSecretsStore({
			id: "x",
			kind: "memory-fixture",
			put: async () => ({ versionId: "v1" }),
			access: async () => ({
				status: "ok" as const,
				valueRef: "ref://x",
				material: "value",
				source: "provider-federation" as const,
			}),
			accessVersion: async () => ({
				status: "denied" as const,
				reason: "no",
				code: "x",
			}),
			listVersions: async () => [],
		});
		await expect(view.access("DB")).rejects.toThrow(/access failed/);
	});

	test("non-ascii material survives the byte round trip", async () => {
		// The view encodes as UTF-8 in both directions; a latin1 assumption here
		// would corrupt any secret containing a multi-byte character.
		const port = createMemorySecretsPort();
		const view = asHoboSecretsStore(port);
		const secret = "pässwörd-🔑";
		await view.put("DB", new TextEncoder().encode(secret));
		const read = await view.access("DB");
		expect(new TextDecoder().decode(read.value)).toBe(secret);
	});

	test("listVersions passes straight through", async () => {
		const port = createMemorySecretsPort();
		await port.put("DB", "a");
		await port.put("DB", "b");
		expect(await asHoboSecretsStore(port).listVersions("DB")).toHaveLength(2);
	});
});
