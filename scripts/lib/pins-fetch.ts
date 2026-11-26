/**
 * The verified, content-addressed fetch behind every asset pin.
 *
 * Bytes are hashed while they stream to a private `*.partial` file and are
 * deleted on any mismatch before anything is extracted or made executable
 * (the discipline of `scripts/fetch-celld.mts`, generalised). The cache is
 * keyed by content: `<cache>/<sha256>/<entry>`, so two pins of the same bytes
 * share one directory and a cached file is trusted only after being re-hashed
 * (`pins-verify.ts`).
 *
 * Erasable TypeScript with node builtins only.
 */
import { createHash } from "node:crypto";
import {
	closeSync,
	fchmodSync,
	fstatSync,
	mkdirSync,
	openSync,
	readSync,
	renameSync,
	rmSync,
	writeSync,
} from "node:fs";
import { rm } from "node:fs/promises";
import { dirname } from "node:path";

import { type AssetFile, assertAllowedUrl, PinsError } from "./pins.ts";
import { extractMember } from "./pins-archive.ts";
import { cachedArchivePath, cachedPath } from "./pins-assets.ts";
import { prepareCache } from "./pins-cache.ts";
import { netTimeout, netTimeoutMs, Watchdog } from "./pins-net.ts";
import { armGuard, partialPath, removeEmptyDirs } from "./pins-partial.ts";
import { verifyCached, verifyFile } from "./pins-verify.ts";

export {
	type CacheState,
	sha256OfFile,
	verifyCached,
} from "./pins-verify.ts";

/** The sha256 of the first `length` bytes of an open file, read through `fd`. */
function sha256OfFd(fd: number, length: number): string {
	const hash = createHash("sha256");
	const buffer = Buffer.alloc(64 * 1024);
	for (let position = 0; position < length; ) {
		const read = readSync(fd, buffer, 0, buffer.length, position);
		if (read === 0) break;
		hash.update(buffer.subarray(0, read));
		position += read;
	}
	return hash.digest("hex");
}

export interface FetchOptions {
	readonly allowLocal?: boolean;
	/** Abort once more than this many bytes arrive. */
	readonly maxBytes?: number;
	/** The finished file must be exactly this long. */
	readonly expectedSize?: number;
	/** The whole download, redirects and body; default the larger of its own default and `idleMs`. */
	readonly timeoutMs?: number;
	/** The longest wait for a response or for the next bytes (default HOBO_PINS_NET_TIMEOUT_MS). */
	readonly idleMs?: number;
	readonly fetch?: typeof fetch;
}

/** What may end a request early: silence, the total deadline, or `extra` (a signal). */
interface Waits {
	readonly signal: AbortSignal;
	readonly watchdog: Watchdog;
	readonly total: AbortSignal;
	readonly totalMs: number;
}

function waitsFor(
	options: FetchOptions,
	defaultTotalMs: number,
	extra?: AbortSignal,
): Waits {
	const watchdog = new Watchdog(options.idleMs ?? netTimeoutMs());
	const totalMs = options.timeoutMs ?? Math.max(defaultTotalMs, watchdog.ms);
	const total = AbortSignal.timeout(totalMs);
	const signals = [watchdog.signal, total];
	if (extra !== undefined) signals.push(extra);
	return { signal: AbortSignal.any(signals), watchdog, total, totalMs };
}

/** The NET_TIMEOUT a request that was cut short by `waits` ends in, if it was. */
function timedOut(waits: Waits, what: string): PinsError | null {
	if (waits.watchdog.fired) return netTimeout(what, waits.watchdog.ms);
	if (waits.total.aborted) {
		return new PinsError(
			"NET_TIMEOUT",
			`${what} did not finish within ${waits.totalMs} ms; nothing was kept`,
		);
	}
	return null;
}

const MAX_REDIRECTS = 5;
const DEFAULT_MAX_BYTES = 512 * 1024 ** 2;

