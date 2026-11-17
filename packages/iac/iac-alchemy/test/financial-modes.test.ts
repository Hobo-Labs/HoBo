import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inMemoryState, Resource, Stack } from "alchemy";
import * as Alchemist from "alchemy/Alchemist";
import * as Provider from "alchemy/Provider";
import * as Effect from "effect/Effect";
import { afterEach, describe, expect, it } from "vitest";
import { alchemyTarget, createAlchemyIacProvider } from "../src/index.js";
import type { FinancialDecision } from "../src/port.js";

type Widget = Resource<"Spec.Widget", object, { id: string }>;
const Widget = Resource<Widget>("Spec.Widget");
const dirs: string[] = [];
const priorHome = process.env.ALCHEMY_HOME;

afterEach(() => {
	if (priorHome === undefined) delete process.env.ALCHEMY_HOME;
	else process.env.ALCHEMY_HOME = priorHome;
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});

function fixture(decision: (requestId: string) => object) {
	const dir = mkdtempSync(join(tmpdir(), "hobo-alchemy-financial-"));
	dirs.push(dir);
	process.env.ALCHEMY_HOME = join(dir, "auth");
	let applies = 0;
	const uncertain: string[] = [];
	const stack = Stack(
		"App",
		{
			providers: Provider.succeed(Widget, {
				reconcile: () =>
					Effect.sync(() => {
						applies++;
						return { id: "widget" };
					}),
				delete: () => Effect.void,
			}),
			state: inMemoryState(),
		},
		Effect.gen(function* () {
			yield* Widget("widget", {});
			return { output: "ok" };
		}),
	);
	const provider = createAlchemyIacProvider({
		stack,
		runtimeLayer: Alchemist.layer(),
		runtimeDirectory: join(dir, "runtime"),
		target: alchemyTarget({
			targetId: "target",
			tenantId: "tenant",
			stackName: "App",
			stage: "test",
			programResourceId: "app",
			sourceDigest: `sha256:${"a".repeat(64)}`,
			inventoryEvidenceRef: "inventory:1",
			resources: [
				{
					resourceId: "widget",
					resourceType: "Spec.Widget",
					providerId: "test",
					providerAccountRef: "account",
					productId: "widget",
				},
			],
		}),
		financial: {
			assess: () => ({}),
			// SAFETY: this boundary intentionally tests malformed provider receipts.
			admit: async (requestId) => decision(requestId) as never,
			uncertain: (id) => {
				uncertain.push(id);
			},
		},
	});
	return {
		provider,
		applies: () => applies,
		uncertain,
		program: {
			programId: "p",
			deploymentId: "d",
			resourceId: "app",
			provider: "test",
			driver: "external",
			action: "apply" as const,
			stackName: "App",
		},
	};
}

function admitted(
	requestId: string,
	evaluation: string,
	unboundedExposure?: boolean,
) {
	const reservation: NonNullable<FinancialDecision["reservation"]> = {
		reservationId: `iac:${requestId}`,
	};
	if (unboundedExposure !== undefined)
		reservation.unboundedExposure = unboundedExposure;
	return {
		requestId,
		targetId: "target",
		status: "admitted",
		code: "",
		message: "",
		requestDigest: `sha256:${"b".repeat(64)}`,
		inventoryHash: `sha256:${"c".repeat(64)}`,
		budget: { evaluation, reservation: "held" },
		reservation,
	};
}

describe("financial admission modes", () => {
	it("executes an explicitly authorized unbounded exposure and discloses the budget bypass", async () => {
		const f = fixture((id) => admitted(id, "bypassed", true));
		await f.provider.preview(f.program);
		const result = await f.provider.applyWithAdmission(f.program, "attempt");
		expect(result).toMatchObject({
			outputs: { output: "ok" },
			admission: {
				budget: { evaluation: "bypassed", reservation: "held" },
				reservation: { reservationId: "iac:attempt", unboundedExposure: true },
			},
		});
		expect(f.applies()).toBe(1);
	});

	it.each([
		["bypassed", undefined],
		["bypassed", false],
		["allowed", true],
	] as const)("refuses a mismatched %s admission marker", async (evaluation, unboundedExposure) => {
		const f = fixture((id) => admitted(id, evaluation, unboundedExposure));
		await f.provider.preview(f.program);
		await expect(
			f.provider.applyWithAdmission(f.program, "attempt"),
		).rejects.toMatchObject({
			code: "ADMISSION_RECEIPT_INVALID",
			requiresReconciliation: true,
		});
		expect(f.applies()).toBe(0);
		expect(f.uncertain).toEqual(["iac:attempt"]);
	});

	it("does not silently replace a ranked priced expectation with a bypassed decision", async () => {
		const f = fixture((id) => admitted(id, "bypassed", true));
		await f.provider.preview(f.program);
		await expect(
			f.provider.applyWithAdmission(f.program, "attempt", {
				targetId: "target",
				inventoryHash: "i",
				modelHash: "m",
				quoteHash: "q",
			}),
		).rejects.toMatchObject({
			code: "ADMISSION_QUOTE_MISMATCH",
			requiresReconciliation: true,
		});
		expect(f.applies()).toBe(0);
		expect(f.uncertain).toEqual(["iac:attempt"]);
	});

	it.each([
		"requestDigest",
		"inventoryHash",
		"modelHash",
		"quoteHash",
	] as const)("refuses a bypass receipt with invalid %s evidence", async (field) => {
		const f = fixture((id) => ({
			...admitted(id, "bypassed", true),
			[field]:
				field.endsWith("Digest") || field === "inventoryHash"
					? "invalid"
					: `sha256:${"d".repeat(64)}`,
		}));
		await f.provider.preview(f.program);
		await expect(
			f.provider.applyWithAdmission(f.program, "attempt"),
		).rejects.toMatchObject({
			code: "ADMISSION_RECEIPT_INVALID",
			requiresReconciliation: true,
		});
		expect(f.applies()).toBe(0);
		expect(f.uncertain).toEqual(["iac:attempt"]);
	});
});
