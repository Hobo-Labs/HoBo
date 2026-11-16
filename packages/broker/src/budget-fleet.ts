import { createHash } from "node:crypto";
import { fromJsonString, toJsonString } from "@bufbuild/protobuf";
import {
	type ImmutableJournal,
	ImmutableJournalError,
} from "@hobo/backend-fleet";
import {
	type BudgetAuthorityEvent,
	BudgetAuthorityEventSchema,
	type BudgetLedgerSnapshot,
	BudgetLedgerSnapshotSchema,
	createBudgetAdmissionAuthority,
} from "./budget-authority.js";
import {
	type BudgetFenceTrust,
	captureBudgetFenceTrust,
} from "./budget-fence-settlement.js";
import type { AsyncBudgetAdmissionAuthority } from "./budget-postgres.js";

type Authority = ReturnType<typeof createBudgetAdmissionAuthority>;
type Journal = ImmutableJournal;
const BASE = "hobo.broker.base/v1:";
const EVENT = "hobo.broker.event/v1:";
const BASE_OPERATION = "broker:base";
const eventId = (value: string) =>
	`broker:event:${createHash("sha256").update(value).digest("hex")}`;

/**
 * The existing financial authority, replayed and committed through HoBo's
 * fixed-membership majority journal. The host must independently verify the
 * complete voter anchor, pre-fund every journal operation and quarantine any
 * voter restored from an older backup. This adapter does not create that proof
 * or fence a provider's external effects.
 */
