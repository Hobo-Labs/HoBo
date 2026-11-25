/**
 * Consumer-driven contract verification for the Kubernetes apiserver boundary.
 *
 * `contracts/provider-kubernetes-apiserver.pact.json` states what this package
 * expects of an apiserver. A pact file nobody replays is a wish, so this suite
 * loads it and drives the real client against each interaction: the request
 * the client emits must match the one the pact describes, and the client must
 * behave as documented when handed the pact's recorded response.
 *
 * Only the consumer half is verifiable here. Nobody can verify a cluster's
 * half offline, and the default test lane starts no cluster. What the pact
 * does is pin what this client sends and record — with a
 * `metadata.source.checkedAt` date — what a human last observed core/v1 and
 * apps/v1 sending back.
 *
 * The fake sits at the HTTP seam and nowhere else: every parser, every
 * manifest renderer, the guarded transport and the driver are the real ones.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	cleanupWorkload,
	createKubernetesApiClient,
	isKubernetesProviderError,
	observeRollout,
	type ProvisionReceipt,
	parseWorkloadPlacement,
	provisionWorkload,
	type WorkloadPlacement,
} from "../src/index.js";
import { isJsonObject } from "../src/json.js";
import type {
	KubernetesTransport,
	TransportRequest,
} from "../src/transport.js";

const API_SERVER_URL = "https://cluster.example.test:6443";

type PactHeaders = Readonly<Record<string, string>>;

type PactInteraction = {
	readonly description: string;
	readonly request: {
		readonly method: string;
		readonly path: string;
		readonly headers?: PactHeaders;
		readonly body?: unknown;
	};
	readonly response: {
		readonly status: number;
		readonly headers?: PactHeaders;
		readonly body?: unknown;
	};
};

type PactFile = {
	readonly consumer: { readonly name: string };
	readonly provider: { readonly name: string };
	readonly metadata: {
		readonly source: {
			readonly url: string;
			readonly apiVersions: readonly string[];
			readonly checkedAt: string;
		};
	};
	readonly interactions: readonly PactInteraction[];
};

/**
 * Parse the pact rather than trusting its shape. The file is checked-in JSON,
 * so this is a legibility boundary, not a security one: a suite that fails
 * with "cannot read property of undefined" three assertions later is worse
 * than one that says the pact is malformed.
 */
function loadPact(): PactFile {
	const raw = readFileSync(
		fileURLToPath(
			new URL(
				"../contracts/provider-kubernetes-apiserver.pact.json",
				import.meta.url,
			),
		),
		"utf8",
	);
	const decoded: unknown = JSON.parse(raw);
	if (!isJsonObject(decoded) || decoded === null) {
		throw new Error("the pact file is not a JSON object");
	}
	// SAFETY: assertion to `ded as Partial<PactFile>; i` is required at this boundary.
	const candidate = decoded as Partial<PactFile>;
	if (
		!Array.isArray(candidate.interactions) ||
		candidate.interactions.length === 0
	) {
		throw new Error("the pact file declares no interactions");
	}
	if (
		candidate.consumer?.name === undefined ||
		candidate.provider?.name === undefined
	) {
		throw new Error("the pact file is missing its consumer or provider name");
	}
	if (candidate.metadata?.source?.checkedAt === undefined) {
		throw new Error(
			"the pact file does not record when its source was checked",
		);
	}
	// SAFETY: assertion to `idate as PactFile; } ` is required at this boundary.
	return candidate as PactFile;
}

const pact = loadPact();

function interaction(fragment: string): PactInteraction {
	const found = pact.interactions.find((entry) =>
		entry.description.includes(fragment),
	);
	if (found === undefined) {
		throw new Error(
			`the pact has no interaction matching ${JSON.stringify(fragment)}`,
		);
	}
	return found;
}

type RecordingTransport = KubernetesTransport & {
	readonly requests: readonly TransportRequest[];
};

/** Answer with the recorded responses, in order, and remember every request. */
function transportReplaying(
	...interactions: readonly PactInteraction[]
): RecordingTransport {
	const requests: TransportRequest[] = [];
	let index = 0;
	return {
		requests,
		async request(request) {
			requests.push(request);
			const next = interactions[index];
			index += 1;
			if (next === undefined) {
				throw new Error(
					`the client made ${requests.length} calls; the pact replay supplied ${interactions.length}`,
				);
			}
			return {
				status: next.response.status,
				headers: Object.fromEntries(
					Object.entries(next.response.headers ?? {}).map(([key, value]) => [
						key.toLowerCase(),
						value,
					]),
				),
				body:
					next.response.body === undefined
						? ""
						: JSON.stringify(next.response.body),
			};
		},
	};
}

