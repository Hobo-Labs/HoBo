import { mustGet } from "@hobo/core/total-access";
import { describe, expect, it } from "vitest";
import {
	CloudNativeEndpointError,
	createAwsCloudNativeProvider,
	createAzureCloudNativeProvider,
	createGcpCloudNativeProvider,
	createVercelCloudNativeProvider,
} from "../src/index.js";

const ensureContext = { hoboHome: "/tmp" };
const serveContext = (bindleEnv: Readonly<Record<string, string>> = {}) => ({
	hoboHome: "/tmp",
	projectDir: "/tmp",
	privateComponents: [{ resourceName: "orders-api", projectDir: "/tmp" }],
	bindleEnv,
});

describe("endpoint cloud-native providers", () => {
	it.each([
		["aws", createAwsCloudNativeProvider, ["AWS_PROFILE"]],
		["gcp", createGcpCloudNativeProvider, ["GOOGLE_APPLICATION_CREDENTIALS"]],
		[
			"azure",
			createAzureCloudNativeProvider,
			["AZURE_CLIENT_ID", "AZURE_TENANT_ID", "AZURE_CLIENT_SECRET"],
		],
		["vercel", createVercelCloudNativeProvider, ["VERCEL_TOKEN"]],
	] as const)("%s fails closed without credentials and becomes ready with credentials", async (providerId, createProvider, credentialNames) => {
		const gated = await createProvider({ env: {} }).ensure(ensureContext);
		expect(gated.ready).toBe(false);
		expect(gated.details).toEqual(
			expect.objectContaining({
				provider: providerId,
				implemented: true,
				credentialGated: true,
			}),
		);

		const env = Object.fromEntries(
			credentialNames.map((name) => [name, `secret-${name}`]),
		);
		const ready = await createProvider({ env }).ensure(ensureContext);
		expect(ready.ready).toBe(true);
		expect(ready.details).toEqual({
			provider: providerId,
			implemented: true,
		});
		expect(JSON.stringify(ready)).not.toContain("secret-");
	});

	it.each([
		[createAwsCloudNativeProvider, { AWS_PROFILE: "ci" }],
		[
			createAzureCloudNativeProvider,
			{
				AZURE_CLIENT_ID: "client",
				AZURE_TENANT_ID: "tenant",
				AZURE_FEDERATED_TOKEN_FILE: "/token",
			},
		],
	] as const)("accepts alternate credential chains", async (createProvider, env) => {
		const result = await createProvider({ env }).ensure(ensureContext);
		expect(result.ready).toBe(true);
	});

	it("proxies requests to a bound provider endpoint", async () => {
		const calls: Array<{
			readonly url: string;
			readonly method: string | undefined;
			readonly body: string;
		}> = [];
		const fetchImpl: typeof fetch = async (input, init) => {
			calls.push({
				url: String(input),
				method: init?.method,
				body:
					init?.body instanceof ArrayBuffer
						? Buffer.from(init.body).toString("utf8")
						: "",
			});
			return new Response("created", {
				status: 201,
				headers: { "x-provider": "aws" },
			});
		};
		const provider = createAwsCloudNativeProvider({ fetchImpl });
		const served = await provider.servePrivate(
			serveContext({
				HOBO_CLOUD_NATIVE_ENDPOINT_ORDERS_API:
					"https://lambda.example.test/base/",
			}),
		);
		const response = await mustGet(
			served.handlers,
			"orders-api",
		)(
			new Request("http://internal/orders/42?full=true", {
				method: "POST",
				body: "payload",
			}),
		);
		expect(response.status).toBe(201);
		expect(response.headers.get("x-provider")).toBe("aws");
		expect(await response.text()).toBe("created");
		expect(calls).toEqual([
			{
				url: "https://lambda.example.test/orders/42?full=true",
				method: "POST",
				body: "payload",
			},
		]);
		await served.close();
		expect(served.handlers.size).toBe(0);
	});

	it("returns a typed refusal for malformed endpoint bindings", async () => {
		const provider = createGcpCloudNativeProvider();
		await expect(
			provider.servePrivate(
				serveContext({ HOBO_CLOUD_NATIVE_ENDPOINT_ORDERS_API: "ftp://bad" }),
			),
		).rejects.toBeInstanceOf(CloudNativeEndpointError);
	});
});
