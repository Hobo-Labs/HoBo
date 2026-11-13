/**
 * Provisioning the pinned gVisor runtime (D58, A10): every branch of
 * `resolveSandboxRuntime` with a fake fetch, over the embedded fixture
 * tarball (a real SHA-512 check and the real in-process unpacker) or a fake
 * extractor.
 */
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
	GVISOR_PIN,
	type GvisorPin,
	gvisorArch,
	gvisorTarballUrl,
	provisionGvisor,
	resolveSandboxRuntime,
	runtimeDir,
} from "../../src/sandbox/runtime-provision.js";
import { FIXTURE_SHA512, FIXTURE_TARBALL } from "./gvisor-fixture.js";

const root = mkdtempSync(join(tmpdir(), "hobo-l40-provision-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const fixture = Buffer.from(FIXTURE_TARBALL, "base64");
/** The pinned release, with the fixture's digest in place of the real ones. */
const FIXTURE_PIN: GvisorPin = {
	release: GVISOR_PIN.release,
	sha512: { x86_64: FIXTURE_SHA512, aarch64: FIXTURE_SHA512 },
};

type FakeFetch = typeof fetch & { urls: string[] };

function fakeFetch(
	answer: () => Response | Promise<Response> = () =>
		new Response(new Uint8Array(fixture)),
): FakeFetch {
	const urls: string[] = [];
	const fake = async (input: string | URL | Request) => {
		urls.push(String(input));
		return answer();
	};
	// SAFETY: the fake answers every call a Response, which is all resolveSandboxRuntime uses of fetch.
	return Object.assign(fake, { urls }) as FakeFetch;
}

const cache = () => mkdtempSync(join(root, "cache-"));

/** Every entry under `<cache>/runsc/<release>`, so leftovers show. */
const entries = (cacheDir: string): string[] => {
	const dir = join(cacheDir, "runsc", GVISOR_PIN.release);
	return existsSync(dir) ? readdirSync(dir).sort() : [];
};

describe("the pinned release", () => {
	it("is gVisor 20261026.0 with the published SHA-512 of each tarball", () => {
		expect(GVISOR_PIN.release).toBe("20261026.0");
		expect(GVISOR_PIN.sha512.x86_64).toBe(
			"26e4a327565f5da0f73261a6387e2c20f4695a232e330095a3111b70efd604fdf09d734e8cc8f714dbb5c5607ce8c87ea80b26df549d83a146f2efd5a1af448a",
		);
		expect(GVISOR_PIN.sha512.aarch64).toBe(
			"da177d9bcfd9ac23899ecfedc6fd47358e9684a1f7e3f5f8ffb8bf7c0ca65f4c08730c0c503b9231b522db28b04c132a06d04d6719e0d8c04c9f82edaf03d8ae",
		);
		expect(gvisorTarballUrl("x86_64")).toBe(
			"https://storage.googleapis.com/gvisor/releases/release/20261026.0/x86_64/gvisor.tar.bz2",
		);
		expect(gvisorTarballUrl("aarch64")).toBe(
			"https://storage.googleapis.com/gvisor/releases/release/20261026.0/aarch64/gvisor.tar.bz2",
		);
	});

	it("maps Node's x64 and arm64 and nothing else", () => {
		expect(gvisorArch("x64")).toBe("x86_64");
		expect(gvisorArch("arm64")).toBe("aarch64");
		for (const arch of ["ia32", "arm", "riscv64", "s390x", "ppc64"])
			expect(gvisorArch(arch)).toBeUndefined();
	});
});

describe("resolveSandboxRuntime", () => {
	it("downloads, verifies and unpacks runsc and gvisor-bin into the cache, then answers the cache", async () => {
		const cacheDir = cache();
		const fetch = fakeFetch();
		const first = await resolveSandboxRuntime({
			cacheDir,
			allowDownload: true,
			arch: "x64",
			fetch,
			pin: FIXTURE_PIN,
		});
		const dir = runtimeDir(cacheDir, GVISOR_PIN.release, "x86_64");
		expect(first).toEqual({
			ok: true,
			runtime: {
				name: "runsc",
				path: join(dir, "runsc"),
				source: "download",
				version: "20261026.0",
				arch: "x86_64",
				digest: `sha512:${FIXTURE_SHA512}`,
			},
		});
		expect(fetch.urls).toEqual([gvisorTarballUrl("x86_64")]);
		expect(readdirSync(dir).sort()).toEqual([
			".hobo-verified.json",
			"gvisor-bin",
			"runsc",
		]);
		expect(readdirSync(join(dir, "gvisor-bin"))).toEqual(["gvisor_sentry"]);
		expect(statSync(dir).mode & 0o777).toBe(0o755);
		expect(statSync(join(dir, "runsc")).mode & 0o777).toBe(0o755);
		expect(entries(cacheDir)).toEqual(["x86_64"]);

		const second = await resolveSandboxRuntime({
			cacheDir,
			allowDownload: true,
			arch: "x64",
			fetch,
			pin: FIXTURE_PIN,
		});
		expect(second.ok && second.runtime.source).toBe("cache");
		expect(fetch.urls).toHaveLength(1);
	});

	it("refuses a tarball whose SHA-512 is not the pinned one, before unpacking, and leaves nothing behind", async () => {
		const cacheDir = cache();
		let extracted = 0;
		const answer = await resolveSandboxRuntime({
			cacheDir,
			allowDownload: true,
			arch: "x64",
			fetch: fakeFetch(),
			extract: async () => {
				extracted += 1;
			},
		});
		expect(answer).toMatchObject({ ok: false, reason: "checksum-mismatch" });
		expect(answer.ok ? "" : answer.detail).toContain(FIXTURE_SHA512);
		expect(extracted).toBe(0);
		expect(entries(cacheDir)).toEqual([]);
	});

	it("answers unavailable on an architecture with no gVisor release, without fetching", async () => {
		const fetch = fakeFetch();
		const answer = await resolveSandboxRuntime({
			cacheDir: cache(),
			allowDownload: true,
			arch: "ia32",
			fetch,
		});
		expect(answer).toMatchObject({ ok: false, reason: "unsupported-arch" });
		expect(fetch.urls).toEqual([]);
	});

	it("answers not-provisioned when downloads are off and the cache is empty", async () => {
		const fetch = fakeFetch();
		const answer = await resolveSandboxRuntime({
			cacheDir: cache(),
			allowDownload: false,
			arch: "arm64",
			fetch,
			pin: FIXTURE_PIN,
		});
		expect(answer).toMatchObject({ ok: false, reason: "not-provisioned" });
		expect(fetch.urls).toEqual([]);
	});

	it("replaces a stale cache (another digest) and a corrupt one (a changed binary)", async () => {
		const cacheDir = cache();
		const options = {
			cacheDir,
			allowDownload: true,
			arch: "x64",
			pin: FIXTURE_PIN,
		};
		const dir = runtimeDir(cacheDir, GVISOR_PIN.release, "x86_64");
		const fetch = fakeFetch();
		await resolveSandboxRuntime({ ...options, fetch });
		expect(fetch.urls).toHaveLength(1);

		const stamp = join(dir, ".hobo-verified.json");
		writeFileSync(
			stamp,
			readFileSync(stamp, "utf8").replace(FIXTURE_SHA512, "0".repeat(128)),
		);
		const stale = await resolveSandboxRuntime({ ...options, fetch });
		expect(stale.ok && stale.runtime.source).toBe("download");
		expect(fetch.urls).toHaveLength(2);

		chmodSync(join(dir, "runsc"), 0o755);
		writeFileSync(join(dir, "runsc"), "#!/bin/sh\necho tampered\n");
		const corrupt = await resolveSandboxRuntime({ ...options, fetch });
		expect(corrupt.ok && corrupt.runtime.source).toBe("download");
		expect(fetch.urls).toHaveLength(3);
		expect(readFileSync(join(dir, "runsc"), "utf8")).toContain(
			"release-20261026.0",
		);

		writeFileSync(join(dir, "gvisor-bin", "gvisor_sentry"), "tampered");
		const offline = await resolveSandboxRuntime({
			...options,
			allowDownload: false,
			fetch,
		});
		expect(offline).toMatchObject({ ok: false, reason: "not-provisioned" });
		expect(offline.ok ? "" : offline.detail).toMatch(/corrupt|removed/u);
		expect(existsSync(dir)).toBe(false);
	});

	it("answers download-failed on an HTTP error or a broken connection, leaving nothing", async () => {
		for (const fetch of [
			fakeFetch(() => new Response("gone", { status: 404 })),
			fakeFetch(() => {
				throw new Error("ECONNRESET");
			}),
		]) {
			const cacheDir = cache();
			const answer = await resolveSandboxRuntime({
				cacheDir,
				allowDownload: true,
				arch: "x64",
				fetch,
				pin: FIXTURE_PIN,
			});
			expect(answer).toMatchObject({ ok: false, reason: "download-failed" });
			expect(entries(cacheDir)).toEqual([]);
		}
	});

	it("answers unpack-failed when the extractor fails or leaves no runsc, leaving no partial directory", async () => {
		for (const extract of [
			async (_tarball: string, into: string) => {
				writeFileSync(join(into, "runsc"), "partial");
				throw new Error("disk full");
			},
			async (_tarball: string, into: string) => {
				mkdirSync(join(into, "gvisor-bin"));
			},
		]) {
			const cacheDir = cache();
			const answer = await resolveSandboxRuntime({
				cacheDir,
				allowDownload: true,
				arch: "x64",
				fetch: fakeFetch(),
				extract,
				pin: FIXTURE_PIN,
			});
			expect(answer).toMatchObject({ ok: false, reason: "unpack-failed" });
			expect(entries(cacheDir)).toEqual([]);
		}
	});

	it("shares one download between concurrent calls in a process", async () => {
		const cacheDir = cache();
		const fetch = fakeFetch();
		const options = {
			cacheDir,
			allowDownload: true,
			arch: "x64",
			fetch,
			pin: FIXTURE_PIN,
		};
		const answers = await Promise.all([
			resolveSandboxRuntime(options),
			resolveSandboxRuntime(options),
			resolveSandboxRuntime(options),
		]);
		expect(answers.every((answer) => answer.ok)).toBe(true);
		expect(fetch.urls).toHaveLength(1);
		expect(entries(cacheDir)).toEqual(["x86_64"]);
	});

	it("lets the first of two concurrent provisioners win the rename; the other adopts its verified copy", async () => {
		const cacheDir = cache();
		const fetch = fakeFetch();
		const options = {
			cacheDir,
			arch: "x86_64" as const,
			fetch,
			pin: FIXTURE_PIN,
		};
		const [a, b] = await Promise.all([
			provisionGvisor(options),
			provisionGvisor(options),
		]);
		expect(fetch.urls).toHaveLength(2);
		expect(a.ok && b.ok).toBe(true);
		expect(a.ok && b.ok && a.runtime.path === b.runtime.path).toBe(true);
		expect(entries(cacheDir)).toEqual(["x86_64"]);
	});

	it("uses an operator-configured host runtime as given, and never otherwise", async () => {
		const bin = mkdtempSync(join(root, "bin-"));
		for (const name of ["runc", "crun", "runsc", "docker"]) {
			writeFileSync(join(bin, name), "#!/bin/sh\n");
			chmodSync(join(bin, name), 0o755);
		}
		const fetch = fakeFetch();
		for (const name of ["runc", "crun", "runsc"]) {
			const answer = await resolveSandboxRuntime({
				hostRuntime: join(bin, name),
				cacheDir: cache(),
				allowDownload: true,
				arch: "x64",
				fetch,
			});
			expect(answer).toEqual({
				ok: true,
				runtime: {
					name,
					path: join(bin, name),
					source: "host",
					version: "",
					arch: "x86_64",
					digest: undefined,
				},
			});
		}
		expect(fetch.urls).toEqual([]);
		for (const hostRuntime of [
			join(bin, "missing-runc"),
			join(bin, "docker"),
			"runc",
		]) {
			const answer = await resolveSandboxRuntime({
				hostRuntime,
				cacheDir: cache(),
				allowDownload: true,
				arch: "x64",
				fetch,
			});
			expect(answer, hostRuntime).toMatchObject({
				ok: false,
				reason: "host-runtime-unusable",
			});
		}
		expect(fetch.urls).toEqual([]);
	});
});
