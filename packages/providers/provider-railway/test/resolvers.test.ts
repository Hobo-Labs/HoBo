import type {
	HttpTransport,
	ResolveRequest,
	TransportRequest,
	TransportResponse,
} from "@hobo/core";
import { describe, expect, it } from "vitest";
import {
	createRailwayDeploymentClient,
	RAILWAY_GRAPHQL_ENDPOINT,
	RAILWAY_SERVICE_PRODUCT_ID,
	railwayResolverRegistry,
} from "../src/index.js";
import {
	isJsonArray,
	isJsonObject,
	isJsonString,
	type JsonObject,
	parseJsonObject,
} from "../src/json.js";

const TOKEN = "private-test-project-token";
const options = {
	projectId: "project-one",
	environmentId: "environment-one",
	resolveCredential: async () => TOKEN,
};
function request(overrides: Partial<ResolveRequest> = {}): ResolveRequest {
	return {
		ref: {
			slot: "service",
			productId: RAILWAY_SERVICE_PRODUCT_ID,
			logicalId: "app",
			physicalId: "deployment-one",
		},
		desired: {
			projectId: options.projectId,
			environmentId: options.environmentId,
			serviceId: "service-one",
			deploymentId: "deployment-one",
			commitSha: "a".repeat(40),
		},
		credentialRef: "vault://railway/project",
		...overrides,
	};
}
function response(data: JsonObject): TransportResponse {
	return { status: 200, headers: {}, body: JSON.stringify({ data }) };
}
function world(
	settings: {
		status?: string;
		endpoint?: string;
		foreignScope?: boolean;
		foreignService?: boolean;
		otherDeployment?: boolean;
		missingDeployment?: boolean;
		stopped?: boolean;
		stopConfirmed?: boolean;
		omitMetadata?: boolean;
		metadata?: JsonObject | null;
	} = {},
) {
	const calls: TransportRequest[] = [];
	let status = settings.status ?? "SUCCESS";
	const transport: HttpTransport = async (call) => {
		calls.push(call);
		const body = parseJsonObject(call.body ?? ""),
			document = body.query;
		if (!isJsonString(document)) throw new Error("missing GraphQL query");
		if (document.includes("hoboProjectToken"))
			return response({
				projectToken: {
					projectId: settings.foreignScope ? "foreign" : options.projectId,
					environmentId: options.environmentId,
				},
			});
		if (document.includes("hoboServiceInstance"))
			return response({
				serviceInstance: {
					id: "instance-one",
					serviceId: "service-one",
					environmentId: options.environmentId,
					latestDeployment: null,
				},
			});
		if (document.includes("hoboService("))
			return response({
				service: {
					id: "service-one",
					projectId: settings.foreignService ? "foreign" : options.projectId,
					name: "app",
				},
			});
		if (document.includes("hoboDeployment("))
			return response({
				deployment: settings.missingDeployment
					? null
					: {
							id: settings.otherDeployment
								? "another-deployment"
								: "deployment-one",
							projectId: options.projectId,
							environmentId: options.environmentId,
							serviceId: "service-one",
							status,
							deploymentStopped: settings.stopped ?? status === "REMOVED",
							url: settings.endpoint ?? "https://app.up.railway.app/",
							...(settings.omitMetadata
								? undefined
								: {
										meta:
											settings.metadata === undefined
												? { commitHash: "a".repeat(40) }
												: settings.metadata,
									}),
						},
			});
		if (document.includes("hoboDeploy("))
			return response({ serviceInstanceDeployV2: "deployment-new" });
		if (document.includes("hoboStop")) {
			if (settings.stopConfirmed !== false) status = "REMOVED";
			return response({ deploymentStop: true });
		}
		throw new Error("unmatched Railway request");
	};
	return {
		calls,
		transport,
		status(value: string) {
			status = value;
		},
	};
}
function mutations(calls: readonly TransportRequest[]) {
	return calls.filter((call) =>
		parseJsonObject(call.body ?? "")
			.query?.toString()
			.startsWith("mutation"),
	);
}

