/**
 * The CredentialAudit projection answers one question: which agent reached which
 * resource, as which user, when. It answers it by folding six event families
 * into a per-correlation row, and the fold is the only thing standing between a
 * complete audit trail and a plausible-looking but wrong one.
 *
 * `credential-audit.test.ts` walks a full brokered-deploy trail through a real
 * store. That covers the happy path and the store integration; it does not cover
 * the fold's edges, which are where an audit quietly loses fidelity:
 *
 *   - the correlation key's fallback chain, which decides whether two events
 *     land in the same row at all;
 *   - out-of-order and duplicate events, since the log is authoritative and a
 *     replay makes no ordering promises the fold can lean on;
 *   - the revoked-status precedence, because a token used after revocation must
 *     not read as merely "used";
 *   - the fail-closed refusal when an event claims to carry plaintext.
 *
 * These tests drive the fold directly over hand-built envelopes, which is the
 * only way to produce those shapes deliberately.
 */
import type { EventEnvelope, PrincipalRef } from "@hobo/core";
import { describe, expect, test } from "vitest";

import {
	CREDENTIAL_AUDIT_EVENT_PREFIXES,
	CREDENTIAL_AUDIT_EVENTS,
	CREDENTIAL_AUDIT_RETENTION,
	CREDENTIAL_AUDIT_RETENTION_FLOOR_DAYS,
	CREDENTIAL_AUDIT_RETENTION_FLOOR_MS,
	compactCredentialAuditStream,
	credentialAuditProjection,
	isCredentialAuditEvent,
} from "../src/index.js";

const ACTOR: PrincipalRef = { kind: "service", id: "yard/token-broker" };
const CORRELATION = "run:deploy-1";

let nextSeq = 0;

/** Build one envelope. `seq` auto-increments unless pinned. */
function envelope(
	type: string,
	data: Record<string, JsonValue>,
	overrides: Partial<EventEnvelope> = {},
): EventEnvelope {
	nextSeq += 1;
	// SAFETY: The surrounding parser, protocol branch, or fixture establishes this asserted shape.
	return {
		id: `evt-${nextSeq}`,
		type,
		v: 1,
		streamId: "credential-audit/run-1",
		seq: nextSeq,
		ts: "2026-01-01T00:00:00.000Z",
		actor: ACTOR,
		tenant: "tenant-a",
		correlationId: CORRELATION,
		data,
		...overrides,
	} as EventEnvelope;
}

/** Fold a list of envelopes and return the row for the default correlation. */
function rowOf(events: readonly EventEnvelope[], key = CORRELATION) {
	const snapshot = credentialAuditProjection.fold(events);
	return credentialAuditProjection.get(snapshot, key);
}

describe("the audit event classifier", () => {
	test("it accepts every family the projection folds", () => {
		// The classifier drives compaction. A family it failed to recognise would
		// have its events silently compacted away despite the never-compact rule.
		for (const type of Object.values(CREDENTIAL_AUDIT_EVENTS)) {
			expect(isCredentialAuditEvent(envelope(type, {}))).toBe(true);
		}
	});

	test("every declared prefix is one the classifier honours", () => {
		for (const prefix of CREDENTIAL_AUDIT_EVENT_PREFIXES) {
			expect(isCredentialAuditEvent(envelope(`${prefix}Something`, {}))).toBe(
				true,
			);
		}
	});

	test("it rejects unrelated event types", () => {
		for (const type of ["deploy.Started", "resource.Created", "run.Finished"]) {
			expect(isCredentialAuditEvent(envelope(type, {}))).toBe(false);
		}
	});

	test("the match is on a prefix, not a substring", () => {
		// `my.identity.Issued` is somebody else's event. Treating it as an audit
		// event would exempt an unrelated stream from compaction forever.
		expect(isCredentialAuditEvent(envelope("my.identity.Issued", {}))).toBe(
			false,
		);
	});

	test("the retention descriptor is never-compact", () => {
		// This constant is duplicated from @hobo/identity to avoid an inward
		// dependency edge; if the two drift, one side stops protecting the audit.
		expect(CREDENTIAL_AUDIT_RETENTION.neverCompact).toBe(true);
		expect(CREDENTIAL_AUDIT_RETENTION.class).toBe("security-audit");
	});

	test("the retention floor is seven years in both units", () => {
		expect(CREDENTIAL_AUDIT_RETENTION_FLOOR_DAYS).toBe(2555);
		expect(CREDENTIAL_AUDIT_RETENTION_FLOOR_MS).toBe(
			2555 * 24 * 60 * 60 * 1000,
		);
	});
});

