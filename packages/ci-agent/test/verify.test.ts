import { describe, expect, it } from "vitest";
import { verifyResolvedFile } from "../src/verify.js";

const sides = (path: string, ours: string, theirs: string, resolved: string) =>
	verifyResolvedFile({ path, ours, theirs, resolved });

describe("resolved-file checks", () => {
	it("refuses a resolution that breaks a file both sides could parse", () => {
		expect(
			sides(
				"src/a.ts",
				"export const a = 1;\n",
				"export const a = 2;\n",
				"export const a = (1;\n",
			),
		).toBe("unparseable-resolution");
		expect(sides("data.json", '{"a":1}', '{"a":2}', '{"a":1,}')).toBe(
			"unparseable-resolution",
		);
		expect(sides("ci.yml", "a: 1\n", "a: 2\n", "a: 1\na: 2\n")).toBe(
			"unparseable-resolution",
		);
		expect(
			sides(
				"view.tsx",
				"export const V = () => <div/>;\n",
				"export const V = () => <span/>;\n",
				"export const V = () => <div>;\n",
			),
		).toBe("unparseable-resolution");
	});

	it("does not block a file that was already unparseable, or a format it cannot parse", () => {
		// tsconfig-style JSON with comments fails strict JSON on both sides.
		expect(
			sides("tsconfig.json", "{ // a\n}", "{ // b\n}", "{ // c\n}"),
		).toBeUndefined();
		expect(sides("README.md", "a", "b", "<<<")).toBeUndefined();
		expect(
			sides(
				"src/a.ts",
				"export const a = (;\n",
				"export const a = 2;\n",
				"export const a = (;\n",
			),
		).toBeUndefined();
	});

	it("refuses a resolution that declares a name twice where neither side did", () => {
		const ours =
			'import { a } from "./a.js";\nexport function f() { return a; }\n';
		const theirs =
			'import { a } from "./a.js";\nexport function f() { return a + 1; }\n';
		const both = `${ours}export function f() { return a + 1; }\n`;
		expect(sides("src/f.ts", ours, theirs, both)).toBe("duplicate-declaration");
		expect(
			sides(
				"src/f.ts",
				ours,
				theirs,
				'import { a } from "./a.js";\nimport { a } from "./a.js";\nexport const g = a;\n',
			),
		).toBe("duplicate-declaration");
		expect(
			sides(
				"src/f.js",
				"let x = 1;\n",
				"let x = 2;\n",
				"let x = 1;\nlet x = 2;\n",
			),
		).toBe("duplicate-declaration");
	});

	it("allows names that may legally repeat, and repeats both sides already had", () => {
		const overloads =
			"export function f(a: string): string;\nexport function f(a: number): number;\nexport function f(a: unknown) { return a; }\n";
		expect(sides("src/f.ts", overloads, overloads, overloads)).toBeUndefined();
		const merged =
			"interface A { x: 1 }\ninterface A { y: 2 }\nnamespace N {}\nnamespace N {}\n";
		expect(
			sides(
				"src/a.ts",
				"interface A { x: 1 }\n",
				"interface A { y: 2 }\n",
				merged,
			),
		).toBeUndefined();
		// A declaration file declares overloads and merges on purpose.
		expect(
			sides(
				"types.d.ts",
				"declare const a: 1;\n",
				"declare const a: 2;\n",
				"declare const a: 1;\ndeclare const a: 2;\n",
			),
		).toBeUndefined();
		const already = "var v = 1;\nvar v = 2;\n";
		expect(
			sides("src/v.js", already, already, `${already}export {};\n`),
		).toBeUndefined();
	});
});
