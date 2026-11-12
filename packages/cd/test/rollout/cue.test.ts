// data-models/rollout.cue and the TypeScript boundary must agree: every
// ledger body the live orchestrator writes vets clean against its definition,
// and what the parse boundary refuses, CUE refuses too.
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { create, type JsonValue, toJson } from "@bufbuild/protobuf";
import { describe, expect, it } from "vitest";
import {
	ReasonRecordSchema,
	RolloutLoweringRecordSchema,
	RolloutStrategy,
	VerificationVerdict,
} from "../../src/_generated/cd_pb.js";
import { CD_EVENTS, WINDOW_CLOSED } from "../../src/events.js";
import { ROLLOUT_LEDGER } from "../../src/rollout/journal.js";
import { jsonOf } from "../../src/rollout/json.js";
import { lowerCamp, stagePercentsFor } from "../../src/rollout/lowering.js";
import { camp, MINUTE, promotion, spec } from "./fakes.js";
import { rig } from "./rig.js";

const here = dirname(fileURLToPath(import.meta.url));
const schema = resolve(here, "../../data-models/rollout.cue");

/** `cue` on PATH, else the repo-pinned binary under an ancestor's `.tools/cue/<version>/cue`. */
function findCue(): string | undefined {
	try {
		execFileSync("cue", ["version"], { stdio: "ignore" });
		return "cue";
	} catch {
		let directory = here;
		while (dirname(directory) !== directory) {
			const tools = join(directory, ".tools", "cue");
			if (existsSync(tools)) {
				for (const version of readdirSync(tools).sort().reverse()) {
					const binary = join(tools, version, "cue");
					if (existsSync(binary)) return binary;
				}
			}
			directory = dirname(directory);
		}
		return undefined;
	}
}

const cue = findCue();
const scratch = mkdtempSync(join(tmpdir(), "hobo-cd-rollout-cue-"));
let written = 0;

function vets(definition: string, value: JsonValue | undefined): boolean {
	if (!cue) throw new Error("cue binary not found");
	written += 1;
	const file = join(scratch, `value-${written}.cue`);
	writeFileSync(
		file,
		`package rollout\n\nvalue: ${definition} & ${JSON.stringify(value)}\n`,
	);
	try {
		execFileSync(cue, ["export", schema, file, "-e", "value"], {
			stdio: "pipe",
		});
		return true;
	} catch {
		return false;
	}
}

const DEFINITION: Readonly<Record<string, string>> = {
	[CD_EVENTS.RolloutLowered]: "#RolloutLowered",
	[ROLLOUT_LEDGER.shiftRequested]: "#RolloutShiftRequested",
	[ROLLOUT_LEDGER.shifted]: "#RolloutShifted",
	[ROLLOUT_LEDGER.stageVerified]: "#RolloutStageVerified",
	[ROLLOUT_LEDGER.held]: "#RolloutHeld",
	[ROLLOUT_LEDGER.rollbackDeltaOpened]: "#RolloutRollbackDeltaOpened",
	[ROLLOUT_LEDGER.finished]: "#RolloutFinished",
};

