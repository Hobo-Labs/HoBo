// HTTP probes (D9): one GET per due interval through the injected
// HttpTransport. A probe is healthy only when the status equals expect_status;
// a timeout, guard refusal or reset is an unhealthy attempt, never skipped.
import { create } from "@bufbuild/protobuf";
import type { HttpTransport } from "@hobo/core";
import { Cohort, type EvidenceObservationRecord, EvidenceObservationRecordSchema, type ProbeCheckRecord } from "../_generated/cd_pb.js";
import { CD_DEFAULTS } from "../events.js";
import type { CampId } from "../ports.js";
import { probeCheckId } from "./spec.js";

const PROBE_MAX_RESPONSE_BYTES = 65_536;

export async function runProbe(
	http: HttpTransport,
	input: Readonly<{ probe: ProbeCheckRecord; campId: CampId; atMs: number }>,
): Promise<EvidenceObservationRecord> {
	let status = 0;
	try {
		const response = await http({
			method: "GET",
			url: input.probe.urlRef,
			headers: { accept: "*/*", "user-agent": "hobo-cd-probe" },
			timeoutMs: CD_DEFAULTS.probeTimeoutMs,
			maxResponseBytes: PROBE_MAX_RESPONSE_BYTES,
		});
		status = response.status;
	} catch {
		status = 0;
	}
	return create(EvidenceObservationRecordSchema, {
		campId: input.campId,
		signal: probeCheckId(input.probe.name),
		healthy: status === input.probe.expectStatus,
		value: status,
		observedAt: new Date(input.atMs).toISOString(),
		source: "probe",
		cohort: Cohort.ALL,
	});
}

/** Whether a probe should fire now: on its interval, inside the window or until it has enough attempts. */
export function probeDue(
	input: Readonly<{ probe: ProbeCheckRecord; attempts: readonly EvidenceObservationRecord[]; atMs: number; windowEndMs: number; deadlineMs: number; required: number }>,
): boolean {
	if (input.atMs >= input.deadlineMs) return false;
	if (input.atMs >= input.windowEndMs && input.attempts.length >= input.required) return false;
	const last = input.attempts.reduce((latest, attempt) => Math.max(latest, Date.parse(attempt.observedAt)), Number.NEGATIVE_INFINITY);
	return input.atMs - last >= Number(input.probe.intervalMs);
}
