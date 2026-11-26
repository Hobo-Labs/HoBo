/**
 * Sibling pins: the manifest types and the parser.
 * What an asset pin means on a machine (target, cache path, override variable,
 * release sums) is `pins-assets.ts`; the verified fetch is `pins-fetch.ts`.
 *
 * `tools/pins/siblings.json` is the one place that says which exact artifact
 * of a sibling repository this repository consumes. This module is the only
 * reader of that file's text. Everything it returns is parsed and frozen: URLs
 * are https, digests are 64 lowercase hex characters, and every path stays
 * inside the repository, so callers never re-check them.
 *
 * Erasable TypeScript with node builtins only: `bootstrap-siblings.mts` runs
 * before `pnpm install`, under `node --experimental-strip-types`.
 */
import { isAbsolute } from "node:path";

import {
	isArray,
	isCount,
	type Json,
	malformed,
	readObject,
	readOnly,
	readString,
} from "./pins-json.ts";

export { PinsError, type PinsErrorCode } from "./pins-error.ts";
export type { Json, JsonObject } from "./pins-json.ts";

/** Where the manifest lives, relative to the repository root. */
export const PINS_FILE = "tools/pins/siblings.json";

export interface GitPin {
	readonly path: string;
	readonly repo: string;
	readonly branch: string;
	readonly sparse: readonly string[] | null;
}

/**
 * The release file is an archive, and what runs is one member of it. The pin's
 * `sha256` and `size` are the archive's: they are what is verified before the
 * member is unpacked (`pins-archive.ts`).
 */
export interface AssetArchive {
	/** Gzip-compressed ustar, what mirror.cloud publishes; the only one read. */
	readonly format: "tar.gz";
	/** The member to unpack: a relative path of plain segments. */
	readonly member: string;
}

export interface AssetFile {
	readonly url: string;
	readonly sha256: string;
	readonly size: number;
	/** File name the verified bytes are stored (and run) under in the cache. */
	readonly entry: string;
	/** Present when `url` is an archive; absent for a bare executable. */
	readonly archive?: AssetArchive;
}

export interface AssetPin {
	readonly repo: string;
	readonly tag: string;
	readonly files: Readonly<Record<string, AssetFile>>;
}

export interface VendorPin {
	readonly from: string;
	readonly path: string;
	readonly dest: string;
}

export interface Pins {
	readonly schemaVersion: 1;
	readonly git: Readonly<Record<string, GitPin>>;
	/** `null` means "not published yet": the override environment variable is required. */
	readonly assets: Readonly<Record<string, AssetPin | null>>;
	readonly vendor: Readonly<Record<string, VendorPin>>;
}

export interface ParseOptions {
	/** Tests only: loopback http URLs and local repository paths. */
	readonly allowLocal?: boolean;
}

const NAME = /^[a-z0-9][a-z0-9-]*$/u;
const TARGET = /^[a-z0-9]+-[a-z0-9_]+$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const SEGMENT = /^[A-Za-z0-9._@+-]+$/u;
// ASCII only, so 200 characters are 200 bytes: room for the partial suffix under NAME_MAX.
const FILE_NAME = /^[A-Za-z0-9._@+-]{1,200}$/u;
const REF = /^[A-Za-z0-9][A-Za-z0-9._/+-]*$/u;
const TAG = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/u;
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);
const MAX_ASSET_BYTES = 2 * 1024 ** 3;

// One archive member path: plain segments, none of them "." or "..".
const MEMBER =
	/^(?!.*(?:^|\/)\.\.?(?:\/|$))[A-Za-z0-9._@+-]+(?:\/[A-Za-z0-9._@+-]+)*$/u;
const ARCHIVE_SUFFIX = /\.(?:tar\.gz|tgz)$/u;

/** A branch, tag or commit id that can never be read as a git option. */
export function isSafeRef(value: string): boolean {
	return REF.test(value) && !value.includes("..") && !value.includes("//");
}

/** A relative archive member path of plain segments, none of them `.` or `..`. */
export function isArchiveMember(value: string): boolean {
	return MEMBER.test(value);
}

/** A file name, not a path, of at most 200 bytes: what `entry` and a release asset are called. */
export function isFileName(value: string): boolean {
	return FILE_NAME.test(value) && value !== "." && value !== "..";
}

/** A path under the repository root: no escape, no option-looking segment. */
export function isRepoPath(value: string): boolean {
	return (
		!value.startsWith("-") &&
		value
			.split("/")
			.every((part) => part !== "." && part !== ".." && SEGMENT.test(part))
	);
}

