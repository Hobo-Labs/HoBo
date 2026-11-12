// data-models/promotion.cue agrees with the bodies the promotion saga writes.
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { JsonValue } from "@hobo/core";
import { describe, expect, it } from "vitest";
import { CD_EVENTS } from "../../src/events.js";
import { resolvedFor } from "./doubles.js";
import { harness } from "./harness.js";
import { camp, fid, HOUR } from "./store.js";

const here = dirname(fileURLToPath(import.meta.url));
const schema = join(here, "../../data-models/promotion.cue");

/** `cue` on PATH, else the repo-pinned binary under an ancestor's `.tools/cue/<version>/cue`. */
function findCue(): string | undefined {
	try {
		execFileSync("cue", ["version"], { stdio: "ignore" });
		return "cue";
	} catch {
		let directory = here;
		while (dirname(directory) !== directory) {
			const tools = join(directory, ".tools", "cue");
			if (existsSync(tools))
				for (const version of readdirSync(tools).sort().reverse()) {
					const binary = join(tools, version, "cue");
					if (existsSync(binary)) return binary;
				}
			directory = dirname(directory);
		}
		return undefined;
	}
}

const cue = findCue();
const scratch = mkdtempSync(join(tmpdir(), "hobo-cd-wp6-cue-"));
let written = 0;

function vets(definition: string, value: JsonValue): boolean {
	if (!cue) throw new Error("cue binary not found");
	written += 1;
	const file = join(scratch, `value-${written}.json`);
	writeFileSync(file, JSON.stringify(value));
	try {
		execFileSync(cue, ["vet", "-c", "-d", definition, schema, file], {
			stdio: "pipe",
		});
		return true;
	} catch {
		return false;
	}
}

async function journal() {
	const h = harness();
	h.freight.add("f1");
	h.desired.seed("dev-1", "f1", resolvedFor("dev-1", "alpha", "f1"));
	await h.service.promote(
		{
			freightId: fid("f1"),
			targets: [camp("dev-1"), camp("dev-2")],
			idempotencyKey: "cue",
		},
		h.ctx(),
	);
	await h.service.createPreview(
		{
			freightId: fid("f1"),
			sourceCampId: camp("dev-1"),
			ttlMs: HOUR,
			idempotencyKey: "pr",
		},
		h.ctx(),
	);
	await h.service.rollback(
		{ campId: camp("dev-1"), reason: "cue", idempotencyKey: "rb" },
		h.ctx(),
	);
	return h.store;
}

describe.skipIf(!cue)("promotion.cue", () => {
	it("every promotion record the saga writes vets as #PromotionRecord", async () => {
		const store = await journal();
		const bodies = [
			CD_EVENTS.EnvPromoteRequested,
			CD_EVENTS.EnvPromoted,
			CD_EVENTS.EnvPromoteRolledBack,
		].flatMap((type) => store.events(type).map((e) => e.data as JsonValue));
		expect(bodies.length).toBeGreaterThan(3);
		for (const body of bodies)
			expect(vets("#PromotionRecord", body), JSON.stringify(body)).toBe(true);
	}, 30_000);

	it("preview records and saga facts vet", async () => {
		const store = await journal();
		for (const e of store.events(CD_EVENTS.EnvCloned))
			expect(vets("#PreviewEnvironmentRecord", e.data as JsonValue)).toBe(true);
		for (const e of store.events("saga.Started"))
			expect(vets("#PromotionSagaStarted", e.data as JsonValue)).toBe(true);
		const steps = store.events("saga.StepEmitted");
		expect(steps.length).toBeGreaterThan(5);
		for (const e of steps)
			expect(
				vets("#PromotionSagaStep", e.data as JsonValue),
				JSON.stringify(e.data),
			).toBe(true);
	}, 30_000);

	it("rejects malformed records", () => {
		const good = {
			schemaVersion: "hobo.cd.promotion/v1",
			promotionId: "promo_0123456789abcdef01234567",
			freightId: "f1",
			targetCampIds: ["dev-1"],
			state: "PROMOTION_STATE_QUEUED",
			requestedBy: "user:ops@acme",
			requestedAt: "2026-11-12T12:00:00.000Z",
			idempotencyKey: "k",
			subject: "FREIGHT_SUBJECT_BINDLE",
		};
		expect(vets("#PromotionRecord", good)).toBe(true);
		expect(vets("#PromotionRecord", { ...good, targetCampIds: [] })).toBe(
			false,
		);
		expect(vets("#PromotionRecord", { ...good, promotionId: "p1" })).toBe(
			false,
		);
		expect(
			vets("#PromotionRecord", { ...good, state: "PROMOTION_STATE_DONE" }),
		).toBe(false);
		expect(
			vets("#PromotionRecord", {
				...good,
				reasons: [{ code: "x", message: "m" }],
			}),
		).toBe(false);
		expect(
			vets("#PromotionSagaStep", {
				sagaId: "cd.promotion:promo_0123456789abcdef01234567",
				step: "dev-1|teleported",
				emittedType: "",
			}),
		).toBe(false);
		expect(
			vets("#PreviewEnvironmentRecord", {
				campId: "dev-1",
				sourceCampId: "dev-1",
				freightId: "f1",
				ttlMs: "0",
				expiresAt: "2026-11-12T12:00:00Z",
				createdBy: "user:x",
			}),
		).toBe(false);
	}, 30_000);
});
