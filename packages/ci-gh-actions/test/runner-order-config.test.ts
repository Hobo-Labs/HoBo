import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_RUNNER_ORDER } from "@hobo/ci";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { parseCiProjectConfig } from "../src/project-config.js";
import { ciProjectJsonSchema } from "../src/project-schema.js";
import {
	parseCiRunnerOrder,
	RunnerOrderDocumentSchema,
} from "../src/runner-order-config.js";

const example = z
	.record(z.string(), z.json())
	.parse(
		JSON.parse(
			readFileSync(
				join(import.meta.dirname, "../examples/project/ci.json"),
				"utf8",
			),
		),
	);

const project = (runnerOrder: string | undefined): string =>
	JSON.stringify(
		runnerOrder === undefined
			? example
			: { ...example, runnerOrder: z.json().parse(JSON.parse(runnerOrder)) },
	);

describe("committed runner order", () => {
	it("is the default when the project file has none", () => {
		expect(parseCiRunnerOrder(project(undefined))).toEqual({
			order: DEFAULT_RUNNER_ORDER,
			source: "default",
			problem: "",
		});
	});

	it("reads a committed order", () => {
		const committed = parseCiRunnerOrder(
			project(
				'{"steps":[{"key":"machine"},{"key":"github","minutesLimitPercent":80},{"key":"depot","spendLimitUsd":50}],"autoSizeVcpus":4}',
			),
		);
		expect(committed.source).toBe("committed");
		expect(committed.problem).toBe("");
		expect(committed.order.steps.map((step) => step.key)).toEqual([
			"machine",
			"github",
			"depot",
		]);
		expect(committed.order.autoSizeVcpus).toBe(4);
	});

	it("keeps the default and says why when the committed order is broken", () => {
		const duplicated = parseCiRunnerOrder(
			project('{"steps":[{"key":"machine"},{"key":"machine"}]}'),
		);
		expect(duplicated.source).toBe("default");
		expect(duplicated.order).toBe(DEFAULT_RUNNER_ORDER);
		expect(duplicated.problem).toContain(
			"the machine step appears more than once",
		);
		expect(parseCiRunnerOrder(project('{"steps":[]}')).problem).toContain(
			"at least one step",
		);
		expect(parseCiRunnerOrder(project('"fleet-first"')).problem).not.toBe("");
	});

	it("never throws on a file that is not JSON", () => {
		expect(parseCiRunnerOrder("{not json")).toEqual({
			order: DEFAULT_RUNNER_ORDER,
			source: "default",
			problem: "the project file is not JSON",
		});
		expect(parseCiRunnerOrder("[]").source).toBe("default");
	});

	it.each([
		"[]",
		"null",
		"42",
		'"project"',
	])("refuses a project document that is not an object: %s", (json) => {
		expect(parseCiRunnerOrder(json).problem).toBe(
			"the project file is not a JSON object",
		);
	});

	it("is part of the project document: a valid order parses, a broken one fails the file", () => {
		expect(
			parseCiProjectConfig(project('{"steps":[{"key":"github"}]}')),
		).toEqual(parseCiProjectConfig(project(undefined)));
		expect(() =>
			parseCiProjectConfig(
				project('{"steps":[{"key":"github"},{"key":"github"}]}'),
			),
		).toThrow();
		expect(() =>
			parseCiProjectConfig(project('{"steps":[{"key":"buildjet"}]}')),
		).toThrow();
	});

	it("gives the schema's own rules the same answer as the parser", () => {
		const accepts = (order: z.infer<ReturnType<typeof z.json>>): boolean =>
			RunnerOrderDocumentSchema.safeParse(order).success;
		expect(accepts({ steps: [{ key: "runs-on" }] })).toBe(true);
		expect(
			accepts({ steps: [{ key: "machine", minutesLimitPercent: 50 }] }),
		).toBe(false);
		expect(accepts({ steps: [{ key: "github", spendLimitUsd: 50 }] })).toBe(
			false,
		);
		expect(accepts({ steps: [{ key: "github" }], autoSizeVcpus: 3 })).toBe(
			false,
		);
		expect(
			accepts({
				steps: [{ key: "github" }],
				retry: { enabled: true, runner: "same", max: 2 },
			}),
		).toBe(true);
		expect(accepts({ steps: [{ key: "github" }], extra: true })).toBe(false);
	});

	it("is described by the editor schema", () => {
		const schema = JSON.stringify(ciProjectJsonSchema());
		expect(schema).toContain('"runnerOrder"');
		expect(schema).toContain('"minutesLimitPercent"');
		expect(schema).toContain('"spendLimitUsd"');
	});
});
