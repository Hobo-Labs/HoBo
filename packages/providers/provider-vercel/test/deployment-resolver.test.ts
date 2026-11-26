import { createHash } from "node:crypto";
import type {
	HttpTransport,
	ResolveRequest,
	ResourceMutationJournal,
	TransportRequest,
} from "@hobo/core";
import { describe, expect, it } from "vitest";
import {
	createVercelStaticDeploymentResolver,
	VERCEL_STATIC_DEPLOY_PRODUCT_ID,
} from "../src/deployment-resolver.js";

const files = { "/index.html": "approved bytes" };
const marker = `sha256:${createHash("sha256")
	.update(JSON.stringify(["operation-1", files]))
	.digest("hex")}`;
const request: ResolveRequest = {
	ref: {
		slot: "web",
		productId: VERCEL_STATIC_DEPLOY_PRODUCT_ID,
		logicalId: "site",
	},
	desired: {
		projectId: "prj_owned",
		name: "site",
		operationId: "operation-1",
		files,
	},
	credentialRef: "hobo-secret://vercel/owned",
};
function journal(): ResourceMutationJournal {
	const entries = new Map<string, string>();
	return {
		persistence: "durable-cas",
		async claim({ mutationId, requestDigest }) {
			const value = entries.get(mutationId);
			if (value !== undefined) {
				if (value !== requestDigest) throw new Error("digest differs");
				return { status: "uncertain" };
			}
			entries.set(mutationId, requestDigest);
			return { status: "claimed" };
		},
		async acknowledge() {},
		async uncertain() {},
	};
}
function fixture(
	config: {
		state?: string;
		foreignProject?: boolean;
		foreignTeam?: boolean;
		wrongMarker?: boolean;
		lostPost?: boolean;
		content?: string;
		missingPinned?: boolean;
		repeatCursor?: boolean;
		projectConfiguration?: Record<string, string | null>;
		deploymentUrl?: string;
	} = {},
) {
	let created = false;
	const calls: TransportRequest[] = [];
	const transport: HttpTransport = async (call) => {
		calls.push(call);
		const url = new URL(call.url);
		if (url.hostname.endsWith(".vercel.app"))
			return {
				status: 200,
				headers: {},
				body: config.content ?? files["/index.html"],
			};
		if (url.pathname.startsWith("/v9/projects/"))
			return {
				status: 200,
				headers: {},
				body: JSON.stringify({
					id: "prj_owned",
					accountId: "team_owned",
					framework: null,
					...config.projectConfiguration,
				}),
			};
		if (call.method === "DELETE") {
			created = false;
			return { status: 200, headers: {}, body: '{"state":"DELETED"}' };
		}
		if (call.method === "POST") {
			created = true;
			if (config.lostPost) throw new Error("response lost");
			return { status: 200, headers: {}, body: '{"id":"dpl_owned"}' };
		}
		if (url.pathname === "/v7/deployments")
			return {
				status: 200,
				headers: {},
				body: JSON.stringify({
					deployments: created
						? [{ uid: "dpl_owned", meta: { hoboOperation: marker } }]
						: [],
					pagination: { next: config.repeatCursor ? 100 : null },
				}),
			};
		if (config.missingPinned || !created)
			return { status: 404, headers: {}, body: "" };
		return {
			status: 200,
			headers: {},
			body: JSON.stringify({
				id: "dpl_owned",
				projectId: config.foreignProject ? "prj_foreign" : "prj_owned",
				team: { id: config.foreignTeam ? "team_foreign" : "team_owned" },
				meta: { hoboOperation: config.wrongMarker ? "wrong" : marker },
				readyState: config.state ?? "READY",
				url: config.deploymentUrl ?? "immutable.vercel.app",
			}),
		};
	};
	const resolver = createVercelStaticDeploymentResolver({
		teamId: "team_owned",
		resolveCredential: async () => "test-material",
		mutationJournal: journal(),
	});
	return {
		calls,
		transport,
		resolver,
		setCreated() {
			created = true;
		},
	};
}
describe("Vercel immutable static deployments", () => {
	it("creates only a preview in an already-scoped project and independently hashes served bytes", async () => {
		const f = fixture();
		const created = await f.resolver.reconcile(request, f.transport);
		expect(created.action).toBe("create");
		expect(created.outputs.ready).toBe(true);
		expect(created.outputs.servingEndpoint).toBe(
			"https://immutable.vercel.app",
		);
		expect(created.outputs.artifactDigest).toBe(
			`sha256:${createHash("sha256").update(JSON.stringify(files)).digest("hex")}`,
		);
		const post = f.calls.find((c) => c.method === "POST");
		expect(post).toBeDefined();
		const body = JSON.parse(post?.body ?? "{}");
		expect(body.target).toBeUndefined();
		expect(body.projectSettings).toBeUndefined();
		expect(body.project).toBe("prj_owned");
		expect(body.files).toEqual([
			{ file: "index.html", data: "approved bytes", encoding: "utf-8" },
		]);
		expect(
			f.calls.filter((c) => c.url.includes("immutable.vercel.app"))[0]?.headers
				.authorization,
		).toBeUndefined();
	});
	it("recovers the same deployment after a lost POST response without creating again", async () => {
		const f = fixture({ lostPost: true });
		await expect(f.resolver.reconcile(request, f.transport)).rejects.toThrow(
			"response lost",
		);
		const adopted = await f.resolver.reconcile(request, f.transport);
		expect(adopted.action).toBe("adopt");
		expect(adopted.physicalId).toBe("dpl_owned");
		expect(f.calls.filter((c) => c.method === "POST")).toHaveLength(1);
	});
	it("retains an uncertain journal when the result is absent and refuses a second POST", async () => {
		const f = fixture({ lostPost: true, missingPinned: true });
		await expect(f.resolver.reconcile(request, f.transport)).rejects.toThrow();
		await expect(f.resolver.reconcile(request, f.transport)).rejects.toThrow();
		expect(f.calls.filter((c) => c.method === "POST")).toHaveLength(1);
	});
	it.each([
		{ foreignProject: true },
		{ foreignTeam: true },
		{ wrongMarker: true },
	])("rejects foreign deployment identity %j", async (config) => {
		const f = fixture(config);
		f.setCreated();
		await expect(
			f.resolver.read?.(
				{ ...request, ref: { ...request.ref, physicalId: "dpl_owned" } },
				f.transport,
			),
		).rejects.toThrow(/identity|marker/);
		expect(f.calls.every((c) => c.method === "GET")).toBe(true);
	});
	it("reports a pending build without ready or artifact evidence", async () => {
		const f = fixture({ state: "BUILDING" });
		f.setCreated();
		const r = await f.resolver.read?.(
			{ ...request, ref: { ...request.ref, physicalId: "dpl_owned" } },
			f.transport,
		);
		expect(r?.outputs).toMatchObject({
			ready: false,
			operationConfirmed: false,
			lifecycleStatus: "pending",
		});
		expect(r?.outputs.artifactDigest).toBeUndefined();
		expect(r?.outputs.servingEndpoint).toBeUndefined();
	});
	it("does not replace observed bytes with the expected digest", async () => {
		const f = fixture({ content: "foreign bytes" });
		const r = await f.resolver.reconcile(request, f.transport);
		expect(r.outputs.artifactDigest).not.toBe(
			`sha256:${createHash("sha256").update(JSON.stringify(files)).digest("hex")}`,
		);
	});
	it("never recreates a missing pinned physical deployment", async () => {
		const f = fixture({ missingPinned: true });
		await expect(
			f.resolver.reconcile(
				{ ...request, ref: { ...request.ref, physicalId: "dpl_missing" } },
				f.transport,
			),
		).rejects.toThrow(/fresh deployment/);
		expect(f.calls.every((c) => c.method === "GET")).toBe(true);
	});
	it("refuses unbounded discovery without allocating resources", async () => {
		const f = fixture({ repeatCursor: true });
		await expect(f.resolver.reconcile(request, f.transport)).rejects.toThrow(
			/cursor/,
		);
		expect(f.calls.every((c) => c.method === "GET")).toBe(true);
	});
	it("deletes an unhealthy deployment using scoped native identity without depending on its public health", async () => {
		const f = fixture({ state: "ERROR" });
		f.setCreated();
		await f.resolver.delete(
			{ ...request, ref: { ...request.ref, physicalId: "dpl_owned" } },
			f.transport,
		);
		expect(f.calls.some((c) => c.method === "DELETE")).toBe(true);
		expect(f.calls.every((c) => new URL(c.url).host === "api.vercel.com")).toBe(
			true,
		);
	});
	it("refuses executable artifact configuration before network I/O", async () => {
		const f = fixture();
		await expect(
			f.resolver.reconcile(
				{
					...request,
					desired: { ...request.desired, files: { "/package.json": "{}" } },
				},
				f.transport,
			),
		).rejects.toThrow(/executable/);
		expect(f.calls).toHaveLength(0);
	});
	it("requires a durable mutation journal before POST", async () => {
		const f = fixture();
		const resolver = createVercelStaticDeploymentResolver({
			teamId: "team_owned",
			resolveCredential: async () => "material",
		});
		await expect(resolver.reconcile(request, f.transport)).rejects.toThrow(
			/journal/,
		);
		expect(f.calls.every((c) => c.method === "GET")).toBe(true);
	});
	it("refuses new deployment effects in a project with existing build/framework configuration", async () => {
		for (const projectConfiguration of [
			{ framework: "nextjs" },
			{ buildCommand: "npm run build" },
			{ installCommand: "npm install" },
			{ rootDirectory: "apps/web" },
		]) {
			const f = fixture({ projectConfiguration });
			await expect(f.resolver.reconcile(request, f.transport)).rejects.toThrow(
				/static project/,
			);
			expect(f.calls.every((c) => c.method === "GET")).toBe(true);
		}
	});
	it.each([
		"https://evil.example",
		"https://immutable.vercel.app.evil.example",
		"https://user:pass@immutable.vercel.app",
		"https://immutable.vercel.app/path?token=private",
	])("refuses native serving endpoint outside immutable hosting scope %s", async (deploymentUrl) => {
		const f = fixture({ deploymentUrl });
		f.setCreated();
		await expect(
			f.resolver.read?.(
				{ ...request, ref: { ...request.ref, physicalId: "dpl_owned" } },
				f.transport,
			),
		).rejects.toThrow(/hosting authority/);
		expect(f.calls.every((c) => new URL(c.url).host === "api.vercel.com")).toBe(
			true,
		);
	});
});
