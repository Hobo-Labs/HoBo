/**
 * The image store: pulls over the registry API from a fake registry, checks
 * every digest, unpacks layers in order with whiteouts, caches by manifest.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
	createRegistryImageStore,
	parseImageReference,
} from "../../src/sandbox/image.js";

const root = mkdtempSync(join(tmpdir(), "hobo-l38-image-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const digest = (bytes: Uint8Array) =>
	`sha256:${createHash("sha256").update(bytes).digest("hex")}`;

/** A gzipped tar of `files` (path → content; content undefined makes a directory). */
function layer(
	name: string,
	files: Readonly<Record<string, string | undefined>>,
): Uint8Array {
	const dir = join(root, `layer-${name}`);
	mkdirSync(dir, { recursive: true });
	for (const [path, content] of Object.entries(files)) {
		const target = join(dir, path);
		if (content === undefined) mkdirSync(target, { recursive: true });
		else {
			mkdirSync(join(target, ".."), { recursive: true });
			writeFileSync(target, content);
		}
	}
	const archive = join(root, `${name}.tar.gz`);
	execFileSync("tar", ["-czf", archive, "-C", dir, "."]);
	return new Uint8Array(readFileSync(archive));
}

type Registry = Readonly<{
	fetch: typeof fetch;
	requests: string[];
	indexDigest: string;
}>;

function registry(): Registry {
	const base = layer("base", {
		"bin/tool": "v1",
		"etc/config": "base",
		"opt/old/file": "old",
		"var/keep/a": "a",
	});
	const top = layer("top", {
		"bin/tool": "v2",
		"etc/.wh.config": "",
		"opt/.wh.old": "",
		"var/keep/.wh..wh..opq": "",
		"var/keep/b": "b",
	});
	const json = (
		value: Readonly<
			Record<
				string,
				| string
				| readonly Readonly<
						Record<string, string | Readonly<Record<string, string>>>
				  >[]
			>
		>,
	) => new TextEncoder().encode(JSON.stringify(value));
	const manifest = json({
		mediaType: "application/vnd.oci.image.manifest.v1+json",
		layers: [{ digest: digest(base) }, { digest: digest(top) }],
	});
	const index = json({
		mediaType: "application/vnd.oci.image.index.v1+json",
		manifests: [
			{
				digest: "sha256:" + "0".repeat(64),
				platform: { os: "linux", architecture: "s390x" },
			},
			{
				digest: digest(manifest),
				platform: { os: "linux", architecture: "amd64" },
			},
		],
	});
	const blobs = new Map<string, Uint8Array>([
		[`/v2/library/tool/manifests/1.0`, index],
		[`/v2/library/tool/manifests/${digest(index)}`, index],
		[`/v2/library/tool/manifests/${digest(manifest)}`, manifest],
		[`/v2/library/tool/blobs/${digest(base)}`, base],
		[`/v2/library/tool/blobs/${digest(top)}`, top],
	]);
	const requests: string[] = [];
	const fake = async (input: string | URL | Request, init?: RequestInit) => {
		const url = new URL(String(input));
		requests.push(`${url.host}${url.pathname}`);
		if (url.host === "auth.example") {
			expect(url.searchParams.get("scope")).toBe(
				"repository:library/tool:pull",
			);
			return new Response(JSON.stringify({ token: "anon-token" }));
		}
		const headers = new Headers(init?.headers);
		if (headers.get("authorization") !== "Bearer anon-token")
			return new Response("", {
				status: 401,
				headers: {
					"www-authenticate":
						'Bearer realm="https://auth.example/token",service="registry.example"',
				},
			});
		const body = blobs.get(url.pathname);
		return body === undefined
			? new Response("", { status: 404 })
			: new Response(Buffer.from(body));
	};
	return { fetch: fake, requests, indexDigest: digest(index) };
}

