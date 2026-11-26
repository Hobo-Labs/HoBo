/* oxlint-disable anti-slop/no-known-value-widening, anti-slop/no-unknown-parameters, anti-slop/require-safety-comment-for-type-assertion -- SAFETY: test fixtures brand ids minted by the fake journal, build partial generated records, and read controlled JSON fixtures at the test boundary. */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { toJson } from "@bufbuild/protobuf";
import { describe, expect, it } from "vitest";
import {
	ReasonStructuredDetailSchema,
	ReconcilerMode,
} from "../../src/_generated/cd_pb.js";
import {
	createCampReconciler,
	createDriftPolicy,
	createInProcessTransport,
} from "../../src/reconcile/index.js";
import { validateReasonStructuredDetail } from "../../src/reconcile/release-freight-detail.js";
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

function cueBinaryOnPath(
	command: string,
	args: readonly string[],
): string | undefined {
	try {
		return (
			execFileSync(command, args, { encoding: "utf8" }).trim() || undefined
		);
	} catch {
		return undefined;
	}
}

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
	return (
		cueBinaryOnPath("which", ["cue"]) ??
		cueBinaryOnPath("mise", ["which", "cue"])
	);
}

const cue = findCue();
if (
	!cue &&
	(process.env.CI === "true" || process.env.GITHUB_ACTIONS === "true")
) {
	throw new Error(
		"cue binary is required in CI; run `mise install` before agent:check",
	);
}

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

	it("accepts structured release Freight detail emitted by validateReasonStructuredDetail", () => {
		const structured = validateReasonStructuredDetail({
			credentialRef: "github-app://Hobo-Labs/HoBo",
			requestedScope: "cd-realize:hobo-release/pages-candidate",
			detailKind: "scope-not-allowed",
		});
		if (!structured) throw new Error("expected structured fixture");
		const json = toJson(ReasonStructuredDetailSchema, structured);
		const result = vet("ReasonStructuredDetail", json);
		expect(result.ok, result.output).toBe(true);
		const mismatch = validateReasonStructuredDetail({
			credentialRef: "github-app://Hobo-Labs/HoBo",
			requestedScope: "github-app://Other/Repo",
			detailKind: "repository-mismatch",
		});
		if (!mismatch) throw new Error("expected repository-mismatch fixture");
		expect(
			vet(
				"ReasonStructuredDetail",
				toJson(ReasonStructuredDetailSchema, mismatch),
			).ok,
		).toBe(true);
		expect(
			vet("ReasonStructuredDetail", {
				credentialRef: "github-app://Hobo-Labs/HoBo",
				requestedScope: "cd-realize:evil",
				detailKind: "repository-mismatch",
			}).ok,
		).toBe(false);
		const pagesReject = validateReasonStructuredDetail({
			credentialRef: "github-app://Hobo-Labs/HoBo",
			requestedScope: "cd-realize:hobo-release/pages-candidate",
			detailKind: "github-permission-missing",
		});
		if (!pagesReject)
			throw new Error("expected github pages structured fixture");
		expect(
			vet(
				"ReasonStructuredDetail",
				toJson(ReasonStructuredDetailSchema, pagesReject),
			).ok,
		).toBe(true);
		const ociReject = validateReasonStructuredDetail({
			credentialRef: "owner://GHCR_PUBLISH",
			requestedScope: "POST:403",
			detailKind: "oci-http-status",
		});
		if (!ociReject) throw new Error("expected oci structured fixture");
		expect(
			vet(
				"ReasonStructuredDetail",
				toJson(ReasonStructuredDetailSchema, ociReject),
			).ok,
		).toBe(true);
	});

	it("accepts each oci structured shape and rejects secret-bearing scopes", () => {
		const labels = (length: number) => {
			const parts: string[] = [];
			let left = length;
			while (left > 0) {
				if (left <= 63) {
					parts.push("a".repeat(left));
					break;
				}
				parts.push("a".repeat(63));
				left -= 64;
			}
			return parts.join(".");
		};
		const accepted: readonly (readonly [string, string])[] = [
			["oci-upload-foreign-host", "upload.foreign.test"],
			["oci-upload-foreign-host", labels(253)],
			["oci-upload-path", "blob-upload-path"],
			["oci-http-status", "POST:403"],
			["oci-http-status", "DELETE:500"],
			["oci-blob-size", "over-transport-bound"],
			["oci-blob-not-observed", "post-upload"],
			["oci-credential-refused", "cd-realize:hobo-release/oci-candidate"],
		];
		for (const [detailKind, requestedScope] of accepted) {
			const structured = validateReasonStructuredDetail({
				credentialRef: "owner://GHCR_PUBLISH",
				requestedScope,
				detailKind,
			});
			expect(structured, detailKind).toBeDefined();
			if (!structured) continue;
			const result = vet(
				"ReasonStructuredDetail",
				toJson(ReasonStructuredDetailSchema, structured),
			);
			expect(result.ok, `${detailKind} ${result.output}`).toBe(true);
		}
		const rejected: readonly (readonly [string, string])[] = [
			[
				"oci-upload-foreign-host",
				"https://evil.example/v2/blobs/uploads/abc?_state=sekret",
			],
			["oci-upload-foreign-host", labels(254)],
			["oci-upload-path", "POST:403"],
			["oci-http-status", "upload.foreign.test"],
			["oci-credential-refused", "registry-basic"],
			["oci-blob-size", "post-upload"],
		];
		for (const [detailKind, requestedScope] of rejected) {
			expect(
				vet("ReasonStructuredDetail", {
					credentialRef: "owner://GHCR_PUBLISH",
					requestedScope,
					detailKind,
				}).ok,
				detailKind,
			).toBe(false);
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
