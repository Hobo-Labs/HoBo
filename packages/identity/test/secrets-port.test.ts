/**
 * The residual secrets ports (ADR-0113).
 *
 * These are the *last* credential path — identity federation is preferred — so
 * the branches worth pinning are the ones that decide whether a secret is
 * handed over at all, and what happens when the backing service says no.
 *
 * Every adapter takes an injected `fetch`, which means the live paths are
 * testable without a network and, more importantly, that the offline fallbacks
 * are testable too. Those fallbacks are the interesting part: each adapter
 * mints deterministic material when it has no transport, so `hobo dev` works
 * without cloud accounts. Deterministic is doing real work there — material
 * that changed per call would make a local run non-reproducible — and it is
 * also precisely the property that must never be mistaken for a real secret.
 */
import { describe, expect, it } from "vitest";
import type { JsonValue } from "../src/json.js";
import {
	asHoboSecretsStore,
	createAwsSecretsManagerPort,
	createAzureKeyVaultPort,
	createCampSecretsPort,
	createLocalStationSecretsPort,
	createMemorySecretsPort,
} from "../src/secrets-port.js";

interface FetchInitBag {
	method?: string;
	headers?: Record<string, string>;
	body?: string;
}

interface FetchCall {
	url: string;
	init?: FetchInitBag;
}

interface FetchResponseFixture {
	ok: boolean;
	status?: number;
	body?: JsonValue;
}

/** A fetch that never gets called; asserting on that is often the point. */
function recordingFetch(response: FetchResponseFixture = { ok: true }) {
	const calls: FetchCall[] = [];
	const fetchLike = async (url: string, init?: FetchInitBag) => {
		calls.push({ url, init });
		return {
			ok: response.ok,
			status: response.status ?? (response.ok ? 200 : 500),
			json: async () => response.body ?? {},
		};
	};
	// SAFETY: assertion to `e as never }; } d` is required at this boundary.
	return { calls, fetchLike: fetchLike as never };
}

describe("the in-memory fixture store", () => {
	it("returns the latest value it was given", async () => {
		const port = createMemorySecretsPort();
		await port.put("db", "first");
		await port.put("db", "second");
		const result = await port.access("db");
		expect(result.status).toBe("ok");
		expect(result.status === "ok" && result.material).toBe("second");
	});

	it("denies an unknown name with a stable code rather than throwing", async () => {
		// Callers switch on the code; a thrown Error would force string matching.
		const result = await createMemorySecretsPort().access("absent");
		expect(result).toMatchObject({
			status: "denied",
			code: "secret-not-found",
		});
	});

	it("keeps every version and can return an older one", async () => {
		const port = createMemorySecretsPort();
		const first = await port.put("db", "v1");
		await port.put("db", "v2");
		const older = await port.accessVersion("db", first.versionId);
		expect(older.status === "ok" && older.material).toBe("v1");
	});

	it("denies a version that does not exist, distinctly from a missing name", async () => {
		const port = createMemorySecretsPort();
		await port.put("db", "v1");
		const missing = await port.accessVersion("db", "v99-deadbeef");
		expect(missing).toMatchObject({ code: "secret-version-not-found" });
	});

	it("denies a version lookup for a name it never saw", async () => {
		const result = await createMemorySecretsPort().accessVersion("nope", "v1");
		expect(result).toMatchObject({ code: "secret-not-found" });
	});

	it("lists versions in the order they were written", async () => {
		const port = createMemorySecretsPort();
		const a = await port.put("db", "v1");
		const b = await port.put("db", "v2");
		expect(await port.listVersions("db")).toEqual([a.versionId, b.versionId]);
	});

	it("lists nothing for an unknown name rather than failing", async () => {
		expect(await createMemorySecretsPort().listVersions("absent")).toEqual([]);
	});

	it("derives distinct version ids from distinct values", async () => {
		const port = createMemorySecretsPort();
		const a = await port.put("db", "one");
		const b = await port.put("db", "two");
		expect(a.versionId).not.toBe(b.versionId);
	});

	it("takes an explicit id and reports the default otherwise", () => {
		expect(createMemorySecretsPort({ id: "custom" }).id).toBe("custom");
		expect(createMemorySecretsPort().id).toBe("secrets:memory");
	});
});

