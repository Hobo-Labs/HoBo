import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
	createVercelDropCliTransport,
	materializeVercelDropStation,
	parseVercelDropDeployOutput,
	provisionTemporaryEnvironmentStation,
	sanitizeVercelDropProjectName,
	supportsAnonymousTemporaryDeploy,
	type VercelDropDeployResult,
} from "../src/temporary-station.js";

function result(
	overrides: Partial<VercelDropDeployResult> = {},
): VercelDropDeployResult {
	return {
		projectName: "hobo-drop-owned",
		deploymentId: "dpl_owned",
		stationUrl: "https://owned.vercel.app",
		claimUrl: "https://vercel.com/claim-deployment?code=fake",
		anonymous: true,
		expiresAt: new Date(Date.now() + 60000).toISOString(),
		expirySource: "provider-reported",
		...overrides,
	};
}
describe("Vercel temporary deployment honesty", () => {
	it("does not advertise an anonymous API or silently invoke an account-backed CLI", async () => {
		expect(supportsAnonymousTemporaryDeploy).toBe(false);
		await expect(
			provisionTemporaryEnvironmentStation({ stationId: "owned" }),
		).rejects.toThrow(/CLI fallback is forbidden/);
		await expect(
			createVercelDropCliTransport().deployDrop({
				stationId: "owned",
				projectName: "owned",
				files: [],
				workDir: "/tmp",
			}),
		).rejects.toThrow(/authenticated account/);
	});
	it("keeps project-name derivation deterministic and provider-legal", () => {
		const name = sanitizeVercelDropProjectName("hello:@ world!");
		expect(name).toMatch(/^hobo-drop-[a-z0-9-]+$/);
		expect(name).toBe(sanitizeVercelDropProjectName("hello:@ world!"));
	});
	it("requires observed native deployment identity in JSON", () => {
		expect(
			parseVercelDropDeployOutput(
				'progress\n{"url":"owned.vercel.app","id":"dpl_owned"}\ndone',
			),
		).toEqual({
			stationUrl: "https://owned.vercel.app",
			deploymentId: "dpl_owned",
		});
		expect(() =>
			parseVercelDropDeployOutput("Production https://owned.vercel.app"),
		).toThrow(/identity/);
		expect(() =>
			parseVercelDropDeployOutput('{"url":"owned.vercel.app"}'),
		).toThrow(/identity/);
	});
	it.each([
		"https://evil.example/vercel.app",
		"https://vercel.app.evil.example",
		"http://owned.vercel.app",
		"https://user:pass@owned.vercel.app",
		"https://owned.vercel.app:444",
	])("rejects foreign output URL %s", (url) => {
		expect(() =>
			parseVercelDropDeployOutput(JSON.stringify({ url, id: "dpl_owned" })),
		).toThrow(/authority/);
	});
	it.each([
		"../secret",
		"/tmp/secret",
		"C:\\secret",
		"nested/../../secret",
		".env",
		"vercel.json",
		"package.json",
	])("rejects unsafe or executable artifact %s before writing", async (file) => {
		await expect(
			materializeVercelDropStation({
				stationId: "owned",
				files: [{ file, data: "untrusted" }],
			}),
		).rejects.toThrow(/artifact/);
	});
	it("uses a new isolated directory even under a caller-supplied artifact root", async () => {
		const root = await mkdtemp(path.join(tmpdir(), "hobo-vercel-test-"));
		try {
			const { workDir } = await materializeVercelDropStation({
				stationId: "owned",
				rootDir: root,
				files: [{ file: "nested/index.html", data: "approved" }],
			});
			expect(workDir).not.toBe(root);
			expect(
				await readFile(path.join(workDir, "nested/index.html"), "utf8"),
			).toBe("approved");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
	it("requires explicit provider-reported anonymous authority and expiry", async () => {
		for (const invalid of [
			{ anonymous: false },
			{ expirySource: undefined },
			{ expiresAt: undefined },
			{ claimUrl: "https://vercel.com/project" },
		])
			await expect(
				provisionTemporaryEnvironmentStation({
					stationId: "owned",
					transport: {
						async deployDrop() {
							return result(invalid);
						},
					},
				}),
			).rejects.toThrow(/authority|expiry|claim/);
	});
	it("returns only observed temporary identity and cleans local artifacts after a verified injected transport", async () => {
		let dir = "";
		const observed = await provisionTemporaryEnvironmentStation({
			stationId: "owned",
			transport: {
				async deployDrop(input) {
					dir = input.workDir;
					expect(
						await readFile(path.join(dir, "index.html"), "utf8"),
					).toContain("HoBo Environment Station");
					return result();
				},
			},
		});
		expect(observed.anonymous).toBe(true);
		expect(observed.accountId).toBeUndefined();
		expect(observed.scriptName).toBe("dpl_owned");
		await expect(readFile(path.join(dir, "index.html"))).rejects.toThrow();
	});
});