function hasControlOrSpace(value: string): boolean {
	for (const char of value) {
		const code = char.codePointAt(0) ?? 0;
		if (code <= 0x20 || code === 0x7f) return true;
	}
	return false;
}

/** https, or (tests only) http on loopback; never credentials in the URL. */
export function assertAllowedUrl(
	value: string,
	allowLocal: boolean,
	where: string,
): URL {
	// `new URL` quietly strips or encodes some of these; the raw text is what
	// ends up in a manifest, a log line and a git argument, so refuse it.
	if (hasControlOrSpace(value)) {
		return malformed(
			where,
			"a URL must not contain a space or a control character",
		);
	}
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		return malformed(where, `${value} is not a URL`);
	}
	const local =
		allowLocal && url.protocol === "http:" && LOOPBACK.has(url.hostname);
	if (url.protocol !== "https:" && !local) {
		return malformed(where, `${value} must be an https:// URL`);
	}
	if (url.username !== "" || url.password !== "") {
		return malformed(where, "a URL must not carry credentials");
	}
	return url;
}

function readPath(value: Json | undefined, where: string): string {
	const path = readString(value, where);
	return isRepoPath(path)
		? path
		: malformed(where, `${path} must stay inside the repository`);
}
/** A repository URL a pin may name: https, or (tests only) loopback http or a local path. */
export function checkRepoUrl(
	repo: string,
	where: string,
	allowLocal: boolean,
): string {
	const local = allowLocal && (isAbsolute(repo) || repo.startsWith("file://"));
	if (!local) assertAllowedUrl(repo, allowLocal, where);
	return repo;
}

/** The tag of a release a pin may name: what a release URL can safely carry. */
export function isReleaseTag(value: string): boolean {
	return TAG.test(value);
}

function readRepo(
	value: Json | undefined,
	where: string,
	options: ParseOptions,
): string {
	return checkRepoUrl(
		readString(value, where),
		where,
		options.allowLocal === true,
	);
}
function mapEntries<T>(
	value: Json | undefined,
	where: string,
	parse: (entry: Json | undefined, at: string) => T,
): Readonly<Record<string, T>> {
	const object = readObject(value, where);
	const entries = Object.entries(object).map(([name, entry]) => {
		if (!NAME.test(name))
			malformed(
				`${where}.${name}`,
				"name must be lowercase letters, digits and dashes",
			);
		return [name, parse(entry, `${where}.${name}`)] as const;
	});
	return Object.freeze(Object.fromEntries(entries));
}

function parseGitPin(
	value: Json | undefined,
	where: string,
	options: ParseOptions,
): GitPin {
	const object = readObject(value, where);
	readOnly(object, ["path", "repo", "branch", "sparse"], where);
	const branch = readString(object.branch, `${where}.branch`);
	if (!isSafeRef(branch))
		malformed(`${where}.branch`, `${branch} is not a branch name`);
	const raw = object.sparse;
	let sparse: readonly string[] | null = null;
	if (raw !== null && raw !== undefined) {
		if (!isArray(raw) || raw.length === 0)
			malformed(`${where}.sparse`, "must be null or a non-empty list");
		sparse = Object.freeze(
			raw.map((entry, index) => readPath(entry, `${where}.sparse[${index}]`)),
		);
	}
	return Object.freeze({
		path: readPath(object.path, `${where}.path`),
		repo: readRepo(object.repo, `${where}.repo`, options),
		branch,
		sparse,
	});
}

function parseAssetFile(
	value: Json | undefined,
	where: string,
	options: ParseOptions,
): AssetFile {
	const object = readObject(value, where);
	readOnly(object, ["url", "sha256", "size", "entry", "archive"], where);
	const sha256 = readString(object.sha256, `${where}.sha256`);
	if (!SHA256.test(sha256))
		malformed(`${where}.sha256`, "must be 64 lowercase hex characters");
	const size = object.size;
	if (!isCount(size) || size > MAX_ASSET_BYTES)
		malformed(`${where}.size`, "must be a positive integer byte count");
	const entry = readString(object.entry, `${where}.entry`);
	if (!isFileName(entry)) {
		malformed(`${where}.entry`, `${entry} must be a plain file name`);
	}
	const url = readString(object.url, `${where}.url`);
	assertAllowedUrl(url, options.allowLocal === true, `${where}.url`);
	if (object.archive === undefined) {
		return Object.freeze({ url, sha256, size, entry });
	}
	const archive = parseAssetArchive(object.archive, `${where}.archive`);
	const published = new URL(url).pathname.split("/").pop() ?? "";
	if (!isFileName(published) || !ARCHIVE_SUFFIX.test(published)) {
		malformed(
			`${where}.url`,
			`an archive pin's file must be a plain .tar.gz file name, got ${published}`,
		);
	}
	// Both are kept in <cache>/<sha256>/, each under its own name.
	if (entry === published) {
		malformed(
			`${where}.entry`,
			`${entry} is the archive's own file name; the entry it is unpacked to must be named something else`,
		);
	}
	return Object.freeze({ url, sha256, size, entry, archive });
}

