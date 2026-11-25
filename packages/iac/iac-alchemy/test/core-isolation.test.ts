import {
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { extname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const repository = fileURLToPath(new URL("../../../../", import.meta.url));
const shared = [
	"core",
	"bindles",
	"cloud",
	"dispatcher",
	"policy",
	"pricing",
	"provider-manifest",
	"runtime",
	"wit",
] as const;
const extensions = new Set([
	".ts",
	".tsx",
	".mts",
	".cts",
	".js",
	".jsx",
	".mjs",
	".cjs",
	".json",
	".jsonc",
	".yaml",
	".yml",
	".toml",
	".cue",
	".proto",
	".wit",
]);

const ALCHEMY_DOMAIN_IMPORT = /@alchemy\.run\/domain(?:\/[A-Za-z0-9_.-]+)*/gi;

const DISPATCHER_ALCHEMY_DOMAIN_BDD_ONLY = new Set<string>(["dispatcher"]);

function containsReference(value: string): boolean {
	const decoded = value.replace(
		/\\(?:u\{([0-9a-f]{1,6})\}|u([0-9a-f]{4})|x([0-9a-f]{2}))/giu,
		(
			match,
			point: string | undefined,
			unit: string | undefined,
			byte: string | undefined,
		) => {
			const code = Number.parseInt(point ?? unit ?? byte ?? "", 16);
			return Number.isFinite(code) && code <= 0x10ffff
				? String.fromCodePoint(code)
				: match;
		},
	);
	return /alchemy/iu.test(decoded);
}

function packageFromRepoPath(root: string, path: string): string | null {
	const relativePath = relative(root, path).split(sep).join("/");
	const match = /^packages\/([^/]+)/u.exec(relativePath);
	return match?.[1] ?? null;
}

function stripAllowedDomainImports(packageName: string, text: string): string {
	if (!DISPATCHER_ALCHEMY_DOMAIN_BDD_ONLY.has(packageName)) {
		return text;
	}
	return text.replace(ALCHEMY_DOMAIN_IMPORT, "");
}

function packageJsonViolations(
	packageName: string,
	text: string,
): string | null {
	if (!containsReference(text)) return null;
	if (!DISPATCHER_ALCHEMY_DOMAIN_BDD_ONLY.has(packageName)) {
		return "package.json";
	}
	// SAFETY: package.json text is read from repo paths or mkdtemp fixtures in this test file only.
	const parsed = JSON.parse(text) as {
		dependencies?: Record<string, string>;
		devDependencies?: Record<string, string>;
		optionalDependencies?: Record<string, string>;
		peerDependencies?: Record<string, string>;
	};
	const depSections = [
		parsed.dependencies,
		parsed.devDependencies,
		parsed.optionalDependencies,
		parsed.peerDependencies,
	];
	for (const section of depSections) {
		if (!section) continue;
		for (const key of Object.keys(section)) {
			if (!/alchemy/iu.test(key)) continue;
			if (key === "@alchemy.run/domain") continue;
			return "package.json";
		}
	}
	const scrubbed = stripAllowedDomainImports(packageName, text);
	return containsReference(scrubbed) ? "package.json" : null;
}

function sourceViolations(packageName: string, text: string): boolean {
	const scrubbed = stripAllowedDomainImports(packageName, text);
	return containsReference(scrubbed);
}

function references(root: string, packages: readonly string[]): string[] {
	const found: string[] = [];
	const pending: string[] = [];
	let visited = 0;
	const label = (path: string) => relative(root, path).split(sep).join("/");
	const inspect = (path: string) => {
		const info = lstatSync(path);
		if (++visited > 4096 || info.size > 4 * 1024 * 1024)
			throw new Error("provider isolation input exceeds its bounds");
		const name = label(path);
		const packageName = packageFromRepoPath(root, path);
		if (info.isSymbolicLink() || containsReference(name)) {
			found.push(name);
			return;
		}
		const text = readFileSync(path, "utf8");
		if (path.endsWith(`${sep}package.json`) && packageName) {
			const violation = packageJsonViolations(packageName, text);
			if (violation) found.push(name);
			return;
		}
		if (packageName && sourceViolations(packageName, text)) {
			found.push(name);
		} else if (!packageName && containsReference(text)) {
			found.push(name);
		}
	};
	for (const name of packages) {
		const path = join(root, "packages", name);
		const info = lstatSync(path);
		if (info.isSymbolicLink() || !info.isDirectory()) {
			found.push(label(path));
			continue;
		}
		inspect(join(path, "package.json"));
		for (const part of ["src", "data-models", "contracts", "wit"]) {
			const entry = readdirSync(path, { withFileTypes: true }).find(
				(item) => item.name === part,
			);
			if (entry?.isSymbolicLink()) found.push(label(join(path, part)));
			else if (entry?.isDirectory()) pending.push(join(path, part));
		}
	}
	while (pending.length > 0) {
		const dir = pending.pop();
		if (!dir || ++visited > 4096)
			throw new Error("provider isolation input exceeds its bounds");
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const path = join(dir, entry.name);
			if (entry.isSymbolicLink()) found.push(label(path));
			else if (entry.isDirectory()) pending.push(path);
			else if (entry.isFile() && extensions.has(extname(entry.name)))
				inspect(path);
		}
	}
	return found.sort();
}

it("keeps shared runtime, pricing and policy packages independent of Alchemy", () => {
	expect(references(repository, shared)).toEqual([]);
});

it("detects references in package metadata and nested source files", () => {
	const root = mkdtempSync(join(tmpdir(), "hobo-provider-isolation-"));
	try {
		const path = join(root, "packages", "core");
		mkdirSync(join(path, "src", "nested"), { recursive: true });
		writeFileSync(
			join(path, "package.json"),
			'{"dependencies":{"alchemy":"1"}}',
		);
		writeFileSync(
			join(path, "src", "nested", "provider.ts"),
			'import "@ALCHEMY.run/example";',
		);
		writeFileSync(
			join(path, "src", "nested", "escaped.tsx"),
			String.raw`import "\u0061lchemy";`,
		);
		expect(references(root, ["core"])).toEqual([
			"packages/core/package.json",
			"packages/core/src/nested/escaped.tsx",
			"packages/core/src/nested/provider.ts",
		]);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

it("allows only @alchemy.run/domain imports in dispatcher", () => {
	const root = mkdtempSync(
		join(tmpdir(), "hobo-provider-isolation-dispatcher-"),
	);
	try {
		const path = join(root, "packages", "dispatcher");
		mkdirSync(join(path, "src"), { recursive: true });
		writeFileSync(
			join(path, "package.json"),
			JSON.stringify({
				dependencies: { "@alchemy.run/domain": "2.0.0-beta.87" },
			}),
		);
		writeFileSync(
			join(path, "src", "model.ts"),
			'import * as Domain from "@alchemy.run/domain";\nimport { Story } from "@alchemy.run/domain/Story";',
		);
		expect(references(root, ["dispatcher"])).toEqual([]);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

it("fails when dispatcher package.json uses JSON-escaped Alchemy dependency keys", () => {
	const root = mkdtempSync(
		join(tmpdir(), "hobo-provider-isolation-dispatcher-escape-"),
	);
	try {
		const path = join(root, "packages", "dispatcher");
		mkdirSync(join(path, "src"), { recursive: true });
		writeFileSync(
			join(path, "package.json"),
			'{"dependencies":{"@\\u0061lchemy.run/rivet":"0.1.0"}}',
		);
		expect(references(root, ["dispatcher"])).toEqual([
			"packages/dispatcher/package.json",
		]);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

it("fails when dispatcher imports other Alchemy packages", () => {
	const root = mkdtempSync(
		join(tmpdir(), "hobo-provider-isolation-dispatcher-bad-"),
	);
	try {
		const path = join(root, "packages", "dispatcher");
		mkdirSync(join(path, "src"), { recursive: true });
		writeFileSync(
			join(path, "package.json"),
			JSON.stringify({
				dependencies: {
					"@alchemy.run/domain": "2.0.0-beta.87",
					"@alchemy.run/rivet": "0.1.0",
				},
			}),
		);
		writeFileSync(join(path, "src", "leak.ts"), 'import "@alchemy.run/rivet";');
		expect(references(root, ["dispatcher"])).toEqual([
			"packages/dispatcher/package.json",
			"packages/dispatcher/src/leak.ts",
		]);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

it.skipIf(process.platform === "win32")(
	"does not follow a linked shared package root",
	() => {
		const root = mkdtempSync(join(tmpdir(), "hobo-provider-isolation-link-"));
		try {
			const target = join(root, "alternate");
			mkdirSync(join(target, "src"), { recursive: true });
			writeFileSync(join(target, "package.json"), "{}");
			mkdirSync(join(root, "packages"));
			symlinkSync(target, join(root, "packages", "core"), "dir");
			expect(references(root, ["core"])).toEqual(["packages/core"]);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	},
);
