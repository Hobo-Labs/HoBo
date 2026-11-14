import type {
	HttpTransport,
	JsonValue,
	ResolveRequest,
	ResourceMutationJournal,
	TransportRequest,
	TransportResponse,
} from "@hobo/core";
import { ResourceMutationNotSentError } from "@hobo/core";
import { describe, expect, it } from "vitest";
import {
	VERCEL_BLOB_PRODUCT_ID,
	vercelResolverRegistry,
} from "../src/index.js";

type Connection = {
	id: string;
	projectId: string;
	environments: string[];
	environmentVariables: string[];
};
type Store = {
	id: string;
	name: string;
	type: string;
	region: string;
	access: string;
	count: number;
	ownerId: string;
	projectsMetadata: Connection[];
};
const team = "team_hobo";
const projectId = "prj_hobo";
const request = (
	environments = ["production"],
	overrides: Partial<ResolveRequest> = {},
): ResolveRequest => ({
	ref: {
		slot: "bucket",
		productId: VERCEL_BLOB_PRODUCT_ID,
		logicalId: "ci-cache",
		...overrides.ref,
	},
	desired: {
		name: "hobo-ci-cache",
		region: "iad1",
		access: "private",
		projectId,
		environments,
		operationId: "operation-1",
		...overrides.desired,
	},
	credentialRef: "hobo-token://vercel/deploy",
	...(overrides.observed ? { observed: overrides.observed } : undefined),
});
function journal(): ResourceMutationJournal {
	const entries = new Map<
		string,
		{ digest: string; status: "claimed" | "acknowledged" | "uncertain" }
	>();
	return {
		persistence: "durable-cas",
		async claim({ mutationId, requestDigest }) {
			const prior = entries.get(mutationId);
			if (prior) {
				if (prior.digest !== requestDigest) throw new Error("digest conflict");
				return {
					status:
						prior.status === "acknowledged" ? "acknowledged" : "uncertain",
				};
			}
			entries.set(mutationId, { digest: requestDigest, status: "claimed" });
			return { status: "claimed" };
		},
		async acknowledge(id, digest) {
			entries.set(id, { digest, status: "acknowledged" });
		},
		async uncertain(id, digest) {
			entries.set(id, { digest, status: "uncertain" });
		},
	};
}
function fixture(seed: Store[] = []) {
	const stores = new Map(
		seed.map((store) => [store.id, structuredClone(store)]),
	);
	const calls: TransportRequest[] = [];
	const json = (status: number, value: JsonValue): TransportResponse => ({
		status,
		headers: {},
		body: JSON.stringify(value),
	});
	const transport: HttpTransport = async (input) => {
		calls.push(input);
		const url = new URL(input.url);
		if (url.searchParams.get("teamId") !== team) return json(403, {});
		if (
			url.pathname === `/v9/projects/${projectId}` ||
			url.pathname === "/v9/projects/hobo-ci"
		)
			return json(200, { id: projectId, name: "hobo-ci", accountId: team });
		if (url.pathname === "/v1/storage/stores" && input.method === "GET")
			return json(200, { stores: [...stores.values()] });
		if (url.pathname === "/v1/storage/stores/blob" && input.method === "POST") {
			const body = JSON.parse(input.body ?? "{}");
			const id = `store_${stores.size + 1}`;
			stores.set(id, {
				id,
				...body,
				type: "blob",
				ownerId: team,
				count: 0,
				projectsMetadata: [],
			});
			return json(200, { store: { id } });
		}
		const match =
			/^\/v1\/storage\/stores\/(?:blob\/)?([^/]+)(?:\/connections(?:\/([^/]+))?)?$/u.exec(
				url.pathname,
			);
		const id = match?.[1];
		if (!id) return json(404, {});
		const store = stores.get(id);
		if (!store) return json(404, {});
		const isConnection = url.pathname.includes("/connections");
		if (!isConnection && input.method === "GET") return json(200, { store });
		if (!isConnection && input.method === "DELETE") {
			stores.delete(id);
			return json(204, {});
		}
		const body = JSON.parse(input.body ?? "{}");
		if (isConnection && input.method === "POST") {
			if (
				input.headers["x-vercel-use-oidc"] !== "1" ||
				body.skipReadWriteToken !== true
			)
				return json(400, {});
			store.projectsMetadata.push({
				id: `conn_${store.projectsMetadata.length + 1}`,
				projectId: body.projectId,
				environments: body.envVarEnvironments,
				environmentVariables: ["BLOB_STORE_ID"],
			});
			return json(200, {});
		}
		const connection = store.projectsMetadata.find(
			(entry) => entry.id === match?.[2],
		);
		if (!connection) return json(404, {});
		if (input.method === "PATCH") {
			connection.environments = body.envVarEnvironments;
			return json(200, {});
		}
		if (input.method === "DELETE") {
			store.projectsMetadata = store.projectsMetadata.filter(
				(entry) => entry.id !== connection.id,
			);
			return json(204, {});
		}
		return json(405, {});
	};
	const resolver = vercelResolverRegistry({
		teamId: team,
		resolveCredential: async () => "test-provider-credential",
		mutationJournal: journal(),
		mutationScope: {
			persistence: "durable-cas",
			async run(_scope, action) {
				try {
					return await action();
				} catch (error) {
					if (error instanceof ResourceMutationNotSentError)
						throw error.refusal;
					throw error;
				}
			},
		},
	}).get(VERCEL_BLOB_PRODUCT_ID);
	if (!resolver) throw new Error("missing Blob resolver");
	return { stores, calls, transport, resolver };
}
function store(overrides: Partial<Store> = {}): Store {
	return {
		id: "store_1",
		name: "hobo-ci-cache",
		type: "blob",
		region: "iad1",
		access: "private",
		count: 0,
		ownerId: team,
		projectsMetadata: [
			{
				id: "conn_1",
				projectId,
				environments: ["production"],
				environmentVariables: ["BLOB_STORE_ID"],
			},
		],
		...overrides,
	};
}
function pinned(
	id = "store_1",
	environments = ["production"],
	extra: Record<string, string | boolean> = {},
) {
	return request(environments, {
		ref: {
			slot: "bucket",
			productId: VERCEL_BLOB_PRODUCT_ID,
			logicalId: "ci-cache",
			physicalId: id,
		},
		desired: extra,
	});
}

