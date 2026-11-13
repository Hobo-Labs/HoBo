/**
 * The sandbox runtime is provisioned by the agent, never assumed on the host
 * (D58). `resolveSandboxRuntime` answers, in this order:
 *
 * 1. an operator-configured host runtime (`runsc`, `crun` or `runc` at an
 *    absolute path): the only way a host binary is ever used, and opt-in;
 * 2. the verified cache: `<cacheDir>/runsc/<release>/<arch>/`, whose stamp
 *    records the pinned tarball digest and the SHA-512 of every unpacked file,
 *    re-checked on every resolution (a stale or corrupt copy is removed);
 * 3. a download, when allowed: the pinned gVisor release tarball, its
 *    SHA-512 checked against the pin before anything is unpacked, `runsc` and
 *    `gvisor-bin/` (which newer runsc needs beside it) unpacked into a
 *    temporary sibling directory, mode 0755, then renamed into place, so a
 *    reader sees a whole verified copy or none, and two provisioners racing
 *    end with the first one's copy;
 * 4. unavailable, with a reason.
 *
 * Unpacking is in-process (`bunzip2.ts`, `tar.ts`): `tar -xjf` would also need
 * a host `bzip2`, which minimal images lack.
 */
import { createHash, randomBytes } from "node:crypto";
import {
	accessSync,
	chmodSync,
	closeSync,
	constants,
	existsSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
	writeSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";
import { bunzip2 } from "./bunzip2.js";
import { extractTarEntries, tarEntryAllowed } from "./tar.js";

export type GvisorArch = "x86_64" | "aarch64";

// domain-view: a gVisor release and the SHA-512 of its tarball per architecture.
export type GvisorPin = Readonly<{
	release: string;
	sha512: Readonly<Record<GvisorArch, string>>;
}>;

// public-contract: the pinned gVisor release and the SHA-512 of its published tarballs (D58).
export const GVISOR_PIN: GvisorPin = {
	release: "20261026.0",
	sha512: {
		x86_64:
			"26e4a327565f5da0f73261a6387e2c20f4695a232e330095a3111b70efd604fdf09d734e8cc8f714dbb5c5607ce8c87ea80b26df549d83a146f2efd5a1af448a",
		aarch64:
			"da177d9bcfd9ac23899ecfedc6fd47358e9684a1f7e3f5f8ffb8bf7c0ca65f4c08730c0c503b9231b522db28b04c132a06d04d6719e0d8c04c9f82edaf03d8ae",
	},
};

const STAMP = ".hobo-verified.json";
const HOST_RUNTIMES = ["runsc", "crun", "runc"] as const;
export type RuntimeName = (typeof HOST_RUNTIMES)[number];

/** gVisor's name for Node's `process.arch`; undefined where gVisor publishes no release. */
export function gvisorArch(nodeArch: string): GvisorArch | undefined {
	if (nodeArch === "x64" || nodeArch === "x86_64") return "x86_64";
	if (nodeArch === "arm64" || nodeArch === "aarch64") return "aarch64";
	return undefined;
}

export function gvisorTarballUrl(
	arch: GvisorArch,
	release: string = GVISOR_PIN.release,
): string {
	return `https://storage.googleapis.com/gvisor/releases/release/${release}/${arch}/gvisor.tar.bz2`;
}

/** Where a verified release lives in the cache. */
export function runtimeDir(
	cacheDir: string,
	release: string,
	arch: GvisorArch,
): string {
	return join(cacheDir, "runsc", release, arch);
}

/** Unpacks the members to keep from a verified tarball into `into`, which exists and is empty. */
export type Extractor = (tarball: string, into: string) => Promise<void>;

/** The default extractor: in-process bzip2 and tar, `runsc` and `gvisor-bin/*` only. */
export const unpackGvisorTarball: Extractor = async (tarball, into) => {
	extractTarEntries(
		bunzip2(new Uint8Array(readFileSync(tarball))),
		into,
		tarEntryAllowed,
	);
};

export type ResolvedRuntime = Readonly<{
	name: RuntimeName;
	path: string;
	source: "host" | "cache" | "download";
	/** The pinned release for a provisioned runtime; empty for a host one (its self-test asks it). */
	version: string;
	arch: GvisorArch | undefined;
	/** `sha512:<hex>` of the verified tarball; undefined for a host runtime. */
	digest: string | undefined;
}>;

export type UnavailableReason =
	| "host-runtime-unusable"
	| "unsupported-arch"
	| "not-provisioned"
	| "download-failed"
	| "checksum-mismatch"
	| "unpack-failed";

export type RuntimeResolution =
	| Readonly<{ ok: true; runtime: ResolvedRuntime }>
	| Readonly<{ ok: false; reason: UnavailableReason; detail: string }>;

export type ResolveOptions = Readonly<{
	/** An operator-configured host runtime: an absolute path to `runsc`, `crun` or `runc`. */
	hostRuntime?: string | undefined;
	cacheDir: string;
	allowDownload: boolean;
	/** Node's `process.arch` by default. */
	arch?: string | undefined;
	fetch?: typeof fetch | undefined;
	extract?: Extractor | undefined;
	/** The pinned release by default; tests substitute a fixture's digest. */
	pin?: GvisorPin | undefined;
}>;

const unavailable = (
	reason: UnavailableReason,
	detail: string,
): RuntimeResolution => ({ ok: false, reason, detail });

function sha512File(path: string): string {
	return createHash("sha512").update(readFileSync(path)).digest("hex");
}

// domain-view: the stamp written beside a verified, unpacked release.
type Stamp = Readonly<{
	release: string;
	arch: GvisorArch;
	tarballSha512: string;
	files: Readonly<Record<string, string>>;
}>;

/** Every regular file under `dir` (one level of `gvisor-bin/`), relative, sorted. */
function unpackedFiles(dir: string): string[] {
	const files: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		if (entry.name === STAMP) continue;
		if (entry.isFile()) files.push(entry.name);
		else if (entry.isDirectory())
			for (const inner of readdirSync(join(dir, entry.name), {
				withFileTypes: true,
			}))
				if (inner.isFile()) files.push(`${entry.name}/${inner.name}`);
	}
	return files.sort();
}