describe("the correlation key", () => {
	test("an explicit correlationId on the envelope wins", () => {
		const row = rowOf(
			[
				envelope(
					CREDENTIAL_AUDIT_EVENTS.IdentityIssued,
					{ identityId: "svid-1", correlationId: "from-data" },
					{ correlationId: "from-envelope" },
				),
			],
			"from-envelope",
		);
		expect(row?.correlationId).toBe("from-envelope");
	});

	test("a correlationId in the data is used when the envelope has none", () => {
		// Events minted by an adapter that does not set the envelope field still
		// have to join the right row, or one logical run splits into several.
		const row = rowOf(
			[
				envelope(
					CREDENTIAL_AUDIT_EVENTS.IdentityIssued,
					{ identityId: "svid-1", correlationId: "from-data" },
					{ correlationId: undefined },
				),
			],
			"from-data",
		);
		expect(row?.identityIds).toEqual(["svid-1"]);
	});

	test("the grantId is the next fallback", () => {
		// A token event with neither correlation still belongs with its grant —
		// this is what keeps grant → use → revoke together.
		const row = rowOf(
			[
				envelope(
					CREDENTIAL_AUDIT_EVENTS.TokenGranted,
					{ grantId: "grant-1" },
					{ correlationId: undefined },
				),
				envelope(
					CREDENTIAL_AUDIT_EVENTS.TokenUsed,
					{ grantId: "grant-1" },
					{ correlationId: undefined },
				),
			],
			"grant-1",
		);
		expect(row?.grantCount).toBe(1);
		expect(row?.useCount).toBe(1);
	});

	test("the streamId is the last resort", () => {
		// Better a row keyed by stream than an event dropped on the floor: an
		// audit that loses events is worse than one that groups them coarsely.
		const row = rowOf(
			[
				envelope(
					CREDENTIAL_AUDIT_EVENTS.SessionStarted,
					{ sessionId: "sess-1" },
					{ correlationId: undefined, streamId: "stream-fallback" },
				),
			],
			"stream-fallback",
		);
		expect(row?.sessionIds).toEqual(["sess-1"]);
	});

	test("events with different correlations land in different rows", () => {
		const snapshot = credentialAuditProjection.fold([
			envelope(
				CREDENTIAL_AUDIT_EVENTS.IdentityIssued,
				{ identityId: "a" },
				{ correlationId: "run-a" },
			),
			envelope(
				CREDENTIAL_AUDIT_EVENTS.IdentityIssued,
				{ identityId: "b" },
				{ correlationId: "run-b" },
			),
		]);
		expect(credentialAuditProjection.query(snapshot)).toHaveLength(2);
		expect(
			credentialAuditProjection.get(snapshot, "run-a")?.identityIds,
		).toEqual(["a"]);
	});
});

