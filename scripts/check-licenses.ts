/**
 * Licence-compliance gate.
 *
 * Two halves, both cheap enough to run in the ordinary local gate:
 *
 *  1. OUTBOUND — every workspace manifest declares a `license`, and every
 *     PUBLISHABLE package (no `"private": true`) additionally ships a LICENSE
 *     file that is actually packed. npm only includes what `files` lists, so a
 *     LICENSE on disk that is missing from `files` would still publish a
 *     tarball with no licence grant — both halves are checked.
 *
 *  2. INBOUND — every third-party dependency resolves to a licence on the
 *     allowlist. An unknown or copyleft licence in an MIT project is a real
 *     problem and the repo previously had no gate that would notice.
 *
 * The inbound half separates PRODUCTION from DEVELOPMENT dependencies, because
 * the obligations are genuinely different: a weak-copyleft library linked into
 * a published package is a distribution question, while the same library used
 * by a build tool that never ships is not. Production offenders fail the gate;
 * development offenders are reported but do not fail, since nothing about them
 * is distributed.
 *
 * Inbound checking needs an installed `node_modules`; when it is absent the
 * inbound half reports SKIPPED rather than passing silently, so a green run
 * never implies coverage it did not have.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

// SPDX identifiers permitted for third-party dependencies. Permissive only:
// anything copyleft or unrecognised needs an explicit review decision rather
// than a silent pass.
const ALLOWED = new Set([
	"0BSD",
	"Apache-2.0",
	"BlueOak-1.0.0",
	"BSD-2-Clause",
	"BSD-3-Clause",
	"CC-BY-3.0",
	"CC-BY-4.0",
	"CC0-1.0",
	"ISC",
	"MIT",
	"MIT-0",
	"MPL-2.0",
	"Python-2.0",
	"Unlicense",
	"WTFPL",
	"Zlib",
]);

// Packages whose manifest metadata does not resolve to a usable SPDX id but
// whose actual LICENSE text was read by hand on 2026-07-27. In every case the
// manifest field is unusable, not the licence.
const REVIEWED_EXCEPTIONS = new Map<string, string>([
	[
		"@bytecodealliance/componentize-js",
		"Apache-2.0 — LICENSE text verified; manifest omits the field entirely",
	],
	[
		"zod-to-ts",
		"MIT — LICENSE text verified; manifest omits the field entirely",
	],
	[
		"@logdna/tail-file",
		"MIT — LICENSE text verified; manifest says 'SEE LICENSE IN LICENSE'",
	],
	[
		"spawndamnit",
		"MIT — LICENSE text verified; manifest says 'SEE LICENSE IN LICENSE'",
	],
	[
		"jsonify",
		"Public Domain — declared as prose rather than an SPDX id; no LICENSE file",
	],
]);

const OUTBOUND_LICENSE = "MIT";

const failures: string[] = [];
const notes: string[] = [];

function fail(message: string): void {
	failures.push(message);
}

/** Legacy licence objects (`{ "type": "MIT", "url": ... }`) still ship in the wild. */
interface LicenseObject {
	type?: string;
}

type LicenseField = string | LicenseObject | Array<string | LicenseObject>;

interface Manifest {
	name?: string;
	private?: boolean;
	license?: LicenseField;
	licenses?: LicenseField;
	files?: string[];
	version?: string;
}

const tagOf = Object.prototype.toString;

function isLicenseText<T>(value: T): value is T & string {
	return tagOf.call(value) === "[object String]";
}

function readManifest(file: string): Manifest {
	// SAFETY: assertion to `ileSync(file, "utf8")) as Manifest; } /** Workspa` is required at this boundary.
	return JSON.parse(readFileSync(file, "utf8")) as Manifest;
}

