/**
 * Drift test for the vendored anti-slop Oxlint plugin (ADR-0173).
 *
 * HoBo keeps three copies of the plugin: the one `oxlint.config.ts` loads
 * (`tools/oxlint/anti-slop`) and the install-anti-slop skill's asset in the
 * `.claude` and `.agents` mirrors. Each copy carries `MANIFEST.sha256`, one
 * `<sha256>  <path>` line per file, in the format OpenSesame's
 * install-anti-slop asset ships and `sha256sum -c` reads. This test stands in
 * for that asset's `verify.mjs`, which the JavaScript-family file policy in
 * AGENTS.md keeps out of the repository.
 *
 * Two kinds of manifest line are not expected on disk, so the upstream
 * manifest can be vendored unchanged: RuleTester-only files (an install made
 * with `--no-tests` leaves them out) and `verify.mjs`. Every other listed file
 * must be present and unchanged, and nothing unlisted may be present.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

const root = join(import.meta.dirname, "../..");
const MANIFEST_NAME = "MANIFEST.sha256";
/** The copy oxlint.config.ts loads; the skill mirrors must equal it. */
const REFERENCE = "tools/oxlint/anti-slop";
const MIRRORS = [
	".claude/skills/install-anti-slop/assets/anti-slop",
	".agents/skills/install-anti-slop/assets/anti-slop",
];
const COPIES = [REFERENCE, ...MIRRORS];
const MANIFEST_LINE = /^([0-9a-f]{64}) {2}([A-Za-z0-9._/-]+)$/u;
const TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$/u;
const TEST_DIRECTORIES = new Set([
	"__fixtures__",
	"__snapshots__",
	"__tests__",
	"fixtures",
]);
const NOT_VENDORED = new Set(["verify.mjs"]);

interface ManifestReading {
	readonly digests: ReadonlyMap<string, string>;
	readonly problems: readonly string[];
}

/** Listed upstream but deliberately absent here: test-only files and verify.mjs. */
function isNotVendored(path: string): boolean {
	const parts = path.split("/");
	return (
		NOT_VENDORED.has(path) ||
		TEST_FILE.test(parts.at(-1) ?? "") ||
		parts.some((part) => TEST_DIRECTORIES.has(part))
	);
}

function isEscape(part: string): boolean {
	return part === "" || part === "." || part === "..";
}

function sha256(file: string): string {
	return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function readManifest(copy: string): ManifestReading {
	const digests = new Map<string, string>();
	const problems: string[] = [];
	const lines = readFileSync(join(root, copy, MANIFEST_NAME), "utf8").split(
		"\n",
	);
	if (lines.at(-1) === "") lines.pop();
	for (const [index, line] of lines.entries()) {
		const where = `${copy}/${MANIFEST_NAME} line ${index + 1}`;
		const [, digest, path] = MANIFEST_LINE.exec(line) ?? [];
		if (digest === undefined || path === undefined)
			problems.push(`${where} is not "<sha256>  <path>"`);
		else if (path === MANIFEST_NAME || path.split("/").some(isEscape))
			problems.push(`${where} names ${path}, not a file of the plugin`);
		else if (digests.has(path))
			problems.push(`${where} lists ${path} a second time`);
		else digests.set(path, digest);
	}
	if (lines.length === 0) problems.push(`${copy}/${MANIFEST_NAME} is empty`);
	return { digests, problems };
}

interface CopyListing {
	/** Regular files, as sorted posix paths. */
	readonly files: readonly string[];
	/** Anything else under the copy (a symlink, a socket), as sorted posix paths. */
	readonly irregular: readonly string[];
}

/** Every entry under `copy` but its manifest. A symlink is never followed. */
function listCopy(copy: string, prefix = ""): CopyListing {
	const files: string[] = [];
	const irregular: string[] = [];
	for (const entry of readdirSync(join(root, copy, prefix), {
		withFileTypes: true,
	})) {
		const path = `${prefix}${entry.name}`;
		if (path === MANIFEST_NAME) continue;
		if (entry.isDirectory()) {
			const inner = listCopy(copy, `${path}/`);
			files.push(...inner.files);
			irregular.push(...inner.irregular);
		} else if (entry.isFile()) files.push(path);
		else irregular.push(path);
	}
	return { files: files.sort(), irregular: irregular.sort() };
}

function listFiles(copy: string): readonly string[] {
	return listCopy(copy).files;
}

describe("vendored anti-slop plugin", () => {
	it("every vendored anti-slop file hashes to its manifest", () => {
		for (const copy of COPIES) {
			const { digests, problems } = readManifest(copy);
			const { files, irregular } = listCopy(copy);
			const present = new Set(files);
			const found = [
				...problems,
				...irregular.map(
					(path) =>
						`Not a regular file: ${copy}/${path} (a symlink or special file)`,
				),
			];
			for (const [path, digest] of digests) {
				if (isNotVendored(path)) continue;
				if (!present.has(path))
					found.push(`Missing file: ${copy}/${path} is listed but absent`);
				else if (sha256(join(root, copy, path)) !== digest)
					found.push(
						`Modified file: ${copy}/${path} does not match its digest`,
					);
			}
			assert.deepEqual(found, []);
		}
	});

	it("no file exists that the manifest does not list", () => {
		for (const copy of COPIES) {
			const { digests } = readManifest(copy);
			const extra = listFiles(copy)
				.filter((path) => !digests.has(path) || isNotVendored(path))
				.map((path) => `Extra file: ${copy}/${path}`);
			assert.deepEqual(extra, []);
		}
	});

	it("the three HoBo copies (tools, .claude skill asset, .agents skill asset) are identical", () => {
		const expected = [MANIFEST_NAME, ...listFiles(REFERENCE)];
		for (const mirror of MIRRORS) {
			assert.deepEqual([MANIFEST_NAME, ...listFiles(mirror)], expected, mirror);
			const differing = expected.filter(
				(path) =>
					!readFileSync(join(root, mirror, path)).equals(
						readFileSync(join(root, REFERENCE, path)),
					),
			);
			assert.deepEqual(differing, [], `${mirror} differs from ${REFERENCE}`);
		}
	});
});