describe("the grant lifecycle", () => {
	test("grant then use then revoke ends revoked with the reason recorded", () => {
		const row = rowOf([
			envelope(CREDENTIAL_AUDIT_EVENTS.TokenGranted, {
				grantId: "g1",
				svidSubject: "spiffe://agent",
				tokenRef: "tokenref://g1",
				scope: { port: "db", resource: "shop", action: "write" },
			}),
			envelope(CREDENTIAL_AUDIT_EVENTS.TokenUsed, { grantId: "g1" }),
			envelope(CREDENTIAL_AUDIT_EVENTS.TokenRevoked, {
				grantId: "g1",
				reason: "run finished",
			}),
		]);
		const grant = row?.grants.g1;
		expect(grant?.status).toBe("revoked");
		expect(grant?.revokedReason).toBe("run finished");
		expect(grant?.svidSubject).toBe("spiffe://agent");
		expect(grant?.scope).toEqual({
			port: "db",
			resource: "shop",
			action: "write",
		});
		expect(grant?.useCount).toBe(1);
	});

	test("a use after a revoke does not downgrade the status", () => {
		// The guard is `if (g.status !== "revoked")`. Without it, a token used
		// after revocation would read as an ordinary "used" grant — which is the
		// single most interesting thing a security reviewer could be looking for.
		const row = rowOf([
			envelope(CREDENTIAL_AUDIT_EVENTS.TokenGranted, { grantId: "g1" }),
			envelope(CREDENTIAL_AUDIT_EVENTS.TokenRevoked, { grantId: "g1" }),
			envelope(CREDENTIAL_AUDIT_EVENTS.TokenUsed, { grantId: "g1" }),
		]);
		expect(row?.grants.g1?.status).toBe("revoked");
		// The use is still counted and timestamped — suppressed status must not
		// mean a suppressed record.
		expect(row?.grants.g1?.useCount).toBe(1);
		expect(row?.grants.g1?.usedAt).toBeDefined();
		expect(row?.useCount).toBe(1);
	});

	test("a use with no preceding grant is folded anomaly-tolerantly", () => {
		// A truncated or out-of-order log must not lose the use. Synthesising the
		// grant row is what keeps the event visible for review.
		const row = rowOf([
			envelope(CREDENTIAL_AUDIT_EVENTS.TokenUsed, { grantId: "orphan" }),
		]);
		expect(row?.grants.orphan?.status).toBe("used");
		expect(row?.grants.orphan?.useCount).toBe(1);
		expect(row?.grantCount).toBe(0);
	});

	test("a revoke with no preceding grant still records the revocation", () => {
		const row = rowOf([
			envelope(CREDENTIAL_AUDIT_EVENTS.TokenRevoked, {
				grantId: "orphan",
				reason: "emergency",
			}),
		]);
		expect(row?.grants.orphan?.status).toBe("revoked");
		expect(row?.revokeCount).toBe(1);
	});

	test("repeated uses accumulate on the grant and the row", () => {
		const row = rowOf([
			envelope(CREDENTIAL_AUDIT_EVENTS.TokenGranted, { grantId: "g1" }),
			envelope(CREDENTIAL_AUDIT_EVENTS.TokenUsed, { grantId: "g1" }),
			envelope(CREDENTIAL_AUDIT_EVENTS.TokenUsed, { grantId: "g1" }),
			envelope(CREDENTIAL_AUDIT_EVENTS.TokenUsed, { grantId: "g1" }),
		]);
		expect(row?.grants.g1?.useCount).toBe(3);
		expect(row?.useCount).toBe(3);
	});

	test("several grants on one correlation are tracked independently", () => {
		// A deploy takes more than one credential; collapsing them would make it
		// impossible to say which scope was actually exercised.
		const row = rowOf([
			envelope(CREDENTIAL_AUDIT_EVENTS.TokenGranted, { grantId: "g1" }),
			envelope(CREDENTIAL_AUDIT_EVENTS.TokenGranted, { grantId: "g2" }),
			envelope(CREDENTIAL_AUDIT_EVENTS.TokenUsed, { grantId: "g2" }),
			envelope(CREDENTIAL_AUDIT_EVENTS.TokenRevoked, { grantId: "g1" }),
		]);
		expect(row?.grants.g1?.status).toBe("revoked");
		expect(row?.grants.g2?.status).toBe("used");
		expect(row?.grantCount).toBe(2);
	});

	test("optional grant fields are omitted rather than set undefined", () => {
		// The row is serialised to a proto wire form; an explicit undefined is a
		// different thing from an absent field there.
		const row = rowOf([
			envelope(CREDENTIAL_AUDIT_EVENTS.TokenGranted, { grantId: "g1" }),
		]);
		const grant = row?.grants.g1;
		expect(grant && "svidSubject" in grant).toBe(false);
		expect(grant && "tokenRef" in grant).toBe(false);
		expect(grant && "scope" in grant).toBe(false);
	});

	test("a revoke with no reason omits the field", () => {
		const row = rowOf([
			envelope(CREDENTIAL_AUDIT_EVENTS.TokenRevoked, { grantId: "g1" }),
		]);
		const grant = row?.grants.g1;
		expect(grant?.status).toBe("revoked");
		expect(grant && "revokedReason" in grant).toBe(false);
	});

	test("a re-grant of the same id updates rather than duplicating", () => {
		const row = rowOf([
			envelope(CREDENTIAL_AUDIT_EVENTS.TokenGranted, {
				grantId: "g1",
				tokenRef: "first",
			}),
			envelope(CREDENTIAL_AUDIT_EVENTS.TokenGranted, {
				grantId: "g1",
				tokenRef: "second",
			}),
		]);
		expect(Object.keys(row?.grants ?? {})).toEqual(["g1"]);
		expect(row?.grants.g1?.tokenRef).toBe("second");
		// The count is of grant *events*, not distinct grants — pinning that so a
		// reader does not mistake it for a cardinality.
		expect(row?.grantCount).toBe(2);
	});
});

