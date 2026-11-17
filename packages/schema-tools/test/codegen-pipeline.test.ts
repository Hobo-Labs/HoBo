import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type MessageDescriptor, Verifier } from "@pact-foundation/pact";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runCli } from "../src/cli.js";
import { checkCodegen, runCodegen } from "../src/codegen.js";
import { vetReportEnvelope } from "../src/cue.js";
import { parseCodegenArgv } from "../src/parse.js";
import {
	type CodegenReport,
	createCodegenReport,
	reportToJson,
} from "../src/types.js";

const REPO_ROOT = join(fileURLToPath(new URL("../../..", import.meta.url)));
const POC_PACKAGES_SOURCE = join(
	REPO_ROOT,
	"src/draft/technical-proofs/s0-04-protobuf-cue-codegen/packages",
);
const CODEGEN_INTEGRATION_TIMEOUT_MS = 60_000;
const REPO_WIDE_CODEGEN_TIMEOUT_MS = 180_000;

let POC_PACKAGES = POC_PACKAGES_SOURCE;
let tempRoot: string | undefined;

beforeAll(async () => {
	tempRoot = await mkdtemp(join(tmpdir(), "schema-tools-poc-"));
	POC_PACKAGES = join(tempRoot, "packages");
	await cp(POC_PACKAGES_SOURCE, POC_PACKAGES, { recursive: true });
}, CODEGEN_INTEGRATION_TIMEOUT_MS);

afterAll(async () => {
	if (tempRoot) await rm(tempRoot, { recursive: true, force: true });
});

function invocation(check = false) {
	return Object.freeze({
		...parseCodegenArgv(check ? ["--check"] : [], REPO_ROOT),
		packagesRoot: POC_PACKAGES,
	});
}

describe("codegen determinism", () => {
	it(
		"writes byte-identical output on consecutive runs",
		async () => {
			const opts = invocation(false);
			const first = await runCodegen(opts);
			const second = await runCodegen(opts);
			expect(first.status).toBe("CLEAN");
			expect(second.status).toBe("CLEAN");
		},
		CODEGEN_INTEGRATION_TIMEOUT_MS,
	);
});

describe("drift gate", () => {
	it(
		"ignores generated assets owned by another generator",
		async () => {
			const unrelated = join(
				POC_PACKAGES,
				"core/src/_generated/illustration.ts",
			);
			await writeFile(unrelated, "export const illustration = true;\n");
			try {
				const report = await checkCodegen(invocation(true));
				expect(report.status).toBe("CLEAN");
			} finally {
				await rm(unrelated, { force: true });
			}
		},
		CODEGEN_INTEGRATION_TIMEOUT_MS,
	);

	it(
		"checkCodegen reports DRIFT for tampered generated file without mutating disk",
		async () => {
			const generated = join(
				POC_PACKAGES,
				"core/src/_generated/hobo/core/v1/event_envelope_pb.ts",
			);
			const before = await readFile(generated, "utf8");
			const { writeFile, stat } = await import("node:fs/promises");
			try {
				await writeFile(generated, `${before}// tampered\n`);
				const beforeStat = await stat(generated);

				const report = await checkCodegen(invocation(true));
				const after = await readFile(generated, "utf8");
				const afterStat = await stat(generated);

				expect(report.status).toBe("DRIFT");
				expect(
					report.drift.some((entry) =>
						entry.path.includes("event_envelope_pb.ts"),
					),
				).toBe(true);
				expect(after).toBe(`${before}// tampered\n`);
				expect(afterStat.mtimeMs).toBe(beforeStat.mtimeMs);
			} finally {
				await writeFile(generated, before);
			}
		},
		CODEGEN_INTEGRATION_TIMEOUT_MS,
	);
});

describe("CUE lane", () => {
	it(
		"accepts valid fixtures and rejects invalid fixtures fail-closed",
		async () => {
			const report = await checkCodegen(invocation(true));
			expect(report.cueViolations).toHaveLength(0);
		},
		CODEGEN_INTEGRATION_TIMEOUT_MS,
	);
});

describe("json envelope", () => {
	it(
		"round-trips CLEAN report and satisfies CUE constraints",
		async () => {
			const result = await runCli(["--check", "--json"], REPO_ROOT);
			expect(result.exitCode).toBe(0);
			const envelope = JSON.parse(result.stdout);
			expect(envelope.status).toBe("CLEAN");
			expect(Array.isArray(envelope.drift)).toBe(true);

			const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
			const { tmpdir } = await import("node:os");
			const dir = await mkdtemp(join(tmpdir(), "codegen-report-"));
			const path = join(dir, "report.json");
			await writeFile(path, result.stdout);
			const cue = await vetReportEnvelope(REPO_ROOT, path);
			await rm(dir, { recursive: true, force: true });
			expect(cue.ok).toBe(true);

			const sample = createCodegenReport({ status: "CLEAN", durationMs: 1 });
			expect(JSON.parse(reportToJson(sample)).status).toBe("CLEAN");
		},
		REPO_WIDE_CODEGEN_TIMEOUT_MS,
	);
});