describe.skipIf(cue === undefined)(
	"rollout.cue agrees with the rollout boundary (skips with no cue binary: run scripts/bootstrap-dev.sh)",
	() => {
		it("vets every ledger body a live promoted and a rolled-back rollout write", async () => {
			const checked: string[] = [];
			for (const failAt of [undefined, 1]) {
				const r = rig();
				r.verification.script = ({ call }) =>
					call === failAt ? VerificationVerdict.FAIL : VerificationVerdict.PASS;
				r.desired.promoted("prod-a", "freight-1");
				r.desired.promoted("prod-b", "freight-1");
				const planned = await r.orchestrator.plan(
					{
						promotion: promotion({
							targets: ["prod-a", "prod-b"],
							strategy: RolloutStrategy.CANARY,
						}),
						obligations: [],
						verification: spec(),
						stagePercents: [],
						windows: ["prod"],
					},
					r.ctx,
				);
				if (!planned.ok) throw new Error("plan refused");
				r.windows.open = false;
				await r.orchestrator.run(planned.value, r.ctx);
				r.windows.open = true;
				r.time.advance(MINUTE);
				await r.orchestrator.tick(r.ctx);
				for (const event of r.store.events(
					ROLLOUT_LEDGER.stream(planned.value.rolloutId),
				)) {
					const definition = DEFINITION[event.type];
					if (!definition) continue;
					expect(
						vets(definition, jsonOf(event.data)),
						`${event.type} ${JSON.stringify(event.data)}`,
					).toBe(true);
					checked.push(event.type);
				}
			}
			for (const type of Object.keys(DEFINITION))
				expect(checked).toContain(type);
		});

		it("refuses stage percents the parser refuses and vets the ones it accepts", () => {
			const plan = (
				stagePercents: readonly number[],
				strategy = "ROLLOUT_STRATEGY_CANARY",
			) => ({
				rolloutId: `rollout-${"a".repeat(32)}`,
				promotionId: "promo-1",
				strategy,
				stagePercents,
				targetCampIds: ["prod-a"],
				lowerings: [{ campId: "prod-a", strategy, offeringId: "lb.weighted" }],
			});
			for (const percents of [
				[50, 25],
				[0, 100],
				[10, 10, 100],
				[5, 50],
			]) {
				const parsed = stagePercentsFor(RolloutStrategy.CANARY, percents);
				// The parser appends 100 to a short ramp; CUE vets the stored (completed) plan.
				const stored = parsed.ok ? parsed.value : percents;
				expect(vets("#RolloutPlanRecord", plan(stored))).toBe(parsed.ok);
			}
			expect(
				vets(
					"#RolloutPlanRecord",
					plan([50, 100], "ROLLOUT_STRATEGY_BLUE_GREEN"),
				),
			).toBe(false);
			expect(stagePercentsFor(RolloutStrategy.BLUE_GREEN, [50, 100]).ok).toBe(
				false,
			);
		});

		it("a lowering is a rung or a progressive-unsupported refusal, never both", () => {
			const rung = lowerCamp({
				campId: camp("a"),
				strategy: RolloutStrategy.CANARY,
				offerings: ["dns.weighted"],
				fallbackForbidden: false,
			});
			const refused = lowerCamp({
				campId: camp("a"),
				strategy: RolloutStrategy.CANARY,
				offerings: [],
				fallbackForbidden: false,
			});
			expect(
				vets(
					"#RolloutLoweringRecord",
					toJson(RolloutLoweringRecordSchema, rung),
				),
			).toBe(true);
			expect(
				vets(
					"#RolloutLoweringRecord",
					toJson(RolloutLoweringRecordSchema, refused),
				),
			).toBe(true);
			const both = create(RolloutLoweringRecordSchema, {
				...rung,
				refusal: refused.refusal,
			});
			expect(
				vets(
					"#RolloutLoweringRecord",
					toJson(RolloutLoweringRecordSchema, both),
				),
			).toBe(false);
			const neither = create(RolloutLoweringRecordSchema, {
				campId: "a",
				strategy: RolloutStrategy.CANARY,
			});
			expect(
				vets(
					"#RolloutLoweringRecord",
					toJson(RolloutLoweringRecordSchema, neither),
				),
			).toBe(false);
		});

		it("a failed or rolled-back finish always says why; holds are only boundary holds", () => {
			const at = new Date(0).toISOString();
			expect(
				vets("#RolloutFinished", { status: "rolled-back", reasons: [], at }),
			).toBe(false);
			expect(
				vets("#RolloutFinished", { status: "promoted", reasons: [], at }),
			).toBe(true);
			const hold = (code: string) =>
				toJson(
					ReasonRecordSchema,
					create(ReasonRecordSchema, { code, remediation: "wait" }),
				);
			expect(vets("#RolloutHeld", { reason: hold(WINDOW_CLOSED), at })).toBe(
				true,
			);
			expect(
				vets("#RolloutHeld", {
					reason: hold("rollout-verification-failed"),
					at,
				}),
			).toBe(false);
		});
	},
);
