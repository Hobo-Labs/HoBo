import {
	asHoboSecretsStore,
	createSecretAccessedEvent,
	requireNoPlaintextConformance,
	resolveConfigEntry,
	type SecretsPort,
} from "@hobo/identity";
import { describe, expect, it } from "vitest";

import { createOpenSesameCredentialResolver } from "../src/credential-resolver.js";
import { OpenSesameAdapterError } from "../src/errors.js";
import { createOpenSesameSecretsPort } from "../src/port.js";
import { parsed, vercelRecord } from "./fixtures/bindings.js";

const SURROGATE = `osr_${"0123456789abcdef".repeat(2)}`;
const LOCATOR = "hobo-token://vercel/deploy";
const VERSION_FALLBACK = "surrogate";

/** What a process started by `runProxied` has beside the surrogate: the run's markers. */
const RUN = {
	HOBO_OPENSESAME_CHILD: "1",
	NODE_USE_ENV_PROXY: "1",
	HTTPS_PROXY: "http://opensesame:run-secret@127.0.0.1:41234",
};

function portWith(env: NodeJS.ProcessEnv): SecretsPort {
	return createOpenSesameSecretsPort({
		bindings: parsed(),
		env: { ...RUN, ...env },
	});
}

describe("the OpenSesame SecretsPort", () => {
	it("is an opensesame port with a stable id", () => {
		const port = portWith({});
		expect(port.kind).toBe("opensesame");
		expect(port.id).toBe("secrets:opensesame");
		expect(
			createOpenSesameSecretsPort({
				bindings: parsed(),
				env: {},
				id: "secrets:qdai",
			}).id,
		).toBe("secrets:qdai");
	});

	it("access returns ok with material shaped osr_ and source provider-federation", async () => {
		const result = await portWith({ VERCEL_TOKEN: SURROGATE }).access(LOCATOR);
		expect(result).toEqual({
			status: "ok",
			valueRef: "opensesame://acme/vercel#surrogate",
			material: SURROGATE,
			versionId: "surrogate",
			source: "provider-federation",
		});
	});

	it("unknown locator is denied secret-not-found", async () => {
		const result = await portWith({ VERCEL_TOKEN: SURROGATE }).access(
			"hobo-token://vercel/other",
		);
		expect(result).toMatchObject({
			status: "denied",
			code: "secret-not-found",
		});
	});

	it("a placeholder is denied placeholders_only", async () => {
		const placeholder = `ostest_${"0123456789abcdef".repeat(2)}`;
		const result = await portWith({ VERCEL_TOKEN: placeholder }).access(
			LOCATOR,
		);
		expect(result).toMatchObject({
			status: "denied",
			code: "placeholders_only",
		});
	});

	it("a variable that is absent is denied placeholders_only", async () => {
		expect(await portWith({}).access(LOCATOR)).toMatchObject({
			status: "denied",
			code: "placeholders_only",
		});
	});

	it("never serves a plain token as material: only a value shaped like a surrogate passes", async () => {
		const plain = "vtok_dummy_marker_0123456789abcdef";
		const result = await portWith({ VERCEL_TOKEN: plain }).access(LOCATOR);
		expect(result).toMatchObject({
			status: "denied",
			code: "placeholders_only",
		});
		expect(JSON.stringify(result)).not.toContain(plain);
	});

	it("rejects a surrogate that is the wrong length or not hex", async () => {
		for (const value of [
			"osr_abc",
			`osr_${"g".repeat(32)}`,
			`${SURROGATE}0`,
			` ${SURROGATE}`,
			`osr_${"0123456789ABCDEF".repeat(2)}`,
		]) {
			expect(
				await portWith({ VERCEL_TOKEN: value }).access(LOCATOR),
				value,
			).toMatchObject({ status: "denied" });
		}
	});

	describe("run provenance: shape alone is not enough", () => {
		// An `osr_` + 32 hex a person pasted, or one left from another or an earlier run, has the
		// right shape and no run behind it. What is checked is the shape and the markers a run
		// started by runProxied carries; it is not cryptographic provenance (the port cannot ask
		// OpenSesame whether a surrogate is live).
		function accessWith(env: NodeJS.ProcessEnv) {
			return createOpenSesameSecretsPort({ bindings: parsed(), env }).access(
				LOCATOR,
			);
		}

		it("serves a surrogate when the child marker, NODE_USE_ENV_PROXY and a loopback proxy are all there", async () => {
			for (const proxy of [
				"http://opensesame:s@127.0.0.1:44719",
				"http://localhost:8080",
				"http://[::1]:3128",
			]) {
				const result = await accessWith({
					...RUN,
					HTTPS_PROXY: proxy,
					VERCEL_TOKEN: SURROGATE,
				});
				expect(result.status, proxy).toBe("ok");
			}
		});

		it("denies a surrogate-shaped value with no run behind it, naming the reason and not the value", async () => {
			const result = await accessWith({ VERCEL_TOKEN: SURROGATE });
			expect(result).toMatchObject({
				status: "denied",
				code: "placeholders_only",
			});
			if (result.status === "denied") {
				expect(result.reason).toMatch(/^no_run_provenance: /u);
				expect(result.reason).not.toContain(SURROGATE);
			}
		});

		it.each([
			["the child marker is missing", { HOBO_OPENSESAME_CHILD: undefined }],
			["the child marker is not 1", { HOBO_OPENSESAME_CHILD: "0" }],
			["NODE_USE_ENV_PROXY is missing", { NODE_USE_ENV_PROXY: undefined }],
			["NODE_USE_ENV_PROXY is off", { NODE_USE_ENV_PROXY: "0" }],
			["there is no HTTPS_PROXY", { HTTPS_PROXY: undefined }],
			[
				"HTTPS_PROXY is not loopback",
				{ HTTPS_PROXY: "http://proxy.example:8080" },
			],
			[
				"HTTPS_PROXY is a private address",
				{ HTTPS_PROXY: "http://10.0.0.1:3128" },
			],
			[
				"HTTPS_PROXY only starts like loopback",
				{ HTTPS_PROXY: "http://127.0.0.1.evil.example:80" },
			],
			["HTTPS_PROXY has no port", { HTTPS_PROXY: "http://127.0.0.1" }],
			["HTTPS_PROXY is not http", { HTTPS_PROXY: "https://127.0.0.1:8443" }],
			["HTTPS_PROXY is not a URL", { HTTPS_PROXY: "127.0.0.1:8080" }],
		])("denies when %s", async (_why, change) => {
			const result = await accessWith({
				...RUN,
				...change,
				VERCEL_TOKEN: SURROGATE,
			});
			expect(result).toMatchObject({
				status: "denied",
				code: "placeholders_only",
			});
			if (result.status === "denied")
				expect(result.reason).toMatch(/^no_run_provenance: /u);
		});

		it("denies accessVersion the same way", async () => {
			const port = createOpenSesameSecretsPort({
				bindings: parsed(),
				env: { VERCEL_TOKEN: SURROGATE },
			});
			expect(await port.accessVersion(LOCATOR, "surrogate")).toMatchObject({
				status: "denied",
				code: "placeholders_only",
			});
		});
	});

	it("accessVersion serves the one version and refuses another", async () => {
		const port = portWith({ VERCEL_TOKEN: SURROGATE });
		expect(await port.accessVersion(LOCATOR, "surrogate")).toMatchObject({
			status: "ok",
			material: SURROGATE,
		});
		expect(await port.accessVersion(LOCATOR, "v1")).toMatchObject({
			status: "denied",
			code: "secret-version-not-found",
		});
	});

	it("listVersions is the one surrogate for a bound locator and nothing for another", async () => {
		const port = portWith({ VERCEL_TOKEN: SURROGATE });
		expect(await port.listVersions(LOCATOR)).toEqual(["surrogate"]);
		expect(await port.listVersions("hobo-token://vercel/other")).toEqual([]);
	});

	it("put throws read_only: secrets enter by a person's `opensesame pass insert`", async () => {
		const port = portWith({ VERCEL_TOKEN: SURROGATE });
		await expect(port.put(LOCATOR, "anything")).rejects.toMatchObject({
			code: "read_only",
		});
		await expect(port.put(LOCATOR, "anything")).rejects.toBeInstanceOf(
			OpenSesameAdapterError,
		);
		await expect(
			asHoboSecretsStore(port).put(LOCATOR, new Uint8Array([1])),
		).rejects.toMatchObject({ code: "read_only" });
	});

	it("serves each binding its own variable", async () => {
		const other = `osr_${"fedcba9876543210".repeat(2)}`;
		const port = createOpenSesameSecretsPort({
			bindings: parsed(
				vercelRecord(),
				vercelRecord({
					locator: "hobo-token://vercel/edge",
					env_name: "EDGE_TOKEN",
				}),
			),
			env: { ...RUN, VERCEL_TOKEN: SURROGATE, EDGE_TOKEN: other },
		});
		expect(await port.access(LOCATOR)).toMatchObject({ material: SURROGATE });
		expect(await port.access("hobo-token://vercel/edge")).toMatchObject({
			material: other,
		});
	});

	it("passes the plaintext conformance oracle: refs only in events and agent context", async () => {
		const port = portWith({ VERCEL_TOKEN: SURROGATE });
		const ok = await port.access(LOCATOR);
		if (ok.status !== "ok") throw new Error("expected ok");
		const event = createSecretAccessedEvent({
			name: LOCATOR,
			source: ok.source,
			valueRef: ok.valueRef,
			tenant: "qdai",
			versionId: ok.versionId ?? VERSION_FALLBACK,
		});
		requireNoPlaintextConformance({
			events: [event],
			agentContext: { valueRef: ok.valueRef, versionId: ok.versionId },
			logs: "opensesame residual",
		});
	});

	it("the ladder resolves a binding named by its locator and keeps the surrogate off the entry", async () => {
		const resolved = await resolveConfigEntry({
			name: LOCATOR,
			sensitive: true,
			preferredSource: "provider-federation",
			allowedSources: ["provider-federation"],
			secretsPort: portWith({ VERCEL_TOKEN: SURROGATE }),
		});
		expect(resolved.status).toBe("resolved");
		if (resolved.status === "resolved") {
			expect(resolved.entry.placeholder).toMatch(/REDACTED/u);
			expect(JSON.stringify(resolved.entry)).not.toContain(SURROGATE);
		}
	});
});

describe("the credential resolver for the Vercel resolvers", () => {
	it("returns the surrogate for a bound locator", async () => {
		const resolve = createOpenSesameCredentialResolver(
			portWith({ VERCEL_TOKEN: SURROGATE }),
		);
		expect(await resolve(LOCATOR)).toBe(SURROGATE);
	});

	it("throws placeholders_only, naming no value, when the child holds a placeholder", async () => {
		const placeholder = `ostest_${"0123456789abcdef".repeat(2)}`;
		const resolve = createOpenSesameCredentialResolver(
			portWith({ VERCEL_TOKEN: placeholder }),
		);
		const error = await resolve(LOCATOR).then(
			() => undefined,
			(caught: Error) => caught,
		);
		expect(error).toBeInstanceOf(OpenSesameAdapterError);
		expect(error).toMatchObject({ code: "placeholders_only" });
		expect(String(error)).not.toContain(placeholder);
	});

	it("throws binding_invalid for a locator that is not bound, and answers for no other", async () => {
		const resolve = createOpenSesameCredentialResolver(
			portWith({ VERCEL_TOKEN: SURROGATE }),
		);
		await expect(resolve("hobo-token://vercel/other")).rejects.toMatchObject({
			code: "binding_invalid",
		});
	});
});