describe("Railway authenticated lifecycle", () => {
	it("emits only HTTP request documents declared by the hosting consumer pact", async () => {
		const pact = parseJsonObject(
			readFileSync(
				new URL(
					"../contracts/provider-railway-hosting.pact.json",
					import.meta.url,
				),
				"utf8",
			),
		);
		if (!isJsonArray(pact.interactions) || pact.interactions.length !== 6)
			throw new Error("Railway hosting pact must declare six API operations");
		const declared = pact.interactions.map((entry) => {
			if (!isJsonObject(entry) || !isJsonObject(entry.request))
				throw new Error("malformed Railway pact request");
			return entry.request;
		});
		const api = world();
		const client = createRailwayDeploymentClient(options);
		await client.read(request(), api.transport);
		await client.deployOnce(request(), api.transport);
		await client.stop(request(), api.transport);
		for (const call of api.calls)
			expect(declared).toContainEqual({
				method: call.method,
				path: new URL(call.url).pathname,
				body: parseJsonObject(call.body ?? ""),
			});
		const emitted = new Set(
			api.calls.map((call) => JSON.stringify(parseJsonObject(call.body ?? ""))),
		);
		expect(emitted.size).toBe(6);
	});
	it("uses the project-token header at the pinned endpoint and observes scoped readiness", async () => {
		const api = world();
		const result = await createRailwayDeploymentClient(options).read(
			request(),
			api.transport,
		);
		expect(result.outputs).toMatchObject({
			projectId: options.projectId,
			environmentId: options.environmentId,
			serviceId: "service-one",
			deploymentId: "deployment-one",
			ready: true,
			operationConfirmed: true,
			retirementConfirmed: false,
		});
		expect(
			api.calls.every(
				(call) =>
					call.url === RAILWAY_GRAPHQL_ENDPOINT &&
					call.headers["project-access-token"] === TOKEN &&
					call.headers.authorization === undefined,
			),
		).toBe(true);
		expect(JSON.stringify(result)).not.toContain(TOKEN);
		expect(mutations(api.calls)).toHaveLength(0);
	});
	it.each([
		{ omitMetadata: true },
		{ metadata: null },
		{ metadata: {} },
		{ metadata: { commitHash: "main" } },
		{ metadata: { commitHash: "b".repeat(40) } },
	])("requires observed pinned commit evidence for readiness: %j", async (settings) => {
		const api = world(settings);
		const result = await createRailwayDeploymentClient(options).read(
			request(),
			api.transport,
		);
		expect(result.outputs).toMatchObject({
			ready: false,
			commitMatches: false,
			lifecycleStatus: "pending",
		});
		expect(result.outputs.servingEndpoint).toBeUndefined();
		expect(mutations(api.calls)).toHaveLength(0);
	});
	it("deploys one pinned commit once and does not equate acknowledgement with readiness", async () => {
		const api = world();
		const result = await createRailwayDeploymentClient(options).deployOnce(
			request(),
			api.transport,
		);
		expect(result.action).toBe("update");
		expect(result.outputs).toMatchObject({
			deploymentId: "deployment-new",
			ready: false,
			operationConfirmed: false,
		});
		expect(mutations(api.calls)).toHaveLength(1);
		expect(
			parseJsonObject(mutations(api.calls)[0]?.body ?? "").variables,
		).toEqual({
			serviceId: "service-one",
			environmentId: options.environmentId,
			commitSha: "a".repeat(40),
		});
	});
	it.each([
		"BUILDING",
		"DEPLOYING",
		"QUEUED",
		"WAITING",
		"SLEEPING",
		"INITIALIZING",
		"NEEDS_APPROVAL",
		"REMOVING",
	])("keeps %s deployments unready", async (status) => {
		const api = world({ status });
		expect(
			(
				await createRailwayDeploymentClient(options).read(
					request(),
					api.transport,
				)
			).outputs,
		).toMatchObject({
			ready: false,
			operationConfirmed: false,
			retirementConfirmed: false,
		});
	});
	it.each([
		"BUILDING",
		"QUEUED",
		"REMOVING",
		"INITIALIZING",
		"NEEDS_APPROVAL",
	])("does not turn zero currently running instances during %s into terminal absence", async (status) => {
		const api = world({ status, stopped: true });
		const result = await createRailwayDeploymentClient(options).read(
			request(),
			api.transport,
		);
		expect(result.outputs).toMatchObject({
			ready: false,
			retirementConfirmed: false,
			absenceConfirmed: false,
			operationTerminal: false,
		});
	});
	it("rejects a deployment response for another identity", async () => {
		const api = world({ otherDeployment: true });
		await expect(
			createRailwayDeploymentClient(options).read(request(), api.transport),
		).rejects.toThrow("foreign deployment");
	});
	it("keeps missing deployment history uncertain", async () => {
		const api = world({ missingDeployment: true });
		const result = await createRailwayDeploymentClient(options).read(
			request(),
			api.transport,
		);
		expect(result.outputs).toMatchObject({
			status: "UNKNOWN",
			ready: false,
			operationConfirmed: false,
			retirementConfirmed: false,
		});
	});
	it.each([
		"https://user:pass@app.up.railway.app/",
		"http://app.up.railway.app/",
		"https://app.up.railway.app/?token=sensitive",
	])("rejects unsafe endpoint evidence %s", async (endpoint) => {
		const api = world({ endpoint });
		await expect(
			createRailwayDeploymentClient(options).read(request(), api.transport),
		).rejects.toThrow("credential-free HTTPS");
	});
	it("refuses a successful deployment without an endpoint as routing readiness", async () => {
		const api = world({ endpoint: "" });
		expect(
			(
				await createRailwayDeploymentClient(options).read(
					request(),
					api.transport,
				)
			).outputs.ready,
		).toBe(false);
	});
	it.each([
		{ foreignScope: true },
		{ foreignService: true },
	])("refuses foreign scope before any mutation: %j", async (settings) => {
		const api = world(settings);
		await expect(
			createRailwayDeploymentClient(options).deployOnce(
				request(),
				api.transport,
			),
		).rejects.toThrow(/another|foreign/);
		expect(mutations(api.calls)).toHaveLength(0);
	});
	it("parses scope, identity, credential locators and pinned commits before network I/O", async () => {
		for (const raw of [
			request({ credentialRef: TOKEN }),
			request({ desired: { ...request().desired, serviceId: undefined } }),
			request({ desired: { ...request().desired, projectId: "foreign" } }),
			request({ desired: { ...request().desired, commitSha: "main" } }),
		]) {
			const api = world();
			await expect(
				createRailwayDeploymentClient(options).deployOnce(raw, api.transport),
			).rejects.toThrow();
			expect(api.calls).toHaveLength(0);
		}
	});
	it("never retries an ambiguous deployment mutation and never echoes provider secrets", async () => {
		const api = world();
		const transport: HttpTransport = async (call) => {
			if (
				parseJsonObject(call.body ?? "")
					.query?.toString()
					.startsWith("mutation")
			) {
				api.calls.push(call);
				throw new Error(`lost reply includes ${TOKEN}`);
			}
			return api.transport(call);
		};
		let message = "";
		try {
			await createRailwayDeploymentClient(options).deployOnce(
				request(),
				transport,
			);
		} catch (error) {
			message = String(error);
		}
		expect(message).toContain("uncertain");
		expect(message).not.toContain(TOKEN);
		expect(mutations(api.calls)).toHaveLength(1);
	});
	it.each([
		200, 429, 500, 302,
	])("does not accept partial GraphQL data or HTTP failure %i", async (status) => {
		const calls: TransportRequest[] = [];
		const transport: HttpTransport = async (call) => {
			calls.push(call);
			return {
				status,
				headers: { location: "https://evil.example/" },
				body: JSON.stringify({
					data: { serviceInstanceDeployV2: "deployment" },
					errors: [{ message: TOKEN }],
				}),
			};
		};
		await expect(
			createRailwayDeploymentClient(options).deployOnce(request(), transport),
		).rejects.toThrow();
		expect(calls).toHaveLength(1);
	});
	it("stops only the scoped deployment and verifies retirement independently", async () => {
		const api = world();
		const result = await createRailwayDeploymentClient(options).stop(
			request(),
			api.transport,
		);
		expect(result.outputs).toMatchObject({
			ready: false,
			retirementConfirmed: true,
		});
		expect(mutations(api.calls)).toHaveLength(1);
		expect(
			parseJsonObject(mutations(api.calls)[0]?.body ?? "").variables,
		).toEqual({ id: "deployment-one" });
		expect(JSON.stringify(api.calls)).not.toContain("serviceDelete");
	});
	it("does not mistake REMOVED history for stopped instances", async () => {
		const api = world({ status: "REMOVED", stopped: false });
		const result = await createRailwayDeploymentClient(options).read(
			request(),
			api.transport,
		);
		expect(result.outputs).toMatchObject({
			retirementConfirmed: false,
			absenceConfirmed: false,
			ready: false,
		});
	});
	it("does not route a successful historical deployment whose instances have stopped", async () => {
		const api = world({ status: "SUCCESS", stopped: true });
		const result = await createRailwayDeploymentClient(options).read(
			request(),
			api.transport,
		);
		expect(result.outputs).toMatchObject({
			retirementConfirmed: true,
			absenceConfirmed: true,
			operationTerminal: true,
			ready: false,
		});
	});
	it("keeps retirement pending after a stop ACK and converges after observed removal", async () => {
		const api = world({ stopConfirmed: false });
		const resolver = railwayResolverRegistry(options).get(
			RAILWAY_SERVICE_PRODUCT_ID,
		);
		if (!resolver) throw new Error("Railway resolver was not registered");
		await expect(resolver.delete(request(), api.transport)).rejects.toThrow(
			"retirement is pending",
		);
		expect(mutations(api.calls)).toHaveLength(1);
		api.status("REMOVED");
		await resolver.delete(request(), api.transport);
		expect(mutations(api.calls)).toHaveLength(1);
	});
	it("does not stop an unobserved deployment", async () => {
		const api = world({ missingDeployment: true });
		await expect(
			createRailwayDeploymentClient(options).stop(request(), api.transport),
		).rejects.toThrow("unobserved deployment");
		expect(mutations(api.calls)).toHaveLength(0);
	});
});

import { readFileSync } from "node:fs";