/** Workspace manifests: packages/<pkg>, packages/<group>/<pkg>, examples/<ex>, site, root. */
function workspaceManifests(): string[] {
	const found: string[] = ["package.json"];
	for (const root of ["packages", "examples"]) {
		if (!existsSync(root)) continue;
		for (const entry of readdirSync(root)) {
			const dir = join(root, entry);
			if (!statSync(dir).isDirectory()) continue;
			if (existsSync(join(dir, "package.json"))) {
				found.push(join(dir, "package.json"));
				continue;
			}
			// One nesting level (packages/providers/<pkg>, packages/iac/<pkg>, ...).
			for (const nested of readdirSync(dir)) {
				const nestedDir = join(dir, nested);
				if (!statSync(nestedDir).isDirectory()) continue;
				if (existsSync(join(nestedDir, "package.json"))) {
					found.push(join(nestedDir, "package.json"));
				}
			}
		}
	}
	if (existsSync(join("site", "package.json")))
		found.push(join("site", "package.json"));
	return found.sort();
}

function checkOutbound(): void {
	const manifests = workspaceManifests();
	let publishable = 0;

	for (const file of manifests) {
		const manifest = readManifest(file);
		const name = manifest.name ?? file;

		if (!manifest.license) {
			fail(`${file}: missing "license" field (expected "${OUTBOUND_LICENSE}")`);
		} else if (manifest.license !== OUTBOUND_LICENSE) {
			fail(
				`${file}: license is "${manifest.license}", expected "${OUTBOUND_LICENSE}" to match the repository LICENSE`,
			);
		}

		if (manifest.private) continue;
		publishable += 1;

		// A published package must carry the notice MIT itself requires.
		const licenseFile = join(file.replace(/package\.json$/, ""), "LICENSE");
		if (!existsSync(licenseFile)) {
			fail(`${name}: publishable but has no LICENSE file at ${licenseFile}`);
		}
		// `files` is an allowlist — a LICENSE not listed there is not packed.
		if (manifest.files && !manifest.files.includes("LICENSE")) {
			fail(
				`${name}: "LICENSE" missing from "files" (${JSON.stringify(manifest.files)}), so it would not be packed`,
			);
		}
	}

	notes.push(
		`outbound: ${manifests.length} workspace manifests checked, ${publishable} publishable`,
	);
}

/** Normalise the several shapes a package.json license field takes in the wild. */
function licenseIdsOf(manifest: Manifest): string[] {
	const raw = manifest.license ?? manifest.licenses;
	const collect = (value: LicenseField | undefined): string[] => {
		if (value === undefined) return [];
		if (Array.isArray(value)) return value.flatMap(collect);
		if (isLicenseText(value)) return [value];
		return value.type === undefined ? [] : [value.type];
	};
	// Split SPDX expressions ("(MIT OR Apache-2.0)", "MIT AND ISC") into terms,
	// then drop any `WITH <exception>` suffix: an SPDX exception grants
	// ADDITIONAL permission over the base licence (e.g. Apache-2.0 WITH
	// LLVM-exception is strictly more permissive than Apache-2.0), so the base
	// identifier is what the allowlist should be judged against.
	return collect(raw)
		.flatMap((expr) => expr.split(/\s+(?:OR|AND)\s+/i))
		.map((id) => (id.replace(/[()]/g, "").split(/\s+WITH\s+/i)[0] ?? "").trim())
		.filter(Boolean);
}

/**
 * Names reachable through the `dependencies` (never `devDependencies`) of a
 * publishable workspace package — i.e. the set that actually ships to a
 * consumer. Walks the pnpm virtual store transitively from those roots.
 */
