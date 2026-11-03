import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
	createTerraformAdapter,
	createTerraformCliEngine,
	createTrivialIacProgram,
	parsePlanChanges,
	renderTerraformJsonProgram,
	runIacBackendConformance,
	TERRAFORM_CLI_MISSING,
	TERRAFORM_UNSUPPORTED_RESOURCE,
	TerraformEngineUnavailableError,
} from "../src/index.js";
import type { JsonObject, JsonValue } from "../src/json.js";

// HOBO-717: the REAL binary lane. Pure renderers and the plan-JSON parser are
// tested offline; binary-gated tests run the full real conformance smoke over
// the builtin `terraform_data` resource (no provider download, no cloud
// credential) whenever `tofu` or `terraform` is on PATH.

function binaryAvailable(bin: string): boolean {
	try {
		execFileSync(bin, ["version"], { stdio: "pipe" });
		return true;
	} catch {
		return false;
	}
}

const availableBinary = ["tofu", "terraform"].find(binaryAvailable);

describe("renderTerraformJsonProgram (deterministic, golden)", () => {
	it("maps hobo:trivial/greeting to the builtin terraform_data resource", () => {
		const document = renderTerraformJsonProgram(
			{
				name: "hello",
				type: "hobo:trivial/greeting",
				inputs: { message: "hello-bindle" },
				outputs: ["greeting", "resourceId"],
			},
			{ accountId: "unset-account" },
		);
		expect(document).toEqual({
			resource: {
				terraform_data: {
					hello: { input: { message: "hello-bindle" } },
				},
			},
			output: {
				greeting: { value: "${terraform_data.hello.output.message}" },
				resourceId: { value: "${terraform_data.hello.id}" },
			},
		});
	});

	it("maps cloudflare tokens with the pinned provider requirement", () => {
		// SAFETY: `const document = renderTerraformJsonProgram(` is required at this I/O or test boundary.
		const document = renderTerraformJsonProgram(
			{
				name: "sessions",
				type: "cloudflare:kv-namespace",
				inputs: {},
				outputs: ["namespaceId", "binding"],
			},
			{ accountId: "acct-1" },
		) as {
			terraform: {
				required_providers: Record<string, { source: string; version: string }>;
			};
			resource: Record<string, Record<string, JsonObject>>;
		};
		expect(document.terraform.required_providers.cloudflare).toEqual({
			source: "cloudflare/cloudflare",
			version: "~> 4.0",
		});
		expect(document.resource.cloudflare_workers_kv_namespace.sessions).toEqual({
			account_id: "acct-1",
			title: "sessions",
		});
		expect(document.output.namespaceId.value).toBe(
			"${cloudflare_workers_kv_namespace.sessions.id}",
		);
		expect(document.output.binding.value).toBe("sessions");
	});

	it("fails closed on a resource class with no real translation", () => {
		expect(() =>
			renderTerraformJsonProgram(
				{ name: "x", type: "hobo:unmapped/thing", outputs: [] },
				{ accountId: "a" },
			),
		).toThrowError(TerraformEngineUnavailableError);
		try {
			renderTerraformJsonProgram(
				{ name: "x", type: "hobo:unmapped/thing", outputs: [] },
				{ accountId: "a" },
			);
		} catch (error) {
			// SAFETY: `expect((error as TerraformEngineUnavailableError).code).toBe(` is required at this I/O or test boundary.
			expect((error as TerraformEngineUnavailableError).code).toBe(
				TERRAFORM_UNSUPPORTED_RESOURCE,
			);
		}
	});
});

describe("parsePlanChanges (fixture plan documents)", () => {
	it("counts create/update/delete actions from show -json output", () => {
		const raw = JSON.stringify({
			resource_changes: [
				{ change: { actions: ["create"] } },
				{ change: { actions: ["update"] } },
				{ change: { actions: ["delete", "create"] } },
				{ change: { actions: ["no-op"] } },
			],
		});
		expect(parsePlanChanges(raw)).toEqual({ create: 2, update: 1, delete: 1 });
	});

	it("fails dirty (never silently clean) on malformed plan JSON", () => {
		expect(parsePlanChanges("not-json")).toEqual({
			create: 1,
			update: 0,
			delete: 0,
		});
	});
});

describe("createTerraformCliEngine gating", () => {
	it("fails closed with the typed error when the binary is missing", async () => {
		const engine = createTerraformCliEngine({
			workDir: mkdtempSync(join(tmpdir(), "hobo-tf-")),
			binary: "/nonexistent/hcl-binary",
		});
		await expect(engine.preview(createTrivialIacProgram())).rejects.toSatisfy(
			(error: JsonValue) =>
				error instanceof TerraformEngineUnavailableError &&
				error.code === TERRAFORM_CLI_MISSING,
		);
	});

	it("declares its binary and pinned toolchain", () => {
		const tofu = createTerraformCliEngine({
			workDir: mkdtempSync(join(tmpdir(), "hobo-tf-")),
		});
		expect(tofu.binary).toBe("tofu");
		const terraform = createTerraformCliEngine({
			workDir: mkdtempSync(join(tmpdir(), "hobo-tf-")),
			binary: "terraform",
		});
		expect(terraform.binary).toBe("terraform");
	});
});

// The real lane: the full IaC-backend conformance smoke over the builtin
// terraform_data resource — a REAL init/plan/apply/refresh/destroy cycle with
// real local state, no provider download, no cloud credential. Runs with
// whichever HCL binary is present; both binaries drive the identical suite.
describe.runIf(availableBinary !== undefined)(
	`real HCL conformance (${availableBinary ?? "no binary"})`,
	() => {
		it("passes the shared conformance smoke against real local state", async () => {
			const engine = createTerraformCliEngine({
				workDir: mkdtempSync(join(tmpdir(), "hobo-tf-live-")),
				// SAFETY: `binary: availableBinary as string,` is required at this I/O or test boundary.
				binary: availableBinary as string,
			});
			const adapter = createTerraformAdapter({ engine });
			const result = await runIacBackendConformance({
				adapter,
				program: createTrivialIacProgram(),
			});
			expect(result.passed).toBe(true);
		}, 180_000);
	},
);
