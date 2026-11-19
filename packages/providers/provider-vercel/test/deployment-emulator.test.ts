import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { createServer } from "@emulators/core";
import {
	getVercelStore,
	seedFromConfig,
	vercelPlugin,
} from "@emulators/vercel";
import type { ResolveRequest, ResourceMutationJournal } from "@hobo/core";
import { describe, expect, it, vi } from "vitest";
import {
	createVercelStaticDeploymentResolver,
	VERCEL_STATIC_DEPLOY_PRODUCT_ID,
} from "../src/deployment-resolver.js";
import { createVercelDeploymentEmulator } from "../src/testing.js";

const TOKEN = "synthetic-vercel-token";
const API = "https://api.vercel.com";

function fixture(
	initialState: "BUILDING" | "READY" = "BUILDING",
	opaqueSourceArchives = false,
) {
	const { app, store } = createServer(vercelPlugin, {
		baseUrl: API,
		tokens: { [TOKEN]: { login: "admin", id: 1 } },
	});
	vercelPlugin.seed?.(store, API);
	seedFromConfig(store, API, {
		teams: [{ slug: "fixture" }],
		projects: [{ name: "sample", team: "fixture" }],
	});
	const state = getVercelStore(store);
	const team = state.teams.findOneBy("slug", "fixture");
	const project = state.projects.findOneBy("name", "sample");
	if (!team || !project) throw new Error("Fixture is unavailable.");
	state.projects.update(project.id, { framework: null });
	const forwarded: string[] = [];
	const projectFetch: typeof fetch = async (input, init) => {
		const request = new Request(input, init);
		forwarded.push(`${request.method} ${new URL(request.url).pathname}`);
		return app.fetch(request);
	};
	const emulator = createVercelDeploymentEmulator({
		teamId: team.uid,
		token: TOKEN,
		projectFetch,
		initialState,
		opaqueSourceArchives,
	});
	emulator.seedProject({
		id: project.uid,
		name: project.name,
		teamId: team.uid,
	});
	const send = (path: string, init: RequestInit = {}) =>
		emulator.fetch(
			`${API}${path}${path.includes("?") ? "&" : "?"}teamId=${team.uid}`,
			{
				...init,
				headers: { authorization: `Bearer ${TOKEN}`, ...init.headers },
			},
		);
	return { emulator, project, team, send, forwarded, store };
}

function journal(): ResourceMutationJournal {
	const claims = new Map<string, string>();
	return {
		persistence: "durable-cas",
		async claim({ mutationId, requestDigest }) {
			const prior = claims.get(mutationId);
			if (prior !== undefined) {
				if (prior !== requestDigest) throw new Error("different request");
				return { status: "uncertain" };
			}
			claims.set(mutationId, requestDigest);
			return { status: "claimed" };
		},
		async acknowledge() {},
		async uncertain() {},
	};
}

function resolverRequest(projectId: string): ResolveRequest {
	return {
		ref: {
			slot: "web",
			productId: VERCEL_STATIC_DEPLOY_PRODUCT_ID,
			logicalId: "site",
		},
		desired: {
			projectId,
			name: "sample",
			operationId: "fixture-op",
			files: { "/index.html": "approved bytes" },
		},
		credentialRef: "hobo-secret://vercel/fixture",
	};
}

