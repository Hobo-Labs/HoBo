import { spawnSync } from "node:child_process";
import {
	cpSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";

type PackageManifest = {
	name: string;
	dependencies?: Record<string, string>;
	exports?: Record<string, { types?: string; default?: string }>;
};

const bundled = ["backend-routing", "fleet"] as const;
const allowedDependencies = new Set([
	"@hobo/core",
	"@hobo/fleet",
	"@bufbuild/protobuf",
]);

export function prepareSqliteSdkManifest(
	manifest: PackageManifest,
	root: string,
): PackageManifest {
	if (manifest.name !== "@hobo/storage-sqlite") return manifest;
	const entry = manifest.exports?.["."];
	if (
		!entry ||
		Object.keys(manifest.exports ?? {}).length !== 1 ||
		entry.types !== "./dist/index.d.ts" ||
		entry.default !== "./dist/index.js" ||
		Object.keys(entry).sort().join(",") !== "default,types"
	) {
		throw new Error("SQLite SDK bundle has an unsupported export map");
	}
	const dependencies = { ...manifest.dependencies };
	for (const name of Object.keys(dependencies)) {
		if (name !== "@hobo/core" && name !== "@hobo/backend-routing") {
			throw new Error(
				`SQLite SDK bundle has unsupported direct dependency ${name}`,
			);
		}
	}
	if (dependencies["@hobo/core"] !== "workspace:*") {
		throw new Error("SQLite SDK bundle requires its expected core dependency");
	}
	if (dependencies["@hobo/backend-routing"] !== "workspace:*") {
		throw new Error(
			"SQLite SDK bundle requires its expected backend-routing dependency",
		);
	}
	delete dependencies["@hobo/backend-routing"];
	let protobuf: string | undefined;
	for (const name of bundled) {
		const pkg: PackageManifest = JSON.parse(
			readFileSync(join(root, "packages", name, "package.json"), "utf8"),
		);
		for (const [dependency, range] of Object.entries(pkg.dependencies ?? {})) {
			if (!allowedDependencies.has(dependency)) {
				throw new Error(
					`SQLite SDK bundle has unsupported dependency ${dependency} in ${name}`,
				);
			}
			if (dependency === "@bufbuild/protobuf") {
				if (protobuf && protobuf !== range)
					throw new Error(
						"SQLite SDK bundle has incompatible protobuf versions",
					);
				protobuf = range;
			}
		}
	}
	if (!protobuf)
		throw new Error("SQLite SDK bundle is missing its protobuf dependency");
	dependencies["@bufbuild/protobuf"] = protobuf;
	return { ...manifest, dependencies };
}

function declarationFiles(dir: string): string[] {
	return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) return declarationFiles(path);
		return entry.name.endsWith(".d.ts") ? [path] : [];
	});
}

export function bundleSqliteSdk(
	staging: string,
	source: string,
	root: string,
): void {
	const output = join(staging, "dist");
	const vendor = join(output, "_vendor");
	for (const name of bundled) {
		const src = join(root, "packages", name);
		const target = join(vendor, name);
		for (const file of declarationFiles(join(src, "dist"))) {
			const destination = join(target, relative(join(src, "dist"), file));
			mkdirSync(dirname(destination), { recursive: true });
			cpSync(file, destination);
		}
		cpSync(join(src, "LICENSE"), join(staging, `LICENSE.${name}`));
	}
	for (const file of declarationFiles(output)) {
		let contents = readFileSync(file, "utf8");
		for (const name of bundled) {
			let target = relative(dirname(file), join(vendor, name, "index.js"));
			if (!target.startsWith(".")) target = `./${target}`;
			contents = contents.replaceAll(`"@hobo/${name}"`, `"${target}"`);
			contents = contents.replaceAll(`'@hobo/${name}'`, `'${target}'`);
			if (contents.includes(`@hobo/${name}/`)) {
				throw new Error(
					`SQLite SDK bundle has an unsupported declaration subpath for ${name}`,
				);
			}
		}
		writeFileSync(file, contents);
	}
	const result = spawnSync(
		"pnpm",
		[
			"exec",
			"esbuild",
			join(source, "dist", "index.js"),
			"--bundle",
			"--platform=node",
			"--format=esm",
			"--target=node22",
			"--external:@hobo/core",
			"--external:@bufbuild/*",
			`--outfile=${join(output, "index.js")}`,
		],
		{ cwd: root, stdio: "inherit" },
	);
	if (result.status !== 0) throw new Error("SQLite SDK bundle failed");
}
