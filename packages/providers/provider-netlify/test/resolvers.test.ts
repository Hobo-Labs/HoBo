import { createHash } from "node:crypto";
import type {
	HttpTransport,
	ResolveRequest,
	ResourceMutationJournal,
} from "@hobo/core";
import { describe, expect, it } from "vitest";
import { NETLIFY_AUTHENTICATED_SITE_DEFINITION_ID } from "../src/definitions.js";
import { isJsonObject, type JsonObject } from "../src/json.js";
import {
	NETLIFY_STATIC_DEPLOY_PRODUCT_ID,
	netlifyResolverRegistry,
} from "../src/resolvers.js";

function journal(): ResourceMutationJournal {
	const states = new Map<
		string,
		{ digest: string; status: "acknowledged" | "uncertain" }
	>();
	return {
		persistence: "durable-cas",
		async claim({ mutationId, requestDigest }) {
			const prior = states.get(mutationId);
			if (prior) {
				if (prior.digest !== requestDigest)
					throw new Error("mutation payload identity conflict");
				return { status: prior.status };
			}
			states.set(mutationId, { digest: requestDigest, status: "uncertain" });
			return { status: "claimed" };
		},
		async acknowledge(id, digest) {
			states.set(id, { digest, status: "acknowledged" });
		},
		async uncertain(id, digest) {
			states.set(id, { digest, status: "uncertain" });
		},
	};
}
function request(
	productId = NETLIFY_AUTHENTICATED_SITE_DEFINITION_ID,
	desired: JsonObject = { name: "example", operationId: "create-one" },
): ResolveRequest {
	return {
		ref: { slot: "web", productId, logicalId: "example" },
		credentialRef: "hobo-secret://netlify/account",
		desired,
	};
}
function harness(
	options: {
		lostDeployAck?: boolean;
		owner?: string;
		deletionPending?: boolean;
	} = {},
) {
	const sites = new Map<string, JsonObject>();
	const deploys = new Map<string, JsonObject>();
	const uploaded = new Map<string, Map<string, string>>();
	const calls: { method: string; path: string }[] = [];
	let lost = false;
	const transport: HttpTransport = async (call) => {
		const url = new URL(call.url),
			path = url.pathname.replace("/api/v1", "");
		calls.push({ method: call.method, path });
		if (url.hostname.endsWith(".netlify.app")) {
			const deployId = url.hostname.split(".")[0] ?? "";
			const content = uploaded.get(deployId)?.get(path);
			return {
				status: content === undefined ? 404 : 200,
				headers: {},
				body: content ?? "",
			};
		}
		const body =
			call.headers["content-type"] === "application/octet-stream"
				? {}
				: JSON.parse(call.body ?? "{}");
		const answer = (
			status: number,
			record: JsonObject | JsonObject[] | null,
		) => ({ status, headers: {}, body: JSON.stringify(record) });
		if (path === "/accounts" && call.method === "GET")
			return answer(200, [{ id: "account", slug: "team" }]);
		if (path === "/team/sites" && call.method === "GET")
			return answer(
				200,
				[...sites.values()].filter(
					(site) => site.name === url.searchParams.get("name"),
				),
			);
		if (path === "/team/sites" && call.method === "POST") {
			const site = {
				id: `site-${sites.size + 1}`,
				name: body.name,
				account_id: options.owner ?? "account",
			};
			sites.set(site.id, site);
			return answer(201, site);
		}
		const parts = path.split("/").filter(Boolean);
		if (parts[0] === "sites" && parts[2] === "deploys" && call.method === "GET")
			return answer(
				200,
				[...deploys.values()].filter((deploy) => deploy.site_id === parts[1]),
			);
		if (
			parts[0] === "sites" &&
			parts[2] === "deploys" &&
			call.method === "POST"
		) {
			const deploy = {
				id: `deploy-${deploys.size + 1}`,
				site_id: parts[1],
				title: url.searchParams.get("title"),
				state: "uploading",
				required: Object.values(body.files),
				manifest: body.files,
				deploy_ssl_url: `https://deploy-${deploys.size + 1}.netlify.app`,
			};
			deploys.set(deploy.id, deploy);
			if (options.lostDeployAck && !lost) {
				lost = true;
				throw new Error("response lost after mutation");
			}
			return answer(200, deploy);
		}
		if (parts[0] === "sites" && parts.length === 2) {
			const site = sites.get(parts[1] ?? "");
			if (!site) return answer(404, {});
			if (call.method === "DELETE") {
				if (!options.deletionPending) sites.delete(parts[1] ?? "");
				return answer(204, null);
			}
			return answer(200, site);
		}
		if (parts[0] === "deploys") {
			const deploy = deploys.get(parts[1] ?? "");
			if (!deploy) return answer(404, {});
			if (call.method === "GET") return answer(200, deploy);
			if (call.method === "DELETE") {
				if (!options.deletionPending) deploys.delete(parts[1] ?? "");
				return answer(204, null);
			}
			if (call.method === "PUT" && parts[2] === "files") {
				const path = `/${parts.slice(3).map(decodeURIComponent).join("/")}`,
					hash = createHash("sha1")
						.update(call.body ?? "")
						.digest("hex");
				if (!isJsonObject(deploy.manifest) || deploy.manifest[path] !== hash)
					return answer(400, {});
				const id = String(deploy.id),
					files = uploaded.get(id) ?? new Map<string, string>();
				files.set(path, call.body ?? "");
				uploaded.set(id, files);
				if (!Array.isArray(deploy.required)) throw new Error("invalid fixture");
				const required = deploy.required.filter((value) => value !== hash),
					updated = {
						...deploy,
						required,
						state: required.length ? "uploading" : "ready",
					};
				deploys.set(String(deploy.id), updated);
				return answer(200, { path });
			}
		}
		throw new Error(`unmatched ${call.method} ${path}`);
	};
	const registry = netlifyResolverRegistry({
		accountId: "account",
		accountSlug: "team",
		resolveCredential: async () => "material",
		mutationJournal: journal(),
	});
	const resolver = (productId: string) => {
		const value = registry.get(productId);
		if (!value) throw new Error("missing resolver");
		return value;
	};
	return { sites, deploys, calls, transport, resolver };
}

