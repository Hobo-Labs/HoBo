import * as Credentials from "@alchemy.run/aws/Credentials";
import * as Endpoint from "@alchemy.run/aws/Endpoint";
import type { CryptographyPort } from "@hobo/core/cryptography";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { expect, it } from "vitest";
import { bindle } from "../../../bindles/src/bindle.js";
import { sessionReplay } from "../../../bindles/src/session-replay.js";
import { createAwsKmsCryptography } from "../src/aws-cryptography.js";
import { withAwsKmsCryptography } from "../src/aws-cryptography-mapper.js";
import {
	awsHttpBindings,
	createAwsBindleApplication,
} from "../src/aws-http-runtime.js";
import { defineAwsHttpSource } from "../src/aws-http-source.js";

const keyId = "12345678-1234-1234-1234-123456789012";
const keyArn = `arn:aws:kms:us-east-1:000000000000:key/${keyId}`;
const grant = {
	keyId,
	accountId: "000000000000",
	partition: "aws",
	region: "us-east-1",
	resourceEpoch: `sha256:${"a".repeat(64)}`,
	grantEpoch: `sha256:${"b".repeat(64)}`,
	allow: ["encrypt", "decrypt"] as const,
};
const request = {
	attemptId: "crypto_attempt_123",
	data: new Uint8Array([1, 2, 3]),
};
const response = () =>
	new Response(JSON.stringify({ KeyId: keyArn, CiphertextBlob: "BAUG" }), {
		headers: { "content-type": "application/x-amz-json-1.1" },
	});
function port(
	fetch: typeof globalThis.fetch,
	verify: () => boolean = () => true,
) {
	const layer = Layer.mergeAll(
		Endpoint.of("http://localhost:4566"),
		Credentials.fromCredentials(
			{
				accessKeyId: Redacted.make("local"),
				secretAccessKey: Redacted.make("local"),
			},
			"us-east-1",
		),
		FetchHttpClient.layer,
		Layer.succeed(FetchHttpClient.Fetch, fetch),
	);
	return createAwsKmsCryptography({ grant, verify, layer });
}
it("binds only the genuine scoped key selected by the source", async () => {
	let retained: CryptographyPort | undefined;
	const definition = bindle("shop", (b) => {
		const key = b.crypto().allow("encrypt", "decrypt");
		return {
			key,
			web: b
				.web((context) => async () => {
					retained = awsHttpBindings(context).crypto("key");
					const result = await retained.encrypt(request);
					return Response.json({ status: result.status });
				})
				.with(sessionReplay({ enabled: false }))
				.dependsOn(key),
		};
	});
	const selected = withAwsKmsCryptography(definition, { key: true });
	let calls = 0;
	const store = port(async () => {
		calls++;
		return response();
	});
	const make = (
		physicalName: string,
		value: CryptographyPort,
		verifyBinding: () => boolean = () => true,
	) =>
		defineAwsHttpSource({
			bindle: selected,
			applicationName: "web",
			environment: { HOBO_RESOURCE_0: physicalName },
			resolveStores: () => ({ key: value }),
			verifyBinding,
		});
	expect(
		await (
			await make(keyId, store).fetch(new Request("https://app.test"))
		).json(),
	).toEqual({ status: "completed" });
	expect(await retained?.encrypt(request)).toEqual({
		status: "rejected",
		code: "unauthorized",
	});
	expect(
		(await make("wrong-key", store).fetch(new Request("https://app.test")))
			.status,
	).toBe(503);
	expect(
		(await make(keyId, { ...store }).fetch(new Request("https://app.test")))
			.status,
	).toBe(503);
	expect(
		(
			await make(keyId, new Proxy(store, {})).fetch(
				new Request("https://app.test"),
			)
		).status,
	).toBe(503);
	expect(
		(
			await make(keyId, store, () => false).fetch(
				new Request("https://app.test"),
			)
		).status,
	).toBe(503);
	expect(calls).toBe(1);
});
it("withholds an in-flight result when the application grant is revoked", async () => {
	let finish!: (value: Response) => void;
	let started!: () => void;
	const dispatch = new Promise<void>((resolve) => {
		started = resolve;
	});
	const store = port(
		async () =>
			new Promise<Response>((resolve) => {
				finish = resolve;
				started();
			}),
	);
	let result: ReturnType<CryptographyPort["encrypt"]> | undefined;
	const definition = bindle("shop", (b) => {
		const key = b.crypto().allow("encrypt", "decrypt");
		return {
			key,
			web: b
				.web((context) => async () => {
					result = awsHttpBindings(context).crypto("key").encrypt(request);
					await result;
					return new Response("ok");
				})
				.with(sessionReplay({ enabled: false }))
				.dependsOn(key),
		};
	});
	let authorized = true;
	const app = createAwsBindleApplication({
		bindle: withAwsKmsCryptography(definition, { key: true }),
		applicationName: "web",
		stores: { key: store },
		verifyBinding: () => authorized,
	});
	const incoming = app.fetch(new Request("https://app.test"));
	await dispatch;
	authorized = false;
	finish(response());
	expect(await result).toEqual({
		status: "unknown",
		attemptId: request.attemptId,
	});
	expect((await incoming).status).toBe(503);
});
it("rejects duplicate physical keys and mismatched permissions", () => {
	const definition = bindle("shop", (b) => {
		const first = b.crypto().allow("encrypt", "decrypt");
		const second = b.crypto().allow("encrypt", "decrypt");
		return {
			first,
			second,
			web: b
				.web(() => () => new Response("ok"))
				.with(sessionReplay({ enabled: false }))
				.dependsOn(first, second),
		};
	});
	const store = port(async () => response());
	expect(() =>
		createAwsBindleApplication({
			bindle: withAwsKmsCryptography(definition, { first: true, second: true }),
			applicationName: "web",
			stores: { first: store, second: store },
			verifyBinding: () => true,
		}),
	).toThrow("identities must be unique");
	const limited = bindle("shop", (b) => {
		const key = b.crypto().allow("encrypt");
		return {
			key,
			web: b
				.web(() => () => new Response("ok"))
				.with(sessionReplay({ enabled: false }))
				.dependsOn(key),
		};
	});
	expect(() =>
		createAwsBindleApplication({
			bindle: withAwsKmsCryptography(limited, { key: true }),
			applicationName: "web",
			stores: { key: store },
			verifyBinding: () => true,
		}),
	).toThrow("does not match");
});

