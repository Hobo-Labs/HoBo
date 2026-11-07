/**
 * A PAM session's end is recorded before the session is dropped.
 *
 * `endSession` deleted the session and then appended its pam.SessionEnded.
 * When the audit could not be written, the close failed with the session
 * already gone: a retried close found nothing to end, and the audit went from
 * pam.SessionStarted straight to pam.GatewayStopped. `stop` cleared every
 * session after its loop, so a stop that failed part way recorded, retried,
 * the endings it had already recorded a second time.
 */
import { describe, expect, test } from "vitest";

import { createPrivilegedAccessGateway } from "../src/pam/gateway.js";
import type { AuditSink, PamAuditEvent } from "../src/pam/types.js";

const T0 = new Date().toISOString();

/** A started development gateway writing to `auditSink`. */
async function started(auditSink: AuditSink) {
	const gw = createPrivilegedAccessGateway({
		kind: "native",
		isolationClass: "development",
		now: () => T0,
		elevatedHmacSecret: "test-elevated-secret-not-for-production",
		auditSink,
	});
	await gw.start({
		stationId: "station-1",
		tenant: "tenant-a",
		isolationClass: "development",
		trustDomain: "yard",
	});
	return gw;
}

const SESSION = {
	subject: "user:alice",
	target: "ssh:web-1",
	preferSecretless: true,
} as const;

/** The audit as `type`, or `type(reason)` for a session's end. */
function brief(events: readonly PamAuditEvent[]): readonly string[] {
	return events.map((e) =>
		e.type === "pam.SessionEnded" ? `${e.type}(${e.reason})` : e.type,
	);
}

describe("a PAM session's end, when the audit cannot be written", () => {
	test("the session stays live, and its end is recorded when retried", async () => {
		const written: PamAuditEvent[] = [];
		let writable = true;
		const gw = await started({
			append(event) {
				if (!writable) throw new Error("the audit is not writable");
				written.push(event);
			},
		});
		const handle = await gw.brokerSession(SESSION);
		writable = false;
		await expect(gw.endSession(handle.sessionId, "first-try")).rejects.toThrow(
			/not writable/u,
		);
		await expect(gw.stop()).rejects.toThrow(/not writable/u);
		expect(gw.listSessions().map((s) => s.sessionId)).toEqual([
			handle.sessionId,
		]);
		writable = true;
		await gw.endSession(handle.sessionId, "retried");
		await gw.stop();
		expect(brief(written)).toEqual([
			"pam.GatewayStarted",
			"pam.SessionStarted",
			"pam.SessionEnded(retried)",
			"pam.GatewayStopped",
		]);
	});

	test("a stop retried records only the endings not yet recorded", async () => {
		const written: PamAuditEvent[] = [];
		let refuseOnce = false;
		const gw = await started({
			append(event) {
				const anotherEnded = written.some((e) => e.type === "pam.SessionEnded");
				if (refuseOnce && event.type === "pam.SessionEnded" && anotherEnded) {
					refuseOnce = false;
					throw new Error("the audit is not writable");
				}
				written.push(event);
			},
		});
		const first = await gw.brokerSession(SESSION);
		const second = await gw.brokerSession(SESSION);
		refuseOnce = true;
		await expect(gw.stop()).rejects.toThrow(/not writable/u);
		await gw.stop();
		const ended = written
			.filter((e) => e.type === "pam.SessionEnded")
			.map((e) => e.sessionId);
		expect(ended).toHaveLength(2);
		expect(new Set(ended)).toEqual(
			new Set([first.sessionId, second.sessionId]),
		);
		expect(written.at(-1)?.type).toBe("pam.GatewayStopped");
	});

	test("two ends of one session at once record one ending", async () => {
		// The session stays live until its ending is written, so a second end
		// that comes meanwhile waits for the first rather than record its own.
		const written: PamAuditEvent[] = [];
		const gw = await started({
			async append(event) {
				await Promise.resolve();
				written.push(event);
			},
		});
		const handle = await gw.brokerSession(SESSION);
		await Promise.all([
			gw.endSession(handle.sessionId, "one"),
			gw.endSession(handle.sessionId, "two"),
		]);
		expect(
			written.filter((e) => e.type === "pam.SessionEnded").map((e) => e.reason),
		).toEqual(["one"]);
	});
});
