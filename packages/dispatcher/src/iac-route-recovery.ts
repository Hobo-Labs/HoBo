/* oxlint-disable anti-slop/no-runtime-typeof, anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns -- SAFETY: recovery claims cross a host authorization boundary and must be checked at runtime. */
import { stableHash } from "./dispatcher.js";
import {
	type IacRouteIdentity,
	type IacRouteOutcome,
	routeDigest,
	routeName,
} from "./iac-route.js";

type MaybePromise<T> = T | Promise<T>;
export interface IacRouteRecoveryAttempt {
	readonly ordinal: number;
	readonly targetId: string;
	readonly inventoryHash: string;
	/** Digest of the attempt capability; the capability itself must remain secret. */
	readonly attemptRef: string;
	readonly status: "running" | "denied" | "finished";
	readonly consumed: boolean;
}
export interface IacRouteRecoverySnapshot extends IacRouteIdentity {
	/** Commits to the complete route, attempt rows, and current operation mapping. */
	readonly version: string;
	/** Route and attempt rows only, stable as the operation advances to a successor. */
	readonly routeVersion: string;
	readonly operationId: string;
	readonly operationCurrentRequest: string;
	readonly phase: "running" | "finished";
	readonly outcome?: IacRouteOutcome;
	readonly attempts: readonly IacRouteRecoveryAttempt[];
}
export type IacRouteRecoveryOutcome =
	| {
			readonly kind: "no-effect";
			readonly successorRequestId: string;
			readonly reservations: readonly {
				readonly reservationId: string;
				readonly status: "released" | "settled";
			}[];
	  }
	| {
			readonly kind: "selected";
			readonly targetId: string;
			readonly inventoryHash: string;
			readonly financial: {
				readonly disposition: "held" | "settled" | "not-applicable";
				readonly reservationId?: string;
			};
	  };
export interface IacRouteRecoveryClaim extends IacRouteIdentity {
	readonly operationId: string;
	readonly operatorId: string;
	readonly expectedVersion: string;
	/** All host proofs and authorization must remain valid through this UTC millisecond deadline. */
	readonly expiresAt: number;
	readonly evidence: {
		readonly fence: { readonly ref: string; readonly establishedAt: number };
		readonly provider: {
			readonly ref: string;
			readonly afterFence: string;
			readonly observedAt: number;
		};
		readonly financial: {
			readonly ref: string;
			readonly afterFence: string;
			readonly observedAt: number;
		};
	};
	readonly outcome: IacRouteRecoveryOutcome;
}
export interface IacRouteRecoveryRecord {
	readonly claim: IacRouteRecoveryClaim;
	readonly claimDigest: string;
}
/** Implementations are privileged host components; never expose commit as an unauthenticated API. */
export interface IacRouteRecoveryStore {
	readonly persistence: "durable-cas";
	inspect(
		identity: IacRouteIdentity,
	): MaybePromise<IacRouteRecoverySnapshot | undefined>;
	get(
		identity: IacRouteIdentity,
	): MaybePromise<IacRouteRecoveryRecord | undefined>;
	commit(input: {
		readonly claim: IacRouteRecoveryClaim;
		readonly claimDigest: string;
	}): MaybePromise<void>;
}
export interface IacRouteRecoveryVerification {
	readonly claim: IacRouteRecoveryClaim;
	readonly snapshot: IacRouteRecoverySnapshot;
}
export interface IacRouteRecoveryDependencies {
	readonly store: IacRouteRecoveryStore;
	/** Authenticated host policy; a grant must remain valid through the transaction commit. */
	readonly authorize: (claim: IacRouteRecoveryClaim) => MaybePromise<boolean>;
	/** Authenticate provider evidence including its exact causal fence reference and observation time. */
	readonly verifyProvider: (
		input: IacRouteRecoveryVerification,
	) => MaybePromise<boolean>;
	/** Authenticate complete reservation coverage, its causal fence reference and observation time. */
	readonly verifyFinancial: (
		input: IacRouteRecoveryVerification,
	) => MaybePromise<boolean>;
	/** Prove all old executors are permanently fenced and cannot produce further effects. */
	readonly verifyFence: (
		input: IacRouteRecoveryVerification,
	) => MaybePromise<boolean>;
	/** Must agree with the store's trusted clock. */
	readonly now?: () => number;
}
export type IacRouteRecoveryResult =
	| {
			readonly status: "recovered" | "replay";
			readonly outcome: IacRouteRecoveryOutcome;
	  }
	| { readonly status: "denied" | "uncertain" };