function parseAssetArchive(
	value: Json | undefined,
	where: string,
): AssetArchive {
	const object = readObject(value, where);
	readOnly(object, ["format", "member"], where);
	const format = readString(object.format, `${where}.format`);
	if (format !== "tar.gz") {
		malformed(
			`${where}.format`,
			`${format} is not an archive format the pins read (tar.gz)`,
		);
	}
	const member = readString(object.member, `${where}.member`);
	if (!isArchiveMember(member)) {
		malformed(
			`${where}.member`,
			`${JSON.stringify(member)} must be a relative path of plain segments, none of them . or ..`,
		);
	}
	return Object.freeze({ format: "tar.gz", member });
}

function parseAssetPin(
	value: Json | undefined,
	where: string,
	options: ParseOptions,
): AssetPin | null {
	if (value === null) return null;
	const object = readObject(value, where);
	readOnly(object, ["repo", "tag", "files"], where);
	const tag = readString(object.tag, `${where}.tag`);
	if (!isReleaseTag(tag))
		malformed(`${where}.tag`, `${tag} is not a release tag`);
	const filesObject = readObject(object.files, `${where}.files`);
	for (const target of Object.keys(filesObject)) {
		if (!TARGET.test(target))
			malformed(`${where}.files.${target}`, "target must look like linux-x64");
	}
	const files = Object.fromEntries(
		Object.entries(filesObject).map(([target, file]) => [
			target,
			parseAssetFile(file, `${where}.files.${target}`, options),
		]),
	);
	if (Object.keys(files).length === 0)
		malformed(`${where}.files`, "must publish at least one target");
	return Object.freeze({
		repo: readRepo(object.repo, `${where}.repo`, options),
		tag,
		files: Object.freeze(files),
	});
}

function parseVendorPin(value: Json | undefined, where: string): VendorPin {
	const object = readObject(value, where);
	readOnly(object, ["from", "path", "dest"], where);
	const from = readString(object.from, `${where}.from`);
	if (!SEGMENT.test(from) || from === "." || from === "..") {
		malformed(
			`${where}.from`,
			`${from} must be the name of a sibling directory`,
		);
	}
	return Object.freeze({
		from,
		path: readPath(object.path, `${where}.path`),
		dest: readPath(object.dest, `${where}.dest`),
	});
}

/** The only reader of `siblings.json` text: untrusted in, frozen and refined out. */
export function parsePins(text: string, options: ParseOptions = {}): Pins {
	let json: Json;
	try {
		json = JSON.parse(text);
	} catch (error) {
		return malformed(
			"siblings.json",
			`not JSON (${error instanceof Error ? error.message : "parse error"})`,
		);
	}
	const root = readObject(json, "siblings.json");
	readOnly(root, ["schemaVersion", "git", "assets", "vendor"], "siblings.json");
	if (root.schemaVersion !== 1)
		malformed("siblings.json.schemaVersion", "must be 1");
	const pins: Pins = Object.freeze({
		schemaVersion: 1,
		git: mapEntries(root.git, "git", (entry, at) =>
			parseGitPin(entry, at, options),
		),
		assets: mapEntries(root.assets, "assets", (entry, at) =>
			parseAssetPin(entry, at, options),
		),
		vendor: mapEntries(root.vendor, "vendor", parseVendorPin),
	});
	const seen = new Set<string>();
	for (const name of [
		...Object.keys(pins.git),
		...Object.keys(pins.assets),
		...Object.keys(pins.vendor),
	]) {
		if (seen.has(name))
			malformed(
				"siblings.json",
				`the name ${name} is used by more than one pin`,
			);
		seen.add(name);
	}
	return pins;
}