describe("parseImageReference", () => {
	it.each([
		["busybox", "registry-1.docker.io", "library/busybox", "latest", undefined],
		[
			"docker.io/library/busybox:1.37",
			"registry-1.docker.io",
			"library/busybox",
			"1.37",
			undefined,
		],
		[
			"ghcr.io/hobo/runner:2@sha256:" + "a".repeat(64),
			"ghcr.io",
			"hobo/runner",
			"2",
			"sha256:" + "a".repeat(64),
		],
		["localhost:5000/tool", "localhost:5000", "tool", "latest", undefined],
		["hobo/runner", "registry-1.docker.io", "hobo/runner", "latest", undefined],
	])("%s", (image, registryHost, repository, tag, pinned) => {
		expect(parseImageReference(image)).toEqual({
			registry: registryHost,
			repository,
			tag,
			digest: pinned,
		});
	});

	it("refuses what is not a reference", () => {
		expect(parseImageReference("Not An Image")).toBeUndefined();
		expect(parseImageReference("busybox@sha256:short")).toBeUndefined();
	});
});

describe("createRegistryImageStore", () => {
	it("pulls this platform's manifest anonymously, applies layers with whiteouts, and caches by digest", async () => {
		const fake = registry();
		const store = createRegistryImageStore({
			cacheDir: join(root, "cache-1"),
			fetch: fake.fetch,
			architecture: "amd64",
		});
		const rootfs = await store.rootfs("registry.example/library/tool:1.0");
		expect(readFileSync(join(rootfs, "bin/tool"), "utf8")).toBe("v2");
		expect(existsSync(join(rootfs, "etc/config"))).toBe(false);
		expect(existsSync(join(rootfs, "etc/.wh.config"))).toBe(false);
		expect(existsSync(join(rootfs, "opt/old"))).toBe(false);
		expect(existsSync(join(rootfs, "var/keep/a"))).toBe(false);
		expect(readFileSync(join(rootfs, "var/keep/b"), "utf8")).toBe("b");
		expect(existsSync(join(rootfs, "var/keep/.wh..wh..opq"))).toBe(false);

		const again = createRegistryImageStore({
			cacheDir: join(root, "cache-1"),
			fetch: fake.fetch,
			architecture: "amd64",
		});
		const before = fake.requests.filter((path) =>
			path.includes("/blobs/"),
		).length;
		expect(await again.rootfs("registry.example/library/tool:1.0")).toBe(
			rootfs,
		);
		expect(
			fake.requests.filter((path) => path.includes("/blobs/")).length,
		).toBe(before);
	});

	it("checks a pinned digest against the manifest it fetched", async () => {
		const fake = registry();
		const store = createRegistryImageStore({
			cacheDir: join(root, "cache-2"),
			fetch: fake.fetch,
			architecture: "amd64",
		});
		await expect(
			store.rootfs(
				`registry.example/library/tool:1.0@sha256:${"b".repeat(64)}`,
			),
		).rejects.toThrow();
		await expect(
			store.rootfs(`registry.example/library/tool:1.0@${fake.indexDigest}`),
		).resolves.toContain("rootfs");
	});

	it("refuses a layer whose bytes do not match its digest", async () => {
		const fake = registry();
		const tampered: typeof fetch = async (input, init) => {
			const answer = await fake.fetch(input, init);
			return String(input).includes("/blobs/") && answer.ok
				? new Response(new TextEncoder().encode("tampered"))
				: answer;
		};
		const store = createRegistryImageStore({
			cacheDir: join(root, "cache-3"),
			fetch: tampered,
			architecture: "amd64",
		});
		await expect(
			store.rootfs("registry.example/library/tool:1.0"),
		).rejects.toThrow(/digest check/u);
		expect(existsSync(join(root, "cache-3", "rootfs"))).toBe(true);
	});

	it("refuses an image without a manifest for this platform", async () => {
		const store = createRegistryImageStore({
			cacheDir: join(root, "cache-4"),
			fetch: registry().fetch,
			architecture: "riscv64",
		});
		await expect(
			store.rootfs("registry.example/library/tool:1.0"),
		).rejects.toThrow(/linux\/riscv64/u);
	});
});