describe("the AWS Secrets Manager adapter", () => {
	it("uses the injected transport when it has one", async () => {
		const { calls, fetchLike } = recordingFetch({
			ok: true,
			body: { VersionId: "AWSCURRENT", SecretString: "live-value" },
		});
		const port = createAwsSecretsManagerPort({ fetch: fetchLike });
		const result = await port.access("db");
		expect(calls).toHaveLength(1);
		expect(result.status === "ok" && result.material).toBe("live-value");
	});

	it("denies rather than falling back when the service refuses", async () => {
		// The important one. Falling through to offline material on a 403 would
		// hand out a locally-minted string in place of a secret the caller was
		// not authorized to read.
		const { fetchLike } = recordingFetch({ ok: false, status: 403 });
		const result = await createAwsSecretsManagerPort({
			fetch: fetchLike,
		}).access("db");
		expect(result).toMatchObject({
			status: "denied",
			code: "aws-sm-http-error",
		});
	});

	it("mints deterministic offline material with no transport", async () => {
		const port = createAwsSecretsManagerPort();
		const first = await port.access("db");
		const second = await port.access("db");
		expect(first.status).toBe("ok");
		expect(first.status === "ok" && first.material).toBe(
			second.status === "ok" ? second.material : undefined,
		);
	});

	it("gives different names different offline material", async () => {
		const port = createAwsSecretsManagerPort();
		const a = await port.access("one");
		const b = await port.access("two");
		expect(a.status === "ok" && a.material).not.toBe(
			b.status === "ok" ? b.material : undefined,
		);
	});

	it("prefers a stored value over minted material", async () => {
		const port = createAwsSecretsManagerPort();
		await port.put("db", "stored");
		const result = await port.access("db");
		expect(result.status === "ok" && result.material).toBe("stored");
	});

	it("labels an offline read as dynamic, so it is not mistaken for stored", async () => {
		const result = await createAwsSecretsManagerPort().access("db");
		expect(result.status === "ok" && result.versionId).toBe("dynamic");
	});

	it("scopes its value reference by region", async () => {
		const result = await createAwsSecretsManagerPort({
			region: "eu-west-1",
		}).access("db");
		expect(result.status === "ok" && result.valueRef).toContain("eu-west-1");
	});

	it("writes through the transport as well as locally", async () => {
		const { calls, fetchLike } = recordingFetch();
		await createAwsSecretsManagerPort({ fetch: fetchLike }).put("db", "v");
		expect(calls).toHaveLength(1);
	});

	it("lists versions from the local store", async () => {
		const port = createAwsSecretsManagerPort();
		await port.put("db", "v1");
		expect(await port.listVersions("db")).toHaveLength(1);
	});

	it("gives every access an expiry, so material is never open-ended", async () => {
		const result = await createAwsSecretsManagerPort().access("db");
		expect(result.status === "ok" && result.expiresAt).toBeTruthy();
	});
});

describe("the Azure Key Vault adapter", () => {
	it("reports its kind and a vault-scoped id", () => {
		const port = createAzureKeyVaultPort({ vaultName: "kv1" });
		expect(port.kind).toBe("azure-kv");
		expect(port.id).toContain("kv1");
	});

	it("mints deterministic offline material with no transport", async () => {
		const port = createAzureKeyVaultPort();
		const first = await port.access("db");
		const second = await port.access("db");
		expect(first.status === "ok" && first.material).toBe(
			second.status === "ok" ? second.material : undefined,
		);
	});

	it("prefers a stored value over minted material", async () => {
		const port = createAzureKeyVaultPort();
		await port.put("db", "stored");
		const result = await port.access("db");
		expect(result.status === "ok" && result.material).toBe("stored");
	});
});

