import type { HttpTransport, ResolveRequest } from "@hobo/core";
import { describe, expect, it } from "vitest";
import {
	createVercelProvider,
	VERCEL_PROJECT_PRODUCT_ID,
	vercelResolvers,
} from "../src/index.js";
import { createFetchTransport } from "../src/transport.js";

const request: ResolveRequest = {
	ref: {
		slot: "web",
		productId: VERCEL_PROJECT_PRODUCT_ID,
		logicalId: "example",
		physicalId: "prj_expected",
	},
	desired: {},
	credentialRef: "hobo-secret://vercel/account",
};
function resolver() {
	const value = vercelResolvers({
		teamId: "team_expected",
		resolveCredential: async () => "scoped-material",
	}).find((candidate) => candidate.productId === VERCEL_PROJECT_PRODUCT_ID);
	if (!value) throw new Error("Vercel project resolver not registered");
	return value;
}

describe("Vercel production boundary", () => {
	it("does not treat static zero hints as verified zero-cost hosting", () => {
		for (const capability of createVercelProvider().capabilities)
			expect(
				capability.estimateCost({ port: capability.port }).pricingStatus,
			).toBe("unknown");
	});
	it("refuses foreign project identity or team before applying any mutation", async () => {
		for (const body of [
			{ id: "prj_foreign", name: "example", accountId: "team_expected" },
			{ id: "prj_expected", name: "example", accountId: "team_foreign" },
		]) {
			const methods: string[] = [];
			const transport: HttpTransport = async (call) => {
				methods.push(call.method);
				return { status: 200, headers: {}, body: JSON.stringify(body) };
			};
			await expect(resolver().reconcile(request, transport)).rejects.toThrow(
				/identity|team/,
			);
			expect(methods).toEqual(["GET"]);
		}
	});
	it("bounds a stalled body and keeps its mutation outcome ambiguous", async () => {
		const transport = createFetchTransport({
			fetchImpl: async () => new Response(new ReadableStream()),
		});
		await expect(
			transport.request({
				method: "POST",
				url: "https://api.vercel.com/v9/projects",
				headers: {},
				timeoutMs: 5,
				maxResponseBytes: 32,
			}),
		).rejects.toMatchObject({ code: "PROVIDER_OPERATION_AMBIGUOUS" });
	});
});

describe("Vercel older resource scope and replay defenses", () => {
	const edge = (options: { teamId?: string } = { teamId: "team_expected" }) => {
		const value = vercelResolvers({
			resolveCredential: async () => "material",
			...options,
		}).find((r) => r.productId === "vercel.edge-config/v1");
		if (!value) throw new Error("missing edge resolver");
		return value;
	};
	const edgeRequest: ResolveRequest = {
		ref: {
			slot: "kv",
			productId: "vercel.edge-config/v1",
			logicalId: "flags",
			physicalId: "ecfg_owned",
		},
		desired: { slug: "flags" },
		credentialRef: "hobo-secret://vercel/account",
	};
	it.each([
		{ id: "ecfg_foreign", slug: "flags", ownerId: "team_expected" },
		{ id: "ecfg_owned", slug: "flags", ownerId: "team_foreign" },
		{ id: "ecfg_owned", slug: "flags" },
	])("refuses foreign or unscoped edge config readback %j before mutation", async (record) => {
		const methods: string[] = [];
		await expect(
			edge().reconcile(edgeRequest, async (call) => {
				methods.push(call.method);
				return { status: 200, headers: {}, body: JSON.stringify(record) };
			}),
		).rejects.toThrow(/identity|team/);
		expect(methods).toEqual(["GET"]);
	});
	it("does not allocate a new edge config after its pinned physical ID disappears", async () => {
		const methods: string[] = [];
		await expect(
			edge().reconcile(edgeRequest, async (call) => {
				methods.push(call.method);
				return { status: 404, headers: {}, body: "" };
			}),
		).rejects.toThrow(/fresh allocation/);
		expect(methods).toEqual(["GET"]);
	});
	it("refuses ambiguous slug discovery instead of choosing the first account resource", async () => {
		const methods: string[] = [];
		await expect(
			edge().reconcile(
				{ ...edgeRequest, ref: { ...edgeRequest.ref, physicalId: undefined } },
				async (call) => {
					methods.push(call.method);
					return {
						status: 200,
						headers: {},
						body: JSON.stringify([
							{ id: "ecfg_1", slug: "flags", ownerId: "team_expected" },
							{ id: "ecfg_2", slug: "flags", ownerId: "team_expected" },
						]),
					};
				},
			),
		).rejects.toThrow(/multiple/);
		expect(methods).toEqual(["GET"]);
	});
	it("does not delete an edge config whose independent native read belongs to another team", async () => {
		const methods: string[] = [];
		await expect(
			edge().delete(edgeRequest, async (call) => {
				methods.push(call.method);
				return {
					status: 200,
					headers: {},
					body: JSON.stringify({
						id: "ecfg_owned",
						slug: "flags",
						ownerId: "team_foreign",
					}),
				};
			}),
		).rejects.toThrow(/team/);
		expect(methods).toEqual(["GET"]);
	});
	it("requires a durable journal before creating a project even if name discovery finds nothing", async () => {
		const methods: string[] = [];
		const r = resolver();
		await expect(
			r.reconcile(
				{ ...request, ref: { ...request.ref, physicalId: undefined } },
				async (call) => {
					methods.push(call.method);
					return { status: 404, headers: {}, body: "" };
				},
			),
		).rejects.toThrow(/journal/);
		expect(methods).toEqual(["GET"]);
	});
	it("refuses unsupported desired fields before making provider calls", async () => {
		let called = false;
		await expect(
			resolver().reconcile(
				{ ...request, desired: { unsupported: true } },
				async () => {
					called = true;
					throw new Error("unexpected");
				},
			),
		).rejects.toThrow(/unsupported setting/);
		expect(called).toBe(false);
	});
});