async function getFollowing(
	url: string,
	options: FetchOptions,
	waits: Waits,
): Promise<Response> {
	const allowLocal = options.allowLocal === true;
	const get = options.fetch ?? fetch;
	let current = assertAllowedUrl(url, allowLocal, "download").toString();
	for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
		let response: Response;
		try {
			waits.watchdog.touch();
			response = await get(current, {
				redirect: "manual",
				signal: waits.signal,
			});
		} catch (error) {
			const late = timedOut(waits, `the download of ${current}`);
			if (late !== null) throw late;
			const cause =
				error instanceof Error && error.cause instanceof Error
					? error.cause.message
					: "";
			throw new PinsError(
				"NETWORK",
				`request to ${current} failed: ${cause || (error instanceof Error ? error.message : String(error))}. ` +
					"Behind a proxy set NODE_USE_ENV_PROXY=1 and, for a TLS-intercepting one, NODE_EXTRA_CA_CERTS.",
			);
		}
		if (response.status < 300 || response.status >= 400) return response;
		const location = response.headers.get("location");
		await response.body?.cancel();
		if (location === null)
			throw new PinsError(
				"HTTP_STATUS",
				`${current} redirected without a location`,
			);
		const next = new URL(location, current).toString();
		try {
			assertAllowedUrl(next, allowLocal, "redirect");
		} catch {
			throw new PinsError(
				"REDIRECT_REFUSED",
				`${current} redirects to ${next}, which is not https`,
			);
		}
		current = next;
	}
	throw new PinsError(
		"REDIRECT_REFUSED",
		`${url} redirected more than ${MAX_REDIRECTS} times`,
	);
}

/**
 * Download `url` to `dest`, keeping it only if it hashes to `sha256`.
 *
 * The bytes go to a private `*.partial` file (0600), are hashed as they
 * arrive, and are deleted on any mismatch before anything is extracted or
 * made executable. Only a verified file is made executable and renamed to its
 * final name, so `dest` never holds unverified bytes.
 *
 * A signal guard is armed before the first directory or file is made and
 * released only once the file is in place (`pins-partial.ts`), and every
 * file operation is synchronous, so a signal is handled between network
 * reads, never in the middle of creating or publishing something.
 */
export async function fetchVerified(
	url: string,
	sha256: string,
	dest: string,
	options: FetchOptions = {},
): Promise<void> {
	const limit = options.maxBytes ?? DEFAULT_MAX_BYTES;
	const partial = partialPath(dest);
	const controller = new AbortController();
	// Read (and validate) the bound first: a refusal must leave no handler armed.
	const waits = waitsFor(options, 300_000, controller.signal);
	const guard = armGuard(partial, () => controller.abort());
	let created: string | undefined;
	// Whatever fails, leave neither the partial file nor a directory we made.
	const discard = (): void => {
		rmSync(partial, { force: true });
		removeEmptyDirs(dirname(dest), created);
	};
	let fd: number | undefined;
	try {
		created = mkdirSync(dirname(dest), { recursive: true, mode: 0o700 });
		guard.made(created);
		const response = await getFollowing(url, options, waits);
		if (!response.ok || response.body === null) {
			await response.body?.cancel();
			throw new PinsError("HTTP_STATUS", `${url} answered ${response.status}`);
		}
		const hash = createHash("sha256");
		let seen = 0;
		// O_CREAT | O_EXCL: never an existing file, never through a link.
		fd = openSync(partial, "wx+", 0o600);
		for await (const chunk of response.body) {
			seen += chunk.byteLength;
			if (seen > limit)
				throw new PinsError(
					"SIZE_EXCEEDED",
					`${url} sent more than ${limit} bytes`,
				);
			hash.update(chunk);
			writeSync(fd, chunk);
			waits.watchdog.touch();
		}
		const actual = hash.digest("hex");
		if (actual !== sha256) {
			throw new PinsError(
				"DIGEST_MISMATCH",
				`${url} hashes to ${actual} but the pin says ${sha256}; refusing to use these bytes`,
			);
		}
		if (options.expectedSize !== undefined && seen !== options.expectedSize) {
			throw new PinsError(
				"SIZE_MISMATCH",
				`${url} is ${seen} bytes but the pin says ${options.expectedSize}`,
			);
		}
		// The stream was verified; now verify what the open file holds, and
		// make that file executable through the same descriptor.
		const onDisk = sha256OfFd(fd, seen);
		if (onDisk !== sha256 || fstatSync(fd).size !== seen) {
			throw new PinsError(
				"DIGEST_MISMATCH",
				`${url} arrived intact but the file on disk hashes to ${onDisk}; refusing to use it`,
			);
		}
		fchmodSync(fd, 0o755);
		closeSync(fd);
		fd = undefined;
		// Residual: rename publishes by name. Only the cache's owner (0700) can
		// swap the name between the check above and this rename.
		renameSync(partial, dest);
	} catch (error) {
		if (fd !== undefined) closeSync(fd);
		discard();
		const signal = guard.interrupted();
		if (signal !== null) {
			throw new PinsError(
				"INTERRUPTED",
				`the download of ${url} was interrupted by ${signal}; nothing was kept`,
			);
		}
		throw timedOut(waits, `the download of ${url}`) ?? error;
	} finally {
		waits.watchdog.stop();
		guard.release();
	}
}

