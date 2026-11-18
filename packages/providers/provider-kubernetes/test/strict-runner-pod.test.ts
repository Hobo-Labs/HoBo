import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	createFetchTransport,
	createStrictRunnerPodClient,
	DEFAULT_TRANSPORT_POLICY,
	type StrictRunnerPodBinding,
	strictRunnerPodName,
} from "../src/index.js";
import {
	isJsonObject,
	isJsonString,
	type JsonObject,
	type JsonValue,
} from "../src/json.js";

type MutableObject = { [key: string]: JsonValue };
type Client = ReturnType<typeof createStrictRunnerPodClient>;

const image = `example.test/runner@sha256:${"a".repeat(64)}`;
const binding: StrictRunnerPodBinding = {
	connectionId: "connection-1",
	namespace: "runners",
	slotId: "slot-1",
	accountId: "account-1",
	profileId: "profile-1",
	ownerName: "runner-owner",
	ownerUid: "12345678-1234-4234-8234-123456789abc",
	serviceAccount: "runner",
	runnerImage: image,
	hookImage: image,
	startFenceUrl: "https://controller.example/v1/fleet/start-fence",
	cpu: "100m",
	memory: "128Mi",
};

function record(value: JsonValue | undefined): MutableObject {
	if (!isJsonObject(value)) throw new Error("expected object");
	return value as MutableObject;
}

function array(value: JsonValue | undefined): JsonValue[] {
	if (!Array.isArray(value)) throw new Error("expected array");
	return value;
}

function serverDefaults(pod: MutableObject): void {
	const spec = record(pod.spec);
	spec.tolerations = [
		...array(spec.tolerations ?? []),
		{
			key: "node.kubernetes.io/not-ready",
			operator: "Exists",
			effect: "NoExecute",
			tolerationSeconds: 300,
		},
		{
			key: "node.kubernetes.io/unreachable",
			operator: "Exists",
			effect: "NoExecute",
			tolerationSeconds: 300,
		},
	];
	spec.dnsPolicy = "ClusterFirst";
	spec.schedulerName = "default-scheduler";
	spec.serviceAccount = "runner";
	for (const value of [
		...array(spec.containers),
		...array(spec.initContainers),
	]) {
		const container = record(value);
		container.resources ??= {};
		container.terminationMessagePath = "/dev/termination-log";
		container.terminationMessagePolicy = "File";
	}
}

