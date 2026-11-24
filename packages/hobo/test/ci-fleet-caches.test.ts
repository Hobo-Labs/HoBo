import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
	AutoscalingRunnerSetSchema,
	withRunnerCaches,
} from "@hobo/ci-gh-actions/arc-runner-caches";
import { createHoboCli } from "@hobo/cli";
import type { HttpTransport, TransportResponse } from "@hobo/core";
import type { OwnerStore } from "@hobo/hobo-ci";
import { createMemorySecretsPort } from "@hobo/identity";
import type { KubernetesTlsMaterial } from "@hobo/provider-kubernetes";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { createCiCommand } from "../src/ci-command.js";
import {
	createOwnerStoreSessions,
	type OwnerStoreSessions,
} from "../src/owner-store-session.js";

const REPOSITORY_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const CWD = "/synthetic/fleet-caches-project";
const PRIVATE_PROJECT = "synthetic-private-caches-project";
const TOKEN = "synthetic-arc-kubeconfig-token-0123456789abcdef";
const CA =
	"-----BEGIN CERTIFICATE-----\nsynthetic-arc-ca\n-----END CERTIFICATE-----\n";
const SHA = "4da35cfd92854b07ea368680fcc19a621faa928f";
const ENTRY = "HOSTINGER_ARC_KUBECONFIG";
const KUBECONFIG = [
	"apiVersion: v1",
	"kind: Config",
	"current-context: hostinger-arc",
	"contexts:",
	"- name: hostinger-arc",
	"  context: {cluster: hostinger-arc, user: hobo-fleet}",
	"clusters:",
	"- name: hostinger-arc",
	"  cluster:",
	"    server: https://arc.cluster.example.test:6443",
	`    certificate-authority-data: ${Buffer.from(CA).toString("base64")}`,
	"users:",
	"- name: hobo-fleet",
	`  user: {token: ${TOKEN}}`,
].join("\n");

const InteractionSchema = z.object({
	description: z.string(),
	request: z.object({
		method: z.string(),
		path: z.string(),
		body: z.json().optional(),
	}),
	response: z.object({ status: z.number(), body: z.json().optional() }),
});

const pact = z
	.object({ interactions: z.array(InteractionSchema) })
	.parse(
		JSON.parse(
			readFileSync(
				fileURLToPath(
					new URL(
						"../../providers/provider-kubernetes/contracts/provider-kubernetes-arc-runner-sets.pact.json",
						import.meta.url,
					),
				),
				"utf8",
			),
		),
	);

function pactInteraction(fragment: string) {
	const found = pact.interactions.find((entry) =>
		entry.description.includes(fragment),
	);
	if (found === undefined) throw new Error(`no pact interaction ${fragment}`);
	return found;
}

const RunnerSetListSchema = z.object({
	items: z.array(z.record(z.string(), z.json())),
});

type Call = Readonly<{
	method: string;
	path: string;
	query: string;
	body: string | undefined;
	authorization: string | undefined;
}>;

function reply(status: number, body: z.infer<ReturnType<typeof z.json>>) {
	const response: TransportResponse = {
		status,
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	};
	return response;
}

function apiserver(override?: (call: Call) => TransportResponse | undefined) {
	const listed = RunnerSetListSchema.parse(
		pactInteraction("list the runner scale sets").response.body,
	).items;
	const sets = new Map(
		listed.map((item) => {
			const parsed = AutoscalingRunnerSetSchema.parse(item);
			return [parsed.metadata.name, item];
		}),
	);
	const jobs = new Map<string, z.infer<ReturnType<typeof z.json>>>();
	const calls: Call[] = [];
	const tls: KubernetesTlsMaterial[] = [];
	const transport: HttpTransport = async (request) => {
		const url = new URL(request.url);
		const call: Call = {
			method: request.method,
			path: url.pathname,
			query: url.search,
			body: request.body,
			authorization: request.headers.Authorization,
		};
		calls.push(call);
		const overridden = override?.(call);
		if (overridden !== undefined) return overridden;
		const sets_ =
			"/apis/actions.github.com/v1alpha1/namespaces/arc-runners/autoscalingrunnersets";
		const jobsPath = "/apis/batch/v1/namespaces/arc-runners/jobs";
		if (request.method === "GET" && url.pathname === sets_)
			return reply(200, { items: [...sets.values()] });
		const name = url.pathname.slice(sets_.length + 1);
		if (url.pathname.startsWith(`${sets_}/`)) {
			const current = sets.get(name);
			if (current === undefined)
				return reply(404, { kind: "Status", reason: "NotFound", code: 404 });
			if (request.method === "GET") return reply(200, current);
			const patched = JSON.parse(
				JSON.stringify(
					withRunnerCaches(AutoscalingRunnerSetSchema.parse(current)),
				),
			);
			sets.set(name, patched);
			return reply(200, patched);
		}
		if (url.pathname === jobsPath && request.method === "POST") {
			const job = z
				.object({ metadata: z.object({ name: z.string() }) })
				.loose()
				.parse(JSON.parse(request.body ?? "{}"));
			if (jobs.has(job.metadata.name))
				return reply(409, {
					kind: "Status",
					reason: "AlreadyExists",
					code: 409,
				});
			jobs.set(job.metadata.name, {
				...JSON.parse(request.body ?? "{}"),
				status: {
					succeeded: 1,
					conditions: [{ type: "Complete", status: "True" }],
				},
			});
			return reply(201, JSON.parse(request.body ?? "{}"));
		}
		if (url.pathname === jobsPath && request.method === "GET")
			return reply(200, { items: [...jobs.values()] });
		return reply(500, { message: "unexpected" });
	};
	return {
		calls,
		tls,
		factory: (material: KubernetesTlsMaterial) => {
			tls.push(material);
			return transport;
		},
	};
}

