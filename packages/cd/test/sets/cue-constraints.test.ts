// Vets real journal bodies against data-models/sets.cue (the constraints the
// TS parsers mirror). Skips with a visible reason when no `cue` binary exists.
import { execFileSync } from "node:child_process";
import {
	existsSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { create } from "@bufbuild/protobuf";
import { describe, expect, it } from "vitest";
import { DeltaRecordSchema, SetOrigin } from "../../src/_generated/cd_pb.js";
import { CD_EVENTS } from "../../src/events.js";
import type { DeltaId } from "../../src/ports.js";
import { createDesiredState, diffResolvedSets } from "../../src/sets/index.js";
import {
	createFakeArtifactStore,
	createFakeEventStore,
	ctxAt,
	resolvedFor,
	SHOP_V1,
	SHOP_V2,
	T0,
} from "./fakes.js";

const schema = fileURLToPath(
	new URL("../../data-models/sets.cue", import.meta.url),
);

function findCue(): string | undefined {
	if (process.env.HOBO_CUE_BIN && existsSync(process.env.HOBO_CUE_BIN))
		return process.env.HOBO_CUE_BIN;
	let dir = fileURLToPath(new URL(".", import.meta.url));
	for (let i = 0; i < 12; i++) {
		const tools = join(dir, ".tools", "cue");
		if (existsSync(tools)) {
			for (const version of readdirSync(tools).sort().reverse()) {
				const bin = join(tools, version, "cue");
				if (existsSync(bin)) return bin;
			}
		}
		dir = join(dir, "..");
	}
	try {
		return (
			execFileSync("which", ["cue"], { encoding: "utf8" }).trim() || undefined
		);
	} catch {
		return undefined;
	}
}

const cue = findCue();
const DEFINITIONS: Record<string, string> = {
	[CD_EVENTS.SetCreated]: "#SetRecord",
	[CD_EVENTS.DeltaOpened]: "#DeltaRecord",
	[CD_EVENTS.DeltaUpdated]: "#DeltaRecord",
	[CD_EVENTS.DeltaApplied]: "#DeltaDecisionRecord",
	[CD_EVENTS.DeltaRejected]: "#DeltaDecisionRecord",
};

function vet(definition: string, body: unknown): string {
	const dir = mkdtempSync(join(tmpdir(), "cd-sets-cue-"));
	const file = join(dir, "body.json");
	writeFileSync(file, JSON.stringify(body));
	try {
		execFileSync(cue ?? "cue", ["vet", "-d", definition, schema, file], {
			encoding: "utf8",
			stdio: "pipe",
		});
		return "";
	} catch (error) {
		return String((error as { stderr?: string }).stderr ?? error);
	}
}

describe.skipIf(cue === undefined)(
	`sets.cue vets real bodies${cue === undefined ? " (skipped: no cue binary; set HOBO_CUE_BIN)" : ""}`,
	() => {
		it("every body the ledger appends satisfies its CUE definition", async () => {
			const store = createFakeEventStore();
			const desired = createDesiredState({
				store,
				artifacts: createFakeArtifactStore(),
				tenant: "acme",
				now: () => T0,
			});
			const v1 = resolvedFor("prod-aws", SHOP_V1);
			await desired.open(
				create(DeltaRecordSchema, {
					deltaId: "d1",
					campId: "prod-aws",
					intent: "up",
					changes: diffResolvedSets(undefined, v1),
				}),
				ctxAt(T0),
			);
			await desired.update(
				create(DeltaRecordSchema, {
					deltaId: "d1",
					campId: "prod-aws",
					intent: "up",
					changes: diffResolvedSets(undefined, v1),
				}),
				ctxAt(T0),
			);
			const applied = await desired.apply(
				{
					deltaId: "d1" as DeltaId,
					gateDecisionId: "g",
					resolved: v1,
					origin: SetOrigin.UP,
				},
				ctxAt(T0),
			);
			if (!applied.ok) throw new Error("refused");
			await desired.open(
				create(DeltaRecordSchema, {
					deltaId: "d2",
					campId: "prod-aws",
					intent: "promote",
					baseSetId: applied.value.setId,
					changes: diffResolvedSets(v1, resolvedFor("prod-aws", SHOP_V2)),
				}),
				ctxAt(T0),
			);
			await desired.reject(
				"d2" as DeltaId,
				[
					{
						$typeName: "hobo.cd.v1.ReasonRecord",
						code: "window-closed",
						message: "",
						remediation: "",
						subject: "",
					},
				],
				ctxAt(T0),
			);
			for (const { event } of store.log) {
				const definition = DEFINITIONS[event.type];
				if (definition === undefined) continue;
				expect(
					vet(definition, event.data),
					`${event.type} vs ${definition}`,
				).toBe("");
			}
		});

		it("the golden journal fixture satisfies the CUE definitions", () => {
			const golden = JSON.parse(
				readFileSync(
					new URL("./fixtures/golden-journal.json", import.meta.url),
					"utf8",
				),
			);
			for (const event of golden.events as { type: string; data: unknown }[]) {
				const definition = DEFINITIONS[event.type];
				if (definition !== undefined)
					expect(vet(definition, event.data), event.type).toBe("");
			}
		});

		it("rejects a Delta id that claims the Set prefix", () => {
			expect(
				vet("#DeltaRecord", {
					schemaVersion: "hobo.cd.delta/v1",
					deltaId: "set_x",
					campId: "a",
					intent: "up",
				}),
			).toMatch(/set_/);
		});
	},
);