describe("strict runner Pod client", () => {
	let server: Server;
	let client: Client;
	let stored: MutableObject | undefined;
	let postMode: "normal" | "reset" | "invalid" | "server-error" = "normal";
	let replaceBeforeDelete = false;
	let lastDelete: JsonObject | undefined;
	let requests: string[];

	beforeEach(async () => {
		stored = undefined;
		requests = [];
		postMode = "normal";
		replaceBeforeDelete = false;
		lastDelete = undefined;
		server = createServer(async (request, response) => {
			const chunks: Buffer[] = [];
			for await (const chunk of request) chunks.push(Buffer.from(chunk));
			const body = Buffer.concat(chunks).toString("utf8");
			requests.push(`${request.method} ${request.url}`);
			response.setHeader("content-type", "application/json");
			if (request.method === "POST") {
				if (stored) {
					response.writeHead(409).end(
						JSON.stringify({
							kind: "Status",
							status: "Failure",
							reason: "AlreadyExists",
							message: "exists",
							code: 409,
						}),
					);
					return;
				}
				if (postMode === "server-error") {
					response.writeHead(503).end("{}");
					return;
				}
				stored = JSON.parse(body) as MutableObject;
				const metadata = record(stored.metadata);
				metadata.uid = randomUUID();
				metadata.resourceVersion = "1";
				stored.status = { phase: "Pending" };
				serverDefaults(stored);
				if (postMode === "reset") {
					response.destroy();
					return;
				}
				response
					.writeHead(201)
					.end(postMode === "invalid" ? "{}" : JSON.stringify(stored));
				return;
			}
			if (request.method === "GET") {
				response
					.writeHead(stored ? 200 : 404)
					.end(JSON.stringify(stored ?? {}));
				return;
			}
			if (request.method === "DELETE") {
				lastDelete = JSON.parse(body) as JsonObject;
				if (replaceBeforeDelete && stored)
					record(stored.metadata).uid = randomUUID();
				if (!stored) {
					response.writeHead(404).end("{}");
					return;
				}
				if (
					record(lastDelete.preconditions).uid !== record(stored.metadata).uid
				) {
					response.writeHead(409).end(
						JSON.stringify({
							kind: "Status",
							status: "Failure",
							reason: "Conflict",
							message: "uid mismatch",
							code: 409,
						}),
					);
					return;
				}
				stored = undefined;
				response.writeHead(200).end("{}");
				return;
			}
			response.writeHead(405).end("{}");
		});
		await new Promise<void>((resolve) =>
			server.listen(0, "127.0.0.1", resolve),
		);
		const address = server.address();
		if (!address || isJsonString(address))
			throw new Error("server address unavailable");
		client = createStrictRunnerPodClient({
			apiServerUrl: `http://127.0.0.1:${address.port}`,
			transport: createFetchTransport({ fetchImpl: fetch }),
			policy: { ...DEFAULT_TRANSPORT_POLICY, allowInsecureLoopback: true },
		});
	});

	afterEach(async () => {
		server.closeAllConnections();
		await new Promise<void>((resolve, reject) =>
			server.close((error) => (error ? reject(error) : resolve())),
		);
	});

	it("creates and adopts only the recorded Pod, then deletes by UID", async () => {
		const created = await client.create(binding);
		expect(created).toMatchObject({
			name: strictRunnerPodName(binding.slotId),
			phase: "pending",
			created: true,
		});
		const pod = record(stored);
		const spec = record(pod.spec);
		const runner = record(array(spec.containers)[0]);
		expect(spec.securityContext).toMatchObject({
			runAsNonRoot: true,
			runAsUser: 1000,
			runAsGroup: 1000,
			fsGroup: 1000,
		});
		expect(array(spec.initContainers).map(record)).toEqual([
			expect.objectContaining({ name: "install-hook" }),
			expect.objectContaining({ name: "prepare-runner", image }),
		]);
		expect(runner).toMatchObject({
			command: ["/opt/actions-runner/run.sh"],
			workingDir: "/opt/actions-runner",
			args: [],
			volumeMounts: expect.arrayContaining([
				{ name: "hook", mountPath: "/opt/hobo/hooks", readOnly: true },
				{ name: "runner-home", mountPath: "/opt/actions-runner" },
				{ name: "work", mountPath: "/opt/actions-runner/_work" },
				{ name: "tmp", mountPath: "/tmp" },
			]),
		});
		const env = array(runner.env).map(record);
		expect(env).toContainEqual({ name: "HOME", value: "/tmp" });
		expect(env).toContainEqual(
			expect.objectContaining({ name: "ACTIONS_RUNNER_INPUT_JITCONFIG" }),
		);
		const references = env
			.filter((item) => item.valueFrom)
			.map((item) => record(record(item.valueFrom).secretKeyRef));
		expect(references.map((item) => item.name)).toEqual(
			Array(2).fill(created.name),
		);
		expect(JSON.stringify(pod)).not.toContain("secret-value");
		expect(await client.create(binding, created.uid)).toMatchObject({
			uid: created.uid,
			created: false,
		});
		await expect(client.create(binding)).rejects.toMatchObject({
			code: "PROVISIONING_CONFLICT",
		});
		await expect(client.create(binding, randomUUID())).rejects.toMatchObject({
			code: "PROVISIONING_CONFLICT",
		});
		expect(await client.remove(binding, created.uid)).toBe(true);
		expect(lastDelete).toMatchObject({ preconditions: { uid: created.uid } });
		expect(await client.observe(binding, created.uid)).toBeUndefined();
		await expect(client.create(binding, created.uid)).rejects.toMatchObject({
			code: "PROVIDER_OPERATION_AMBIGUOUS",
		});
		expect(
			requests.filter((request) => request.startsWith("POST")),
		).toHaveLength(2);
	});

	it.each([
		[
			"owner",
			(pod: MutableObject) => {
				record(array(record(pod.metadata).ownerReferences)[0]).uid =
					randomUUID();
			},
		],
		[
			"slot",
			(pod: MutableObject) => {
				record(record(pod.metadata).annotations)["hobo.dev/slot-id"] = "other";
			},
		],
		[
			"termination",
			(pod: MutableObject) => {
				record(pod.metadata).deletionTimestamp = "2026-01-01T00:00:00Z";
			},
		],
		[
			"finalizer",
			(pod: MutableObject) => {
				record(pod.metadata).finalizers = ["other.test/finalizer"];
			},
		],
		[
			"service account token",
			(pod: MutableObject) => {
				record(pod.spec).automountServiceAccountToken = true;
			},
		],
		[
			"host networking",
			(pod: MutableObject) => {
				record(pod.spec).hostNetwork = true;
			},
		],
		[
			"priority",
			(pod: MutableObject) => {
				record(pod.spec).priority = 1000000;
			},
		],
		[
			"host aliases",
			(pod: MutableObject) => {
				record(pod.spec).hostAliases = [
					{ ip: "127.0.0.1", hostnames: ["controller.example"] },
				];
			},
		],
		[
			"wildcard toleration",
			(pod: MutableObject) => {
				array(record(pod.spec).tolerations).push({ operator: "Exists" });
			},
		],
		[
			"sidecar",
			(pod: MutableObject) => {
				array(record(pod.spec).containers).push({ name: "foreign" });
			},
		],
		[
			"ephemeral container",
			(pod: MutableObject) => {
				record(pod.spec).ephemeralContainers = [{ name: "foreign" }];
			},
		],
		[
			"extra capability",
			(pod: MutableObject) => {
				record(
					record(record(array(record(pod.spec).containers)[0]).securityContext)
						.capabilities,
				).add = ["SYS_ADMIN"];
			},
		],
		[
			"mount propagation",
			(pod: MutableObject) => {
				record(
					array(record(array(record(pod.spec).containers)[0]).volumeMounts)[0],
				).mountPropagation = "Bidirectional";
			},
		],
		[
			"work mount mode",
			(pod: MutableObject) => {
				record(
					array(record(array(record(pod.spec).containers)[0]).volumeMounts)[1],
				).readOnly = true;
			},
		],
		[
			"extra resource",
			(pod: MutableObject) => {
				record(
					record(record(array(record(pod.spec).containers)[0]).resources)
						.limits,
				)["example.test/device"] = "1";
			},
		],
		[
			"extra volume source",
			(pod: MutableObject) => {
				record(array(record(pod.spec).volumes)[0]).hostPath = { path: "/" };
			},
		],
		[
			"secret reference",
			(pod: MutableObject) => {
				const env = array(record(array(record(pod.spec).containers)[0]).env)
					.map(record)
					.find((entry) => entry.name === "HOBO_BINDING_SECRET");
				record(record(record(env).valueFrom).secretKeyRef).name =
					"other-secret";
			},
		],
	])("rejects a Pod with changed %s", async (_name, mutate) => {
		const created = await client.create(binding);
		mutate(record(stored));
		await expect(client.observe(binding, created.uid)).rejects.toMatchObject({
			code: "PROVISIONING_CONFLICT",
		});
	});

	it.each([
		"reset",
		"invalid",
		"server-error",
	] as const)("treats %s after a create as ambiguous", async (mode) => {
		postMode = mode;
		await expect(client.create(binding)).rejects.toMatchObject({
			code: "PROVIDER_OPERATION_AMBIGUOUS",
			retryable: false,
		});
		if (stored)
			await expect(client.create(binding)).rejects.toMatchObject({
				code: "PROVISIONING_CONFLICT",
			});
	});

	it("does not delete a replacement Pod after a UID race", async () => {
		const created = await client.create(binding);
		replaceBeforeDelete = true;
		await expect(client.remove(binding, created.uid)).rejects.toMatchObject({
			code: "PROVISIONING_CONFLICT",
		});
		expect(stored).toBeDefined();
		expect(lastDelete).toMatchObject({ preconditions: { uid: created.uid } });
	});

	it("accepts pinned tolerations alongside Kubernetes defaults and rejects extra defaults", async () => {
		const placement = {
			...binding,
			tolerations: [
				{
					key: "fleet.example/runner",
					operator: "Equal",
					value: "yes",
					effect: "NoSchedule",
				},
			],
		} as const;
		const created = await client.create(placement);
		expect((await client.observe(placement, created.uid))?.uid).toBe(
			created.uid,
		);
		array(record(record(stored).spec).tolerations).push({
			key: "node.kubernetes.io/not-ready",
			operator: "Exists",
			effect: "NoExecute",
			tolerationSeconds: 300,
		});
		await expect(client.observe(placement, created.uid)).rejects.toMatchObject({
			code: "PROVISIONING_CONFLICT",
		});
	});

	it("rejects unpinned images and invalid placement before contacting the cluster", async () => {
		await expect(
			client.create({ ...binding, runnerImage: "example.test/runner:latest" }),
		).rejects.toMatchObject({ code: "PLACEMENT_REJECTED" });
		await expect(
			client.create({
				...binding,
				startFenceUrl: "http://controller.example/v1/fleet/start-fence",
			}),
		).rejects.toMatchObject({ code: "PLACEMENT_REJECTED" });
		await expect(
			client.create({
				...binding,
				tolerations: [
					{
						key: "node.kubernetes.io/not-ready",
						operator: "Exists",
						effect: "NoExecute",
					},
				],
			}),
		).rejects.toMatchObject({ code: "PLACEMENT_REJECTED" });
		expect(requests).toHaveLength(0);
	});
});