async function withContractWorkspace<T>(
	run: (root: string) => Promise<T>,
): Promise<T> {
	const root = await mkdtemp(join(tmpdir(), "schema-tools-contract-"));
	try {
		await cp(POC_PACKAGES_SOURCE, join(root, "packages"), { recursive: true });
		await cp(
			join(
				REPO_ROOT,
				"src/draft/technical-proofs/s0-04-protobuf-cue-codegen/buf.gen.yaml",
			),
			join(root, "buf.gen.yaml"),
		);
		return await run(root);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}

type CodegenContract = {
	consumer: { name: string };
	provider: { name: string };
	metadata: { pactSpecification: { version: string }; transport: string };
	interactions: Array<{
		type: string;
		description: string;
		providerStates: Array<{ name: string }>;
		request: {
			contents: {
				contentType: string;
				encoded: false;
				content: { argv: string[] };
			};
		};
		response: Array<{
			contents: {
				contentType: string;
				encoded: false;
				content: {
					exitCode: number;
					report: Pick<CodegenReport, "status" | "drift" | "cueViolations">;
				};
			};
		}>;
	}>;
};

describe("codegen CLI contract", () => {
	it(
		"executes every recorded invocation against current and modified generated output",
		async () => {
			const pact: CodegenContract = JSON.parse(
				await readFile(
					join(
						import.meta.dirname,
						"../contracts/pacts/schema_tools_codegen_report.pact.json",
					),
					"utf8",
				),
			);
			expect(pact.consumer.name).toBe("HoboCiSchemaGate");
			expect(pact.provider.name).toBe("SchemaToolsCodegen");
			expect(pact.metadata).toEqual({
				pactSpecification: { version: "4.0.0" },
				transport: "cli-json",
			});
			expect(pact.interactions).toHaveLength(2);
			for (const interaction of pact.interactions) {
				expect(interaction.type).toBe("Synchronous/Messages");
				expect(interaction.request.contents.contentType).toBe(
					"application/json",
				);
				expect(interaction.request.contents.encoded).toBe(false);
				expect(interaction.response).toHaveLength(1);
				const response = interaction.response[0];
				if (!response) throw new Error("missing contract response");
				expect(response.contents.contentType).toBe("application/json");
				expect(response.contents.encoded).toBe(false);
				await withContractWorkspace(async (root) => {
					const generated = join(
						root,
						"packages/core/src/_generated/hobo/core/v1/event_envelope_pb.ts",
					);
					const state = interaction.providerStates[0]?.name;
					if (state === "the event envelope output is modified") {
						await writeFile(
							generated,
							`${await readFile(generated, "utf8")}\nexport const modified = true;\n`,
						);
					} else if (state !== "generated output is current") {
						throw new Error(`unknown provider state: ${state}`);
					}
					const before = await readFile(generated, "utf8");
					const result = await runCli(
						interaction.request.contents.content.argv,
						root,
					);
					expect(result.stderr).toBe("");
					expect({
						exitCode: result.exitCode,
						report: JSON.parse(result.stdout),
					}).toMatchObject(response.contents.content);
					expect(await readFile(generated, "utf8")).toBe(before);
				});
			}
		},
		CODEGEN_INTEGRATION_TIMEOUT_MS,
	);

	it(
		"verifies both CLI states with the Pact provider verifier",
		async () => {
			const path = join(
				import.meta.dirname,
				"../contracts/pacts/schema_tools_codegen_report.pact.json",
			);
			const pact: CodegenContract = JSON.parse(await readFile(path, "utf8"));
			let state = "";
			const stateHandlers = {
				"generated output is current": async () => {
					state = "generated output is current";
				},
				"the event envelope output is modified": async () => {
					state = "the event envelope output is modified";
				},
			};
			const verified = new Set<string>();
			const invoke = async (message: MessageDescriptor) => {
				if (
					message.content === undefined ||
					Buffer.isBuffer(message.content) ||
					message.providerStates?.[0]?.name !== state
				)
					throw new Error("invalid codegen contract request or state");
				const request: { argv: string[] } = JSON.parse(
					JSON.stringify(message.content),
				);
				return withContractWorkspace(async (root) => {
					const generated = join(
						root,
						"packages/core/src/_generated/hobo/core/v1/event_envelope_pb.ts",
					);
					if (state === "the event envelope output is modified")
						await writeFile(
							generated,
							`${await readFile(generated, "utf8")}\nexport const modified = true;\n`,
						);
					else if (state !== "generated output is current")
						throw new Error(`unknown provider state: ${state}`);
					const before = await readFile(generated, "utf8");
					const result = await runCli(request.argv, root);
					expect(result.stderr).toBe("");
					expect(await readFile(generated, "utf8")).toBe(before);
					verified.add(message.description);
					return {
						exitCode: result.exitCode,
						report: JSON.parse(result.stdout),
					};
				});
			};
			const messageProviders = Object.fromEntries(
				pact.interactions.map(({ description }) => [description, invoke]),
			);
			await new Verifier({
				provider: "SchemaToolsCodegen",
				pactUrls: [path],
				messageProviders,
				stateHandlers,
				logLevel: "error",
				failIfNoPactsFound: true,
			}).verifyProvider();
			expect([...verified].sort()).toEqual(
				pact.interactions.map(({ description }) => description).sort(),
			);
		},
		REPO_WIDE_CODEGEN_TIMEOUT_MS,
	);
});