function data(input: unknown, key: string): unknown {
	if (typeof input !== "object" || input === null || Array.isArray(input))
		return undefined;
	const descriptor = Object.getOwnPropertyDescriptor(input, key);
	if (descriptor === undefined) return undefined;
	if (!("value" in descriptor))
		throw new TypeError("accessor in recovery input");
	return descriptor.value;
}
function name(value: unknown): value is string {
	return typeof value === "string" && routeName(value);
}
function digest(value: unknown): value is string {
	return typeof value === "string" && routeDigest(value);
}
function objectArray(value: unknown): unknown[] | undefined {
	if (!Array.isArray(value) || value.length > 256) return undefined;
	const result: unknown[] = [];
	for (let i = 0; i < value.length; i++) {
		const descriptor = Object.getOwnPropertyDescriptor(value, String(i));
		if (!descriptor || !("value" in descriptor)) return undefined;
		result.push(descriptor.value);
	}
	return result;
}
/** Normalize without invoking getters, retaining only the bounded, signed claim fields. */
export function normalizeIacRouteRecoveryClaim(
	input: unknown,
): IacRouteRecoveryClaim | undefined {
	const tenantId = data(input, "tenantId");
	const requestId = data(input, "requestId");
	const operationId = data(input, "operationId");
	const operatorId = data(input, "operatorId");
	const expectedVersion = data(input, "expectedVersion");
	const expiresAt = data(input, "expiresAt");
	const evidenceInput = data(input, "evidence");
	const fenceInput = data(evidenceInput, "fence");
	const fenceRef = data(fenceInput, "ref");
	const establishedAt = data(fenceInput, "establishedAt");
	const providerInput = data(evidenceInput, "provider");
	const providerRef = data(providerInput, "ref");
	const providerFence = data(providerInput, "afterFence");
	const providerObservedAt = data(providerInput, "observedAt");
	const financialInput = data(evidenceInput, "financial");
	const financialRef = data(financialInput, "ref");
	const financialFence = data(financialInput, "afterFence");
	const financialObservedAt = data(financialInput, "observedAt");
	const outcomeInput = data(input, "outcome");
	if (
		!name(tenantId) ||
		!name(requestId) ||
		!digest(operationId) ||
		!name(operatorId) ||
		!digest(expectedVersion) ||
		typeof expiresAt !== "number" ||
		!Number.isSafeInteger(expiresAt) ||
		expiresAt <= 0 ||
		!name(fenceRef) ||
		!name(providerRef) ||
		!name(financialRef) ||
		providerFence !== fenceRef ||
		financialFence !== fenceRef ||
		typeof establishedAt !== "number" ||
		!Number.isSafeInteger(establishedAt) ||
		establishedAt <= 0 ||
		typeof providerObservedAt !== "number" ||
		!Number.isSafeInteger(providerObservedAt) ||
		providerObservedAt <= establishedAt ||
		providerObservedAt >= expiresAt ||
		typeof financialObservedAt !== "number" ||
		!Number.isSafeInteger(financialObservedAt) ||
		financialObservedAt <= establishedAt ||
		financialObservedAt >= expiresAt
	)
		return undefined;
	const common = {
		tenantId,
		requestId,
		operationId,
		operatorId,
		expectedVersion,
		expiresAt,
		evidence: {
			fence: { ref: fenceRef, establishedAt },
			provider: {
				ref: providerRef,
				afterFence: fenceRef,
				observedAt: providerObservedAt,
			},
			financial: {
				ref: financialRef,
				afterFence: fenceRef,
				observedAt: financialObservedAt,
			},
		},
	};
	const kind = data(outcomeInput, "kind");
	if (kind === "no-effect") {
		if (
			data(outcomeInput, "targetId") !== undefined ||
			data(outcomeInput, "inventoryHash") !== undefined ||
			data(outcomeInput, "financial") !== undefined
		)
			return undefined;
		const successorRequestId = data(outcomeInput, "successorRequestId");
		const rawReservations = objectArray(data(outcomeInput, "reservations"));
		if (
			!name(successorRequestId) ||
			successorRequestId === requestId ||
			rawReservations === undefined
		)
			return undefined;
		const reservations: {
			reservationId: string;
			status: "released" | "settled";
		}[] = [];
		const seen = new Set<string>();
		for (const reservation of rawReservations) {
			const reservationId = data(reservation, "reservationId");
			const status = data(reservation, "status");
			if (
				!name(reservationId) ||
				seen.has(reservationId) ||
				(status !== "released" && status !== "settled")
			)
				return undefined;
			seen.add(reservationId);
			reservations.push({ reservationId, status });
		}
		reservations.sort((a, b) =>
			a.reservationId < b.reservationId
				? -1
				: a.reservationId > b.reservationId
					? 1
					: 0,
		);
		return { ...common, outcome: { kind, successorRequestId, reservations } };
	}
	if (kind === "selected") {
		if (
			data(outcomeInput, "successorRequestId") !== undefined ||
			data(outcomeInput, "reservations") !== undefined
		)
			return undefined;
		const targetId = data(outcomeInput, "targetId");
		const inventoryHash = data(outcomeInput, "inventoryHash");
		const info = data(outcomeInput, "financial");
		const disposition = data(info, "disposition");
		const reservationId = data(info, "reservationId");
		if (
			!name(targetId) ||
			!digest(inventoryHash) ||
			(disposition !== "held" &&
				disposition !== "settled" &&
				disposition !== "not-applicable")
		)
			return undefined;
		if (disposition === "not-applicable") {
			if (reservationId !== undefined) return undefined;
			return {
				...common,
				outcome: { kind, targetId, inventoryHash, financial: { disposition } },
			};
		}
		if (!name(reservationId)) return undefined;
		return {
			...common,
			outcome: {
				kind,
				targetId,
				inventoryHash,
				financial: { disposition, reservationId },
			},
		};
	}
	return undefined;
}

