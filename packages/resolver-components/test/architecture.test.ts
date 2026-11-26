// Architecture guards for the component host (I8, I9, R2): no ambient
// network, DNS, environment or randomness; no shell or process escape hatch;
// generated record types only.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../src", import.meta.url));

function sources(dir: string): string[] {
	return readdirSync(dir).flatMap((name) => {
		const path = join(dir, name);
		if (statSync(path).isDirectory())
			return name === "_generated" ? [] : sources(path);
		return path.endsWith(".ts") ? [path] : [];
	});
}

const files = sources(root).map((path) => ({
	path: path.slice(root.length + 1),
	text: readFileSync(path, "utf8")
		.split("\n")
		.filter(
			(line) => !line.trim().startsWith("//") && !line.trim().startsWith("*"),
		)
		.join("\n"),
}));

describe("resolver-components architecture", () => {
	it.each([
		["ambient fetch", /\bfetch\(/u],
		["ambient DNS", /node:dns/u],
		["environment reads", /process\.env/u],
		["randomness", /Math\.random|randomUUID|getRandomValues/u],
		[
			"shell or process escape hatch",
			/node:child_process|(?<!\.)\bspawn\(|(?<![.\w])exec\(/u,
		],
		[
			"a raw network socket",
			/node:(?:tls|http|https|dgram)|createConnection|new\s+(?:net\.)?Socket|\.connect\(/u,
		],
	])("source performs no %s", (_label, pattern) => {
		const offenders = files
			.filter((file) => pattern.test(file.text))
			.map((file) => file.path);
		expect(offenders).toEqual([]);
	});

	it("reads the clock only through the injected `now` (default in runtime.ts)", () => {
		const offenders = files
			.filter((file) => /Date\.now/u.test(file.text))
			.map((file) => file.path);
		expect(offenders).toEqual(["runtime.ts"]);
	});

	it("never imports a provider, IaC, CI, CLI or app package", () => {
		const offenders = files.filter((file) =>
			/from "@hobo\/(?:provider-|iac-|ci|cli|hobo"|broker)/u.test(file.text),
		);
		expect(offenders.map((file) => file.path)).toEqual([]);
	});
});
