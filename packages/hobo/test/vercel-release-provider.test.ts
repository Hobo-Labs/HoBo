import { describe, expect, it } from "vitest";
import {
	promoteVerifiedRelease,
	type ReleaseCheckpoint,
	type ReleaseJournal,
} from "../src/release-controller.js";
import { createVercelReleaseProvider } from "../src/vercel-release-provider.js";

const COMMIT = "0123456789abcdef0123456789abcdef01234567";

describe("Vercel release provider", () => {
	it("promotes the staged project deployment and verifies public health without changing protection", async () => {
		let current = "dpl_old";
		let checkpoint: ReleaseCheckpoint | undefined;
		let time = 0;
		const calls: { url: URL; init: RequestInit }[] = [];
		const fetcher: typeof fetch = async (raw, init) => {
			const url = new URL(String(raw));
			calls.push({ url, init: init ?? {} });
			if (url.hostname === "hobo-ci.vercel.app") {
				if (url.pathname === "/healthz")
					return Response.json({ commit: COMMIT });
				return Response.json({ ready: true });
			}
			if (url.pathname === "/v13/deployments/dpl_new")
				return Response.json({
					id: "dpl_new",
					projectId: "prj_test",
					target: "production",
					readyState: "READY",
					meta: { hoboSourceCommit: COMMIT, hoboStagedProduction: "true" },
				});
			if (url.pathname === "/v13/deployments/dpl_old")
				return Response.json({
					id: "dpl_old",
					projectId: "prj_test",
					target: "production",
					readyState: "READY",
				});
			if (url.pathname.startsWith("/v4/aliases/"))
				return Response.json({
					alias: "hobo-ci.vercel.app",
					projectId: "prj_test",
					deploymentId: current,
					protectionBypass: { ignored: "sensitive" },
				});
			if (url.pathname === "/v10/projects/prj_test/promote/dpl_new") {
				current = "dpl_new";
				return Response.json({});
			}
			return new Response(null, { status: 404 });
		};
		const journal: ReleaseJournal = {
			async load() {
				return checkpoint;
			},
			async reserve(value) {
				if (checkpoint) return { checkpoint, created: false };
				checkpoint = value;
				return { checkpoint, created: true };
			},
			async save(value) {
				checkpoint = value;
			},
		};
		const provider = createVercelReleaseProvider({
			token: "test-token",
			teamId: "team_test",
			projectId: "prj_test",
			productionOrigin: "https://hobo-ci.vercel.app",
			fetch: fetcher,
		});
		expect(
			await promoteVerifiedRelease({
				provider,
				journal,
				deploymentId: "dpl_new",
				commit: COMMIT,
				deadline: 100,
				now: () => time,
				sleep: async (ms) => {
					time += ms;
				},
				intervalMs: 10,
			}),
		).toEqual({ ok: true, previousDeploymentId: "dpl_old" });
		expect(
			calls
				.filter((call) => call.url.hostname === "hobo-ci.vercel.app")
				.every((call) => call.init.headers === undefined),
		).toBe(true);
		expect(calls.every((call) => call.init.redirect === "error")).toBe(true);
		expect(
			calls.some((call) =>
				/protection-bypass|_vercel_share/u.test(call.url.href),
			),
		).toBe(false);
	});

	it("refuses untrusted origins and another project's candidate", async () => {
		expect(() =>
			createVercelReleaseProvider({
				token: "test-token",
				teamId: "team_test",
				projectId: "prj_test",
				productionOrigin: "https://internal.example",
			}),
		).toThrow();
		const provider = createVercelReleaseProvider({
			token: "test-token",
			teamId: "team_test",
			projectId: "prj_test",
			productionOrigin: "https://hobo-ci.vercel.app",
			fetch: async () =>
				Response.json({ id: "dpl_new", projectId: "prj_other", meta: {} }),
		});
		await expect(provider.inspect("dpl_new")).rejects.toThrow(/invalid/i);
	});
});