describe("authenticated Netlify lifecycle", () => {
	it("creates, independently observes, adopts and deletes an account-scoped site", async () => {
		const h = harness(),
			r = h.resolver(NETLIFY_AUTHENTICATED_SITE_DEFINITION_ID),
			wanted = request();
		const created = await r.reconcile(wanted, h.transport);
		expect(created.outputs.ready).toBe(false);
		expect((await r.reconcile(wanted, h.transport)).action).toBe("adopt");
		expect(h.calls.filter((call) => call.method === "POST")).toHaveLength(1);
		const known = {
			...wanted,
			ref: { ...wanted.ref, physicalId: created.physicalId },
		};
		await r.delete(known, h.transport);
		expect(await r.read?.(known, h.transport)).toBeUndefined();
	});
	it("uploads the approved file hashes and reports ready only after independent deployment readback", async () => {
		const h = harness();
		h.sites.set("site-1", {
			id: "site-1",
			name: "example",
			account_id: "account",
		});
		const wanted = request(NETLIFY_STATIC_DEPLOY_PRODUCT_ID, {
			siteId: "site-1",
			operationId: "deploy-one",
			files: { "/index.html": "hello" },
		});
		const r = h.resolver(NETLIFY_STATIC_DEPLOY_PRODUCT_ID),
			created = await r.reconcile(wanted, h.transport);
		expect(created.outputs.ready).toBe(true);
		expect(created.outputs.artifactDigest).toMatch(/^sha256:/);
		expect(created.outputs.servingEndpoint).toBe(
			"https://deploy-1.netlify.app",
		);
		expect((await r.reconcile(wanted, h.transport)).action).toBe("adopt");
		expect(h.calls.filter((call) => call.method === "POST")).toHaveLength(1);
		await r.delete(
			{ ...wanted, ref: { ...wanted.ref, physicalId: created.physicalId } },
			h.transport,
		);
		expect(h.deploys.size).toBe(0);
	});
	it("a lost deployment acknowledgement never permits a second POST", async () => {
		const h = harness({ lostDeployAck: true });
		h.sites.set("site-1", {
			id: "site-1",
			name: "example",
			account_id: "account",
		});
		const wanted = request(NETLIFY_STATIC_DEPLOY_PRODUCT_ID, {
				siteId: "site-1",
				operationId: "lost",
				files: { "/index.html": "hello" },
			}),
			r = h.resolver(NETLIFY_STATIC_DEPLOY_PRODUCT_ID);
		await expect(r.reconcile(wanted, h.transport)).rejects.toThrow(
			"response lost",
		);
		await r.reconcile(wanted, h.transport);
		expect(h.calls.filter((call) => call.method === "POST")).toHaveLength(1);
	});
	it("will not confuse deletion acknowledgement with observed absence", async () => {
		const h = harness({ deletionPending: true }),
			r = h.resolver(NETLIFY_AUTHENTICATED_SITE_DEFINITION_ID),
			wanted = request();
		const created = await r.reconcile(wanted, h.transport),
			known = {
				...wanted,
				ref: { ...wanted.ref, physicalId: created.physicalId },
			};
		await r.delete(known, h.transport);
		expect(await r.read?.(known, h.transport)).toBeDefined();
	});
	it("refuses a foreign owning account before adopting or uploading", async () => {
		const h = harness();
		h.sites.set("foreign", {
			id: "foreign",
			name: "example",
			account_id: "other",
		});
		await expect(
			h
				.resolver(NETLIFY_AUTHENTICATED_SITE_DEFINITION_ID)
				.reconcile(request(), h.transport),
		).rejects.toThrow("different owning account");
		expect(h.calls.every((call) => call.method === "GET")).toBe(true);
	});
	it("requires a durable journal before allocating a new site", async () => {
		const h = harness(),
			r = netlifyResolverRegistry({
				accountId: "account",
				accountSlug: "team",
				resolveCredential: async () => "material",
			}).get(NETLIFY_AUTHENTICATED_SITE_DEFINITION_ID);
		if (!r) throw new Error("missing resolver");
		await expect(r.reconcile(request(), h.transport)).rejects.toThrow(
			"durable mutation journal",
		);
		expect(h.calls.every((call) => call.method === "GET")).toBe(true);
	});
});