export function createFleetBudgetAdmissionAuthority(options: {
	readonly journal: Journal;
	readonly snapshot: BudgetLedgerSnapshot;
	readonly now?: () => string;
	readonly fenceTrust?: BudgetFenceTrust;
	/** Operational hosts may install a separately funded, actor-authorized
	 * recovery. Read-only inspection leaves this absent. */
	readonly recover?: () => Promise<void>;
}): AsyncBudgetAdmissionAuthority & {
	initializeFresh(
		verifyFresh: Parameters<Journal["bootstrap"]>[0],
	): Promise<void>;
	configure(...args: Parameters<Authority["configure"]>): Promise<void>;
} {
	const initial = toJsonString(BudgetLedgerSnapshotSchema, options.snapshot);
	const initialSnapshot = fromJsonString(BudgetLedgerSnapshotSchema, initial);
	const fenceTrust = captureBudgetFenceTrust(options.fenceTrust);
	if (!initialSnapshot.identity?.tenantId || !initialSnapshot.identity.budgetId)
		throw new Error("complete shared budget ownership required");
	createBudgetAdmissionAuthority({ snapshot: initialSnapshot });
	const now = options.now ?? (() => new Date().toISOString());
	const journal = options.journal;
	const recover = options.recover;

	async function history(allowRecovery: boolean) {
		try {
			return await journal.read();
		} catch (error) {
			// Finishing an already offered command is a separately funded journal
			// operation. It never invents a replacement financial decision.
			if (
				allowRecovery &&
				recover &&
				error instanceof ImmutableJournalError &&
				error.reason === "quorum-unavailable"
			) {
				await recover();
				return journal.read();
			}
			throw error;
		}
	}

	async function run<T>(
		operation: (authority: Authority) => T,
		allowRecovery: boolean,
	): Promise<T> {
		for (let attempt = 0; attempt < 8; attempt += 1) {
			const entries = await history(allowRecovery);
			const first = entries[0];
			if (
				first?.position !== 1 ||
				first.operationId !== BASE_OPERATION ||
				!first.value.startsWith(BASE)
			)
				throw new Error("shared budget journal base missing");
			const base = fromJsonString(
				BudgetLedgerSnapshotSchema,
				first.value.slice(BASE.length),
			);
			if (
				`${BASE}${toJsonString(BudgetLedgerSnapshotSchema, base)}` !==
				first.value
			)
				throw new Error("shared budget journal base invalid");
			if (
				base.identity?.tenantId !== initialSnapshot.identity?.tenantId ||
				base.identity?.budgetId !== initialSnapshot.identity?.budgetId
			)
				throw new Error("journal belongs to another budget");
			const priorEvents: BudgetAuthorityEvent[] = [];
			for (const [index, entry] of entries.slice(1).entries()) {
				if (
					entry.position !== index + 2 ||
					!entry.value.startsWith(EVENT) ||
					entry.operationId !== eventId(entry.value)
				)
					throw new Error("shared budget journal sequence mismatch");
				const event = fromJsonString(
					BudgetAuthorityEventSchema,
					entry.value.slice(EVENT.length),
				);
				if (
					event.snapshot?.seq !== base.seq + index + 1 ||
					`${EVENT}${toJsonString(BudgetAuthorityEventSchema, event)}` !==
						entry.value
				)
					throw new Error("shared budget journal sequence mismatch");
				priorEvents.push(event);
			}
			let seq = priorEvents.at(-1)?.snapshot?.seq ?? base.seq;
			const pending: BudgetAuthorityEvent[] = [];
			const authority = createBudgetAdmissionAuthority({
				snapshot: base,
				priorEvents,
				...(fenceTrust ? { fenceTrust } : undefined),
				commit(event, expectedSeq) {
					if (seq !== expectedSeq || event.snapshot?.seq !== expectedSeq + 1)
						throw new Error("budget sequence conflict");
					seq = event.snapshot.seq;
					pending.push(event);
				},
			});
			const result = operation(authority);
			if (!pending.length) return result;
			if (pending.length !== 1 || !pending[0])
				throw new Error("budget operation cannot be committed atomically");
			const value = `${EVENT}${toJsonString(BudgetAuthorityEventSchema, pending[0])}`;
			const operationId = eventId(value);
			try {
				const committed = await journal.append(
					operationId,
					value,
					entries.length,
				);
				if (
					committed.position !== entries.length + 1 ||
					committed.operationId !== operationId ||
					committed.value !== value
				)
					throw new Error("shared budget journal commit mismatch");
				return result;
			} catch (error) {
				if (
					!(error instanceof ImmutableJournalError) ||
					error.reason !== "head-conflict" ||
					attempt === 7
				)
					throw error;
			}
		}
		throw new Error("shared budget journal contention");
	}

	return {
		persistence: "durable-cas",
		async initializeFresh(verifyFresh) {
			try {
				await journal.bootstrap(verifyFresh);
			} catch (error) {
				if (
					!(error instanceof ImmutableJournalError) ||
					error.reason !== "freshness-unverified"
				)
					throw error;
				// The journal checks every member's authenticated identity, exact
				// local prefix and documents before recovering this one command.
				const entries = await journal.recoverBootstrap(verifyFresh, {
					operationId: BASE_OPERATION,
					value: `${BASE}${initial}`,
				});
				if (
					entries.length === 1 &&
					entries[0]?.operationId === BASE_OPERATION &&
					entries[0]?.value === `${BASE}${initial}`
				)
					return;
				if (entries.length !== 0) throw error;
			}
			await journal.append(BASE_OPERATION, `${BASE}${initial}`, 0);
		},
		read(_at) {
			return run((authority) => authority.read(now()), false);
		},
		lookup(id) {
			return run((authority) => authority.lookup(id), false);
		},
		claimExecution(input) {
			return run((authority) => {
				authority.read(now());
				return authority.claimExecution(input);
			}, true);
		},
		reserve(input) {
			return run(
				(authority) => authority.reserve({ ...input, now: now() }),
				true,
			);
		},
		settle(id, actualMicros, evidence) {
			return run(
				(authority) => authority.settle(id, actualMicros, evidence),
				true,
			);
		},
		uncertain(id) {
			return run((authority) => authority.uncertain(id), true);
		},
		release(id, confirmedUnused, evidenceRef) {
			return run(
				(authority) => authority.release(id, confirmedUnused, evidenceRef),
				true,
			);
		},
		configure(snapshot, expectedSeq, _at, evidence) {
			return run(
				(authority) =>
					authority.configure(snapshot, expectedSeq, now(), evidence),
				true,
			);
		},
	};
}