const MAX_TEXT_BYTES = 1024 ** 2;

/** A small text document (a release's SHA256SUMS), under the same URL rules and waits. */
export async function fetchText(
	url: string,
	options: FetchOptions = {},
): Promise<string> {
	const limit = options.maxBytes ?? MAX_TEXT_BYTES;
	const waits = waitsFor(options, 60_000);
	try {
		const response = await getFollowing(url, options, waits);
		if (!response.ok || response.body === null) {
			await response.body?.cancel();
			throw new PinsError("HTTP_STATUS", `${url} answered ${response.status}`);
		}
		const chunks: Uint8Array[] = [];
		let seen = 0;
		for await (const chunk of response.body) {
			seen += chunk.byteLength;
			if (seen > limit) {
				throw new PinsError(
					"SIZE_EXCEEDED",
					`${url} sent more than ${limit} bytes`,
				);
			}
			chunks.push(chunk);
			waits.watchdog.touch();
		}
		return Buffer.concat(chunks).toString("utf8");
	} catch (error) {
		throw timedOut(waits, `the download of ${url}`) ?? error;
	} finally {
		waits.watchdog.stop();
	}
}

export interface Cached {
	readonly path: string;
	/** The file (or, for an archive pin, the archive) was downloaded now. */
	readonly downloaded: boolean;
	/** An archive pin's entry was unpacked now, from the verified archive. */
	readonly unpacked: boolean;
}

/** The cached path of `file`, downloading and verifying it first when needed. */
export async function ensureCached(
	cache: string,
	file: AssetFile,
	options: FetchOptions = {},
): Promise<Cached> {
	await prepareCache(cache, file.sha256);
	const path = cachedPath(cache, file);
	const downloadTo =
		file.archive === undefined ? path : cachedArchivePath(cache, file);
	const state = await verifyCached(cache, file);
	if (state.state === "ok") return { path, downloaded: false, unpacked: false };
	if (state.state === "mismatch") await rm(state.path, { force: true });
	if (state.state === "invalid")
		await rm(state.path, { recursive: true, force: true });
	let downloaded = false;
	const fetched =
		file.archive === undefined
			? state
			: await verifyFile(downloadTo, file.sha256);
	if (fetched.state !== "ok") {
		await fetchVerified(file.url, file.sha256, downloadTo, {
			...options,
			maxBytes: file.size,
			expectedSize: file.size,
		});
		downloaded = true;
	}
	if (file.archive === undefined) return { path, downloaded, unpacked: false };
	// Only now, with the archive verified, is anything unpacked from it.
	await rm(path, { recursive: true, force: true });
	await extractMember(downloadTo, file.archive.member, path, file.sha256);
	return { path, downloaded, unpacked: true };
}
