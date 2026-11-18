import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { REPO_ROOT } from "./support/temp-workspace.js";

const CORE_DATA_MODELS = join(REPO_ROOT, "packages", "core", "data-models");
const RUNTIME_LOCAL_DATA_MODELS = join(
	REPO_ROOT,
	"packages",
	"runtimes",
	"runtime-local",
	"data-models",
);

function stripComments(content: string): string {
	return content
		.split("\n")
		.filter((line) => !line.trimStart().startsWith("//"))
		.join("\n")
		.trim();
}

describe("event envelope single-sourcing (IMPL-009)", () => {
	it("runtime-local's event_envelope.proto matches core's except the package line", async () => {
		const core = stripComments(
			await readFile(join(CORE_DATA_MODELS, "event_envelope.proto"), "utf8"),
		);
		const mirror = stripComments(
			await readFile(
				join(RUNTIME_LOCAL_DATA_MODELS, "event_envelope.proto"),
				"utf8",
			),
		);
		expect(mirror).toContain("package hobo.runtime_local.v1;");
		expect(
			mirror.replace("package hobo.runtime_local.v1;", "package hobo.core.v1;"),
		).toBe(core);
	});

	it("runtime-local's event_envelope.cue matches core's byte-for-byte (comments aside)", async () => {
		const core = stripComments(
			await readFile(join(CORE_DATA_MODELS, "event_envelope.cue"), "utf8"),
		);
		const mirror = stripComments(
			await readFile(
				join(RUNTIME_LOCAL_DATA_MODELS, "event_envelope.cue"),
				"utf8",
			),
		);
		expect(mirror).toBe(core);
	});

	it("marks both mirrors as generated copies pointing back at core", async () => {
		for (const file of ["event_envelope.proto", "event_envelope.cue"]) {
			const content = await readFile(
				join(RUNTIME_LOCAL_DATA_MODELS, file),
				"utf8",
			);
			expect(content.startsWith("// MIRROR")).toBe(true);
			expect(content).toContain("packages/core/data-models/");
			expect(content).toContain("IMPL-009");
		}
	});

	it("keeps the eventstore-specific definitions out of the mirrored envelope schema", async () => {
		const mirror = await readFile(
			join(RUNTIME_LOCAL_DATA_MODELS, "event_envelope.cue"),
			"utf8",
		);
		const port = await readFile(
			join(RUNTIME_LOCAL_DATA_MODELS, "eventstore_port.cue"),
			"utf8",
		);
		for (const definition of [
			"#EventInput:",
			"#AppendRequest:",
			"#AppendResult:",
			"#SnapshotRecord:",
			"#QuarantineFact:",
		]) {
			expect(stripComments(mirror)).not.toContain(definition);
			expect(port).toContain(definition);
		}
	});
});
