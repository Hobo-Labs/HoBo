import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { create, fromJson, toJson } from "@bufbuild/protobuf";
import {
	createBoundedFetchTransport,
	type DurableEventStore,
	type HttpTransport,
	parseResolveRequest,
	type ResourceMutationJournal,
	type ResourceMutationJournalEntry,
	ResourceMutationJournalEntrySchema,
} from "@hobo/core";
import {
	createManualClock,
	createRuntimeLocalEventStore,
} from "@hobo/runtime-local";
import { afterEach, describe, expect, it } from "vitest";
import {
	RAILWAY_SERVICE_PRODUCT_ID,
	railwayResolverRegistry,
} from "../src/index.js";
import {
	isJsonObject,
	isJsonString,
	type JsonObject,
	parseJsonObject,
} from "../src/json.js";

const dispose: (() => void | Promise<void>)[] = [];
afterEach(async () => {
	while (dispose.length) await dispose.pop()?.();
});
const token = "test-project-token-not-persisted";
const actor = { kind: "service", id: "hosting-worker" } as const;
function mutationJournal(store: DurableEventStore): ResourceMutationJournal {
	const stream = (id: string) => `test-railway-claim:${encodeURIComponent(id)}`;
	async function current(id: string) {
		let seq = 0,
			entry: ResourceMutationJournalEntry | undefined;
		for await (const event of store.read(stream(id))) {
			entry = fromJson(
				ResourceMutationJournalEntrySchema,
				JSON.parse(JSON.stringify(event.data)),
			);
			seq = event.seq;
		}
		return { entry, seq };
	}
	async function write(
		id: string,
		digest: string,
		status: string,
		seq: number,
	) {
		await store.commit({
			streamId: stream(id),
			append: { expectedSeq: seq, tenant: "tenant", actor, fenceToken: 1n },
			events: [
				{
					type: "test.MutationJournal",
					data: toJson(
						ResourceMutationJournalEntrySchema,
						create(ResourceMutationJournalEntrySchema, {
							mutationId: id,
							requestDigest: digest,
							status,
							recordedAtMs: 1000,
						}),
					),
				},
			],
		});
	}
	async function finish(id: string, digest: string, status: string) {
		const existing = await current(id);
		if (!existing.entry || existing.entry.requestDigest !== digest)
			throw new Error("journal scope mismatch");
		if (existing.entry.status !== "acknowledged")
			await write(id, digest, status, existing.seq);
	}
	return {
		persistence: "durable-cas",
		async claim(input) {
			const existing = await current(input.mutationId);
			if (existing.entry) {
				if (existing.entry.requestDigest !== input.requestDigest)
					throw new Error("changed mutation digest");
				return {
					status:
						existing.entry.status === "acknowledged"
							? "acknowledged"
							: "uncertain",
				};
			}
			try {
				await write(input.mutationId, input.requestDigest, "claimed", 0);
				return { status: "claimed" };
			} catch (error) {
				if (!(await current(input.mutationId)).entry) throw error;
				return { status: "uncertain" };
			}
		},
		acknowledge: (id, digest) => finish(id, digest, "acknowledged"),
		uncertain: (id, digest) => finish(id, digest, "uncertain"),
	};
}
function request(changes: Record<string, string> = {}) {
	return parseResolveRequest({
		ref: {
			slot: "service",
			productId: RAILWAY_SERVICE_PRODUCT_ID,
			logicalId: "isolated-app",
		},
		desired: {
			projectId: "project-one",
			environmentId: "environment-one",
			serviceId: "service-one",
			commitSha: "a".repeat(40),
			operationId: "hosting:immutable-generation-1",
			...changes,
		},
		credentialRef: "vault://railway/version-one",
	});
}
function api(
	settings: {
		loseReply?: boolean;
		occupied?: boolean;
		wrongCommit?: boolean;
		foreignDeployment?: boolean;
	} = {},
) {
	let deploymentId: string | undefined,
		stopped = false;
	const queries: string[] = [];
	async function answer(text: string) {
		const payload = parseJsonObject(text),
			query = payload.query,
			variables = payload.variables;
		if (!isJsonString(query) || !isJsonObject(variables))
			throw new Error("invalid GraphQL fixture request");
		queries.push(query);
		let data: JsonObject;
		if (query.includes("hoboProjectToken"))
			data = {
				projectToken: {
					projectId: "project-one",
					environmentId: "environment-one",
				},
			};
		else if (query.includes("hoboServiceInstance"))
			data = {
				serviceInstance: {
					id: "instance-one",
					serviceId: "service-one",
					environmentId: "environment-one",
					latestDeployment: settings.occupied
						? { id: "untracked-deployment" }
						: null,
				},
			};
		else if (query.includes("hoboService("))
			data = {
				service: {
					id: "service-one",
					name: "isolated-app",
					projectId: "project-one",
				},
			};
		else if (query.includes("hoboDeploy(")) {
			deploymentId = "deployment-new";
			if (settings.loseReply)
				throw new Error(`connection reset after provider effect ${token}`);
			data = { serviceInstanceDeployV2: deploymentId };
		} else if (query.includes("hoboDeployment("))
			data = {
				deployment: deploymentId
					? {
							id: settings.foreignDeployment ? "foreign" : deploymentId,
							projectId: "project-one",
							environmentId: "environment-one",
							serviceId: "service-one",
							status: stopped ? "REMOVED" : "SUCCESS",
							deploymentStopped: stopped,
							url: "https://isolated-app.up.railway.app/",
							meta: {
								commitHash: (settings.wrongCommit ? "b" : "a").repeat(40),
							},
						}
					: null,
			};
		else if (query.includes("hoboStop")) {
			if (variables.id !== deploymentId)
				throw new Error("stopping another deployment");
			stopped = true;
			data = { deploymentStop: true };
		} else throw new Error("unmatched GraphQL fixture request");
		return { status: 200, headers: {}, body: JSON.stringify({ data }) };
	}
	const transport: HttpTransport = async (call) => answer(call.body ?? "");
	return {
		answer,
		transport,
		queries,
		deployCount: () =>
			queries.filter((query) => query.includes("mutation hoboDeploy(")).length,
	};
}
function fixture() {
	const dataDir = mkdtempSync(join(tmpdir(), "railway-deployment-"));
	dispose.push(() => rmSync(dataDir, { recursive: true, force: true }));
	function connect(settings: { ackFailure?: boolean } = {}) {
		const store = createRuntimeLocalEventStore({
			dataDir,
			clock: createManualClock("2026-10-30T00:00:00Z"),
		});
		dispose.push(() => store.close());
		const journal = mutationJournal(store);
		const supplied = settings.ackFailure
			? {
					...journal,
					async acknowledge() {
						throw new Error("process lost after durable native identity");
					},
				}
			: journal;
		const options = {
			projectId: "project-one",
			environmentId: "environment-one",
			resolveCredential: async () => token,
			mutationJournal: supplied,
			deploymentStore: {
				store,
				tenantId: "tenant",
				actor,
				fenceToken: 1n,
				nowMs: () => 1000,
			},
		};
		const resolver = railwayResolverRegistry(options).get(
			RAILWAY_SERVICE_PRODUCT_ID,
		);
		if (!resolver) throw new Error("Railway resolver missing");
		return { store, resolver };
	}
	return { connect };
}
describe("Railway durable single-dispatch deployments", () => {
	it("creates one native billable deployment, persists its identity, and converges across SQLite reopen", async () => {
		const f = fixture(),
			world = api(),
			first = f.connect();
		expect(
			await first.resolver.reconcile(request(), world.transport),
		).toMatchObject({
			action: "create",
			physicalId: "deployment-new",
			outputs: { ready: false, operationConfirmed: false },
		});
		const reopened = f.connect();
		const observed = await reopened.resolver.reconcile(
			request(),
			world.transport,
		);
		expect(observed).toMatchObject({
			physicalId: "deployment-new",
			outputs: {
				serviceId: "service-one",
				deploymentId: "deployment-new",
				ready: true,
				observedCommitSha: "a".repeat(40),
				servingEndpoint: "https://isolated-app.up.railway.app/",
			},
		});
		expect(observed.outputs.artifactDigest).toBeUndefined();
		expect(world.deployCount()).toBe(1);
		const events = [];
		for await (const positioned of reopened.store.readAll())
			events.push(positioned.event);
		const located = events.filter(
			(row) => row.type === "railway.DeploymentLocated",
		);
		expect(located).toHaveLength(1);
		expect(JSON.stringify(located)).not.toContain(token);
		expect(JSON.stringify(located)).not.toContain("query");
	});
	it("serializes independent SQLite contenders before the only deployment POST", async () => {
		const f = fixture(),
			a = f.connect(),
			b = f.connect(),
			world = api();
		const results = await Promise.allSettled([
			a.resolver.reconcile(request(), world.transport),
			b.resolver.reconcile(request(), world.transport),
		]);
		expect(
			results.filter((result) => result.status === "fulfilled").length,
		).toBeGreaterThanOrEqual(1);
		expect(world.deployCount()).toBe(1);
	});
	it("never repeats a deployment after its response is lost", async () => {
		const f = fixture(),
			a = f.connect(),
			world = api({ loseReply: true });
		await expect(
			a.resolver.reconcile(request(), world.transport),
		).rejects.toThrow(/uncertain/);
		await expect(
			f.connect().resolver.reconcile(request(), world.transport),
		).rejects.toThrow(/second deployment mutation is forbidden/);
		expect(world.deployCount()).toBe(1);
	});
	it("recovers a native ID committed before an acknowledgement crash without another POST", async () => {
		const f = fixture(),
			world = api();
		await expect(
			f
				.connect({ ackFailure: true })
				.resolver.reconcile(request(), world.transport),
		).rejects.toThrow(/lost after durable native identity/);
		expect(
			await f.connect().resolver.reconcile(request(), world.transport),
		).toMatchObject({ physicalId: "deployment-new", outputs: { ready: true } });
		expect(world.deployCount()).toBe(1);
	});
	it("refuses changed-commit reuse of the same immutable deployment operation", async () => {
		const f = fixture(),
			a = f.connect(),
			world = api();
		await a.resolver.reconcile(request(), world.transport);
		await expect(
			a.resolver.reconcile(
				request({ commitSha: "b".repeat(40) }),
				world.transport,
			),
		).rejects.toThrow(/another request/);
		expect(world.deployCount()).toBe(1);
	});
	it("requires durable claims and native identity storage before any allocating API", async () => {
		const world = api(),
			resolver = railwayResolverRegistry({
				projectId: "project-one",
				environmentId: "environment-one",
				resolveCredential: async () => token,
			}).get(RAILWAY_SERVICE_PRODUCT_ID);
		if (!resolver) throw new Error("resolver missing");
		await expect(
			resolver.reconcile(request(), world.transport),
		).rejects.toThrow(/durable/);
		expect(world.queries).toHaveLength(0);
	});
	it("does not replace an untracked existing parent workload", async () => {
		const f = fixture(),
			world = api({ occupied: true });
		await expect(
			f.connect().resolver.reconcile(request(), world.transport),
		).rejects.toThrow(/fresh approved parent/);
		expect(world.deployCount()).toBe(0);
	});
	it("does not call a different observed Git commit ready or fabricate an OCI content digest", async () => {
		const f = fixture(),
			a = f.connect(),
			world = api({ wrongCommit: true });
		await a.resolver.reconcile(request(), world.transport);
		const found = await a.resolver.read?.(request(), world.transport);
		expect(found?.outputs).toMatchObject({
			ready: false,
			commitMatches: false,
		});
		expect(found?.outputs.servingEndpoint).toBeUndefined();
		expect(found?.outputs.artifactDigest).toBeUndefined();
	});
	it("stops only the persisted deployment and independently observes terminal absence", async () => {
		const f = fixture(),
			a = f.connect(),
			world = api();
		await a.resolver.reconcile(request(), world.transport);
		await f.connect().resolver.delete(request(), world.transport);
		expect(
			(await a.resolver.read?.(request(), world.transport))?.outputs,
		).toMatchObject({
			retirementConfirmed: true,
			operationTerminal: true,
			ready: false,
		});
		expect(world.deployCount()).toBe(1);
	});
	it("runs the shipped resolver over a real bounded HTTP transport", async () => {
		const f = fixture(),
			a = f.connect(),
			world = api();
		const server = createServer((incoming, response) => {
			let text = "";
			incoming.setEncoding("utf8");
			incoming.on("data", (chunk) => {
				text += chunk;
			});
			incoming.on("end", () => {
				world.answer(text).then(
					(reply) => {
						response.writeHead(reply.status);
						response.end(reply.body);
					},
					() => {
						response.writeHead(500);
						response.end();
					},
				);
			});
		});
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(0, "127.0.0.1", resolve);
		});
		dispose.push(
			() =>
				new Promise<void>((resolve, reject) =>
					server.close((error) => (error ? reject(error) : resolve())),
				),
		);
		const address = server.address();
		if (!address || isJsonString(address))
			throw new Error("missing local test address");
		const bounded = createBoundedFetchTransport({
				fetchImpl: globalThis.fetch,
			}),
			transport: HttpTransport = (call) =>
				bounded({
					...call,
					url: `http://127.0.0.1:${address.port}/graphql/v2`,
				});
		await a.resolver.reconcile(request(), transport);
		expect((await a.resolver.read?.(request(), transport))?.physicalId).toBe(
			"deployment-new",
		);
		expect(world.deployCount()).toBe(1);
	});
});