describe("Vercel Blob provider lifecycle", () => {
	it("resolves the approved project name and pins its identity before connecting or retiring Blob", async () => {
		const api = fixture();
		const named: ResolveRequest = {
			...request(),
			desired: {
				store: "hobo-ci-cache",
				region: "iad1",
				access: "private",
				projectName: "hobo-ci",
				teamId: team,
				environments: ["production"],
				operationId: "operation-1",
			},
		};
		const created = await api.resolver.reconcile(named, api.transport);
		expect(created).toMatchObject({
			action: "create",
			outputs: { projectId, oidc: true, ready: true },
		});
		expect((await api.resolver.reconcile(named, api.transport)).action).toBe(
			"adopt",
		);
		const pinnedName = {
			...named,
			ref: { ...named.ref, physicalId: created.physicalId },
		};
		await expect(
			api.resolver.delete(pinnedName, api.transport),
		).rejects.toThrow(/pinned project observation/u);
		await api.resolver.delete(
			{ ...pinnedName, observed: { id: created.physicalId, projectId } },
			api.transport,
		);
		expect(api.stores.get(created.physicalId)?.projectsMetadata).toEqual([]);
	});
	it("refuses a different project or team before any Blob mutation", async () => {
		const api = fixture();
		const named: ResolveRequest = {
			...request(),
			desired: {
				store: "hobo-ci-cache",
				region: "iad1",
				access: "private",
				projectName: "hobo-ci",
				teamId: "team_foreign",
				environments: ["production"],
				operationId: "operation-1",
			},
		};
		await expect(api.resolver.reconcile(named, api.transport)).rejects.toThrow(
			/team/u,
		);
		expect(api.calls).toHaveLength(0);
		const wrongProject: HttpTransport = async (call) =>
			new URL(call.url).pathname === "/v9/projects/hobo-ci"
				? {
						status: 200,
						headers: {},
						body: JSON.stringify({
							id: projectId,
							name: "different",
							accountId: team,
						}),
					}
				: api.transport(call);
		await expect(
			api.resolver.reconcile(
				{ ...named, desired: { ...named.desired, teamId: team } },
				wrongProject,
			),
		).rejects.toThrow(/project identity/u);
		expect(api.calls.some((call) => call.method !== "GET")).toBe(false);
	});
	it("creates once, connects with OIDC, adopts, expands environments, and tears down without removing a shared environment", async () => {
		const api = fixture();
		const first = await api.resolver.reconcile(request(), api.transport);
		expect(first.action).toBe("create");
		expect(first.outputs).toMatchObject({
			name: "hobo-ci-cache",
			oidc: true,
			environments: ["production"],
		});
		const second = await api.resolver.reconcile(request(), api.transport);
		expect(second.action).toBe("adopt");
		expect(api.calls.filter((call) => call.method === "POST")).toHaveLength(2);
		const expanded = await api.resolver.reconcile(
			pinned(first.physicalId, ["preview"]),
			api.transport,
		);
		expect(expanded.action).toBe("update");
		expect(expanded.outputs.environments).toEqual(["preview", "production"]);
		await api.resolver.delete(
			pinned(first.physicalId, ["preview"], { deleteWhenEmpty: true }),
			api.transport,
		);
		expect(
			api.stores.get(first.physicalId)?.projectsMetadata[0]?.environments,
		).toEqual(["production"]);
		await api.resolver.delete(
			pinned(first.physicalId, ["production"], { deleteWhenEmpty: true }),
			api.transport,
		);
		expect(api.stores.size).toBe(0);
		await api.resolver.delete(
			pinned(first.physicalId, ["production"], { deleteWhenEmpty: true }),
			api.transport,
		);
		for (const call of api.calls) {
			expect(call.url).not.toContain("test-provider-credential");
			expect(call.body ?? "").not.toContain("test-provider-credential");
			expect(call.headers.authorization).toBe(
				"Bearer test-provider-credential",
			);
		}
	});
	it("preserves retained objects and other projects", async () => {
		const occupied = fixture([store({ count: 1 })]);
		await expect(
			occupied.resolver.delete(
				pinned("store_1", ["production"], { deleteWhenEmpty: true }),
				occupied.transport,
			),
		).rejects.toThrow(/verified empty/u);
		expect(
			occupied.calls.some(
				(call) => call.method === "DELETE" || call.method === "PATCH",
			),
		).toBe(false);
		const shared = fixture([
			store({
				projectsMetadata: [
					{
						id: "conn_1",
						projectId,
						environments: ["production"],
						environmentVariables: ["BLOB_STORE_ID"],
					},
					{
						id: "conn_2",
						projectId: "prj_other",
						environments: ["production"],
						environmentVariables: ["BLOB_STORE_ID"],
					},
				],
			}),
		]);
		await shared.resolver.delete(
			pinned("store_1", ["production"], { deleteWhenEmpty: true }),
			shared.transport,
		);
		expect(
			shared.stores
				.get("store_1")
				?.projectsMetadata.map((entry) => entry.projectId),
		).toEqual(["prj_other"]);
	});
	it("can create a new incarnation after a verified teardown", async () => {
		const api = fixture();
		const first = await api.resolver.reconcile(request(), api.transport);
		await api.resolver.delete(
			pinned(first.physicalId, ["production"], { deleteWhenEmpty: true }),
			api.transport,
		);
		const again = await api.resolver.reconcile(
			request(["production"], { desired: { operationId: "operation-2" } }),
			api.transport,
		);
		expect(again.action).toBe("create");
		expect(api.stores.size).toBe(1);
		expect(
			api.calls.filter(
				(call) => call.url.includes("/stores/blob") && call.method === "POST",
			),
		).toHaveLength(2);
	});
	it("does not duplicate a store when the create response is lost", async () => {
		const api = fixture();
		let lost = false;
		const unreliable: HttpTransport = async (call) => {
			const response = await api.transport(call);
			if (
				!lost &&
				call.method === "POST" &&
				new URL(call.url).pathname === "/v1/storage/stores/blob"
			) {
				lost = true;
				throw new Error("response lost after provider committed");
			}
			return response;
		};
		await expect(
			api.resolver.reconcile(request(), unreliable),
		).rejects.toThrow();
		await expect(api.resolver.reconcile(request(), unreliable)).rejects.toThrow(
			/import its exact ID/u,
		);
		expect(api.stores.size).toBe(1);
		expect(api.calls.filter((call) => call.method === "POST")).toHaveLength(1);
	});
	it("rejects ambiguous or unrelated stores rather than creating or adopting them", async () => {
		const ambiguous = fixture([store(), store({ id: "store_2" })]);
		await expect(
			ambiguous.resolver.reconcile(request(), ambiguous.transport),
		).rejects.toThrow(/multiple Vercel stores/u);
		const unrelated = fixture([store({ projectsMetadata: [] })]);
		await expect(
			unrelated.resolver.reconcile(request(), unrelated.transport),
		).rejects.toThrow(/import its exact ID/u);
		const foreign = fixture([store({ type: "integration" })]);
		await expect(
			foreign.resolver.reconcile(request(), foreign.transport),
		).rejects.toThrow(/store type/u);
		for (const api of [ambiguous, unrelated, foreign])
			expect(api.calls.some((call) => call.method === "POST")).toBe(false);
	});
	it("requires a team, durable coordination, valid settings, and a recorded ID before mutation", async () => {
		const api = fixture();
		const withoutScope = vercelResolverRegistry({
			teamId: team,
			resolveCredential: async () => "value",
			mutationJournal: journal(),
		}).get(VERCEL_BLOB_PRODUCT_ID);
		if (!withoutScope) throw new Error("missing Blob resolver");
		await expect(
			withoutScope.reconcile(request(), api.transport),
		).rejects.toThrow(/durable mutation journal and shared mutation scope/u);
		await expect(api.resolver.delete(request(), api.transport)).rejects.toThrow(
			/recorded physical store ID/u,
		);
		await expect(
			api.resolver.reconcile(request(["staging"]), api.transport),
		).rejects.toThrow(/requires a valid/u);
		expect(api.calls).toHaveLength(0);
	});
	it("does not replace an immutable store or silently use a static token", async () => {
		const wrongRegion = fixture([store({ region: "sfo1" })]);
		await expect(
			wrongRegion.resolver.reconcile(request(), wrongRegion.transport),
		).rejects.toThrow(/differs from the desired/u);
		const token = fixture([
			store({
				projectsMetadata: [
					{
						id: "conn_1",
						projectId,
						environments: ["production"],
						environmentVariables: ["BLOB_READ_WRITE_TOKEN"],
					},
				],
			}),
		]);
		await expect(
			token.resolver.reconcile(request(), token.transport),
		).rejects.toThrow(/not OIDC-only/u);
		expect(
			[...wrongRegion.calls, ...token.calls].some(
				(call) => call.method === "POST" || call.method === "DELETE",
			),
		).toBe(false);
	});
	it("refuses incomplete provider inventory before deleting or connecting", async () => {
		const api = fixture([store()]);
		const incomplete: HttpTransport = async (call) => {
			const response = await api.transport(call);
			if (
				call.method === "GET" &&
				new URL(call.url).pathname === "/v1/storage/stores/store_1"
			) {
				const body = JSON.parse(response.body);
				delete body.store.projectsMetadata;
				return { ...response, body: JSON.stringify(body) };
			}
			return response;
		};
		await expect(
			api.resolver.delete(
				pinned("store_1", ["production"], { deleteWhenEmpty: true }),
				incomplete,
			),
		).rejects.toThrow(/connection inventory is missing/u);
		await expect(api.resolver.reconcile(pinned(), incomplete)).rejects.toThrow(
			/connection inventory is missing/u,
		);
		expect(
			api.calls.some((call) =>
				["POST", "PATCH", "DELETE"].includes(call.method),
			),
		).toBe(false);
	});
	it("rejects a foreign account and incomplete store listing without mutation", async () => {
		const foreign = fixture([store({ ownerId: "team_other" })]);
		await expect(
			foreign.resolver.reconcile(request(), foreign.transport),
		).rejects.toThrow(/owner/u);
		const paginated = fixture();
		const partial: HttpTransport = async (call) => {
			const response = await paginated.transport(call);
			if (new URL(call.url).pathname === "/v1/storage/stores")
				return {
					...response,
					body: JSON.stringify({ stores: [], hasMore: true }),
				};
			return response;
		};
		await expect(
			paginated.resolver.reconcile(request(), partial),
		).rejects.toThrow(/inventory is missing or incomplete/u);
		expect(
			[...foreign.calls, ...paginated.calls].some(
				(call) => call.method === "POST",
			),
		).toBe(false);
	});
	it("keeps authoritative absence observation available when telemetry is enabled", async () => {
		const api = fixture();
		const points: string[] = [];
		const resolver = vercelResolverRegistry({
			teamId: team,
			resolveCredential: async () => "test-provider-credential",
			nowMs: () => 1000,
			metrics: {
				async metrics(batch) {
					points.push(
						...batch.map(
							(point) => point.attributes["hobo.resolver.operation"],
						),
					);
				},
			},
		}).get(VERCEL_BLOB_PRODUCT_ID);
		if (!resolver?.observeAbsence) throw new Error("absence observer was lost");
		expect(await resolver.observeAbsence(pinned(), api.transport)).toBe(true);
		expect(points).toContain("observeAbsence");
	});
});
