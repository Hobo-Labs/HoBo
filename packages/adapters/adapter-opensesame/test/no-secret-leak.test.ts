import {
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import {
	createSecretAccessedEvent,
	requireNoPlaintextConformance,
} from "@hobo/identity";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { OpenSesameAdapterError } from "../src/errors.js";
import { surrogateEvidence } from "../src/evidence.js";
import { runProxied } from "../src/launch.js";
import { exitCodeOf, outcomeError } from "../src/outcome.js";
import { createOpenSesameSecretsPort } from "../src/port.js";
import { onlyBinding, parsed } from "./fixtures/bindings.js";

const here = dirname(fileURLToPath(import.meta.url));
const FAKE = join(here, "fixtures/fake-opensesame.mts");
const CHILD = join(here, "fixtures/child.mts");

/** The dummy that stands for a sealed token, and the shapes a failing child tends to print. */
const DUMMY = "vtok_dummy_marker_0123456789abcdef";
const HOSTILE = [
	`Error: deploy failed Authorization: Bearer ${DUMMY}`,
	"Error: AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
	`opensesame: surrogate.misdirected: ${DUMMY}`,
	`GITHUB_TOKEN=ghp_${"a1".repeat(18)}`,
].join("\n");
const LEAK_MARKERS = [DUMMY, "AWS_SECRET", "wJalr", "Bearer", "ghp_"];

let work = "";
beforeEach(() => {
	work = mkdtempSync(join(tmpdir(), "hobo-leak-test-"));
});
afterEach(() => {
	rmSync(work, { recursive: true, force: true });
});

function mentionsSecret(text: string): string | undefined {
	return LEAK_MARKERS.find((marker) => text.includes(marker));
}

describe("a failing child's output, and a sealed token, reach nothing the adapter returns, throws or writes", () => {
	for (const [status, scenario] of [
		[2, "surrogate-delivered"],
		[0, "surrogate-delivered"],
		[77, "misdirected"],
		[1, "plugin-changed"],
	] as const) {
		it(`exit ${status} (${scenario}) with a child that prints credentials`, async () => {
			const stderrFile = join(work, "child-stderr.txt");
			writeFileSync(stderrFile, `${HOSTILE}\n`);
			const sealed = join(work, "sealed-token.txt");
			writeFileSync(sealed, DUMMY);
			const before = JSON.stringify(Object.entries(process.env).sort());
			const sink = new PassThrough();
			sink.resume();
			const record = join(work, "record.json");
			const tmp = join(work, "tmp");
			const { mkdirSync } = await import("node:fs");
			mkdirSync(tmp);

			let thrown: unknown;
			let outcome: Awaited<ReturnType<typeof runProxied>> | undefined;
			try {
				outcome = await runProxied({
					bin: FAKE,
					bindings: parsed(),
					argv: [
						process.execPath,
						"--no-warnings",
						CHILD,
						join(work, "child.json"),
						String(status),
						stderrFile,
					],
					passEnv: [
						"FAKE_OPENSESAME_RECORD",
						"FAKE_OPENSESAME_SCENARIO",
						"FAKE_OPENSESAME_STORE_TOKEN",
					],
					env: {
						PATH: process.env.PATH ?? "",
						FAKE_OPENSESAME_RECORD: record,
						FAKE_OPENSESAME_SCENARIO: scenario,
						FAKE_OPENSESAME_STORE_TOKEN: DUMMY,
					},
					stderr: sink,
					tmpRoot: tmp,
				});
			} catch (error) {
				thrown = error;
			}

			const returned: string[] = [];
			if (outcome !== undefined) {
				returned.push(JSON.stringify(outcome), String(exitCodeOf(outcome)));
				returned.push(outcomeError(outcome)?.message ?? "");
			}
			if (thrown instanceof OpenSesameAdapterError)
				returned.push(thrown.message, thrown.code);
			for (const text of returned) {
				expect(mentionsSecret(text), text).toBeUndefined();
			}

			// The parent's environment is untouched, and nothing is left in the temp root.
			expect(JSON.stringify(Object.entries(process.env).sort())).toBe(before);
			expect(readdirSync(tmp)).toEqual([]);

			// What the stand-in saw as argv and schema: references only.
			const seen = readFileSync(record, "utf8");
			expect(seen).not.toContain(DUMMY);
			expect(seen).not.toContain("Bearer");
		});
	}

	it("the port's results, an event built from them, and the evidence record carry no secret shape", async () => {
		const surrogate = `osr_${"0123456789abcdef".repeat(2)}`;
		const port = createOpenSesameSecretsPort({
			bindings: parsed(),
			env: {
				VERCEL_TOKEN: surrogate,
				HOBO_OPENSESAME_CHILD: "1",
				NODE_USE_ENV_PROXY: "1",
				HTTPS_PROXY: "http://opensesame:x@127.0.0.1:9",
			},
		});
		const ok = await port.access("hobo-token://vercel/deploy");
		const denied = await createOpenSesameSecretsPort({
			bindings: parsed(),
			env: { VERCEL_TOKEN: DUMMY },
		}).access("hobo-token://vercel/deploy");
		if (ok.status !== "ok")
			throw new Error("expected a surrogate to be served");
		const event = createSecretAccessedEvent({
			name: "hobo-token://vercel/deploy",
			source: ok.source,
			valueRef: ok.valueRef,
			versionId: ok.versionId ?? "surrogate",
			tenant: "qdai",
		});
		requireNoPlaintextConformance({
			events: [event],
			agentContext: { denied },
			logs: JSON.stringify(denied),
		});
		for (const text of [
			JSON.stringify(event),
			JSON.stringify(denied),
			JSON.stringify(surrogateEvidence(onlyBinding())),
		]) {
			expect(text).not.toContain(DUMMY);
			expect(text).not.toContain(surrogate);
		}
	});
});