/** Why the copy in `dir` is not the verified pinned release, or undefined when it is. */
function cacheProblem(
	dir: string,
	pin: GvisorPin,
	arch: GvisorArch,
): string | undefined {
	let stamp: Stamp;
	try {
		// SAFETY: the agent's own stamp file; every field read is checked below.
		stamp = JSON.parse(readFileSync(join(dir, STAMP), "utf8")) as Stamp;
	} catch {
		return "the cached copy has no readable stamp";
	}
	if (
		stamp.release !== pin.release ||
		stamp.arch !== arch ||
		stamp.tarballSha512 !== pin.sha512[arch]
	)
		return "the cached copy is stale (another release or digest)";
	const files = unpackedFiles(dir);
	const stamped = Object.keys(stamp.files ?? {}).sort();
	if (!stamped.includes("runsc") || files.join("\n") !== stamped.join("\n"))
		return "the cached copy is corrupt (files differ from its stamp)";
	for (const file of files) {
		if ((statSync(join(dir, file)).mode & 0o755) !== 0o755)
			return `the cached copy is corrupt (${file} is not mode 0755)`;
		if (sha512File(join(dir, file)) !== stamp.files[file])
			return `the cached copy is corrupt (${file} changed)`;
	}
	return undefined;
}

function provisioned(
	dir: string,
	pin: GvisorPin,
	arch: GvisorArch,
	source: "cache" | "download",
): RuntimeResolution {
	return {
		ok: true,
		runtime: {
			name: "runsc",
			path: join(dir, "runsc"),
			source,
			version: pin.release,
			arch,
			digest: `sha512:${pin.sha512[arch]}`,
		},
	};
}

/** Streams the tarball to `path`, answering its SHA-512. */
async function download(
	fetchImpl: typeof fetch,
	url: string,
	path: string,
): Promise<string> {
	const response = await fetchImpl(url);
	if (!response.ok || response.body === null)
		throw new Error(`GET ${url} answered ${response.status}`);
	const hash = createHash("sha512");
	const fd = openSync(path, "wx", 0o600);
	try {
		for await (const chunk of response.body) {
			hash.update(chunk);
			writeSync(fd, chunk);
		}
	} finally {
		closeSync(fd);
	}
	return hash.digest("hex");
}

/**
 * Downloads, verifies and unpacks the pinned release into the cache, without
 * looking at what is there first. Concurrent provisioners each work in their
 * own temporary directory; the first rename wins, and the others adopt the
 * winner's copy once it verifies.
 */
