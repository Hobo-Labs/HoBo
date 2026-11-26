import { describe, expect, it } from "vitest";

import { synthesizeTryRuntimeFromDeclared } from "./synthesize-try-runtime.js";

describe("synthesizeTryRuntimeFromDeclared", () => {
	it("maps ambient @intent greet into try-runtime routes", () => {
		const runtime = synthesizeTryRuntimeFromDeclared(`
@trainable
export declare class Hello {
  @intent("Produce a simple hello-world greeting")
  @returns("Hello World! or Hello, <name>! when supplied")
  greet(name?: string): string;
}
`);
		expect(runtime).toEqual({
			schemaVersion: "hobo.try-runtime/v1",
			resources: {},
			routes: [
				{ method: "GET", path: "/health", action: "health" },
				{ method: "POST", path: "/api/greet", action: "greet" },
			],
		});
	});

	it("fails closed when no trainable operations are declared", () => {
		expect(() => synthesizeTryRuntimeFromDeclared("export const x = 1;")).toThrow(
			/No ambient @trainable/,
		);
	});
});