export function recoveryClaimDigest(claim: IacRouteRecoveryClaim): string {
	return stableHash(claim);
}
/** The current attempt is the final non-denied attempt, if one exists. */
export function recoveryMatchesSnapshot(
	claim: IacRouteRecoveryClaim,
	snapshot: IacRouteRecoverySnapshot,
): boolean {
	if (
		snapshot.tenantId !== claim.tenantId ||
		snapshot.requestId !== claim.requestId ||
		snapshot.operationId !== claim.operationId ||
		snapshot.operationCurrentRequest !== claim.requestId ||
		snapshot.version !== claim.expectedVersion
	)
		return false;
	if (
		snapshot.phase === "finished" &&
		(snapshot.outcome?.status === "denied" ||
			snapshot.outcome?.status === "selected")
	)
		return false;
	if (claim.outcome.kind === "no-effect") return true;
	const attempt = snapshot.attempts.at(-1);
	return (
		attempt !== undefined &&
		attempt.status !== "denied" &&
		attempt.targetId === claim.outcome.targetId &&
		attempt.inventoryHash === claim.outcome.inventoryHash
	);
}
function recordMatches(
	record: IacRouteRecoveryRecord | undefined,
	claim: IacRouteRecoveryClaim,
	claimDigest: string,
): boolean {
	if (!record) return false;
	const saved = normalizeIacRouteRecoveryClaim(record.claim);
	return (
		saved !== undefined &&
		record.claimDigest === claimDigest &&
		recoveryClaimDigest(saved) === claimDigest &&
		JSON.stringify(saved) === JSON.stringify(claim)
	);
}
/** Reconcile one blocked route. Independent host verifiers, not operator assertions, authorize effects. */
export async function recoverIacRoute(
	deps: IacRouteRecoveryDependencies,
	input: IacRouteRecoveryClaim,
): Promise<IacRouteRecoveryResult> {
	let claim: IacRouteRecoveryClaim | undefined;
	try {
		claim = normalizeIacRouteRecoveryClaim(input);
	} catch {
		return { status: "denied" };
	}
	if (!claim || deps.store?.persistence !== "durable-cas")
		return { status: "denied" };
	const now = deps.now ?? Date.now;
	const identity = { tenantId: claim.tenantId, requestId: claim.requestId };
	const claimDigest = recoveryClaimDigest(claim);
	let authorizedForCommit = false;
	try {
		if ((await deps.authorize(structuredClone(claim))) !== true)
			return { status: "denied" };
		const previous = await deps.store.get(identity);
		if (previous !== undefined)
			return recordMatches(previous, claim, claimDigest)
				? { status: "replay", outcome: claim.outcome }
				: { status: "denied" };
		const currentTime = now();
		if (
			!Number.isSafeInteger(currentTime) ||
			claim.expiresAt <= currentTime ||
			claim.expiresAt > currentTime + 300_000 ||
			claim.evidence.provider.observedAt > currentTime ||
			claim.evidence.financial.observedAt > currentTime
		)
			return { status: "denied" };
		const snapshot = await deps.store.inspect(identity);
		if (!snapshot || !recoveryMatchesSnapshot(claim, snapshot))
			return { status: "denied" };
		const inputForVerifier = () => structuredClone({ claim, snapshot });
		if (
			(await deps.verifyFence(inputForVerifier())) !== true ||
			(await deps.verifyProvider(inputForVerifier())) !== true ||
			(await deps.verifyFinancial(inputForVerifier())) !== true
		)
			return { status: "denied" };
		if ((await deps.authorize(structuredClone(claim))) !== true)
			return { status: "denied" };
		if (claim.expiresAt <= now()) return { status: "denied" };
		authorizedForCommit = true;
		await deps.store.commit({ claim: structuredClone(claim), claimDigest });
		const saved = await deps.store.get(identity);
		return recordMatches(saved, claim, claimDigest)
			? { status: "recovered", outcome: claim.outcome }
			: { status: "uncertain" };
	} catch {
		if (!authorizedForCommit) return { status: "uncertain" };
		try {
			const saved = await deps.store.get(identity);
			if (recordMatches(saved, claim, claimDigest))
				return { status: "replay", outcome: claim.outcome };
		} catch {
			/* An unreadable ledger is never evidence of success. */
		}
		return { status: "uncertain" };
	}
}
/* oxlint-enable anti-slop/no-runtime-typeof, anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns */
