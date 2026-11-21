/** Exercise the real project resolver against Vercel Labs' stateful API emulator. */
import { createServer } from "@emulators/core";
import {
	getVercelStore,
	seedFromConfig,
	vercelPlugin,
} from "@emulators/vercel";
import type {
	HttpTransport,
	ResolveRequest,
	TransportRequest,
} from "@hobo/core";
import { describe, expect, it } from "vitest";

import {
	VERCEL_PROJECT_PRODUCT_ID,
	vercelResolverRegistry,
} from "../src/index.js";

const token = "local-emulator-token";
const origin = "https://api.vercel.com";

function fixture() {
	const { app, store } = createServer(vercelPlugin, {
		baseUrl: origin,
		tokens: { [token]: { login: "admin", id: 1 } },
	});
	vercelPlugin.seed?.(store, origin);
	seedFromConfig(store, origin, {
		teams: [{ slug: "hobo" }, { slug: "other" }],
		projects: [{ name: "storefront", team: "hobo", framework: "nextjs" }],
	});
	const state = getVercelStore(store);
	const team = state.teams.findOneBy("slug", "hobo");
	const otherTeam = state.teams.findOneBy("slug", "other");
	const project = state.projects.findOneBy("name", "storefront");
	if (!team || !otherTeam || !project) throw new Error("emulator seed failed");

	const calls: TransportRequest[] = [];
	const transport: HttpTransport = async (request) => {
		calls.push(request);
		// The resolver's real guard still checks api.vercel.com. Dispatch only
		// to the in-process emulator; never let this test make a network call.
		const init: RequestInit = {
			method: request.method,
			headers: request.headers,
		};
		if (request.body !== undefined) init.body = request.body;
		const response = await app.fetch(new Request(request.url, init));
		return {
			status: response.status,
			headers: Object.fromEntries(response.headers),
			body: await response.text(),
		};
	};
	const resolverFor = (teamId: string, authorized = true) => {
		const resolver = vercelResolverRegistry({
			teamId,
			resolveCredential: async () => token,
			verifyProjectControl: async (scope) =>
				authorized &&
				scope.teamId === team.uid &&
				scope.projectId === project.uid &&
				scope.operationId === "emulator-op",
			verifyProjectDeletion: async (scope) =>
				authorized &&
				scope.teamId === team.uid &&
				scope.projectId === project.uid &&
				scope.operationId === "emulator-op",
			mutationJournal: {
				persistence: "durable-cas",
				claim: async () => ({ status: "claimed" }),
				acknowledge: async () => {},
				uncertain: async () => {},
			},
		}).get(VERCEL_PROJECT_PRODUCT_ID);
		if (!resolver) throw new Error("project resolver is missing");
		return resolver;
	};
	const request: ResolveRequest = {
		ref: {
			slot: "web",
			productId: VERCEL_PROJECT_PRODUCT_ID,
			logicalId: "storefront",
		},
		desired: { framework: "nextjs", operationId: "emulator-op" },
		credentialRef: "hobo-token://vercel/emulator",
	};
	return { calls, otherTeam, project, request, resolverFor, team, transport };
}

describe("Vercel project resolver with the Vercel Labs emulator", () => {
	it("adopts, updates, reads and deletes the same scoped project", async () => {
		const f = fixture();
		const resolver = f.resolverFor(f.team.uid);
		const adopted = await resolver.reconcile(f.request, f.transport);
		expect(adopted.action).toBe("adopt");
		expect(adopted.physicalId).toBe(f.project.uid);

		const pinned = {
			...f.request,
			ref: { ...f.request.ref, physicalId: adopted.physicalId },
			desired: { ...f.request.desired, buildCommand: "pnpm build" },
		};
		const updated = await resolver.reconcile(pinned, f.transport);
		expect(updated.action).toBe("update");
		expect(updated.outputs.buildCommand).toBe("pnpm build");
		expect((await resolver.reconcile(pinned, f.transport)).action).toBe("noop");
		expect((await resolver.read?.(pinned, f.transport))?.outputs).toMatchObject(
			{
				id: f.project.uid,
				accountId: f.team.uid,
				buildCommand: "pnpm build",
			},
		);

		await resolver.delete(pinned, f.transport);
		expect(await resolver.read?.(pinned, f.transport)).toBeUndefined();
		await resolver.delete(pinned, f.transport);
		expect(f.calls.filter((call) => call.method === "PATCH")).toHaveLength(1);
		expect(f.calls.filter((call) => call.method === "DELETE")).toHaveLength(1);
	});

	it("refuses adoption and deletion without independent authorization", async () => {
		const f = fixture();
		const resolver = f.resolverFor(f.team.uid, false);
		await expect(resolver.reconcile(f.request, f.transport)).rejects.toThrow(
			/project control authorization/u,
		);
		const pinned = {
			...f.request,
			ref: { ...f.request.ref, physicalId: f.project.uid },
		};
		await expect(resolver.delete(pinned, f.transport)).rejects.toThrow(
			/independent deletion authorization/u,
		);
		expect(f.calls.every((call) => call.method === "GET")).toBe(true);
		expect(
			await f.resolverFor(f.team.uid).read?.(pinned, f.transport),
		).toBeDefined();
	});

	it("refuses to claim a Git-linked creation when readback has an incompatible link", async () => {
		const f = fixture();
		const request: ResolveRequest = {
			...f.request,
			ref: { ...f.request.ref, logicalId: "new-project" },
			desired: { ...f.request.desired, repository: "hobo/example" },
		};
		const resolver = f.resolverFor(f.team.uid);
		await expect(resolver.reconcile(request, f.transport)).rejects.toThrow(
			/different Git repository/u,
		);
		await expect(resolver.reconcile(request, f.transport)).rejects.toThrow(
			/different Git repository/u,
		);
		const posts = f.calls.filter((call) => call.method === "POST");
		expect(posts).toHaveLength(1);
		expect(new URL(posts[0]?.url ?? "").pathname).toBe("/v11/projects");
	});

	it("does not mutate a project belonging to another team", async () => {
		const f = fixture();
		const pinned = {
			...f.request,
			ref: { ...f.request.ref, physicalId: f.project.uid },
		};
		const resolver = f.resolverFor(f.otherTeam.uid);
		await expect(resolver.reconcile(pinned, f.transport)).rejects.toThrow();
		await resolver.delete(pinned, f.transport);
		expect(f.calls.every((call) => call.method === "GET")).toBe(true);
		expect(
			await f.resolverFor(f.team.uid).read?.(pinned, f.transport),
		).toBeDefined();
	});
});
