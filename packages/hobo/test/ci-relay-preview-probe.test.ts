import { createBoundedFetchTransport, type TransportRequest } from "@hobo/core";
import { describe, expect, it } from "vitest";
import { protectedPreviewProbe } from "../src/ci-relay-preview-probe.js";

const request: TransportRequest = {
	method: "GET",
	url: "https://preview.invalid/healthz",
	headers: {},
	timeoutMs: 1000,
	maxResponseBytes: 1024,
};

describe("protected preview probe", () => {
	it("sends the OIDC token only to the deployment CD created", async () => {
		const sent: TransportRequest[] = [];
		const probe = protectedPreviewProbe({
			placeholderOrigin: "https://preview.invalid",
			project: "hobo-ci",
			deploymentUrl: () => "https://hobo-ci-git-main.example.vercel.app",
			jwt: async () => "synthetic-oidc-token",
			base: async (outbound) => {
				sent.push(outbound);
				return { status: 200, headers: {}, body: "{}" };
			},
		});
		expect((await probe(request)).status).toBe(200);
		expect(sent).toHaveLength(1);
		expect(sent[0]?.url).toBe(
			"https://hobo-ci-git-main.example.vercel.app/healthz",
		);
		expect(sent[0]?.headers["x-vercel-trusted-oidc-idp-token"]).toBe(
			"synthetic-oidc-token",
		);
	});

	it("fails closed for invalid deployment URLs, paths and token failures", async () => {
		for (const deploymentUrl of [
			undefined,
			"",
			"http://hobo-ci-git-main.example.vercel.app",
			"https://vercel.app.evil.test",
			"https://user@hobo-ci-git-main.example.vercel.app",
			"https://hobo-ci-git-main.example.vercel.app:444",
			"https://other.vercel.app",
			"https://other-hobo-ci.vercel.app",
			"https://hobo-ci.vercel.app.evil.test",
			"https://hobo-ci-evil.vercel.app",
			"https://hobo-ci-example.vercel.app",
			"https://hobo-ci-git-main.example.evil.test",
		]) {
			let sent = false;
			const probe = protectedPreviewProbe({
				placeholderOrigin: "https://preview.invalid",
				project: "hobo-ci",
				deploymentUrl: () => deploymentUrl,
				jwt: async () => "synthetic-oidc-token",
				base: async () => {
					sent = true;
					return { status: 200, headers: {}, body: "{}" };
				},
			});
			expect((await probe(request)).status).toBe(503);
			expect(sent).toBe(false);
		}
		let sent = false;
		const probe = protectedPreviewProbe({
			placeholderOrigin: "https://preview.invalid",
			project: "hobo-ci",
			deploymentUrl: () => "https://hobo-ci-git-main.example.vercel.app",
			jwt: async () => {
				throw new Error("token failure");
			},
			base: async () => {
				sent = true;
				return { status: 200, headers: {}, body: "{}" };
			},
		});
		expect((await probe(request)).status).toBe(503);
		expect(sent).toBe(false);
		expect(
			(await probe({ ...request, url: "https://preview.invalid/other" }))
				.status,
		).toBe(503);
		expect(sent).toBe(false);
	});

	it("surfaces a redirect answer once and never re-sends the token cross-origin", async () => {
		const calls: { url: string; init: RequestInit }[] = [];
		const probe = protectedPreviewProbe({
			placeholderOrigin: "https://preview.invalid",
			project: "hobo-ci",
			deploymentUrl: () => "https://hobo-ci-git-main.example.vercel.app",
			jwt: async () => "synthetic-oidc-token",
			base: createBoundedFetchTransport({
				fetchImpl: async (url, init) => {
					calls.push({ url: String(url), init: init ?? {} });
					return new Response("", {
						status: 302,
						headers: { location: "https://evil.test/healthz" },
					});
				},
			}),
		});
		const answer = await probe(request);
		expect(answer.status).toBe(302);
		expect(calls).toHaveLength(1);
		expect(calls[0]?.url).toBe(
			"https://hobo-ci-git-main.example.vercel.app/healthz",
		);
		expect(calls[0]?.init.redirect).toBe("manual");
		expect(
			new Headers(calls[0]?.init.headers).get(
				"x-vercel-trusted-oidc-idp-token",
			),
		).toBe("synthetic-oidc-token");
	});

	it("accepts prebuilt deployment hosts under the project prefix", async () => {
		const sent: TransportRequest[] = [];
		for (const deploymentUrl of [
			"https://hobo-ci-staged.vercel.app",
			"https://hobo-ci-abc.vercel.app",
			"https://hobo-ci-a1b2c3d4e5f67890.vercel.app",
		]) {
			const probe = protectedPreviewProbe({
				placeholderOrigin: "https://preview.invalid",
				project: "hobo-ci",
				deploymentUrl: () => deploymentUrl,
				jwt: async () => "synthetic-oidc-token",
				base: async (outbound) => {
					sent.push(outbound);
					return { status: 200, headers: {}, body: "{}" };
				},
			});
			expect((await probe(request)).status).toBe(200);
		}
		expect(sent.map((outbound) => new URL(outbound.url).origin)).toEqual([
			"https://hobo-ci-staged.vercel.app",
			"https://hobo-ci-abc.vercel.app",
			"https://hobo-ci-a1b2c3d4e5f67890.vercel.app",
		]);
	});

	it("normalizes a host-only or path-carrying deployment URL to its https origin", async () => {
		const sent: TransportRequest[] = [];
		for (const deploymentUrl of [
			"hobo-ci-git-main.example.vercel.app",
			"https://hobo-ci-git-main.example.vercel.app/anything/deep?query=1#fragment",
		]) {
			const probe = protectedPreviewProbe({
				placeholderOrigin: "https://preview.invalid",
				project: "hobo-ci",
				deploymentUrl: () => deploymentUrl,
				jwt: async () => "synthetic-oidc-token",
				base: async (outbound) => {
					sent.push(outbound);
					return { status: 200, headers: {}, body: "{}" };
				},
			});
			expect((await probe(request)).status).toBe(200);
		}
		expect(sent.map((outbound) => outbound.url)).toEqual([
			"https://hobo-ci-git-main.example.vercel.app/healthz",
			"https://hobo-ci-git-main.example.vercel.app/healthz",
		]);
	});

	it("binds each probe to the host its own deployment URL names, even when that URL mutates", async () => {
		let deploymentUrl: string | undefined =
			"https://hobo-ci-git-main.example.vercel.app";
		const sent: TransportRequest[] = [];
		const audiences: string[] = [];
		const probe = protectedPreviewProbe({
			placeholderOrigin: "https://preview.invalid",
			project: "hobo-ci",
			deploymentUrl: () => deploymentUrl,
			jwt: async (audience) => {
				audiences.push(audience);
				return "synthetic-oidc-token";
			},
			base: async (outbound) => {
				sent.push(outbound);
				return { status: 200, headers: {}, body: "{}" };
			},
		});
		expect((await probe(request)).status).toBe(200);
		deploymentUrl = "https://hobo-ci-git-next.example.vercel.app";
		expect((await probe(request)).status).toBe(200);
		deploymentUrl = "https://hobo-ci-evil.vercel.app";
		expect((await probe(request)).status).toBe(503);
		expect(sent.map((outbound) => outbound.url)).toEqual([
			"https://hobo-ci-git-main.example.vercel.app/healthz",
			"https://hobo-ci-git-next.example.vercel.app/healthz",
		]);
		expect(audiences).toEqual([
			"https://hobo-ci-git-main.example.vercel.app",
			"https://hobo-ci-git-next.example.vercel.app",
		]);
		for (const outbound of sent)
			expect(new URL(outbound.url).origin).toBe(
				audiences[sent.indexOf(outbound)],
			);
	});
});
