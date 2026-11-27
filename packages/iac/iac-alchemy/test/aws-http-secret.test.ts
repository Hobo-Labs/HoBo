import * as Credentials from "@alchemy.run/aws/Credentials";
import * as Endpoint from "@alchemy.run/aws/Endpoint";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { describe, expect, it } from "vitest";
import { bindle } from "../../../bindles/src/bindle.js";
import { sessionReplay } from "../../../bindles/src/session-replay.js";
import type { BindleRuntimeContext } from "../../../bindles/src/types.js";
import {
	awsHttpBindings,
	createAwsBindleApplication,
} from "../src/aws-http-runtime.js";
import { defineAwsHttpSource } from "../src/aws-http-source.js";
import { createAwsSecretStore } from "../src/aws-secret.js";
import { withAwsVersionedSecret } from "../src/aws-secret-mapper.js";

const arn = "arn:aws:secretsmanager:us-east-1:000000000000:secret:app-ABC123";
const id = "00000000-0000-4000-8000-000000000001";
function layer(fetch: typeof globalThis.fetch) {
	return Layer.mergeAll(
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
}
function store(
	fetch: typeof globalThis.fetch,
	allow: readonly ("put" | "access")[],
) {
	return createAwsSecretStore({
		grant: {
			secretArn: arn,
			resourceEpoch: `sha256:${"a".repeat(64)}`,
			grantEpoch: `sha256:${"b".repeat(64)}`,
			allow,
		},
		verify: () => true,
		layer: layer(fetch),
	});
}

describe("AWS HTTP secret bindings", () => {
	it("rejects a different physical ARN and a grant broader than the declaration", async () => {
		const neutral = bindle("shop", (b) => {
			const credentials = b.secret().allow("access");
			return {
				credentials,
				web: b
					.web(() => () => new Response("ok"))
					.with(sessionReplay({ enabled: false }))
					.dependsOn(credentials),
			};
		});
		const selected = withAwsVersionedSecret(neutral, { credentials: true });
		let calls = 0;
		const fetch = async () => {
			calls++;
			return new Response();
		};
		const good = store(fetch, ["access"]);
		const broad = store(fetch, ["put", "access"]);
		const create = (physicalName: string, candidate: typeof good) =>
			defineAwsHttpSource({
				bindle: selected,
				applicationName: "web",
				environment: { HOBO_RESOURCE_0: physicalName },
				resolveStores: () => ({ credentials: candidate }),
				verifyBinding: () => true,
			});
		expect(
			(
				await create(`${arn}-other`, good).fetch(
					new Request("https://app.test/"),
				)
			).status,
		).toBe(503);
		expect(
			(await create(arn, broad).fetch(new Request("https://app.test/"))).status,
		).toBe(503);
		expect(calls).toBe(0);
	});
	it("reports an in-flight write as unknown when the request grant is revoked", async () => {
		let finish: ((response: Response) => void) | undefined;
		let signal: (() => void) | undefined;
		const started = new Promise<void>((resolve) => {
			signal = resolve;
		});
		const secrets = store(
			async () =>
				new Promise<Response>((resolve) => {
					finish = resolve;
					signal?.();
				}),
			["put"],
		);
		let mutation: Promise<string> | undefined;
		const neutral = bindle("shop", (b) => {
			const credentials = b.secret().allow("put");
			return {
				credentials,
				web: b
					.web((context?: BindleRuntimeContext) => async () => {
						mutation = awsHttpBindings(context)
							.secret("credentials")
							.put(new Uint8Array([1]), id);
						try {
							await mutation;
						} catch {
							/* The application handles uncertain outcomes. */
						}
						return new Response("done");
					})
					.with(sessionReplay({ enabled: false }))
					.dependsOn(credentials),
			};
		});
		let authorized = true;
		const app = createAwsBindleApplication({
			bindle: withAwsVersionedSecret(neutral, { credentials: true }),
			applicationName: "web",
			stores: { credentials: secrets },
			verifyBinding: () => authorized,
		});
		const response = app.fetch(new Request("https://app.test/"));
		await started;
		authorized = false;
		if (!finish || !mutation) throw new Error("write was not dispatched");
		const failed = expect(mutation).rejects.toMatchObject({
			code: "AWS_SECRET_MUTATION_OUTCOME_UNKNOWN",
			versionId: id,
		});
		finish(Response.json({ ARN: arn, VersionId: id }));
		await failed;
		expect((await response).status).toBe(503);
	});
});