describe("identity and session tracking", () => {
	test("identity ids are deduplicated across issue and rotate", () => {
		// A rotation names the same identity; counting it twice would suggest two
		// principals were involved where there was one.
		const row = rowOf([
			envelope(CREDENTIAL_AUDIT_EVENTS.IdentityIssued, { identityId: "i1" }),
			envelope(CREDENTIAL_AUDIT_EVENTS.IdentityRotated, { identityId: "i1" }),
			envelope(CREDENTIAL_AUDIT_EVENTS.IdentityRotated, { identityId: "i2" }),
		]);
		expect(row?.identityIds).toEqual(["i1", "i2"]);
		expect(row?.timeline).toHaveLength(3);
	});

	test("session ids are deduplicated across start and revoke", () => {
		const row = rowOf([
			envelope(CREDENTIAL_AUDIT_EVENTS.SessionStarted, { sessionId: "s1" }),
			envelope(CREDENTIAL_AUDIT_EVENTS.SessionRevoked, { sessionId: "s1" }),
		]);
		expect(row?.sessionIds).toEqual(["s1"]);
		expect(row?.timeline).toHaveLength(2);
	});

	test("connection ids are gathered from every connection event", () => {
		const row = rowOf([
			envelope(CREDENTIAL_AUDIT_EVENTS.ConnectionCreated, {
				connectionId: "c1",
			}),
			envelope(CREDENTIAL_AUDIT_EVENTS.ConnectionAuthorized, {
				connectionId: "c1",
			}),
			envelope(CREDENTIAL_AUDIT_EVENTS.ConnectionTokenIssued, {
				connectionId: "c1",
				grantId: "g1",
			}),
			envelope(CREDENTIAL_AUDIT_EVENTS.ConnectionNeedsReauth, {
				connectionId: "c2",
			}),
			envelope(CREDENTIAL_AUDIT_EVENTS.ConnectionRevoked, {
				connectionId: "c1",
			}),
		]);
		expect(row?.connectionIds).toEqual(["c1", "c2"]);
		expect(row?.timeline).toHaveLength(5);
	});

	test("a token grant carrying a connection id records the connection too", () => {
		// This is the join between the Connection aggregate and the token trail;
		// without it a connection-backed token has no visible provenance.
		const row = rowOf([
			envelope(CREDENTIAL_AUDIT_EVENTS.TokenGranted, {
				grantId: "g1",
				connectionId: "c1",
			}),
		]);
		expect(row?.connectionIds).toEqual(["c1"]);
	});

	test("a connection-issued token event carries its grant onto the timeline", () => {
		const row = rowOf([
			envelope(CREDENTIAL_AUDIT_EVENTS.ConnectionTokenIssued, {
				connectionId: "c1",
				grantId: "g1",
			}),
		]);
		expect(row?.timeline[0]?.grantId).toBe("g1");
	});

	test("a connection-issued token event without a grant omits the field", () => {
		const row = rowOf([
			envelope(CREDENTIAL_AUDIT_EVENTS.ConnectionTokenIssued, {
				connectionId: "c1",
			}),
		]);
		const entry = row?.timeline[0];
		expect(entry && "grantId" in entry).toBe(false);
	});

	test("a missing connection id is ignored rather than recorded as undefined", () => {
		const row = rowOf([
			envelope(CREDENTIAL_AUDIT_EVENTS.ConnectionCreated, {}),
		]);
		expect(row?.connectionIds).toEqual([]);
		expect(row?.timeline).toHaveLength(1);
	});
});

