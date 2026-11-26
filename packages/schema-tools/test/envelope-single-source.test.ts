import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { REPO_ROOT } from "./support/temp-workspace.js";

// GAPS IMPL-009: event_envelope.{proto,cue} is authored once, in
// packages/core/data-models/. The runtime-local copies exist only because the
// architecture guard requires every package's data-models to carry its own
// .proto+.cue; they are header-marked mirrors, and this test is the drift
// guard that turns silent duplication into a failing check.
//
// To change the envelope schema: edit the core files, re-copy the schema body
// into the runtime-local mirrors (keeping the mirror header and, for the
// proto, the hobo.runtime_local.v1 package line), then run codegen.

const CORE_DATA_MODELS = join(REPO_ROOT, "packages", "core", "data-models");
const RUNTIME_LOCAL_DATA_MODELS = join(
	REPO_ROOT,
	"packages",
	"runtimes",
	"runtime-local",
	"data-models",
);

/** Drop comment lines (the mirror header) and trailing whitespace noise. */
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
