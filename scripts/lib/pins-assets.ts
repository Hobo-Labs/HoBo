/**
 * What an asset pin means on this machine: which build it is, where its bytes
 * live once verified, which variable overrides it, and how a release lists its
 * digests. Pure; the download itself is `pins-fetch.ts`.
 *
 * Erasable TypeScript with node builtins only.
 */
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

import { type AssetFile, type AssetPin, type Pins, PinsError } from "./pins.ts";

/** `linux-x64`, `linux-arm64`: the key under which an asset pin lists a file. */
export function currentTarget(
	platform: string = process.platform,
	arch: string = process.arch,
): string {
	return `${platform}-${arch}`;
}

export function assetFor(
	pin: AssetPin,
	name: string,
	target: string = currentTarget(),
): AssetFile {
	const file = Object.hasOwn(pin.files, target) ? pin.files[target] : undefined;
	if (file === undefined) {
		const supported = Object.keys(pin.files).sort().join(", ");
		throw new PinsError(
			"TARGET_UNSUPPORTED",
			`${name} is not published for ${target}; supported: ${supported}`,
		);
	}
	return file;
}

/** The variable that points a lane at a local build instead of the pinned asset. */
export function overrideEnv(name: string): string {
	switch (name) {
		case "mirror":
			return "MIRROR_BIN";
		case "opensesame-kit":
			return "HOBO_OPENSESAME_KIT";
		default:
			return `HOBO_${name.toUpperCase().replace(/-/gu, "_")}`;
	}
}

/** `${XDG_CACHE_HOME:-~/.cache}/siblings`: once per machine, outside every repository. */
export function cacheDir(env: NodeJS.ProcessEnv = process.env): string {
	const xdg = env.XDG_CACHE_HOME;
	const base =
		xdg !== undefined && isAbsolute(xdg)
			? xdg
			: join(env.HOME ?? homedir(), ".cache");
	return join(base, "siblings");
}

/** `<cache>/<sha256>/<entry>`: the key is the content, so two pins of the same bytes share it. */
export function cachedPath(cache: string, file: AssetFile): string {
	return join(cache, file.sha256, file.entry);
}

/** The release file's own name: the last segment of its URL. */
export function publishedName(file: AssetFile): string {
	return new URL(file.url).pathname.split("/").pop() ?? "";
}

/**
 * `<cache>/<sha256>/<archive name>`: an archive pin keeps the verified archive
 * beside the member unpacked from it, so status can re-check the member
 * against the archive offline.
 */
export function cachedArchivePath(cache: string, file: AssetFile): string {
	return join(cache, file.sha256, publishedName(file));
}

const GO_ARCH: Readonly<Record<string, string>> = Object.freeze({
	x64: "amd64",
	arm64: "arm64",
});

/**
 * `<name>_<tag>_<os>_<arch>.tar.gz`, the Go toolchain's names for this
 * target: how a release that ships archives (mirror.cloud's) names each one.
 * `undefined` for a target Go has no name for here.
 */
export function goArchiveName(
	name: string,
	tag: string,
	target: string,
): string | undefined {
	const [os, arch = ""] = target.split("-");
	const goArch = Object.hasOwn(GO_ARCH, arch) ? GO_ARCH[arch] : undefined;
	return os === undefined || goArch === undefined
		? undefined
		: `${name}_${tag}_${os}_${goArch}.tar.gz`;
}

/** Where a release publishes its assets and `SHA256SUMS`. */
export function releaseBase(repo: string, tag: string): string {
	return `${repo.replace(/\/+$/u, "").replace(/\.git$/u, "")}/releases/download/${tag}/`;
}

const SUMS_LINE = /^([0-9a-f]{64}) [ *]([A-Za-z0-9][A-Za-z0-9._@+-]*)$/u;

/** `sha256sum` output: name -> digest. A line that is not `<64 hex> <name>` is an error. */
export function parseSums(text: string): ReadonlyMap<string, string> {
	const sums = new Map<string, string>();
	for (const line of text.split(/\r?\n/u)) {
		if (line.trim() === "" || line.startsWith("#")) continue;
		const match = SUMS_LINE.exec(line);
		const digest = match?.[1];
		const name = match?.[2];
		if (digest === undefined || name === undefined || sums.has(name)) {
			throw new PinsError(
				"SUMS_MALFORMED",
				`cannot read this SHA256SUMS line: ${line.slice(0, 80)}`,
			);
		}
		sums.set(name, digest);
	}
	return sums;
}

/**
 * The canonical text of a manifest. The parser builds every object with its
 * keys in a fixed order, so this is also what `siblings.json` already looks
 * like, and a bump changes only the lines it means to.
 */
export function serializePins(pins: Pins): string {
	return `${JSON.stringify(pins, null, 2)}\n`;
}