describe("the migration event family", () => {
	const MIGRATION_TYPES = [
		CREDENTIAL_AUDIT_EVENTS.MigrationStarted,
		CREDENTIAL_AUDIT_EVENTS.DualLinked,
		CREDENTIAL_AUDIT_EVENTS.ShadowVerified,
		CREDENTIAL_AUDIT_EVENTS.DualConsistencyChecked,
		CREDENTIAL_AUDIT_EVENTS.MigrationProgressed,
		CREDENTIAL_AUDIT_EVENTS.Migrated,
		CREDENTIAL_AUDIT_EVENTS.MigrationCutover,
		CREDENTIAL_AUDIT_EVENTS.MigrationAborted,
		CREDENTIAL_AUDIT_EVENTS.MigrationCompensated,
	];

	test("every migration event type is folded", () => {
		// A migration moves principals between identity adapters. A type the fold
		// silently ignored would leave a gap in exactly the record that proves
		// the move was authorised.
		const row = rowOf(
			MIGRATION_TYPES.map((type) => envelope(type, { migrationId: "m1" })),
		);
		expect(row?.migrationEventCount).toBe(MIGRATION_TYPES.length);
		expect(row?.timeline).toHaveLength(MIGRATION_TYPES.length);
	});

	test("migration ids are deduplicated but the event count is not", () => {
		// The id set answers "which migrations touched this run"; the count
		// answers "how much migration activity happened". Both are needed.
		const row = rowOf([
			envelope(CREDENTIAL_AUDIT_EVENTS.MigrationStarted, { migrationId: "m1" }),
			envelope(CREDENTIAL_AUDIT_EVENTS.DualLinked, { migrationId: "m1" }),
			envelope(CREDENTIAL_AUDIT_EVENTS.DualLinked, { migrationId: "m2" }),
		]);
		expect(row?.migrationIds).toEqual(["m1", "m2"]);
		expect(row?.migrationEventCount).toBe(3);
	});

	test("a migration event with no id still lands on the timeline", () => {
		// The event happened; losing it because a field was missing would be the
		// wrong trade for an audit.
		const row = rowOf([envelope(CREDENTIAL_AUDIT_EVENTS.MigrationStarted, {})]);
		expect(row?.migrationIds).toEqual([]);
		expect(row?.timeline).toHaveLength(1);
		// The counter is bumped inside the id guard, so an id-less event does not
		// increment it. Pinned deliberately: migrationEventCount counts *events
		// carrying an id*, not migration events.
		expect(row?.migrationEventCount).toBe(0);
	});
});

describe("config resolution and secret access", () => {
	test("config names are deduplicated and counted", () => {
		const row = rowOf([
			envelope(CREDENTIAL_AUDIT_EVENTS.ConfigResolved, {
				name: "DATABASE_URL",
				source: "provider-federation",
			}),
			envelope(CREDENTIAL_AUDIT_EVENTS.ConfigResolved, {
				name: "DATABASE_URL",
				source: "provider-federation",
			}),
			envelope(CREDENTIAL_AUDIT_EVENTS.ConfigResolved, { name: "REGION" }),
		]);
		expect(row?.configNames).toEqual(["DATABASE_URL", "REGION"]);
		expect(row?.configResolveCount).toBe(3);
	});

	test("a config event with no name is still counted", () => {
		const row = rowOf([envelope(CREDENTIAL_AUDIT_EVENTS.ConfigResolved, {})]);
		expect(row?.configNames).toEqual([]);
		expect(row?.configResolveCount).toBe(1);
	});

	test("secret value refs are recorded, deduplicated and counted", () => {
		const row = rowOf([
			envelope(CREDENTIAL_AUDIT_EVENTS.SecretAccessed, {
				name: "DB",
				valueRef: "secref://DB/v1",
				versionId: "v1",
			}),
			envelope(CREDENTIAL_AUDIT_EVENTS.SecretAccessed, {
				valueRef: "secref://DB/v1",
			}),
			envelope(CREDENTIAL_AUDIT_EVENTS.SecretAccessed, {
				valueRef: "secref://DB/v2",
			}),
		]);
		expect(row?.secretValueRefs).toEqual(["secref://DB/v1", "secref://DB/v2"]);
		expect(row?.secretAccessCount).toBe(3);
	});

	test("a secret access claiming plaintext is refused by the fold", () => {
		// The conformance rule: a secret event may carry a reference and a version
		// id, never a value. Folding one that admits to plaintext would write the
		// claim into a never-compacted stream, so the fold refuses instead.
		expect(() =>
			credentialAuditProjection.fold([
				envelope(CREDENTIAL_AUDIT_EVENTS.SecretAccessed, {
					valueRef: "secref://DB/v1",
					plaintextPresent: true,
				}),
			]),
		).toThrow(/plaintextPresent/);
	});

	test("plaintextPresent false or absent folds normally", () => {
		// The check is `=== true`, so a merely falsy field must not be read as a
		// violation — that would make the fold refuse ordinary events.
		expect(() =>
			credentialAuditProjection.fold([
				envelope(CREDENTIAL_AUDIT_EVENTS.SecretAccessed, {
					valueRef: "a",
					plaintextPresent: false,
				}),
				envelope(CREDENTIAL_AUDIT_EVENTS.SecretAccessed, { valueRef: "b" }),
			]),
		).not.toThrow();
	});

	test("a secret access carrying a grant id joins it on the timeline", () => {
		const row = rowOf([
			envelope(CREDENTIAL_AUDIT_EVENTS.SecretAccessed, {
				valueRef: "secref://DB/v1",
				grantId: "g1",
			}),
		]);
		expect(row?.timeline[0]?.grantId).toBe("g1");
	});
});

