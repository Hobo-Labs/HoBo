import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import { asObject, asText, type JsonValue } from "./attestation.mts";

const RELATIVE_IMPORT =
	/(?:\bfrom|\bimport\s*\(?)\s*["'](\.{1,2}\/[^"']+)["']/gu;

export function packagesScriptsTestsImport(): readonly string[] {
	const queue = readdirSync("scripts/test")
		.filter((name) => name.endsWith(".test.ts"))
		.map((name) => join("scripts/test", name));
	const seen = new Set<string>();
	const directories = new Set<string>();
	for (let file = queue.pop(); file !== undefined; file = queue.pop()) {
		if (seen.has(file)) continue;
		seen.add(file);
		for (const [, specifier = ""] of readFileSync(file, "utf8").matchAll(
			RELATIVE_IMPORT,
		)) {
			const target = normalize(join(dirname(file), specifier));
			const owner = /^packages\/(.+?)\/(?:src|dist)\//u.exec(target)?.[1];
			if (owner !== undefined) directories.add(owner);
			else if (target.startsWith("scripts/")) {
				const source = [
					target,
					target.replace(/\.js$/u, ".ts"),
					target.replace(/\.mjs$/u, ".mts"),
				].find((candidate) => existsSync(candidate));
				if (source !== undefined) queue.push(source);
			}
		}
	}
	return [...directories].sort().map((directory) => {
		const parsed: JsonValue = JSON.parse(
			readFileSync(join("packages", directory, "package.json"), "utf8"),
		);
		const name = asText(asObject(parsed)?.name);
		assert.ok(name, `packages/${directory}/package.json has no name`);
		return name;
	});
}

if (import.meta.url === `file://${process.argv[1]}`) {
	const filters = packagesScriptsTestsImport().map(
		(name) => `--filter=${name}...`,
	);
	process.stdout.write(`${filters.join("\n")}\n`);
}