describe("Vercel deployment emulator", () => {
	it("runs the real static deployment resolver through its HTTP port", async () => {
		const f = fixture("READY");
		const resolver = createVercelStaticDeploymentResolver({
			teamId: f.team.uid,
			resolveCredential: async () => TOKEN,
			mutationJournal: journal(),
		});
		const request = resolverRequest(f.project.uid);
		const created = await resolver.reconcile(request, f.emulator.transport);
		expect(created.action).toBe("create");
		expect(created.outputs).toMatchObject({
			ready: true,
			operationConfirmed: true,
		});
		expect(created.outputs.artifactDigest).toBe(
			`sha256:${createHash("sha256")
				.update(JSON.stringify({ "/index.html": "approved bytes" }))
				.digest("hex")}`,
		);
		const pinned = {
			...request,
			ref: { ...request.ref, physicalId: created.physicalId },
		};
		expect(
			(await resolver.read?.(pinned, f.emulator.transport))?.physicalId,
		).toBe(created.physicalId);
		await resolver.delete(pinned, f.emulator.transport);
		expect(await resolver.read?.(pinned, f.emulator.transport)).toBeUndefined();
		expect(f.forwarded).toContain(`GET /v9/projects/${f.project.uid}`);
	});

	it("recovers an applied deployment after the create reply is lost", async () => {
		const f = fixture("READY");
		const resolver = createVercelStaticDeploymentResolver({
			teamId: f.team.uid,
			resolveCredential: async () => TOKEN,
			mutationJournal: journal(),
		});
		const request = resolverRequest(f.project.uid);
		f.emulator.failNext({
			method: "POST",
			path: "/v13/deployments",
			when: "after",
		});
		await expect(
			resolver.reconcile(request, f.emulator.transport),
		).rejects.toThrow("Synthetic response loss");
		const recovered = await resolver.reconcile(request, f.emulator.transport);
		expect(recovered.action).toBe("adopt");
		expect(recovered.outputs.ready).toBe(true);
		const list = await f.send(`/v7/deployments?projectId=${f.project.uid}`);
		expect((await list.json()).deployments).toHaveLength(1);
	});

	it("uploads source bytes, stages, promotes, and rolls back project aliases", async () => {
		const f = fixture();
		f.emulator.seedDeployment({
			id: "dpl_previous",
			projectId: f.project.uid,
			target: "production",
			files: { "index.html": "old" },
		});
		f.emulator.seedAlias("fixture.vercel.app", "dpl_previous");
		f.emulator.seedAlias("second.vercel.app", "dpl_previous");
		const source = new TextEncoder().encode("new source");
		const sha = createHash("sha1").update(source).digest("hex");
		const upload = await f.send("/v2/files", {
			method: "POST",
			headers: { "x-vercel-digest": sha },
			body: source,
		});
		expect(upload.status).toBe(200);
		expect(f.forwarded).toContain("POST /v2/files");
		source.fill(0);
		const created = await f.send("/v13/deployments", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				name: f.project.name,
				project: f.project.uid,
				target: "production",
				autoAssignCustomDomains: false,
				files: [{ file: "index.html", sha, size: source.byteLength }],
				meta: { hoboSourceRequest: "request-one" },
			}),
		});
		expect(created.status).toBe(200);
		const deployment = await created.json();
		expect(deployment).toMatchObject({
			readyState: "BUILDING",
			projectId: f.project.uid,
		});
		expect(deployment).not.toHaveProperty("readySubstate");
		expect(
			await (
				await f.send(
					`/v4/aliases/fixture.vercel.app?projectId=${f.project.uid}`,
				)
			).json(),
		).toMatchObject({ deploymentId: "dpl_previous" });
		expect(
			(
				await f.send(
					`/v10/projects/${f.project.uid}/promote/${deployment.id}`,
					{
						method: "POST",
					},
				)
			).status,
		).toBe(409);
		f.emulator.setState(deployment.id, "READY");
		expect(
			await (await f.send(`/v13/deployments/${deployment.id}`)).json(),
		).toMatchObject({ readyState: "READY", readySubstate: "STAGED" });
		const stagedAlias = await f.send(
			`/v2/deployments/${deployment.id}/aliases`,
			{
				method: "POST",
				body: JSON.stringify({ alias: "fixture.vercel.app" }),
			},
		);
		expect(stagedAlias.status).toBe(501);
		expect(
			await (
				await f.send(
					`/v4/aliases/fixture.vercel.app?projectId=${f.project.uid}`,
				)
			).json(),
		).toMatchObject({ deploymentId: "dpl_previous" });
		const promotion = await f.send(
			`/v10/projects/${f.project.uid}/promote/${deployment.id}`,
			{ method: "POST" },
		);
		expect(promotion.status).toBe(201);
		expect(
			await (await f.send(`/v13/deployments/${deployment.id}`)).json(),
		).toMatchObject({ readyState: "READY", readySubstate: "PROMOTED" });
		expect(
			await (
				await f.send(
					`/v4/aliases/fixture.vercel.app?projectId=${f.project.uid}`,
				)
			).json(),
		).toMatchObject({ deploymentId: deployment.id });
		expect(
			await (
				await f.send(`/v4/aliases/second.vercel.app?projectId=${f.project.uid}`)
			).json(),
		).toMatchObject({ deploymentId: deployment.id });
		expect(
			await (
				await f.emulator.fetch(`https://${deployment.url}/index.html`)
			).text(),
		).toBe("new source");
		expect(
			await (
				await f.emulator.fetch("https://fixture.vercel.app/index.html")
			).text(),
		).toBe("new source");
		const matching = await (
			await f.send(
				`/v6/deployments?projectId=${f.project.uid}&target=production&meta-hoboSourceRequest=request-one`,
			)
		).json();
		expect(
			matching.deployments.map((item: { uid: string }) => item.uid),
		).toEqual([deployment.id]);
		const rollback = await f.send(
			`/v1/projects/${f.project.uid}/rollback/dpl_previous`,
			{ method: "POST" },
		);
		expect(rollback.status).toBe(201);
		expect(
			await (
				await f.send(
					`/v4/aliases/fixture.vercel.app?projectId=${f.project.uid}`,
				)
			).json(),
		).toMatchObject({ deploymentId: "dpl_previous" });
		expect(
			await (
				await f.send(`/v4/aliases/second.vercel.app?projectId=${f.project.uid}`)
			).json(),
		).toMatchObject({ deploymentId: "dpl_previous" });
		const manualAlias = await f.send(
			`/v2/deployments/${deployment.id}/aliases`,
			{
				method: "POST",
				body: JSON.stringify({ alias: "fixture.vercel.app" }),
			},
		);
		expect(manualAlias.status).toBe(200);
		expect(await manualAlias.json()).toMatchObject({
			alias: "fixture.vercel.app",
			oldDeploymentId: "dpl_previous",
		});
		expect(
			await (await f.send(`/v13/deployments/${deployment.id}`)).json(),
		).toMatchObject({ readyState: "READY", readySubstate: "PROMOTED" });
		expect(
			await (
				await f.send(`/v4/aliases/second.vercel.app?projectId=${f.project.uid}`)
			).json(),
		).toMatchObject({ deploymentId: "dpl_previous" });
	});

	it("rejects invalid or foreign requests without changing the selected project", async () => {
		const f = fixture("READY");
		const implicitScope = await f.emulator.fetch(
			`${API}/v9/projects/${f.project.uid}`,
			{ headers: { authorization: `Bearer ${TOKEN}` } },
		);
		expect(implicitScope.status).toBe(200);
		const badUpload = await f.send("/v2/files", {
			method: "POST",
			headers: { "x-vercel-digest": "0".repeat(40) },
			body: "different",
		});
		expect(badUpload.status).toBe(400);
		const missing = await f.send("/v13/deployments", {
			method: "POST",
			body: JSON.stringify({
				name: f.project.name,
				project: f.project.uid,
				files: [{ file: "index.html", sha: "0".repeat(40), size: 9 }],
			}),
		});
		expect(missing.status).toBe(400);
		expect(
			(await f.send("/v13/deployments", { method: "POST", body: "{" })).status,
		).toBe(400);
		expect(
			(
				await f.send("/v2/deployments/dpl_missing/aliases", {
					method: "POST",
					body: "{",
				})
			).status,
		).toBe(400);
		const foreign = await f.emulator.fetch(
			`${API}/v13/deployments?teamId=team_foreign`,
			{
				method: "POST",
				headers: { authorization: `Bearer ${TOKEN}` },
				body: "{}",
			},
		);
		expect(foreign.status).toBe(404);
		const forwardedBeforeScopeChecks = f.forwarded.length;
		for (const query of [
			`teamId=${f.team.uid}&teamId=team_foreign`,
			`teamId=${f.team.uid}&slug=foreign`,
			"slug=fixture",
		]) {
			const response = await f.emulator.fetch(
				`${API}/v9/projects/${f.project.uid}?${query}`,
				{ headers: { authorization: `Bearer ${TOKEN}` } },
			);
			expect(response.status).toBe(404);
		}
		expect(f.forwarded).toHaveLength(forwardedBeforeScopeChecks);
		expect((await f.send("/unimplemented")).status).toBe(501);
		expect(
			(
				await (
					await f.send(`/v7/deployments?projectId=${f.project.uid}`)
				).json()
			).deployments,
		).toHaveLength(0);
	});

	it("refuses Git deployments, automatic production aliases, and preview promotion", async () => {
		const f = fixture("READY");
		const file = { file: "index.html", data: "preview", encoding: "utf-8" };
		const payload = {
			name: f.project.name,
			project: f.project.uid,
			files: [file],
		};
		const git = await f.send("/v13/deployments", {
			method: "POST",
			body: JSON.stringify({ ...payload, gitSource: { type: "github" } }),
		});
		expect(git.status).toBe(400);
		const automatic = await f.send("/v13/deployments", {
			method: "POST",
			body: JSON.stringify({ ...payload, target: "production" }),
		});
		expect(automatic.status).toBe(400);
		const archive = await f.send("/v13/deployments", {
			method: "POST",
			body: JSON.stringify({
				...payload,
				files: [{ file: ".vercel/source.tgz.part0", data: "fixture" }],
			}),
		});
		expect(archive.status).toBe(400);
		f.emulator.seedDeployment({
			id: "dpl_previous",
			projectId: f.project.uid,
			target: "production",
		});
		f.emulator.seedAlias("fixture.vercel.app", "dpl_previous");
		const preview = await f.send("/v13/deployments", {
			method: "POST",
			body: JSON.stringify(payload),
		});
		const deployment = await preview.json();
		const promoted = await f.send(
			`/v10/projects/${f.project.uid}/promote/${deployment.id}`,
			{ method: "POST" },
		);
		expect(promoted.status).toBe(409);
		expect(
			await (
				await f.send(
					`/v4/aliases/fixture.vercel.app?projectId=${f.project.uid}`,
				)
			).json(),
		).toMatchObject({ deploymentId: "dpl_previous" });
		expect(() => f.emulator.setState(deployment.id, "BUILDING")).toThrow(
			/already terminal/u,
		);
	});

	it("does not apply a request that fails before dispatch", async () => {
		const f = fixture("READY");
		const payload = {
			name: f.project.name,
			project: f.project.uid,
			files: [{ file: "index.html", data: "ready" }],
		};
		f.emulator.failNext({
			method: "POST",
			path: "/v13/deployments",
			when: "before",
		});
		await expect(
			f.send("/v13/deployments", {
				method: "POST",
				body: JSON.stringify(payload),
			}),
		).rejects.toThrow("Synthetic transport failure");
		expect(
			(
				await (
					await f.send(`/v7/deployments?projectId=${f.project.uid}`)
				).json()
			).deployments,
		).toHaveLength(0);
		expect(
			(
				await f.send("/v13/deployments", {
					method: "POST",
					body: JSON.stringify(payload),
				})
			).status,
		).toBe(200);
	});

	it("does not move an alias to a deployment from another project", async () => {
		const f = fixture("READY");
		seedFromConfig(f.store, API, {
			projects: [{ name: "other", team: "fixture" }],
		});
		const other = getVercelStore(f.store).projects.findOneBy("name", "other");
		if (!other) throw new Error("Fixture is unavailable.");
		f.emulator.seedProject({
			id: other.uid,
			name: other.name,
			teamId: f.team.uid,
		});
		f.emulator.seedDeployment({
			id: "dpl_previous",
			projectId: f.project.uid,
			target: "production",
		});
		f.emulator.seedDeployment({
			id: "dpl_other",
			projectId: other.uid,
			target: "production",
		});
		f.emulator.seedAlias("fixture.vercel.app", "dpl_previous");
		const promotion = await f.send("/v2/deployments/dpl_other/aliases", {
			method: "POST",
			body: JSON.stringify({ alias: "fixture.vercel.app" }),
		});
		expect(promotion.status).toBe(409);
		expect(
			(
				await f.send(`/v10/projects/${f.project.uid}/promote/dpl_other`, {
					method: "POST",
				})
			).status,
		).toBe(404);
		expect(() =>
			f.emulator.seedAlias("fixture.vercel.app", "dpl_other"),
		).toThrow("Invalid emulator alias");
		expect(
			await (
				await f.send(
					`/v4/aliases/fixture.vercel.app?projectId=${f.project.uid}`,
				)
			).json(),
		).toMatchObject({ deploymentId: "dpl_previous" });
	});

	it("normalizes seeded deployment hosts and rejects collisions", async () => {
		const f = fixture("READY");
		f.emulator.seedDeployment({
			id: "dpl_AbC",
			projectId: f.project.uid,
			target: "production",
			files: { "index.html": "synthetic content" },
		});
		expect(
			await (
				await f.emulator.fetch("https://dpl-AbC.vercel.app/index.html")
			).text(),
		).toBe("synthetic content");
		expect(() =>
			f.emulator.seedDeployment({
				id: "dpl_aBc",
				projectId: f.project.uid,
				target: "production",
			}),
		).toThrow("Invalid emulator deployment");
		expect(() => f.emulator.seedAlias("dpl-abc.vercel.app", "dpl_AbC")).toThrow(
			"Invalid emulator alias",
		);
	});

	it("does not generate a deployment origin reserved by an alias", async () => {
		const f = fixture("READY");
		f.emulator.seedDeployment({
			id: "dpl_previous",
			projectId: f.project.uid,
			target: "production",
		});
		f.emulator.seedAlias("deployment-1.vercel.app", "dpl_previous");
		expect(
			(await f.send("/v13/deployments/dpl_previous", { method: "DELETE" }))
				.status,
		).toBe(200);
		const created = await f.send("/v13/deployments", {
			method: "POST",
			body: JSON.stringify({
				name: f.project.name,
				project: f.project.uid,
				files: [{ file: "index.html", data: "fixture" }],
			}),
		});
		expect(created.status).toBe(200);
		expect(await created.json()).toMatchObject({
			id: "dpl_2",
			url: "deployment-2.vercel.app",
		});
	});

	it("rejects invalid runtime states without changing a deployment", async () => {
		const f = fixture();
		f.emulator.seedDeployment({
			id: "dpl_fixture",
			projectId: f.project.uid,
			target: "production",
			state: "BUILDING",
		});
		expect(() =>
			f.emulator.setState("dpl_fixture", JSON.parse('"INVALID"')),
		).toThrow("Invalid emulator deployment state");
		expect(
			await (await f.send("/v13/deployments/dpl_fixture")).json(),
		).toMatchObject({
			readyState: "BUILDING",
		});
		f.emulator.setState("dpl_fixture", "READY");
		expect(
			await (await f.send("/v13/deployments/dpl_fixture")).json(),
		).toMatchObject({
			readyState: "READY",
		});
	});

	it("keeps a configured alias owned by its project after deployment deletion", async () => {
		const f = fixture("READY");
		seedFromConfig(f.store, API, {
			projects: [{ name: "other", team: "fixture" }],
		});
		const other = getVercelStore(f.store).projects.findOneBy("name", "other");
		if (!other) throw new Error("Fixture is unavailable.");
		f.emulator.seedProject({
			id: other.uid,
			name: other.name,
			teamId: f.team.uid,
		});
		f.emulator.seedDeployment({
			id: "dpl_previous",
			projectId: f.project.uid,
			target: "production",
		});
		f.emulator.seedDeployment({
			id: "dpl_other",
			projectId: other.uid,
			target: "production",
		});
		f.emulator.seedAlias("fixture.vercel.app", "dpl_previous");
		expect(
			(await f.send("/v13/deployments/dpl_previous", { method: "DELETE" }))
				.status,
		).toBe(200);
		expect(() =>
			f.emulator.seedAlias("fixture.vercel.app", "dpl_other"),
		).toThrow("Invalid emulator alias");
	});

	it("keeps promotion readback separate from a lost promotion response", async () => {
		const f = fixture("READY");
		f.emulator.seedDeployment({
			id: "dpl_previous",
			projectId: f.project.uid,
			target: "production",
		});
		f.emulator.seedAlias("fixture.vercel.app", "dpl_previous");
		f.emulator.seedDeployment({
			id: "dpl_candidate",
			projectId: f.project.uid,
			target: "production",
			staged: true,
		});
		const path = `/v10/projects/${f.project.uid}/promote/dpl_candidate`;
		f.emulator.failNext({ method: "POST", path, when: "after" });
		await expect(f.send(path, { method: "POST" })).rejects.toThrow(
			"Synthetic response loss",
		);
		expect(
			await (await f.send("/v13/deployments/dpl_candidate")).json(),
		).toMatchObject({ readyState: "READY", readySubstate: "PROMOTED" });
		expect(
			await (
				await f.send(
					`/v4/aliases/fixture.vercel.app?projectId=${f.project.uid}`,
				)
			).json(),
		).toMatchObject({ deploymentId: "dpl_candidate" });
	});

	it("enforces the shared transport deadline and cancels a stalled project fetch", async () => {
		vi.useFakeTimers();
		try {
			let aborted = false;
			let markStarted = () => {};
			const started = new Promise<void>((resolve) => {
				markStarted = resolve;
			});
			const projectFetch: typeof fetch = (_input, init) =>
				new Promise((_resolve, reject) => {
					init?.signal?.addEventListener(
						"abort",
						() => {
							aborted = true;
							reject(new Error("fixture cancelled"));
						},
						{ once: true },
					);
					markStarted();
				});
			const emulator = createVercelDeploymentEmulator({
				teamId: "team_fixture",
				token: TOKEN,
				projectFetch,
			});
			emulator.seedProject({
				id: "prj_fixture",
				name: "sample",
				teamId: "team_fixture",
			});
			const request = {
				method: "GET" as const,
				url: `${API}/v9/projects/prj_fixture`,
				headers: { authorization: `Bearer ${TOKEN}` },
				timeoutMs: 25,
				maxResponseBytes: 1024,
			};
			const timedOut = expect(
				emulator.transport(request),
			).rejects.toMatchObject({
				code: "TRANSPORT_TIMEOUT_EXCEEDED",
			});
			await started;
			await vi.advanceTimersByTimeAsync(request.timeoutMs);
			await timedOut;
			expect(aborted).toBe(true);
			await expect(
				emulator.transport({ ...request, timeoutMs: Number.NaN }),
			).rejects.toMatchObject({ code: "TRANSPORT_TIMEOUT_EXCEEDED" });
			await expect(
				emulator.transport({ ...request, maxResponseBytes: 1.5 }),
			).rejects.toMatchObject({ code: "TRANSPORT_BODY_TOO_LARGE" });
			await expect(
				emulator.transport({ ...request, maxResponseBytes: Number.NaN }),
			).rejects.toMatchObject({ code: "TRANSPORT_BODY_TOO_LARGE" });
		} finally {
			vi.useRealTimers();
		}
	});

	it("enforces the transport byte cap on the forwarded project response", async () => {
		const f = fixture();
		await expect(
			f.emulator.transport({
				method: "GET",
				url: `${API}/v9/projects/${f.project.uid}`,
				headers: { authorization: `Bearer ${TOKEN}` },
				timeoutMs: 1000,
				maxResponseBytes: 16,
			}),
		).rejects.toMatchObject({ code: "TRANSPORT_BODY_TOO_LARGE" });
	});

	it("does not retain an upload whose uncooperative upstream finishes after timeout", async () => {
		vi.useFakeTimers();
		try {
			let release = () => {};
			let markStarted = () => {};
			const started = new Promise<void>((resolve) => {
				markStarted = resolve;
			});
			const projectFetch: typeof fetch = (input) => {
				if (new URL(String(input)).pathname === "/v2/files")
					return new Promise((resolve) => {
						release = () => resolve(new Response("[]"));
						markStarted();
					});
				return Promise.resolve(
					new Response(
						JSON.stringify({
							id: "prj_fixture",
							name: "sample",
							accountId: "team_fixture",
							framework: null,
						}),
					),
				);
			};
			const emulator = createVercelDeploymentEmulator({
				teamId: "team_fixture",
				token: TOKEN,
				projectFetch,
			});
			emulator.seedProject({
				id: "prj_fixture",
				name: "sample",
				teamId: "team_fixture",
			});
			const body = "synthetic source";
			const sha = createHash("sha1").update(body).digest("hex");
			const timedOut = expect(
				emulator.transport({
					method: "POST",
					url: `${API}/v2/files`,
					headers: { authorization: `Bearer ${TOKEN}`, "x-vercel-digest": sha },
					body,
					timeoutMs: 25,
					maxResponseBytes: 1024,
				}),
			).rejects.toMatchObject({ code: "TRANSPORT_TIMEOUT_EXCEEDED" });
			await started;
			await vi.advanceTimersByTimeAsync(25);
			await timedOut;
			release();
			await vi.advanceTimersByTimeAsync(0);
			const deployment = await emulator.fetch(`${API}/v13/deployments`, {
				method: "POST",
				headers: { authorization: `Bearer ${TOKEN}` },
				body: JSON.stringify({
					project: "prj_fixture",
					name: "sample",
					files: [{ file: "index.html", sha, size: body.length }],
				}),
			});
			expect(deployment.status).toBe(400);
		} finally {
			vi.useRealTimers();
		}
	});

	it("accepts an opaque source archive and only serves explicitly injected responses", async () => {
		const f = fixture("READY", true);
		f.emulator.seedDeployment({
			id: "dpl_previous",
			projectId: f.project.uid,
			target: "production",
		});
		f.emulator.seedAlias("fixture.vercel.app", "dpl_previous");
		const archive = gzipSync("synthetic opaque archive bytes");
		const sha = createHash("sha1").update(archive).digest("hex");
		expect(
			(
				await f.send("/v2/files", {
					method: "POST",
					headers: { "x-vercel-digest": sha },
					body: new Uint8Array(archive),
				})
			).status,
		).toBe(200);
		const manifest = {
			name: f.project.name,
			project: f.project.uid,
			target: "production",
			autoAssignCustomDomains: false,
			files: [{ file: ".vercel/source.tgz.part1", sha, size: archive.length }],
		};
		const invalid = await f.send("/v13/deployments", {
			method: "POST",
			body: JSON.stringify({
				...manifest,
				files: [{ ...manifest.files[0], size: archive.length + 1 }],
			}),
		});
		expect(invalid.status).toBe(400);
		const multipart = await f.send("/v13/deployments", {
			method: "POST",
			body: JSON.stringify({
				...manifest,
				files: [manifest.files[0], { file: "other.txt", data: "extra" }],
			}),
		});
		expect(multipart.status).toBe(400);
		const created = await f.send("/v13/deployments", {
			method: "POST",
			body: JSON.stringify(manifest),
		});
		const deployment = await created.json();
		const copy = f.emulator.readOpaqueArchive(deployment.id);
		expect(copy).toEqual(new Uint8Array(archive));
		copy?.fill(0);
		expect(f.emulator.readOpaqueArchive(deployment.id)).toEqual(
			new Uint8Array(archive),
		);
		expect(
			(await f.emulator.fetch(`https://${deployment.url}/healthz`)).status,
		).toBe(501);
		f.emulator.setSyntheticResponses(deployment.id, {
			healthz: '{"commit":"synthetic"}',
			readyz: "synthetic ready",
		});
		expect(
			(
				await f.send(
					`/v10/projects/${f.project.uid}/promote/${deployment.id}`,
					{
						method: "POST",
					},
				)
			).status,
		).toBe(201);
		expect(
			await (
				await f.emulator.fetch("https://fixture.vercel.app/healthz")
			).text(),
		).toBe('{"commit":"synthetic"}');
		expect(
			(await f.emulator.fetch("https://fixture.vercel.app/unknown")).status,
		).toBe(501);
	});

	it("cancels a stalled request body before invoking the project emulator", async () => {
		const f = fixture();
		const controller = new AbortController();
		const body = new ReadableStream<Uint8Array>({
			pull: () => new Promise<void>(() => {}),
			cancel: () => new Promise<void>(() => {}),
		});
		const upload = f.emulator.fetch(`${API}/v2/files`, {
			method: "POST",
			headers: { authorization: `Bearer ${TOKEN}` },
			body,
			duplex: "half",
			signal: controller.signal,
		} as const);
		controller.abort();
		await expect(upload).rejects.toMatchObject({ name: "AbortError" });
		expect(f.forwarded).not.toContain("POST /v2/files");
	});

	it("bounds aggregate deployment content even for repeated uploaded references", async () => {
		const f = fixture("READY");
		const content = new Uint8Array(11 * 1024 * 1024);
		const sha = createHash("sha1").update(content).digest("hex");
		expect(
			(
				await f.send("/v2/files", {
					method: "POST",
					headers: { "x-vercel-digest": sha },
					body: content,
				})
			).status,
		).toBe(200);
		const files = ["one", "two", "three"].map((file) => ({
			file,
			sha,
			size: content.byteLength,
		}));
		const create = (entries: typeof files) =>
			f.send("/v13/deployments", {
				method: "POST",
				body: JSON.stringify({
					name: f.project.name,
					project: f.project.uid,
					files: entries,
				}),
			});
		expect((await create(files)).status).toBe(400);
		expect((await create(files.slice(0, 2))).status).toBe(200);
	});

	it("refuses an upload larger than the bounded request body", async () => {
		const f = fixture();
		await expect(
			f.emulator.fetch(`${API}/v2/files`, {
				method: "POST",
				headers: { authorization: `Bearer ${TOKEN}` },
				body: new Uint8Array(32 * 1024 * 1024 + 1),
			}),
		).rejects.toThrow("Synthetic request exceeds the byte limit");
		expect(f.forwarded).not.toContain("POST /v2/files");
	});
});