describe("the local station port", () => {
	it("defaults to the in-memory backend", () => {
		expect(createLocalStationSecretsPort({ env: {} }).kind).toBe(
			"memory-fixture",
		);
	});

	it("selects the Vault backend when asked", () => {
		expect(
			createLocalStationSecretsPort({
				env: { HOBO_LOCAL_SECRETS_BACKEND: "vault-jwt" },
			}).kind,
		).toBe("vault-jwt");
	});

	it("matches the backend name case-insensitively", () => {
		expect(
			createLocalStationSecretsPort({
				env: { HOBO_LOCAL_SECRETS_BACKEND: "VAULT-JWT" },
			}).kind,
		).toBe("vault-jwt");
	});

	it("refuses OpenBao with a message naming the package to install", () => {
		// A bare "unknown backend" here would send someone hunting; OpenBao is a
		// deliberate opt-in package, and the error says so.
		expect(() =>
			createLocalStationSecretsPort({
				env: { HOBO_LOCAL_SECRETS_BACKEND: "openbao" },
			}),
		).toThrow(/@hobo\/adapter-openbao/u);
	});

	it("falls back to memory for an unrecognised backend", () => {
		expect(
			createLocalStationSecretsPort({
				env: { HOBO_LOCAL_SECRETS_BACKEND: "wishful" },
			}).kind,
		).toBe("memory-fixture");
	});

	it("names the port after the station", () => {
		expect(
			createLocalStationSecretsPort({ stationId: "s7", env: {} }).id,
		).toContain("s7");
	});

	it("takes the station id from the environment when not passed", () => {
		expect(
			createLocalStationSecretsPort({ env: { HOBO_STATION_ID: "envstation" } })
				.id,
		).toContain("envstation");
	});
});

describe("the Camp-scoped factory", () => {
	it.each([
		["memory", "memory-fixture"],
		["vault-jwt", "vault-jwt"],
		["aws-sm", "aws-sm"],
		["azure-kv", "azure-kv"],
	])("builds a %s port", (backend, kind) => {
		// SAFETY: assertion to `as "memory" }).kind` is required at this boundary.
		expect(createCampSecretsPort({ backend: backend as "memory" }).kind).toBe(
			kind,
		);
	});

	it("throws for a backend outside the union", () => {
		// The exhaustiveness arm. Reachable only from untyped input, which is
		// exactly where it matters.
		expect(() =>
			// SAFETY: assertion to `" as "memory" }), )` is required at this boundary.
			createCampSecretsPort({ backend: "openbao" as "memory" }),
		).toThrow(/unknown secrets backend/u);
	});
});

describe("the WIT-shaped store view", () => {
	it("round-trips bytes through a port that speaks strings", async () => {
		const store = asHoboSecretsStore(createMemorySecretsPort());
		await store.put("db", new TextEncoder().encode("hello"));
		const read = await store.access("db");
		expect(new TextDecoder().decode(read.value)).toBe("hello");
	});

	it("returns the version id from a put", async () => {
		const store = asHoboSecretsStore(createMemorySecretsPort());
		expect(await store.put("db", new Uint8Array([1]))).toMatch(/^v1-/u);
	});

	it("throws the denial reason rather than a generic failure", async () => {
		// WIT has no result union here, so a denial has to become a throw — but
		// it must carry the reason, or the caller learns nothing.
		const store = asHoboSecretsStore(createMemorySecretsPort());
		await expect(store.access("absent")).rejects.toThrow(/not found/u);
	});

	it("reads a specific version back as bytes", async () => {
		const port = createMemorySecretsPort();
		const { versionId } = await port.put("db", "pinned");
		await port.put("db", "newer");
		const store = asHoboSecretsStore(port);
		expect(
			new TextDecoder().decode(await store.accessVersion("db", versionId)),
		).toBe("pinned");
	});

	it("lists versions through the view", async () => {
		const port = createMemorySecretsPort();
		await port.put("db", "v1");
		expect(await asHoboSecretsStore(port).listVersions("db")).toHaveLength(1);
	});
});
