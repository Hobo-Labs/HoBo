import type { CdContext, CredentialResolver, RunbookExecutor } from "@hobo/cd";
import type { HttpTransport, JsonValue, TransportResponse } from "@hobo/core";
import { describe, expect, it, vi } from "vitest";
import { createArgoCdControlClient } from "../src/client.js";
import {
	ARGO_CD_SYNC_RUNBOOK,
	createArgoCdRunbookExecutor,
} from "../src/hook.js";

const REV = "9f8e7d6c5b4a39281706f5e4d3c2b1a098f7e6d5";

const ctx: CdContext = Object.freeze({
	tenant: "t1",
	principal: { kind: "service", id: "test" },
	now: () => 1_700_000_000_000,
});

const credentials: CredentialResolver = {
	async resolve() {
		return { token: "synthetic" };
	},
};

function json(status: number, body: JsonValue): TransportResponse {
	return {
		status,
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	};
}

function argoApp(sync: string, health: string, revision: string) {
	return json(200, {
		metadata: { name: "hobo-prod", namespace: "argocd" },
		status: {
			sync: { status: sync, revision },
			health: { status: health },
		},
	});
}

describe("ArgoCdControlClient", () => {
	it.each([
		"http://argo.example",
		"https://user:password@argo.example",
		"https://argo.example:invalid",
		"https://argo.example/?token=not-real",
	])("refuses an unsafe API URL before resolving credentials: %s", (apiBaseUrl) => {
		const http = vi.fn<HttpTransport>();
		const resolver: CredentialResolver = { resolve: vi.fn() };
		expect(() =>
			createArgoCdControlClient(
				{
					apiBaseUrl,
					application: "hobo-prod",
					appNamespace: "argocd",
					tokenRef: "owner://ARGO_TOKEN",
				},
				http,
				resolver,
			),
		).toThrow();
		expect(http).not.toHaveBeenCalled();
		expect(resolver.resolve).not.toHaveBeenCalled();
	});

	it("keeps the validated endpoint and credential reference if the input object changes", async () => {
		const config = {
			apiBaseUrl: "https://argo.example",
			application: "hobo-prod",
			appNamespace: "argocd",
			tokenRef: "owner://ARGO_TOKEN",
		};
		const http = vi.fn<HttpTransport>(async () =>
			argoApp("Synced", "Healthy", REV),
		);
		const resolver: CredentialResolver = {
			resolve: vi.fn(async () => ({ token: "synthetic" })),
		};
		const client = createArgoCdControlClient(config, http, resolver);
		config.apiBaseUrl = "http://elsewhere.example";
		config.tokenRef = "owner://OTHER";
		await client.getWorkload({ name: "hobo-prod", namespace: "argocd" }, ctx);
		expect(http.mock.calls[0]?.[0].url).toMatch(/^https:\/\/argo\.example\//u);
		expect(resolver.resolve).toHaveBeenCalledWith(
			"owner://ARGO_TOKEN",
			expect.any(String),
		);
	});

	it("rejects invalid application paths before using credentials", async () => {
		const http = vi.fn<HttpTransport>();
		const resolver: CredentialResolver = { resolve: vi.fn() };
		const client = createArgoCdControlClient(
			{
				apiBaseUrl: "https://argo.example",
				application: "hobo-prod",
				appNamespace: "argocd",
				tokenRef: "owner://ARGO_TOKEN",
			},
			http,
			resolver,
		);
		const result = await client.getWorkload(
			{ name: "..", namespace: "argocd" },
			ctx,
		);
		expect(result.ok).toBe(false);
		expect(http).not.toHaveBeenCalled();
		expect(resolver.resolve).not.toHaveBeenCalled();
	});

	it("does not return credentials embedded in transport errors", async () => {
		const http: HttpTransport = async (request) => {
			throw new Error(`failed ${request.headers.authorization}`);
		};
		const client = createArgoCdControlClient(
			{
				apiBaseUrl: "https://argo.example",
				application: "hobo-prod",
				appNamespace: "argocd",
				tokenRef: "owner://ARGO_TOKEN",
			},
			http,
			credentials,
		);
		const result = await client.getWorkload(
			{ name: "hobo-prod", namespace: "argocd" },
			ctx,
		);
		expect(result.ok).toBe(false);
		expect(JSON.stringify(result)).not.toContain("synthetic");
	});

	it("does not report another Application as converged", async () => {
		const http: HttpTransport = async () =>
			json(200, {
				metadata: { name: "another-app", namespace: "argocd" },
				status: {
					sync: { status: "Synced", revision: REV },
					health: { status: "Healthy" },
				},
			});
		const client = createArgoCdControlClient(
			{
				apiBaseUrl: "https://argo.example",
				application: "hobo-prod",
				appNamespace: "argocd",
				tokenRef: "owner://ARGO_TOKEN",
			},
			http,
			credentials,
		);
		const observed = await client.observeSync(
			{ name: "hobo-prod", namespace: "argocd", revision: REV },
			ctx,
		);
		expect(observed.state).not.toBe("converged");
		expect(observed.healthy).toBe(false);
	});

	it("observes converged when synced on revision", async () => {
		const http: HttpTransport = async () => argoApp("Synced", "Healthy", REV);
		const client = createArgoCdControlClient(
			{
				apiBaseUrl: "https://argo.example",
				application: "hobo-prod",
				appNamespace: "argocd",
				tokenRef: "owner://ARGO_TOKEN",
			},
			http,
			credentials,
		);
		const verdict = await client.observeSync(
			{ name: "hobo-prod", namespace: "argocd", revision: REV },
			ctx,
		);
		expect(verdict.state).toBe("converged");
	});

	it.each([
		"",
		"  \t",
	])("refuses a sync without a revision before contacting Argo CD", async (revision) => {
		const http = vi.fn<HttpTransport>(async () => json(200, {}));
		const resolver: CredentialResolver = {
			resolve: vi.fn(async () => ({ token: "synthetic" })),
		};
		const client = createArgoCdControlClient(
			{
				apiBaseUrl: "https://argo.example",
				application: "hobo-prod",
				appNamespace: "argocd",
				tokenRef: "owner://ARGO_TOKEN",
			},
			http,
			resolver,
		);
		const result = await client.requestSync(
			{ name: "hobo-prod", namespace: "argocd", revision },
			ctx,
		);
		expect(result).toMatchObject({
			ok: false,
			reasons: [{ code: "argocd-body-invalid" }],
		});
		expect(http).not.toHaveBeenCalled();
		expect(resolver.resolve).not.toHaveBeenCalled();
	});

	it("sync posts revision to the sync endpoint", async () => {
		const calls: string[] = [];
		const http: HttpTransport = async (req) => {
			calls.push(`${req.method} ${req.url}`);
			if (req.method === "POST") return json(200, {});
			return argoApp("OutOfSync", "Healthy", "other");
		};
		const client = createArgoCdControlClient(
			{
				apiBaseUrl: "https://argo.example",
				application: "hobo-prod",
				appNamespace: "argocd",
				tokenRef: "owner://ARGO_TOKEN",
			},
			http,
			credentials,
		);
		const synced = await client.requestSync(
			{
				name: "hobo-prod",
				namespace: "argocd",
				revision: REV,
				manual: true,
			},
			ctx,
		);
		expect(synced.ok).toBe(true);
		expect(calls.some((c) => c.includes("/sync?"))).toBe(true);
		expect(
			calls
				.find((c) => c.startsWith("POST"))
				?.includes(encodeURIComponent("hobo-prod")),
		).toBe(true);
	});

	it("reports a missing credential before requesting a sync", async () => {
		const http = vi.fn<HttpTransport>();
		const client = createArgoCdControlClient(
			{
				apiBaseUrl: "https://argo.example",
				application: "hobo-prod",
				appNamespace: "argocd",
				tokenRef: "owner://ARGO_TOKEN",
			},
			http,
			{
				async resolve() {
					return {};
				},
			},
		);
		const result = await client.requestSync(
			{ name: "hobo-prod", namespace: "argocd", revision: REV },
			ctx,
		);
		expect(result).toMatchObject({
			ok: false,
			reasons: [{ code: "argocd-credential-missing" }],
		});
		expect(http).not.toHaveBeenCalled();
	});

	it.each([
		["other-app", "argocd"],
		["hobo-prod", "other-ns"],
	] as const)("refuses getWorkload for %s/%s before resolving credentials", async (name, namespace) => {
		const http = vi.fn<HttpTransport>();
		const resolver: CredentialResolver = { resolve: vi.fn() };
		const client = createArgoCdControlClient(
			{
				apiBaseUrl: "https://argo.example",
				application: "hobo-prod",
				appNamespace: "argocd",
				tokenRef: "owner://ARGO_TOKEN",
			},
			http,
			resolver,
		);
		const result = await client.getWorkload({ name, namespace }, ctx);
		expect(result).toMatchObject({
			ok: false,
			reasons: [
				{
					code: "argocd-body-invalid",
					message: "Argo CD client is bound to one Application",
					subject: "hobo-prod",
				},
			],
		});
		expect(http).not.toHaveBeenCalled();
		expect(resolver.resolve).not.toHaveBeenCalled();
	});

	it.each([
		["other-app", "argocd"],
		["hobo-prod", "other-ns"],
	] as const)("refuses requestSync for %s/%s before resolving credentials", async (name, namespace) => {
		const http = vi.fn<HttpTransport>();
		const resolver: CredentialResolver = { resolve: vi.fn() };
		const client = createArgoCdControlClient(
			{
				apiBaseUrl: "https://argo.example",
				application: "hobo-prod",
				appNamespace: "argocd",
				tokenRef: "owner://ARGO_TOKEN",
			},
			http,
			resolver,
		);
		const result = await client.requestSync(
			{ name, namespace, revision: REV },
			ctx,
		);
		expect(result).toMatchObject({
			ok: false,
			reasons: [
				{
					code: "argocd-body-invalid",
					message: "Argo CD client is bound to one Application",
					subject: "hobo-prod",
				},
			],
		});
		expect(http).not.toHaveBeenCalled();
		expect(resolver.resolve).not.toHaveBeenCalled();
	});

	it.each([
		["other-app", "argocd"],
		["hobo-prod", "other-ns"],
	] as const)("refuses observeSync for %s/%s before resolving credentials", async (name, namespace) => {
		const http = vi.fn<HttpTransport>();
		const resolver: CredentialResolver = { resolve: vi.fn() };
		const client = createArgoCdControlClient(
			{
				apiBaseUrl: "https://argo.example",
				application: "hobo-prod",
				appNamespace: "argocd",
				tokenRef: "owner://ARGO_TOKEN",
			},
			http,
			resolver,
		);
		const observed = await client.observeSync(
			{ name, namespace, revision: REV },
			ctx,
		);
		expect(observed).toMatchObject({
			state: "converging",
			healthy: false,
			reason: {
				code: "argocd-body-invalid",
				message: "Argo CD client is bound to one Application",
			},
		});
		expect(http).not.toHaveBeenCalled();
		expect(resolver.resolve).not.toHaveBeenCalled();
	});

	it("keeps the snapshotted Application when the config object changes", async () => {
		const config = {
			apiBaseUrl: "https://argo.example",
			application: "hobo-prod",
			appNamespace: "argocd",
			tokenRef: "owner://ARGO_TOKEN",
		};
		const http = vi.fn<HttpTransport>();
		const resolver: CredentialResolver = { resolve: vi.fn() };
		const client = createArgoCdControlClient(config, http, resolver);
		config.application = "other-app";
		config.appNamespace = "other-ns";
		const result = await client.getWorkload(
			{ name: "other-app", namespace: "other-ns" },
			ctx,
		);
		expect(result).toMatchObject({
			ok: false,
			reasons: [
				{
					code: "argocd-body-invalid",
					subject: "hobo-prod",
				},
			],
		});
		expect(http).not.toHaveBeenCalled();
		expect(resolver.resolve).not.toHaveBeenCalled();
	});

	it.each([
		[
			"another application",
			"argocd",
			{
				application: "other-app",
				appNamespace: "argocd",
				revision: REV,
			},
		],
		[
			"another namespace",
			"argocd",
			{
				application: "hobo-prod",
				appNamespace: "other-ns",
				revision: REV,
				manual: true,
			},
		],
		[
			"the default namespace",
			"tenant-a",
			{ application: "hobo-prod", revision: REV },
		],
	] as const)("refuses a RUNBOOK sync for %s before resolving credentials", async (_label, appNamespace, args) => {
		const http = vi.fn<HttpTransport>();
		const resolver: CredentialResolver = { resolve: vi.fn() };
		const client = createArgoCdControlClient(
			{
				apiBaseUrl: "https://argo.example",
				application: "hobo-prod",
				appNamespace,
				tokenRef: "owner://ARGO_TOKEN",
			},
			http,
			resolver,
		);
		let delegated = 0;
		const inner: RunbookExecutor = {
			async run() {
				delegated += 1;
				return { ok: true, value: {} };
			},
		};
		const result = await createArgoCdRunbookExecutor(inner, client).run(
			{ path: ARGO_CD_SYNC_RUNBOOK, args },
			ctx,
		);
		expect(result).toMatchObject({
			ok: false,
			reasons: [
				{
					code: "argocd-body-invalid",
					message: "Argo CD client is bound to one Application",
					subject: "hobo-prod",
				},
			],
		});
		expect(delegated).toBe(0);
		expect(http).not.toHaveBeenCalled();
		expect(resolver.resolve).not.toHaveBeenCalled();
	});
});
