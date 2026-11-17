import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inMemoryState, Resource, Stack } from "alchemy";
import * as Alchemist from "alchemy/Alchemist";
import * as Provider from "alchemy/Provider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { describe, expect, it } from "vitest";
import {
	alchemyTarget,
	captureAlchemyProgram,
	createAlchemyIacProvider,
	type FinancialPlan,
	type IacProgram,
} from "../src/index.js";

type Widget = Resource<"Spec.Widget", Record<string, never>, { id: string }>;
const Widget = Resource<Widget>("Spec.Widget");

function baseProgram(): IacProgram {
	return {
		programId: "p",
		deploymentId: "d",
		resourceId: "app",
		provider: "provider",
		driver: "external",
		action: "apply",
		stackName: "App",
	};
}
function resource() {
	return {
		name: "app",
		provider: "provider",
		port: "kv",
		deps: ["one"],
		realizationParameters: { region: "west", replicas: 2 },
	};
}

describe("Alchemy program input boundary", () => {
	it("captures and freezes the full declaration, preserving stable presence and canonical digests", () => {
		const input = {
			...baseProgram(),
			resource: resource(),
			operationGeneration: "generation-1",
		};
		const captured = captureAlchemyProgram(input);
		const absent = captureAlchemyProgram(baseProgram());
		expect(captured.declarationPresence).toBe("present");
		expect(absent.declarationPresence).toBe("absent");
		expect(captured.declarationDigest).not.toBe(absent.declarationDigest);
		expect(absent.declarationDigest).toMatch(/^sha256:[a-f0-9]{64}$/u);
		const equivalent = captureAlchemyProgram({
			...baseProgram(),
			operationGeneration: "generation-1",
			resource: {
				realizationParameters: { replicas: 2, region: "west" },
				deps: ["one"],
				port: "kv",
				provider: "provider",
				name: "app",
			},
		});
		expect(captured.declarationDigest).toBe(equivalent.declarationDigest);
		input.resource.realizationParameters.region = "east";
		input.resource.deps.push("two");
		expect(captured.program.resource).toEqual(resource());
		expect(Object.isFrozen(captured.program)).toBe(true);
		expect(Object.isFrozen(captured.program.resource)).toBe(true);
	});

	it("accepts bounded orchestrator composite identities without truncating them", () => {
		const program = {
			...baseProgram(),
			programId: "p".repeat(401),
			stackName: "s".repeat(602),
		};
		const captured = captureAlchemyProgram(program);
		expect(captured.program.programId).toBe(program.programId);
		expect(captured.program.stackName).toBe(program.stackName);
		expect(() =>
			captureAlchemyProgram({ ...program, programId: "p".repeat(402) }),
		).toThrow("PROGRAM_INVALID");
		expect(() =>
			captureAlchemyProgram({ ...program, stackName: "s".repeat(603) }),
		).toThrow("PROGRAM_INVALID");
	});

	it("rejects program and nested proxies, accessors, hidden keys and unknown fields without running them", () => {
		let calls = 0;
		const accessor = { ...baseProgram() };
		Object.defineProperty(accessor, "provider", {
			enumerable: true,
			get() {
				calls++;
				return "provider";
			},
		});
		const hidden = { ...baseProgram() };
		Object.defineProperty(hidden, "hidden", { value: "x" });
		const nested = resource();
		Object.defineProperty(nested.realizationParameters, "secret", {
			enumerable: true,
			get() {
				calls++;
				return "value";
			},
		});
		const proxy = new Proxy(baseProgram(), {
			ownKeys() {
				calls++;
				throw new Error("trap");
			},
		});
		const nestedProxy = new Proxy(resource(), {
			ownKeys() {
				calls++;
				throw new Error("trap");
			},
		});
		for (const value of [
			accessor,
			hidden,
			{ ...baseProgram(), extra: "unknown" },
			proxy,
			{ ...baseProgram(), resource: nested },
			{ ...baseProgram(), resource: nestedProxy },
		])
			expect(() => captureAlchemyProgram(value)).toThrow("PROGRAM_INVALID");
		expect(calls).toBe(0);
	});

	it("rejects mismatched identities, cycles, sparse/decorated arrays and oversized declarations", () => {
		interface CyclicFixture {
			self?: CyclicFixture;
		}
		const cyclic: CyclicFixture = {};
		cyclic.self = cyclic;
		const sparse = Array(1);
		const decorated = Object.assign(["one"], { extra: true });
		const oversized = Array(1_000_000_000);
		const values: object[] = [
			{ ...resource(), name: "other" },
			{ ...resource(), provider: "other" },
			{ ...resource(), deploymentId: "other" },
			{ ...resource(), realizationParameters: cyclic },
			{ ...resource(), deps: sparse },
			{ ...resource(), deps: decorated },
			{ ...resource(), deps: oversized },
			{ ...resource(), realizationParameters: { large: "x".repeat(4097) } },
		];
		for (const value of values)
			expect(() =>
				captureAlchemyProgram({ ...baseProgram(), resource: value }),
			).toThrow("PROGRAM_INVALID");
	});

	it("refuses a desired declaration before planning until a host authority can authenticate it", async () => {
		const f = fixture();
		try {
			await expect(
				f.provider.preview({ ...baseProgram(), resource: resource() }),
			).rejects.toMatchObject({ code: "PROGRAM_DECLARATION_UNVERIFIED" });
			expect(f.effects()).toEqual([]);
		} finally {
			f.cleanup();
		}
	});

	it("pins operation generation and snapshots the action across asynchronous admission", async () => {
		const f = fixture();
		try {
			const program = { ...baseProgram(), operationGeneration: "generation-1" };
			await f.provider.preview(program);
			await expect(
				f.provider.applyWithAdmission(
					{ ...program, operationGeneration: "generation-2" },
					"other",
				),
			).rejects.toMatchObject({ code: "PREVIEW_REQUIRED" });
			const pending = f.provider.applyWithAdmission(program, "request");
			await f.admitting;
			program.action = "destroy";
			program.resourceId = "mutated";
			f.release();
			const result = await pending;
			expect(result.admission.reservation.reservationId).toBe("iac:request");
			expect(f.financialOperations()).toEqual(["deploy"]);
			expect(f.effects()).toEqual(["create"]);
		} finally {
			f.release();
			f.cleanup();
		}
	});
});