async function session(
	entries: Readonly<Record<string, string>>,
): Promise<OwnerStoreSessions> {
	const port = createMemorySecretsPort({ id: `store:${PRIVATE_PROJECT}` });
	for (const [name, value] of Object.entries(entries))
		await port.put(name, value);
	const owner: OwnerStore = {
		id: "infisical",
		chosen: true,
		missing: [],
		canAwaitEgressCredential: false,
		egressCredentialHost: undefined,
		opened: {
			id: "infisical",
			port,
			reference: (name) => `infisical://${PRIVATE_PROJECT}/prod/${name}`,
		},
		infisicalFolder: undefined,
		unopened: undefined,
		stage: async () => {
			throw new Error("the fleet never stages a page");
		},
	};
	const sessions = createOwnerStoreSessions({
		signIn: async () => ({ kind: "owner", owner }),
		env: {},
	});
	await sessions.establish(CWD);
	return sessions;
}

function cli(
	sessions: OwnerStoreSessions | undefined,
	server: ReturnType<typeof apiserver>,
) {
	return createHoboCli({
		commands: {
			ci: createCiCommand({
				env: {},
				git: async (args) =>
					args[0] === "rev-parse"
						? REPOSITORY_ROOT
						: "https://github.com/Hobo-Labs/HoBo.git",
				...(sessions !== undefined
					? { ownerCredentials: sessions.credentials }
					: undefined),
				kubernetesHttp: server.factory,
			}),
		},
	});
}

function leaksNothing(text: string): void {
	expect(text).not.toContain(TOKEN);
	expect(text).not.toContain(KUBECONFIG);
	expect(text).not.toContain(Buffer.from(CA).toString("base64"));
	expect(text).not.toContain(PRIVATE_PROJECT);
	expect(text).not.toContain("infisical://");
}

async function run(
	sessions: OwnerStoreSessions | undefined,
	server: ReturnType<typeof apiserver>,
	args: readonly string[],
) {
	const result = await cli(sessions, server).run(
		["ci", "fleet", "caches", ...args, "--json"],
		{ cwd: CWD },
	);
	leaksNothing(result.stdout + result.stderr);
	return { result, envelope: JSON.parse(result.stdout) };
}

