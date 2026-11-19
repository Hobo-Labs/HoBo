import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { deployVercelSource } from "../src/vercel-source-upload.js";

const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const TOKEN = "a-secret-for-the-fake-only";
const content = Buffer.from("same bytes\n");
const digest = createHash("sha1").update(content).digest("hex");

describe("Vercel source delivery", () => {
	it("does not dispatch after the owner session is revoked", async () => {
		const controller = new AbortController();
		controller.abort();
		let calls = 0;
		await expect(
			deployVercelSource({
				token: TOKEN,
				teamId: "team_123",
				project: "prj_123",
				name: "hobo-ci",
				repository: "Hobo-Labs/HoBo",
				ref: "main",
				rootDirectory: "packages/ci-vercel",
				source: {
					commit: COMMIT,
					files: [{ path: "a", mode: "100644", content }],
				},
				target: "production",
				signal: controller.signal,
				fetch: async () => {
					calls++;
					return Response.json({});
				},
			}),
		).rejects.toThrow(/owner session changed/u);
		expect(calls).toBe(0);
	});

	it.each([
		"nested",
		"top-level",
	])("uploads missing files from a %s error and stages production", async (errorLocation) => {
		const requests: { url: string; init: RequestInit }[] = [];
		const fetcher: typeof fetch = async (url, init) => {
			requests.push({ url: String(url), init: init ?? {} });
			if (requests.length === 1)
				return Response.json(
					errorLocation === "nested"
						? { error: { code: "missing_files", missing: [digest] } }
						: { code: "missing_files", missing: [digest] },
					{ status: 400 },
				);
			if (requests.length === 2) return new Response(null, { status: 200 });
			return Response.json({ id: "dpl_123", url: "relay-abc.vercel.app" });
		};
		const result = await deployVercelSource({
			token: TOKEN,
			teamId: "team_123",
			project: "prj_123",
			name: "hobo-ci",
			repository: "Hobo-Labs/HoBo",
			ref: "main",
			rootDirectory: "packages/ci-vercel",
			source: {
				commit: COMMIT,
				files: [
					{ path: "packages/ci-vercel/a.txt", mode: "100644", content },
					{ path: "packages/ci-vercel/b.txt", mode: "100755", content },
				],
			},
			target: "production",
			fetch: fetcher,
		});
		expect(result).toEqual({
			id: "dpl_123",
			url: "https://relay-abc.vercel.app",
		});
		expect(requests.map((r) => new URL(r.url).pathname)).toEqual([
			"/v13/deployments",
			"/v2/files",
			"/v13/deployments",
		]);
		const body = JSON.parse(String(requests[0]?.init.body));
		expect(body.gitSource).toBeUndefined();
		expect(body.autoAssignCustomDomains).toBe(false);
		expect(body.gitMetadata.commitSha).toBe(COMMIT);
		expect(body.env.HOBO_CI_SOURCE_SHA).toBe(COMMIT);
		expect(body.files).toEqual([
			{
				file: "packages/ci-vercel/a.txt",
				sha: digest,
				size: content.length,
				mode: 33188,
			},
			{
				file: "packages/ci-vercel/b.txt",
				sha: digest,
				size: content.length,
				mode: 33261,
			},
		]);
		const uploadBody = requests[1]?.init.body;
		if (!(uploadBody instanceof Uint8Array))
			throw new Error("Expected binary upload bytes.");
		expect(Buffer.from(uploadBody)).toEqual(content);
		expect(JSON.stringify(requests[0]?.init.body)).not.toContain(TOKEN);
	});

	it("refuses an unrequested digest without uploading or creating a deployment", async () => {
		let calls = 0;
		const fetcher: typeof fetch = async () => {
			calls++;
			return Response.json(
				{ error: { code: "missing_files", missing: ["f".repeat(40)] } },
				{ status: 400 },
			);
		};
		await expect(
			deployVercelSource({
				token: TOKEN,
				teamId: "team_123",
				project: "prj_123",
				name: "hobo-ci",
				repository: "Hobo-Labs/HoBo",
				ref: "main",
				rootDirectory: "packages/ci-vercel",
				source: {
					commit: COMMIT,
					files: [{ path: "a", mode: "100644", content }],
				},
				target: "preview",
				fetch: fetcher,
			}),
		).rejects.toThrow(/missing file/i);
		expect(calls).toBe(1);
	});

	it("does not create a deployment when a required upload fails, and never echoes the token", async () => {
		const paths: string[] = [];
		const fetcher: typeof fetch = async (url) => {
			paths.push(new URL(String(url)).pathname);
			if (paths.length === 1)
				return Response.json(
					{ error: { code: "missing_files", missing: [digest] } },
					{ status: 400 },
				);
			return Response.json({ error: { message: TOKEN } }, { status: 403 });
		};
		const failure = await deployVercelSource({
			token: TOKEN,
			teamId: "team_123",
			project: "prj_123",
			name: "hobo-ci",
			repository: "Hobo-Labs/HoBo",
			ref: "main",
			rootDirectory: "packages/ci-vercel",
			source: {
				commit: COMMIT,
				files: [{ path: "a", mode: "100644", content }],
			},
			target: "production",
			fetch: fetcher,
		}).catch((error: Error) => error);
		expect(failure).toBeInstanceOf(Error);
		expect(String(failure)).not.toContain(TOKEN);
		expect(paths).toEqual(["/v13/deployments", "/v2/files"]);
	});

	it("bounds provider response bodies before parsing them", async () => {
		const fetcher: typeof fetch = async () =>
			new Response("ignored", { headers: { "content-length": "3000000" } });
		await expect(
			deployVercelSource({
				token: TOKEN,
				teamId: "team_123",
				project: "hobo-ci",
				name: "hobo-ci",
				repository: "Hobo-Labs/HoBo",
				ref: "main",
				rootDirectory: "packages/ci-vercel",
				source: {
					commit: COMMIT,
					files: [{ path: "a", mode: "100644", content }],
				},
				target: "preview",
				fetch: fetcher,
			}),
		).rejects.toThrow(/invalid deployment response/u);
	});
});