export async function provisionGvisor(
	options: Readonly<{
		cacheDir: string;
		arch: GvisorArch;
		fetch?: typeof fetch | undefined;
		extract?: Extractor | undefined;
		pin?: GvisorPin | undefined;
	}>,
): Promise<RuntimeResolution> {
	const pin = options.pin ?? GVISOR_PIN;
	const { arch } = options;
	const dir = runtimeDir(options.cacheDir, pin.release, arch);
	const parent = dirname(dir);
	mkdirSync(parent, { recursive: true, mode: 0o755 });
	const tag = randomBytes(6).toString("hex");
	const tarball = join(parent, `.download-${arch}-${tag}.tar.bz2`);
	const temp = join(parent, `.unpack-${arch}-${tag}`);
	const url = gvisorTarballUrl(arch, pin.release);
	try {
		let digest: string;
		try {
			digest = await download(options.fetch ?? fetch, url, tarball);
		} catch (error) {
			return unavailable("download-failed", `${url}: ${String(error)}`);
		}
		if (digest !== pin.sha512[arch])
			return unavailable(
				"checksum-mismatch",
				`${url} has SHA-512 ${digest}, the pin is ${pin.sha512[arch]}`,
			);
		try {
			mkdirSync(temp, { mode: 0o755 });
			await (options.extract ?? unpackGvisorTarball)(tarball, temp);
			if (!existsSync(join(temp, "runsc")))
				throw new Error("the tarball holds no runsc");
			const files: Record<string, string> = {};
			for (const file of unpackedFiles(temp)) {
				chmodSync(join(temp, file), 0o755);
				files[file] = sha512File(join(temp, file));
			}
			if (existsSync(join(temp, "gvisor-bin")))
				chmodSync(join(temp, "gvisor-bin"), 0o755);
			chmodSync(temp, 0o755);
			const stamp: Stamp = {
				release: pin.release,
				arch,
				tarballSha512: digest,
				files,
			};
			writeFileSync(join(temp, STAMP), `${JSON.stringify(stamp)}\n`, {
				mode: 0o644,
			});
		} catch (error) {
			return unavailable("unpack-failed", `${url}: ${String(error)}`);
		}
		try {
			renameSync(temp, dir);
		} catch (error) {
			// Another provisioner renamed its copy into place first.
			const problem = existsSync(dir) ? cacheProblem(dir, pin, arch) : "absent";
			if (problem !== undefined)
				return unavailable(
					"unpack-failed",
					`moving the verified copy into ${dir}: ${String(error)}`,
				);
		}
		return provisioned(dir, pin, arch, "download");
	} finally {
		rmSync(tarball, { force: true });
		rmSync(temp, { recursive: true, force: true });
	}
}

/** One provisioning per cache directory at a time within this process. */
const inFlight = new Map<string, Promise<RuntimeResolution>>();

function hostRuntime(
	path: string,
	arch: GvisorArch | undefined,
): RuntimeResolution {
	const name = HOST_RUNTIMES.find((runtime) => basename(path) === runtime);
	if (!isAbsolute(path) || name === undefined)
		return unavailable(
			"host-runtime-unusable",
			`the configured host runtime must be an absolute path to runsc, crun or runc: ${path}`,
		);
	try {
		accessSync(path, constants.X_OK);
		if (!statSync(path).isFile()) throw new Error("not a regular file");
	} catch (error) {
		return unavailable(
			"host-runtime-unusable",
			`the configured host runtime ${path} is not executable: ${String(error)}`,
		);
	}
	return {
		ok: true,
		runtime: {
			name,
			path,
			source: "host",
			version: "",
			arch,
			digest: undefined,
		},
	};
}

/** The sandbox runtime to use, by the order in this file's comment. */
export async function resolveSandboxRuntime(
	options: ResolveOptions,
): Promise<RuntimeResolution> {
	const nodeArch = options.arch ?? process.arch;
	const arch = gvisorArch(nodeArch);
	if (options.hostRuntime !== undefined && options.hostRuntime !== "")
		return hostRuntime(options.hostRuntime, arch);
	if (arch === undefined)
		return unavailable(
			"unsupported-arch",
			`gVisor publishes no release for ${nodeArch}`,
		);
	const pin = options.pin ?? GVISOR_PIN;
	const dir = runtimeDir(options.cacheDir, pin.release, arch);
	const pending = inFlight.get(dir);
	if (pending !== undefined) return pending;
	const work = (async (): Promise<RuntimeResolution> => {
		let removed = "";
		if (existsSync(dir)) {
			const problem = cacheProblem(dir, pin, arch);
			if (problem === undefined) return provisioned(dir, pin, arch, "cache");
			rmSync(dir, { recursive: true, force: true });
			removed = `${problem}; removed. `;
		}
		if (!options.allowDownload)
			return unavailable(
				"not-provisioned",
				`${removed}gVisor ${pin.release} is not in ${options.cacheDir} and downloads are off`,
			);
		return provisionGvisor({
			cacheDir: options.cacheDir,
			arch,
			fetch: options.fetch,
			extract: options.extract,
			pin,
		});
	})();
	inFlight.set(dir, work);
	try {
		return await work;
	} finally {
		inFlight.delete(dir);
	}
}