function clientOver(transport: KubernetesTransport) {
	return createKubernetesApiClient({ transport, apiServerUrl: API_SERVER_URL });
}

function headerOf(request: TransportRequest, name: string): string | undefined {
	return Object.entries(request.headers).find(
		([key]) => key.toLowerCase() === name.toLowerCase(),
	)?.[1];
}

function pathOf(request: TransportRequest): string {
	return new URL(request.url).pathname;
}

/**
 * The placement the whole pact is written against. It goes through the real
 * parser, so a change that makes this input unacceptable fails here first.
 */
const placement: WorkloadPlacement = parseWorkloadPlacement({
	name: "try-site",
	namespace: "hobo-try-site",
	image:
		"ghcr.io/hobo/try-site@sha256:221b467378d5ca6ae498f03408d3b19d3b762bb8b078a99a014b61c33d1f1240",
	replicas: 2,
	port: 8080,
	requests: { cpu: "250m", memory: "128Mi" },
	limits: { cpu: "500m", memory: "256Mi" },
});

function assertMatchesPactRequest(
	request: TransportRequest,
	expected: PactInteraction,
): void {
	expect(request.method).toBe(expected.request.method);
	expect(pathOf(request)).toBe(expected.request.path);
	for (const [name, value] of Object.entries(expected.request.headers ?? {})) {
		expect(headerOf(request, name)).toBe(value);
	}
	if (expected.request.body !== undefined) {
		expect(JSON.parse(request.body ?? "null")).toEqual(expected.request.body);
	}
}

