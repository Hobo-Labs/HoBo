import { generateKeyPairSync } from "node:crypto";
import { expect, it } from "vitest";
import {
	bindle,
	type CollectionContext,
	collectBindleManifest,
	discoveryEnvForDependency,
	evaluateBindingDeliveryGate,
	parseManifest,
} from "../src/index.js";

it("examines source annotations before manifest collection", () => {
	const credential = "fixture-source-credential";
	const definitions = [
		bindle("source", (builder) => ({
			web: builder.web().with({
				provider: "hobo",
				option: "env",
				config: { SERVICE_TOKEN: credential },
			}),
		})),
		bindle("source", (builder) => ({
			web: builder.web(),
			database: builder.external({
				connectionString: `postgres://user:${credential}@example.test/db`,
			}),
		})),
		bindle("source", (builder) => ({
			web: builder.web(),
			worker: builder.container({
				image: "example.test/worker:1",
				env: { CLIENT_SECRET: credential },
			}),
		})),
		bindle("source", (builder) => ({
			web: builder.web(),
			service: builder.external({
				endpoints: { http: `https://user:${credential}@example.test/` },
			}),
		})),
	];
	for (const definition of definitions) {
		const result = evaluateBindingDeliveryGate({ definition });
		expect(result.ok).toBe(false);
		expect(JSON.stringify(result)).not.toContain(credential);
	}
});

it("allows ordinary source configuration and public endpoint discovery", () => {
	const definition = bindle("source", (builder) => ({
		web: builder.web().with({
			provider: "hobo",
			option: "env",
			config: { LOG_LEVEL: "debug", PORT: 8080 },
		}),
		service: builder.external({
			endpoints: { http: "https://service.example.test/" },
		}),
	}));
	expect(evaluateBindingDeliveryGate({ definition }).ok).toBe(true);
	expect(
		discoveryEnvForDependency("service", null, {
			httpUrl: "https://service.example.test/",
		}),
	).toEqual({ services__service__http__0: "https://service.example.test/" });
});

it("never emits a credential-bearing discovery URL", () => {
	const credential = "fixture-discovery-credential";
	const discover = () =>
		discoveryEnvForDependency("service", null, {
			httpUrl: `https://user:${credential}@example.test/`,
		});
	expect(discover).toThrow(/binding.delivery/i);
	try {
		discover();
	} catch (error) {
		expect(String(error)).not.toContain(credential);
	}
});

it("rejects secret-shaped keys and values under ordinary environment names", () => {
	for (const key of [
		"SERVICE_TOKEN",
		"AWS_SECRET_ACCESS_KEY",
		"AUTHORIZATION",
	]) {
		const verdict = evaluateBindingDeliveryGate({
			env: { [key]: "fixture-secret" },
		});
		expect(verdict.ok).toBe(false);
		expect(JSON.stringify(verdict)).not.toContain("fixture-secret");
	}
	for (const value of [
		"password=fixture-secret",
		"Bearer fixture-secret",
		"https://service.example.test/?access_token=fixture-secret",
		"https://service.example.test/?X-Amz-Signature=fixture-secret",
		`${generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" })}fixture-secret`,
	]) {
		const verdict = evaluateBindingDeliveryGate({
			env: { SERVICE_CONFIG: value },
		});
		expect(verdict.ok).toBe(false);
		expect(JSON.stringify(verdict)).not.toContain("fixture-secret");
	}
});

it("rejects unsafe collected environments before emitting a manifest", () => {
	const target = {
		bindleId: "fixture",
		componentHost: { kind: "wasmtime", version: "1" },
		define(collector: CollectionContext) {
			collector.service("web", {
				env: { SERVICE_TOKEN: "fixture-collect-secret" },
			});
		},
	};
	expect(() => collectBindleManifest(target)).toThrow(/binding.delivery/i);
	try {
		collectBindleManifest(target);
	} catch (error) {
		expect(String(error)).not.toContain("fixture-collect-secret");
	}
});

it("rejects credentials in nested authored and collected endpoints", () => {
	const credential = "fixture-nested-credential";
	const options = JSON.parse(
		JSON.stringify({
			image: "example.test/worker:1",
			endpoints: {
				http: { port: 8080, url: `https://user:${credential}@example.test/` },
			},
		}),
	);
	const definition = bindle("source", (builder) => ({
		worker: builder.container(options),
	}));
	const manifest = parseManifest({
		schema: "hobo.manifest/v1",
		componentHost: { kind: "wasmtime", version: "1" },
		resources: {
			worker: {
				type: "component.v1",
				endpoints: options.endpoints,
			},
		},
	});
	for (const result of [
		evaluateBindingDeliveryGate({ definition }),
		evaluateBindingDeliveryGate({ manifest }),
	]) {
		expect(result.ok).toBe(false);
		expect(JSON.stringify(result)).not.toContain(credential);
	}
});

it("accepts ordinary structured endpoints and rejects non-scalar environments", () => {
	const safe = bindle("source", (builder) => ({
		worker: builder.container({
			image: "example.test/worker:1",
			endpoints: { http: { port: 8080, external: true } },
		}),
	}));
	expect(evaluateBindingDeliveryGate({ definition: safe }).ok).toBe(true);
	const invalid = bindle("source", (builder) => ({
		web: builder.web().with({
			provider: "hobo",
			option: "env",
			config: { NESTED: { level: "debug" } },
		}),
	}));
	expect(evaluateBindingDeliveryGate({ definition: invalid })).toMatchObject({
		ok: false,
		reasons: [{ code: "invalid-annotation" }],
	});
});

it("fails closed for cyclic endpoint metadata", () => {
	const endpoints = { http: { port: 8080 } };
	const definition = bindle("source", (builder) => ({
		worker: builder.container({ image: "example.test/worker:1", endpoints }),
	}));
	Object.defineProperty(endpoints.http, "cycle", {
		value: endpoints,
		enumerable: true,
	});
	expect(evaluateBindingDeliveryGate({ definition })).toMatchObject({
		ok: false,
		reasons: [{ code: "invalid-annotation" }],
	});
});
