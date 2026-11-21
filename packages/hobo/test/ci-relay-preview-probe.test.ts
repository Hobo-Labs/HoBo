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
			deploymentUrl: () => "https://hobo-ci-example.vercel.app",
			jwt: async () => "synthetic-oidc-token",
			base: async (outbound) => {
				sent.push(outbound);
				return { status: 200, headers: {}, body: "{}" };
			},
		});
		expect((await probe(request)).status).toBe(200);
		expect(sent).toHaveLength(1);
		expect(sent[0]?.url).toBe("https://hobo-ci-example.vercel.app/healthz");
		expect(sent[0]?.headers["x-vercel-trusted-oidc-idp-token"]).toBe(
			"synthetic-oidc-token",
		);
	});

	it("fails closed for invalid deployment URLs, paths and token failures", async () => {
		for (const deploymentUrl of [
			undefined,
			"",
			"http://evil.vercel.app",
			"https://vercel.app.evil.test",
			"https://user@a.vercel.app",
			"https://a.vercel.app:444",
		]) {
			let sent = false;
			const probe = protectedPreviewProbe({
				placeholderOrigin: "https://preview.invalid",
				deploymentUrl: () => deploymentUrl,
				jwt: async () => "synthetic-oidc-token",
				base: async () => {
					sent = true;
					throw new Error("unexpected");
				},
			});
			expect((await probe(request)).status).toBe(503);
			expect(sent).toBe(false);
		}
		const probe = protectedPreviewProbe({
			placeholderOrigin: "https://preview.invalid",
			deploymentUrl: () => "https://a.vercel.app",
			jwt: async () => {
				throw new Error("token failure");
			},
			base: async () => {
				throw new Error("unexpected");
			},
		});
		expect((await probe(request)).status).toBe(503);
		expect(
			(await probe({ ...request, url: "https://preview.invalid/other" }))
				.status,
		).toBe(503);
	});

	it("surfaces a redirect answer once and never re-sends the token cross-origin", async () => {
		const calls: { url: string; init: RequestInit }[] = [];
		const probe = protectedPreviewProbe({
			placeholderOrigin: "https://preview.invalid",
			deploymentUrl: () => "https://hobo-ci-example.vercel.app",
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
		expect(calls[0]?.url).toBe("https://hobo-ci-example.vercel.app/healthz");
		expect(calls[0]?.init.redirect).toBe("manual");
		expect(
			new Headers(calls[0]?.init.headers).get(
				"x-vercel-trusted-oidc-idp-token",
			),
		).toBe("synthetic-oidc-token");
	});

	it("normalizes a host-only or path-carrying deployment URL to its https origin", async () => {
		const sent: TransportRequest[] = [];
		for (const deploymentUrl of [
			"hobo-ci-example.vercel.app",
			"https://hobo-ci-example.vercel.app/anything/deep?query=1#fragment",
		]) {
			const probe = protectedPreviewProbe({
				placeholderOrigin: "https://preview.invalid",
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
			"https://hobo-ci-example.vercel.app/healthz",
			"https://hobo-ci-example.vercel.app/healthz",
		]);
	});
});