describe("the timeline", () => {
	test("it preserves the sequence of every folded event", () => {
		const events = [
			envelope(CREDENTIAL_AUDIT_EVENTS.IdentityIssued, { identityId: "i1" }),
			envelope(CREDENTIAL_AUDIT_EVENTS.TokenGranted, { grantId: "g1" }),
			envelope(CREDENTIAL_AUDIT_EVENTS.TokenUsed, { grantId: "g1" }),
			envelope(CREDENTIAL_AUDIT_EVENTS.TokenRevoked, { grantId: "g1" }),
		];
		const row = rowOf(events);
		expect(row?.timeline.map((t) => t.type)).toEqual(events.map((e) => e.type));
		expect(row?.timeline.map((t) => t.seq)).toEqual(events.map((e) => e.seq));
	});

	test("it records the events in fold order even when sequences are out of order", () => {
		// The timeline is append-order, not sorted by seq. Worth pinning: a
		// reviewer reading it must know it reflects the order the fold saw, and
		// the `seq` field is what they sort by if they need log order.
		const row = rowOf([
			envelope(
				CREDENTIAL_AUDIT_EVENTS.TokenUsed,
				{ grantId: "g1" },
				{ seq: 9 },
			),
			envelope(
				CREDENTIAL_AUDIT_EVENTS.TokenGranted,
				{ grantId: "g1" },
				{ seq: 2 },
			),
		]);
		expect(row?.timeline.map((t) => t.seq)).toEqual([9, 2]);
	});

	test("token events carry their grant id, identity events do not", () => {
		// The grant id is what links a timeline entry back to a row in `grants`.
		const row = rowOf([
			envelope(CREDENTIAL_AUDIT_EVENTS.IdentityIssued, { identityId: "i1" }),
			envelope(CREDENTIAL_AUDIT_EVENTS.TokenGranted, { grantId: "g1" }),
		]);
		expect(row?.timeline[0] && "grantId" in row.timeline[0]).toBe(false);
		expect(row?.timeline[1]?.grantId).toBe("g1");
	});

	test("unrelated event types are not folded at all", () => {
		// The projection's read-set is `Object.keys(on)`. An event outside it must
		// not create a row, or every deploy event would materialise an empty audit.
		const snapshot = credentialAuditProjection.fold([
			envelope("deploy.Started", { deployId: "d1" }),
		]);
		expect(credentialAuditProjection.query(snapshot)).toHaveLength(0);
	});

	test("the read-set names every handled type", () => {
		expect([...credentialAuditProjection.readSet].sort()).toEqual(
			[...new Set(Object.values(CREDENTIAL_AUDIT_EVENTS))].sort(),
		);
	});
});

describe("the fold as a pure function", () => {
	test("folding the same events twice gives the same row", () => {
		// The log is authoritative and the projection is rebuildable from zero;
		// a fold that carried hidden state would make a rebuild diverge from the
		// live materialisation.
		const events = [
			envelope(CREDENTIAL_AUDIT_EVENTS.TokenGranted, { grantId: "g1" }),
			envelope(CREDENTIAL_AUDIT_EVENTS.TokenUsed, { grantId: "g1" }),
		];
		expect(rowOf(events)).toEqual(rowOf(events));
	});

	test("folding does not mutate a previously produced row", () => {
		// `base()` copies every array and the grants map. Without those copies a
		// second fold would retroactively edit the first one's result.
		const first = [
			envelope(CREDENTIAL_AUDIT_EVENTS.IdentityIssued, { identityId: "i1" }),
		];
		const rowA = rowOf(first);
		const identitiesBefore = [...(rowA?.identityIds ?? [])];
		rowOf([
			...first,
			envelope(CREDENTIAL_AUDIT_EVENTS.IdentityIssued, { identityId: "i2" }),
		]);
		expect(rowA?.identityIds).toEqual(identitiesBefore);
	});

	test("an empty event list yields no rows", () => {
		const snapshot = credentialAuditProjection.fold([]);
		expect(credentialAuditProjection.query(snapshot)).toHaveLength(0);
	});

	test("the snapshot names the projection", () => {
		expect(credentialAuditProjection.fold([]).projection).toBe(
			"credential-audit",
		);
	});

	test("get returns undefined for a correlation that was never seen", () => {
		const snapshot = credentialAuditProjection.fold([
			envelope(CREDENTIAL_AUDIT_EVENTS.IdentityIssued, { identityId: "i1" }),
		]);
		expect(credentialAuditProjection.get(snapshot, "never")).toBeUndefined();
	});
});