function productionDependencyNames(): Set<string> {
	const store = join("node_modules", ".pnpm");
	// name -> its own prod dependency names, built once from the virtual store.
	const edges = new Map<string, string[]>();
	if (existsSync(store)) {
		for (const entry of readdirSync(store)) {
			const modules = join(store, entry, "node_modules");
			if (!existsSync(modules)) continue;
			for (const scopeOrPkg of readdirSync(modules)) {
				const rels = scopeOrPkg.startsWith("@")
					? readdirSync(join(modules, scopeOrPkg)).map((n) =>
							join(scopeOrPkg, n),
						)
					: [scopeOrPkg];
				for (const rel of rels) {
					const manifestPath = join(modules, rel, "package.json");
					if (!existsSync(manifestPath)) continue;
					try {
						const manifest = readManifest(manifestPath);
						if (!manifest.name || edges.has(manifest.name)) continue;
						edges.set(
							manifest.name,
							Object.keys(
								// SAFETY: assertion to `encies?: object }).dependencies ?? {}` is required at this boundary.
								(manifest as { dependencies?: object }).dependencies ?? {},
							),
						);
					} catch {
						/* unreadable manifest — the inbound scan reports it separately */
					}
				}
			}
		}
	}

	const queue: string[] = [];
	for (const file of workspaceManifests()) {
		const manifest = readManifest(file);
		if (manifest.private) continue; // only published packages ship their deps
		queue.push(
			...Object.keys(
				// SAFETY: assertion to `cies?: object }).dependencies ?? {}, ` is required at this boundary.
				(manifest as { dependencies?: object }).dependencies ?? {},
			),
		);
	}

	const seen = new Set<string>();
	while (queue.length > 0) {
		// SAFETY: assertion to ` if (seen.has(name)` is required at this boundary.
		const name = queue.pop() as string;
		if (seen.has(name)) continue;
		seen.add(name);
		queue.push(...(edges.get(name) ?? []));
	}
	return seen;
}

function checkInbound(): void {
	const store = join("node_modules", ".pnpm");
	if (!existsSync(store)) {
		notes.push(
			"inbound: SKIPPED — node_modules/.pnpm absent (run `pnpm install` to check dependency licences)",
		);
		return;
	}

	const production = productionDependencyNames();
	const offenders = new Map<string, string>();
	const devOffenders = new Map<string, string>();
	let checked = 0;

	for (const entry of readdirSync(store)) {
		const modules = join(store, entry, "node_modules");
		if (!existsSync(modules)) continue;
		for (const scopeOrPkg of readdirSync(modules)) {
			const dirs = scopeOrPkg.startsWith("@")
				? readdirSync(join(modules, scopeOrPkg)).map((n) => join(scopeOrPkg, n))
				: [scopeOrPkg];
			for (const rel of dirs) {
				const manifestPath = join(modules, rel, "package.json");
				if (!existsSync(manifestPath)) continue;
				let manifest: Manifest;
				try {
					manifest = readManifest(manifestPath);
				} catch {
					continue;
				}
				if (!manifest.name || !manifest.version) continue;
				// Workspace packages are covered by the outbound half.
				if (manifest.name.startsWith("@hobo/")) continue;
				checked += 1;

				const id = `${manifest.name}@${manifest.version}`;
				if (REVIEWED_EXCEPTIONS.has(manifest.name)) continue;

				const ids = licenseIdsOf(manifest);
				const bucket = production.has(manifest.name) ? offenders : devOffenders;
				if (ids.length === 0) {
					bucket.set(id, "no licence declared");
					continue;
				}
				// A dual-licensed package passes if ANY term is allowed.
				if (!ids.some((licenseId) => ALLOWED.has(licenseId))) {
					bucket.set(id, ids.join(" / "));
				}
			}
		}
	}

	notes.push(
		`inbound: ${checked} third-party packages checked (${production.size} reachable from a publishable package)`,
	);

	// Distributed code: a licence problem here is a real distribution problem.
	for (const [id, why] of [...offenders].sort()) {
		fail(`production dependency ${id}: licence not on the allowlist (${why})`);
	}

	// Build/dev-only: reported for visibility, but nothing about these ships,
	// so they do not block. Reviewing them is still worthwhile.
	if (devOffenders.size > 0) {
		notes.push(
			`inbound: ${devOffenders.size} development-only dependencies carry a non-allowlisted licence (not distributed, not blocking):`,
		);
		for (const [id, why] of [...devOffenders].sort()) {
			notes.push(`    ${id} — ${why}`);
		}
	}
}

checkOutbound();
checkInbound();

for (const note of notes) console.log(`  ${note}`);

if (failures.length > 0) {
	console.error(`\nLicence gate failed with ${failures.length} problem(s):\n`);
	for (const failure of failures) console.error(`  - ${failure}`);
	console.error(
		"\nTo allow a new dependency licence, add it to ALLOWED in scripts/check-licenses.ts with a review note.",
	);
	process.exit(1);
}

console.log("\nLicence gate passed.");