describe("hobo ci fleet caches", () => {
	it("plans the node caches for every scale set in the pool's namespace without changing any", async () => {
		const server = apiserver();
		const { result, envelope } = await run(
			await session({ [ENTRY]: KUBECONFIG }),
			server,
			["--plan"],
		);
		expect(result.exitCode).toBe(0);
		expect(server.tls).toEqual([{ ca: CA }]);
		expect(server.calls.every((call) => call.method === "GET")).toBe(true);
		expect(
			server.calls.every((call) => call.authorization === `Bearer ${TOKEN}`),
		).toBe(true);
		expect(envelope.data.fleetCaches).toMatchObject({
			cluster: "hostinger-arc",
			namespace: "arc-runners",
			mode: "plan",
		});
		const planned = envelope.data.fleetCaches.scaleSets;
		expect(
			planned.map((set: { name: string; patchState: string }) => [
				set.name,
				set.patchState,
			]),
		).toEqual([
			["hobo-trunk", "planned"],
			["hobo-runner", "planned"],
		]);
		expect(planned[0].cachesMounted).toBe(false);
		expect(
			planned[0].patch.map(
				(operation: { op: string; path: string; valueJson: string }) => ({
					op: operation.op,
					path: operation.path,
					value: JSON.parse(operation.valueJson),
				}),
			),
		).toEqual(pactInteraction("JSON-patch the node caches").request.body);
	});

	it("applies the pact's patch and prewarm Job once, and is a no-op the second time", async () => {
		const server = apiserver();
		const sessions = await session({ [ENTRY]: KUBECONFIG });
		const args = ["--apply", "--scale-set", "hobo-trunk", "--prewarm", SHA];
		const first = await run(sessions, server, args);
		expect(first.result.exitCode).toBe(0);
		const writes = server.calls.filter((call) => call.method !== "GET");
		expect(writes.map((call) => [call.method, call.path])).toEqual([
			[
				"PATCH",
				"/apis/actions.github.com/v1alpha1/namespaces/arc-runners/autoscalingrunnersets/hobo-trunk",
			],
			["POST", "/apis/batch/v1/namespaces/arc-runners/jobs"],
		]);
		expect(JSON.parse(writes[0]?.body ?? "null")).toEqual(
			pactInteraction("JSON-patch the node caches").request.body,
		);
		expect(JSON.parse(writes[1]?.body ?? "null")).toEqual(
			pactInteraction("create the store prewarm Job").request.body,
		);
		expect(first.envelope.data.fleetCaches.scaleSets[0]).toMatchObject({
			name: "hobo-trunk",
			cachesMounted: true,
			patchState: "applied",
			prewarm: { ref: SHA, state: "created" },
		});

		const second = await run(sessions, server, args);
		expect(second.result.exitCode).toBe(0);
		expect(server.calls.filter((call) => call.method === "PATCH")).toHaveLength(
			1,
		);
		expect(second.envelope.data.fleetCaches.scaleSets[0]).toMatchObject({
			cachesMounted: true,
			patchState: "current",
			patch: [],
			prewarm: { state: "exists" },
		});

		const status = await run(sessions, server, [
			"--status",
			"--scale-set",
			"hobo-trunk",
		]);
		expect(status.envelope.data.fleetCaches.scaleSets[0]).toMatchObject({
			cachesMounted: true,
			patchState: "current",
			prewarm: {
				job: "hobo-trunk-store-prewarm-4da35cfd9285",
				ref: SHA,
				state: "succeeded",
			},
		});
		expect(server.calls.at(-1)?.query).toBe(
			"?labelSelector=hobo.ci%2Fstore-prewarm%3Dhobo-trunk",
		);
	});

	it("reports a scale set with no caches and no prewarm Job", async () => {
		const server = apiserver();
		const { envelope } = await run(
			await session({ [ENTRY]: KUBECONFIG }),
			server,
			["--status", "--scale-set", "hobo-runner"],
		);
		expect(envelope.data.fleetCaches.scaleSets).toEqual([
			expect.objectContaining({
				name: "hobo-runner",
				cachesMounted: false,
				patchState: "planned",
				prewarm: { job: "", ref: "", state: "absent" },
			}),
		]);
		expect(envelope.message).toContain("no store prewarm Job");
	});

	it("refuses without the kubeconfig, naming only the reference and choose_secret_store", async () => {
		for (const sessions of [undefined, await session({})]) {
			const server = apiserver();
			const { result, envelope } = await run(sessions, server, ["--status"]);
			expect(result.exitCode).not.toBe(0);
			expect(envelope.code).toBe("HOBO_CI_FLEET_CREDENTIAL_UNAVAILABLE");
			expect(envelope.message).toContain(`owner://${ENTRY}`);
			expect(envelope.message).toContain("choose_secret_store");
			expect(server.calls).toEqual([]);
			expect(server.tls).toEqual([]);
		}
	});

	it("keeps the kubeconfig's token out of apiserver errors", async () => {
		const server = apiserver((call) =>
			call.method === "PATCH"
				? reply(403, {
						kind: "Status",
						reason: "Forbidden",
						code: 403,
						message: `token ${TOKEN} cannot patch autoscalingrunnersets`,
					})
				: undefined,
		);
		const { result, envelope } = await run(
			await session({ [ENTRY]: KUBECONFIG }),
			server,
			["--apply", "--scale-set", "hobo-trunk"],
		);
		expect(result.exitCode).not.toBe(0);
		expect(envelope.code).toBe("KUBERNETES_PROVIDER_AUTH_FAILED");
	});

	it("refuses a kubeconfig it cannot use without echoing it", async () => {
		const server = apiserver();
		const { envelope } = await run(
			await session({
				[ENTRY]: KUBECONFIG.replace(
					`  user: {token: ${TOKEN}}`,
					`  user: {token: ${TOKEN}, exec: {command: aws}}`,
				),
			}),
			server,
			["--status"],
		);
		expect(envelope.code).toBe("HOBO_CI_FLEET_KUBECONFIG_UNSUPPORTED");
		expect(server.calls).toEqual([]);
	});

	it.each([
		[["--plan", "--apply"]],
		[["--prewarm", "main"]],
		[["--status", "--prewarm", SHA]],
		[["--scale-set", "../../api/v1/secrets"]],
		[["--namespace", "Kube System"]],
		[["--bogus"]],
		[["extra"]],
	])("refuses %j before any cluster call", async (args) => {
		const server = apiserver();
		const { envelope } = await run(
			await session({ [ENTRY]: KUBECONFIG }),
			server,
			args,
		);
		expect(envelope.code).toBe("HOBO_CLI_USAGE");
		expect(server.calls).toEqual([]);
	});

	it("refuses a pool the project does not declare", async () => {
		const server = apiserver();
		const { envelope } = await run(
			await session({ [ENTRY]: KUBECONFIG }),
			server,
			["--cluster", "nowhere"],
		);
		expect(envelope.code).toBe("HOBO_CI_FLEET_CACHES_NO_CLUSTER");
		expect(server.calls).toEqual([]);
	});
});