describe("compaction against the retention floor", () => {
	function old(type: string): EventEnvelope {
		return envelope(type, {}, { ts: "2000-01-01T00:00:00.000Z" });
	}
	function recent(type: string): EventEnvelope {
		return envelope(type, {}, { ts: "2026-08-01T00:00:00.000Z" });
	}
	const NOW = Date.parse("2026-08-21T00:00:00.000Z");

	test("audit events survive compaction no matter how old", () => {
		// The whole point of NFR-018: a compaction pass over an audit stream drops
		// nothing, so a grant from years ago is still answerable today.
		const events = [
			old("identity.Issued"),
			old("token.Granted"),
			old("session.Started"),
			old("connection.Created"),
			old("config.Resolved"),
			old("secret.Accessed"),
		];
		const result = compactCredentialAuditStream(events, { now: NOW });
		expect(result.retained).toHaveLength(events.length);
		expect(result.droppedCount).toBe(0);
		expect(result.auditPreserved).toBe(true);
	});

	test("non-audit events older than the floor are dropped", () => {
		const result = compactCredentialAuditStream(
			[old("deploy.Started"), recent("deploy.Started")],
			{ now: NOW },
		);
		expect(result.droppedCount).toBe(1);
		expect(result.retained).toHaveLength(1);
		// Nothing auditable was in the stream, so the guarantee still holds.
		expect(result.auditPreserved).toBe(true);
	});

	test("non-audit events inside the floor are kept", () => {
		const result = compactCredentialAuditStream([recent("deploy.Started")], {
			now: NOW,
		});
		expect(result.droppedCount).toBe(0);
	});

	test("an event exactly at the floor is retained", () => {
		// The comparison is `<=`, so the boundary is inclusive. An exclusive
		// boundary would drop an event on the exact day its retention expires,
		// which is a day early by the letter of the policy.
		const ts = new Date(
			NOW - CREDENTIAL_AUDIT_RETENTION_FLOOR_MS,
		).toISOString();
		const result = compactCredentialAuditStream(
			[envelope("deploy.Started", {}, { ts })],
			{ now: NOW },
		);
		expect(result.droppedCount).toBe(0);
	});

	test("a custom retention floor is honoured", () => {
		// Tests and short-lived environments need a shorter floor; ignoring the
		// option would make the behaviour untestable at any realistic timescale.
		const result = compactCredentialAuditStream([recent("deploy.Started")], {
			now: NOW,
			retentionFloorMs: 1000,
		});
		expect(result.droppedCount).toBe(1);
	});

	test("a mixed stream keeps every audit event and drops only stale others", () => {
		const result = compactCredentialAuditStream(
			[
				old("identity.Issued"),
				old("deploy.Started"),
				recent("token.Granted"),
				recent("deploy.Finished"),
			],
			{ now: NOW },
		);
		expect(result.retained.map((e) => e.type)).toEqual([
			"identity.Issued",
			"token.Granted",
			"deploy.Finished",
		]);
		expect(result.auditPreserved).toBe(true);
	});

	test("an empty stream compacts to an empty stream and still reports preserved", () => {
		const result = compactCredentialAuditStream([], { now: NOW });
		expect(result.retained).toEqual([]);
		expect(result.droppedCount).toBe(0);
		expect(result.auditPreserved).toBe(true);
	});

	test("compaction does not mutate the input", () => {
		const events = [old("deploy.Started"), old("identity.Issued")];
		compactCredentialAuditStream(events, { now: NOW });
		expect(events).toHaveLength(2);
	});
});
import type { JsonValue } from "../src/plan-types.js";