describe("Netlify account and credential proof before allocation", () => {
	it("requires account slug and account ID to identify the same native account before site POST", async () => {
		const resolver = netlifyResolverRegistry({
			accountId: "approved",
			accountSlug: "wrong-team",
			resolveCredential: async () => "material",
			mutationJournal: journal(),
		}).get(NETLIFY_AUTHENTICATED_SITE_DEFINITION_ID);
		if (!resolver) throw new Error("missing resolver");
		const calls: string[] = [];
		await expect(
			resolver.reconcile(request(), async (call) => {
				calls.push(call.method);
				return {
					status: 200,
					headers: {},
					body: new URL(call.url).pathname.endsWith("/accounts")
						? JSON.stringify([{ id: "foreign", slug: "wrong-team" }])
						: "[]",
				};
			}),
		).rejects.toThrow(/account slug/);
		expect(calls).toEqual(["GET", "GET"]);
	});
	it("refuses raw credential material before invoking a transport", async () => {
		const h = harness();
		await expect(
			h
				.resolver(NETLIFY_AUTHENTICATED_SITE_DEFINITION_ID)
				.reconcile(
					{ ...request(), credentialRef: "plaintext-token" },
					h.transport,
				),
		).rejects.toThrow(/credential|custody/);
		expect(h.calls).toHaveLength(0);
	});
	it.each([
		{ maxArtifactBytes: Number.POSITIVE_INFINITY },
		{ maxArtifactBytes: 0 },
		{ maxArtifactFiles: 100000 },
	])("refuses unbounded artifact policy %j", (limits) => {
		expect(() =>
			netlifyResolverRegistry({
				accountId: "account",
				accountSlug: "team",
				resolveCredential: async () => "material",
				...limits,
			}),
		).toThrow(/bounded artifact/);
	});
	it.each([
		"https://evil.example",
		"https://deploy-1.netlify.app.evil.example",
		"https://user:pass@deploy-1.netlify.app",
		"https://deploy-1.netlify.app/path?token=private",
	])("refuses a foreign or non-root immutable serving endpoint %s", async (url) => {
		const h = harness(),
			site = await h
				.resolver(NETLIFY_AUTHENTICATED_SITE_DEFINITION_ID)
				.reconcile(request(), h.transport),
			deployRequest = request(NETLIFY_STATIC_DEPLOY_PRODUCT_ID, {
				siteId: site.physicalId,
				operationId: "endpoint-proof",
				files: { "/index.html": "approved" },
			}),
			r = h.resolver(NETLIFY_STATIC_DEPLOY_PRODUCT_ID),
			created = await r.reconcile(deployRequest, h.transport),
			native = h.deploys.get(created.physicalId);
		if (!native) throw new Error("missing deployment fixture");
		h.deploys.set(created.physicalId, { ...native, deploy_ssl_url: url });
		await expect(
			r.read?.(
				{
					...deployRequest,
					ref: { ...deployRequest.ref, physicalId: created.physicalId },
				},
				h.transport,
			),
		).rejects.toThrow(/hosting authority/);
	});
});