describe("the pact file itself", () => {
	it("names this package as the consumer and dates its source", () => {
		expect(pact.consumer.name).toBe("@hobo/provider-kubernetes");
		expect(pact.provider.name).toBe("KubernetesApiServer");
		expect(pact.metadata.source.apiVersions).toEqual(["v1", "apps/v1"]);
		expect(pact.metadata.source.checkedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/u);
	});

	it("carries no credential-shaped string in any recorded body", () => {
		// An apiserver body near a failure path routinely quotes the object that
		// caused it, and those objects carry tokens. Nothing like one belongs in
		// a checked-in fixture.
		const serialized = JSON.stringify(pact.interactions);
		expect(serialized).not.toMatch(/Bearer\s+\S/u);
		expect(serialized).not.toMatch(/eyJ[A-Za-z0-9_-]{8,}\./u);
		expect(serialized).not.toMatch(/BEGIN [A-Z ]*PRIVATE KEY/u);
	});

	it("only describes the two API roots the transport policy allows", () => {
		for (const entry of pact.interactions) {
			expect(entry.request.path).toMatch(/^\/(api\/v1|apis\/apps\/v1)\//u);
		}
	});
});

describe("namespace creation, verified against the pact", () => {
	const create = interaction("create the placement namespace");

	it("sends exactly the namespace manifest the pact declares", async () => {
		const transport = transportReplaying(create);

		await clientOver(transport).createOrAdoptNamespace(placement);

		// SAFETY: assertion to `sport.requests[0] as TransportRequest, cr` is required at this boundary.
		assertMatchesPactRequest(transport.requests[0] as TransportRequest, create);
	});

	it("parses the recorded 201 into an owned, Active namespace", async () => {
		const transport = transportReplaying(create);

		const namespace =
			await clientOver(transport).createOrAdoptNamespace(placement);

		expect(namespace.name).toBe("hobo-try-site");
		expect(namespace.phase).toBe("Active");
		expect(namespace.createdByHobo).toBe(true);
		expect(namespace.resourceVersion).toBe("148213");
	});
});

describe("adoption, verified against the pact", () => {
	const conflict = interaction("report AlreadyExists");
	const read = interaction("so a second deploy adopts it");

	it("re-reads the namespace after AlreadyExists instead of failing", async () => {
		const transport = transportReplaying(conflict, read);

		const namespace =
			await clientOver(transport).createOrAdoptNamespace(placement);

		expect(transport.requests).toHaveLength(2);
		// SAFETY: assertion to `sport.requests[1] as TransportRequest, re` is required at this boundary.
		assertMatchesPactRequest(transport.requests[1] as TransportRequest, read);
		expect(namespace.name).toBe("hobo-try-site");
	});

	it("marks an adopted namespace as not created here, which is what stops cleanup deleting it", async () => {
		const transport = transportReplaying(conflict, read);

		const namespace =
			await clientOver(transport).createOrAdoptNamespace(placement);

		expect(namespace.createdByHobo).toBe(false);
	});
});

describe("deployment creation, verified against the pact", () => {
	const create = interaction("create the workload deployment");

	it("sends exactly the Deployment manifest the pact declares", async () => {
		const transport = transportReplaying(create);

		await clientOver(transport).createDeployment(placement);

		// SAFETY: assertion to `sport.requests[0] as TransportRequest, cr` is required at this boundary.
		assertMatchesPactRequest(transport.requests[0] as TransportRequest, create);
	});

	it("pins the surge the CUE replica bounds depend on", () => {
		const spec =
			// SAFETY: assertion to `te.request.body as { spec: { strategy: { rollingUpdate: { maxSurge: number } } }; } )` is required at this boundary.
			(
				create.request.body as {
					spec: { strategy: { rollingUpdate: { maxSurge: number } } };
				}
			).spec;
		expect(spec.strategy.rollingUpdate.maxSurge).toBe(1);
	});

	it("reads a fresh Deployment with an empty status as pending, not as failed", async () => {
		const transport = transportReplaying(create);

		const deployment = await clientOver(transport).createDeployment(placement);

		expect(deployment.generation).toBe(1);
		expect(deployment.observedGeneration).toBe(0);
		expect(deployment.phase).toBe("pending");
	});
});

describe("service creation, verified against the pact", () => {
	const create = interaction("create the ClusterIP service");

	it("sends exactly the Service manifest the pact declares", async () => {
		const transport = transportReplaying(create);

		await clientOver(transport).createService(placement);

		// SAFETY: assertion to `sport.requests[0] as TransportRequest, cr` is required at this boundary.
		assertMatchesPactRequest(transport.requests[0] as TransportRequest, create);
	});

	it("derives the in-cluster DNS name from the recorded object", async () => {
		const transport = transportReplaying(create);

		const service = await clientOver(transport).createService(placement);

		expect(service.clusterDnsName).toBe(
			"try-site.hobo-try-site.svc.cluster.local",
		);
		expect(service.clusterIp).toBe("10.96.42.17");
		expect(service.targetPort).toBe(8080);
	});
});

describe("rollout observation, verified against the pact", () => {
	it("calls a half-converged rollout progressing", async () => {
		const status = interaction("has seen but not finished");
		const transport = transportReplaying(status);

		const record = await clientOver(transport).readDeploymentStatus(placement);

		// SAFETY: assertion to `sport.requests[0] as TransportRequest, st` is required at this boundary.
		assertMatchesPactRequest(transport.requests[0] as TransportRequest, status);
		expect(record.phase).toBe("progressing");
		expect(record.readyReplicas).toBe(1);
	});

	it("calls a finished rollout available", async () => {
		const status = interaction("calls complete");
		const transport = transportReplaying(status);

		const record = await observeRollout({
			client: clientOver(transport),
			placement,
		});

		expect(record.phase).toBe("available");
		expect(record.availableReplicas).toBe(2);
		expect(record.failureReason).toBe("");
	});

	it("calls a deadline-exceeded rollout failed even though its replicas look healthy", async () => {
		// This is the interaction that justifies deriving a phase at all: two
		// replicas are available and the controller has observed the current
		// generation, so every counter says "fine" while the rollout is dead.
		const status = interaction("ran out of progress deadline");
		const transport = transportReplaying(status);

		const record = await clientOver(transport).readDeploymentStatus(placement);

		expect(record.availableReplicas).toBe(record.desiredReplicas);
		expect(record.observedGeneration).toBe(record.generation);
		expect(record.phase).toBe("failed");
		expect(record.failureReason).toBe("ProgressDeadlineExceeded");
	});

	it("turns that failure into ROLLOUT_FAILED rather than a receipt", async () => {
		const transport = transportReplaying(
			interaction("ran out of progress deadline"),
		);

		await expect(
			observeRollout({ client: clientOver(transport), placement }),
		).rejects.toSatisfy(
			(error: Error) =>
				isKubernetesProviderError(error) &&
				error.code === "ROLLOUT_FAILED" &&
				error.detail.reason === "ProgressDeadlineExceeded",
		);
	});
});

describe("authorization failure, verified against the pact", () => {
	it("maps the pact's 403 Status onto PROVIDER_AUTH_FAILED with its reason", async () => {
		const forbidden = interaction("not authorized for");
		const transport = transportReplaying(forbidden);

		await expect(
			clientOver(transport).createDeployment(placement),
		).rejects.toSatisfy(
			(error: Error) =>
				isKubernetesProviderError(error) &&
				error.code === "PROVIDER_AUTH_FAILED" &&
				error.detail.reason === "Forbidden" &&
				!error.retryable,
		);
	});
});

describe("provisioning end to end, replayed from the pact", () => {
	it("creates namespace, then deployment, then service, and reports an in-cluster endpoint", async () => {
		const transport = transportReplaying(
			interaction("create the placement namespace"),
			interaction("create the workload deployment"),
			interaction("create the ClusterIP service"),
		);

		const receipt = await provisionWorkload({
			client: clientOver(transport),
			placement,
		});

		expect(transport.requests.map(pathOf)).toEqual([
			"/api/v1/namespaces",
			"/apis/apps/v1/namespaces/hobo-try-site/deployments",
			"/api/v1/namespaces/hobo-try-site/services",
		]);
		expect(receipt.schemaVersion).toBe("hobo.provider-kubernetes.receipt/v1");
		expect(receipt.adopted).toBe(false);
		expect(receipt.endpointUrl).toBe(
			"http://try-site.hobo-try-site.svc.cluster.local:80",
		);
	});
});

describe("cleanup, verified against the pact", () => {
	async function receiptFrom(
		transport: RecordingTransport,
	): Promise<ProvisionReceipt> {
		return provisionWorkload({ client: clientOver(transport), placement });
	}

	it("reports deleting, not deleted, when the apiserver answers Terminating", async () => {
		const owned = await receiptFrom(
			transportReplaying(
				interaction("create the placement namespace"),
				interaction("create the workload deployment"),
				interaction("create the ClusterIP service"),
			),
		);
		const deleteInteraction = interaction("accept a namespace delete");
		const transport = transportReplaying(deleteInteraction);

		const outcome = await cleanupWorkload({
			client: clientOver(transport),
			receipt: owned,
			now: () => Date.UTC(2026, 7, 8, 12, 30),
		});

		assertMatchesPactRequest(
			// SAFETY: assertion to `sport.requests[0] as TransportRequest, ` is required at this boundary.
			transport.requests[0] as TransportRequest,
			deleteInteraction,
		);
		expect(outcome.state).toBe("deleting");
		expect(outcome.retainedReason).toBe("");
	});

	it("reports deleted only after observing the NotFound the pact records", async () => {
		const owned = await receiptFrom(
			transportReplaying(
				interaction("create the placement namespace"),
				interaction("create the workload deployment"),
				interaction("create the ClusterIP service"),
			),
		);
		const transport = transportReplaying(
			interaction("accept a namespace delete"),
			interaction("once the namespace finalizers have run"),
		);

		const outcome = await cleanupWorkload({
			client: clientOver(transport),
			receipt: owned,
			now: () => Date.UTC(2026, 7, 8, 12, 35),
			confirm: true,
		});

		expect(outcome.state).toBe("deleted");
	});

	it("never sends a DELETE for a namespace it adopted", async () => {
		const adopted = await receiptFrom(
			transportReplaying(
				interaction("report AlreadyExists"),
				interaction("so a second deploy adopts it"),
				interaction("create the workload deployment"),
				interaction("create the ClusterIP service"),
			),
		);
		const transport = transportReplaying();

		const outcome = await cleanupWorkload({
			client: clientOver(transport),
			receipt: adopted,
			now: () => Date.UTC(2026, 7, 8, 12, 40),
		});

		expect(adopted.adopted).toBe(true);
		expect(transport.requests).toHaveLength(0);
		expect(outcome.state).toBe("retained");
		expect(outcome.retainedReason).toBe("adopted-namespace");
	});
});