it("rejects an operation when the source key changes during the request", async () => {
	const environment = { HOBO_RESOURCE_0: keyId };
	let calls = 0;
	let result: Awaited<ReturnType<CryptographyPort["encrypt"]>> | undefined;
	const store = port(async () => {
		calls++;
		return response();
	});
	const definition = bindle("shop", (b) => {
		const key = b.crypto().allow("encrypt", "decrypt");
		return {
			key,
			web: b
				.web((context) => async () => {
					const scoped = awsHttpBindings(context).crypto("key");
					environment.HOBO_RESOURCE_0 = "changed-key";
					result = await scoped.encrypt(request);
					return new Response("ok");
				})
				.with(sessionReplay({ enabled: false }))
				.dependsOn(key),
		};
	});
	const source = defineAwsHttpSource({
		bindle: withAwsKmsCryptography(definition, { key: true }),
		applicationName: "web",
		environment,
		resolveStores: () => ({ key: store }),
		verifyBinding: () => true,
	});
	expect((await source.fetch(new Request("https://app.test"))).status).toBe(
		503,
	);
	expect(result).toEqual({ status: "rejected", code: "unauthorized" });
	expect(calls).toBe(0);
});

it("withholds an in-flight result when the source key changes", async () => {
	const environment = { HOBO_RESOURCE_0: keyId };
	let finish!: (value: Response) => void;
	let started!: () => void;
	const dispatch = new Promise<void>((resolve) => {
		started = resolve;
	});
	const store = port(
		async () =>
			new Promise<Response>((resolve) => {
				finish = resolve;
				started();
			}),
	);
	let result: ReturnType<CryptographyPort["encrypt"]> | undefined;
	const definition = bindle("shop", (b) => {
		const key = b.crypto().allow("encrypt", "decrypt");
		return {
			key,
			web: b
				.web((context) => async () => {
					result = awsHttpBindings(context).crypto("key").encrypt(request);
					await result;
					return new Response("ok");
				})
				.with(sessionReplay({ enabled: false }))
				.dependsOn(key),
		};
	});
	const source = defineAwsHttpSource({
		bindle: withAwsKmsCryptography(definition, { key: true }),
		applicationName: "web",
		environment,
		resolveStores: () => ({ key: store }),
		verifyBinding: () => true,
	});
	const incoming = source.fetch(new Request("https://app.test"));
	await dispatch;
	environment.HOBO_RESOURCE_0 = "changed-key";
	finish(response());
	expect(await result).toEqual({
		status: "unknown",
		attemptId: request.attemptId,
	});
	expect((await incoming).status).toBe(503);
});

it("rechecks the source after a verifier changes its key", async () => {
	const environment = { HOBO_RESOURCE_0: keyId };
	let armed = false;
	let calls = 0;
	let result: Awaited<ReturnType<CryptographyPort["encrypt"]>> | undefined;
	const store = port(async () => {
		calls++;
		return response();
	});
	const definition = bindle("shop", (b) => {
		const key = b.crypto().allow("encrypt", "decrypt");
		return {
			key,
			web: b
				.web((context) => async () => {
					armed = true;
					result = await awsHttpBindings(context)
						.crypto("key")
						.encrypt(request);
					return new Response("ok");
				})
				.with(sessionReplay({ enabled: false }))
				.dependsOn(key),
		};
	});
	const source = defineAwsHttpSource({
		bindle: withAwsKmsCryptography(definition, { key: true }),
		applicationName: "web",
		environment,
		resolveStores: () => ({ key: store }),
		verifyBinding: () => {
			if (armed) environment.HOBO_RESOURCE_0 = "changed-key";
			return true;
		},
	});
	expect((await source.fetch(new Request("https://app.test"))).status).toBe(
		503,
	);
	expect(result).toEqual({ status: "rejected", code: "unauthorized" });
	expect(calls).toBe(0);
});

it("reports unknown if a provider verifier changes the source after the scoped check", async () => {
	const environment = { HOBO_RESOURCE_0: keyId };
	let calls = 0;
	let result: Awaited<ReturnType<CryptographyPort["encrypt"]>> | undefined;
	const store = port(
		async () => {
			calls++;
			return response();
		},
		() => {
			environment.HOBO_RESOURCE_0 = "changed-key";
			return true;
		},
	);
	const definition = bindle("shop", (b) => {
		const key = b.crypto().allow("encrypt", "decrypt");
		return {
			key,
			web: b
				.web((context) => async () => {
					result = await awsHttpBindings(context)
						.crypto("key")
						.encrypt(request);
					return new Response("ok");
				})
				.with(sessionReplay({ enabled: false }))
				.dependsOn(key),
		};
	});
	const source = defineAwsHttpSource({
		bindle: withAwsKmsCryptography(definition, { key: true }),
		applicationName: "web",
		environment,
		resolveStores: () => ({ key: store }),
		verifyBinding: () => true,
	});
	expect((await source.fetch(new Request("https://app.test"))).status).toBe(
		503,
	);
	expect(result).toEqual({ status: "unknown", attemptId: request.attemptId });
	expect(calls).toBe(1);
});