function fixture() {
	const directory = mkdtempSync(join(tmpdir(), "hobo-iac-program-"));
	const oldHome = process.env.ALCHEMY_HOME;
	process.env.ALCHEMY_HOME = directory;
	const seen: string[] = [];
	const financial: string[] = [];
	let begin: (() => void) | undefined;
	let release: (() => void) | undefined;
	const admitting = new Promise<void>((resolve) => {
		begin = resolve;
	});
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	const providers = Provider.succeed(Widget, {
		reconcile: () =>
			Effect.sync(() => {
				seen.push("create");
				return { id: "widget" };
			}),
		delete: () =>
			Effect.sync(() => {
				seen.push("delete");
			}),
	});
	const stack = Stack(
		"App",
		{
			providers,
			state: inMemoryState(),
		},
		Effect.gen(function* () {
			yield* Widget("widget", {});
			return {};
		}),
	);
	const provider = createAlchemyIacProvider({
		stack,
		runtimeLayer: Layer.merge(Alchemist.layer(), providers),
		runtimeDirectory: directory,
		target: alchemyTarget({
			targetId: "t",
			tenantId: "tenant",
			stackName: "App",
			stage: "test",
			programResourceId: "app",
			sourceDigest: `sha256:${"a".repeat(64)}`,
			inventoryEvidenceRef: "inventory",
			resources: [
				{
					resourceId: "widget",
					resourceType: "Spec.Widget",
					providerId: "provider",
					providerAccountRef: "account",
					productId: "widget",
				},
			],
		}),
		financial: {
			assess: (plan: FinancialPlan) => ({ plan }),
			admit: async (requestId, plan) => {
				financial.push(plan.operation);
				begin?.();
				await gate;
				return {
					requestId,
					targetId: "t",
					status: "admitted",
					code: "",
					message: "",
					budget: { evaluation: "allowed", reservation: "held" },
					reservation: { reservationId: `iac:${requestId}` },
				};
			},
			uncertain: () => {},
		},
	});
	return {
		provider,
		admitting,
		release: () => release?.(),
		effects: () => seen,
		financialOperations: () => financial,
		cleanup: () => {
			if (oldHome === undefined) delete process.env.ALCHEMY_HOME;
			else process.env.ALCHEMY_HOME = oldHome;
			rmSync(directory, { recursive: true, force: true });
		},
	};
}
