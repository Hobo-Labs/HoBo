// Vets real reconcile status-event bodies against data-models/reconcile.cue
// (the constraints src/reconcile mirrors). Skips with a visible reason when no
// `cue` binary exists.
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ReconcilerMode } from "../../src/_generated/cd_pb.js";
import {
	createCampReconciler,
	createDriftPolicy,
	createInProcessTransport,
} from "../../src/reconcile/index.js";
import {
	asCamp,
	asReconciler,
	createClock,
	createFakeDesired,
	createFakeRealizer,
	createFakeStore,
	createRecordingSink,
	ctxAt,
	resolvedFor,
	setFor,
	statusEvents,
	TENANT,
} from "./fakes.js";

const schema = fileURLToPath(
	new URL("../../data-models/reconcile.cue", import.meta.url),
);

function findCue(): string | undefined {
	if (process.env.HOBO_CUE_BIN && existsSync(process.env.HOBO_CUE_BIN))
		return process.env.HOBO_CUE_BIN;
	let dir = fileURLToPath(new URL(".", import.meta.url));
	for (let i = 0; i < 12; i++) {
		const tools = join(dir, ".tools", "cue");
		if (existsSync(tools))
			for (const version of readdirSync(tools).sort().reverse()) {
				const bin = join(tools, version, "cue");
				if (existsSync(bin)) return bin;
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

function vet(
	definition: string,
	value: unknown,
): { ok: boolean; output: string } {
	if (!cue) throw new Error("cue missing");
	const dir = mkdtempSync(join(tmpdir(), "hobo-cd-reconcile-cue-"));
	const file = join(dir, "data.json");
	writeFileSync(file, JSON.stringify(value));
	try {
		execFileSync(cue, ["vet", "-d", definition, schema, file], {
			encoding: "utf8",
			stdio: "pipe",
		});
		return { ok: true, output: "" };
	} catch (error) {
		const e = error as { stderr?: string; stdout?: string };
		return { ok: false, output: `${e.stderr ?? ""}${e.stdout ?? ""}` };
	}
}

describe.skipIf(!cue)("data-models/reconcile.cue", () => {
	it("accepts every status event body a real reconcile pass writes", async () => {
		const clock = createClock();
		const store = createFakeStore(clock);
		const desired = createFakeDesired(store, ["tls.minVersion"]);
		const camp = asCamp("camp-cue");
		const realizer = createFakeRealizer();
		const reconciler = createCampReconciler({
			store,
			tenant: TENANT,
			now: clock.now,
			reconcilerId: asReconciler("r1"),
			mode: ReconcilerMode.CONDUCTOR,
			campIds: [camp],
			holderId: "host",
			transport: createInProcessTransport({
				store,
				tenant: TENANT,
				now: clock.now,
				desired,
			}),
			realizer,
			drift: createDriftPolicy(),
			telemetry: createRecordingSink(),
		});
		const resolved = resolvedFor(camp, [
			{ name: "api" },
			{ name: "db", port: "database" },
		]);
		await desired.publish(setFor(camp, resolved, 1), resolved);
		await reconciler.reconcileOnce(camp, ctxAt(clock));
		clock.advance(61_000);
		const db = realizer.target.get("db");
		if (db) db.driftKind = "deleted";
		await reconciler.reconcileOnce(camp, ctxAt(clock));
		const bodies = statusEvents(store, camp).map((e) => e.data);
		expect(bodies.length).toBeGreaterThan(4);
		for (const body of bodies) {
			const result = vet("#ReconcileStatusEvent", body);
			expect(result.output).toBe("");
		}
	});

	it("rejects a BLOCKED observation without a reason and a malformed drift kind", () => {
		const base = {
			campId: "c",
			reconcilerId: "r",
			fenceToken: "1",
			observedAt: "2026-11-12T00:00:00.000Z",
		};
		expect(
			vet("#ReconcileObservationRecord", {
				...base,
				status: "RECONCILE_STATUS_BLOCKED",
			}).ok,
		).toBe(false);
		expect(
			vet("#ReconcileObservationRecord", {
				...base,
				status: "RECONCILE_STATUS_DRIFTED",
				resources: [{ resource: "a", driftKind: "Modified::" }],
			}).ok,
		).toBe(false);
		expect(
			vet("#ReconcileObservationRecord", {
				...base,
				fenceToken: "-1",
				status: "RECONCILE_STATUS_CONVERGED",
			}).ok,
		).toBe(false);
		expect(
			vet("#ReconcileObservationRecord", {
				...base,
				status: "RECONCILE_STATUS_CONVERGED",
			}).ok,
		).toBe(true);
	});
});
