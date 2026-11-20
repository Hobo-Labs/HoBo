import {
	createHash,
	createPublicKey,
	type KeyObject,
	verify,
} from "node:crypto";
import { create } from "@bufbuild/protobuf";
import { canonicalFenceOperationReceipt, isJsonString } from "@hobo/data-core";
import { z } from "zod";
import {
	type BudgetFencedPlacement,
	BudgetFencedPlacementSchema,
	type BudgetFenceSettlementGuard,
	BudgetFenceSettlementGuardSchema,
	type BudgetReservation,
	type BudgetSettlementEvidence,
} from "./_generated/yard_placement_pb.js";

export type BudgetFencedPlacementScope = Pick<
	BudgetFencedPlacement,
	| "yardId"
	| "campId"
	| "providerId"
	| "providerAccountId"
	| "resourceId"
	| "deploymentId"
	| "incarnationId"
	| "manifestHash"
	| "planHash"
>;
export type BudgetFenceFinanceAccount = Pick<
	BudgetFencedPlacement,
	"providerId" | "providerAccountId"
>;
type Evidence = Pick<
	BudgetSettlementEvidence,
	"usageEvidenceRef" | "sourceStoppedEvidenceRef"
> &
	Partial<
		Pick<
			BudgetSettlementEvidence,
			| "providerAccounts"
			| "entitlementClaims"
			| "fenceOperationReceiptJson"
			| "financeSignature"
		>
	>;

/** Separately enrolled destination identity. The host must authenticate this
 * enrollment against the actual receiver; a declaration is not that proof. */
export interface BudgetFenceReceiverEnrollment {
	readonly keyId: string;
	readonly publicKey: KeyObject;
	readonly tenantId: string;
	/** Exact independently authorized source dataset scope; empty is global. */
	readonly sourceScopeTenant: string;
	readonly dataset: string;
	readonly source: BudgetFencedPlacementScope;
	readonly destination: BudgetFencedPlacementScope;
}

/** Finance signers are scoped to a budget and its allowed provider accounts. */
export interface BudgetFenceFinanceEnrollment {
	readonly keyId: string;
	readonly publicKey: KeyObject;
	readonly tenantId: string;
	readonly budgetId: string;
	readonly providerAccounts: readonly BudgetFenceFinanceAccount[];
}

export interface BudgetFenceTrust {
	readonly receivers: readonly BudgetFenceReceiverEnrollment[];
	readonly finance: readonly BudgetFenceFinanceEnrollment[];
}

export interface BudgetFenceGuardRequest {
	readonly dataset: string;
	readonly operationId: string;
	readonly fenceTokenDigest: string;
	readonly receiverKeyId: string;
	readonly financeKeyId: string;
	readonly logicalCampId: string;
	readonly source: BudgetFencedPlacementScope;
	readonly destination: BudgetFencedPlacementScope;
	readonly decision: "to-target" | "to-source";
	readonly executionDigest: string;
	readonly expectedRouteGeneration: string;
	readonly currentSetId: string;
	readonly desiredSetId: string;
	readonly migrationId: string;
	readonly decisionHead: string;
}

/** Preserve one host enrollment across every replay performed by an adapter. */
export function captureBudgetFenceTrust(
	trust: BudgetFenceTrust | undefined,
): BudgetFenceTrust | undefined {
	if (!trust) return undefined;
	const captured: BudgetFenceTrust = {
		receivers: trust.receivers.map((row) => ({
			...row,
			source: { ...row.source },
			destination: { ...row.destination },
		})),
		finance: trust.finance.map((row) => ({
			...row,
			providerAccounts: row.providerAccounts.map((account) => ({ ...account })),
		})),
	};
	createBudgetFenceVerifier(captured);
	return captured;
}

const receiptSchema = z.strictObject({
	contract: z.literal("hobo.fence-operation-receipt/v1"),
	scope: z.strictObject({ dataset: z.string(), tenant: z.string() }),
	operationId: z.string(),
	routeDigest: z.string(),
	receiverKeyId: z.string(),
	fenceTokenDigest: z.string(),
	outcome: z.literal("committed"),
	signature: z.string(),
});

function text(value: string | undefined): value is string {
	return (
		isJsonString(value) &&
		value.length > 0 &&
		value.length <= 512 &&
		value === value.trim() &&
		!/\p{Cc}/u.test(value)
	);
}
function digest(value: string): boolean {
	return value.length === 71 && /^sha256:[a-f0-9]{64}$/u.test(value);
}
function location(
	value: BudgetFencedPlacementScope | undefined,
): readonly string[] {
	if (!value) throw new Error("fenced route placement missing");
	const fields = [
		value.yardId,
		value.campId,
		value.providerId,
		value.providerAccountId,
		value.resourceId,
		value.deploymentId,
		value.incarnationId,
		value.manifestHash,
		value.planHash,
	];
	if (
		!fields.every(text) ||
		!digest(value.manifestHash) ||
		!digest(value.planHash)
	)
		throw new Error("invalid fenced route placement");
	return fields;
}
function publicKeyBytes(key: KeyObject): string {
	if (key.type !== "public" || key.asymmetricKeyType !== "ed25519")
		throw new Error("Ed25519 public enrollment key required");
	return key.export({ type: "spki", format: "der" }).toString("base64url");
}
function signature(value: string): Buffer {
	const decoded = Buffer.from(value, "base64url");
	if (decoded.length !== 64 || decoded.toString("base64url") !== value)
		throw new Error("invalid canonical Ed25519 signature");
	return decoded;
}
function enrollmentKey(value: string): KeyObject {
	const bytes = Buffer.from(value, "base64url");
	if (bytes.toString("base64url") !== value)
		throw new Error("invalid enrolled key encoding");
	const key = createPublicKey({ key: bytes, format: "der", type: "spki" });
	if (publicKeyBytes(key) !== value) throw new Error("invalid enrolled key");
	return key;
}
function identity(reservation: BudgetReservation): readonly string[] {
	const id = reservation.identity;
	if (
		!id ||
		![
			id.tenantId,
			id.budgetId,
			id.periodId,
			id.policyRevision,
			reservation.reservationId,
			reservation.requestDigest,
			reservation.quoteDigest,
			reservation.financialPlanHash,
		].every(text) ||
		!digest(reservation.requestDigest) ||
		!digest(reservation.financialPlanHash) ||
		reservation.quoteDigest.length !== 64 ||
		!/^[a-f0-9]{64}$/u.test(reservation.quoteDigest)
	)
		throw new Error(
			"fenced reservation requires complete budget, request and financial plan identity",
		);
	return [
		id.tenantId,
		id.budgetId,
		id.periodId,
		id.policyRevision,
		reservation.reservationId,
		reservation.requestDigest,
		reservation.quoteDigest,
		reservation.financialPlanHash,
	];
}
function routePayload(
	reservation: BudgetReservation,
	guard: BudgetFenceSettlementGuard,
): string {
	if (
		![
			guard.dataset,
			guard.operationId,
			guard.receiverKeyId,
			guard.receiverPublicKey,
			guard.financeKeyId,
			guard.financePublicKey,
			guard.logicalCampId,
			guard.executionDigest,
			guard.currentSetId,
			guard.desiredSetId,
			guard.migrationId,
		].every(text) ||
		(guard.scopeTenant !== "" && !text(guard.scopeTenant)) ||
		!digest(guard.fenceTokenDigest) ||
		!digest(guard.executionDigest) ||
		guard.expectedRouteGeneration.length > 20 ||
		!/^(0|[1-9][0-9]{0,19})$/u.test(guard.expectedRouteGeneration) ||
		BigInt(guard.expectedRouteGeneration) > 18446744073709551615n ||
		guard.decisionHead.length > 20 ||
		!/^[1-9][0-9]{0,19}$/u.test(guard.decisionHead) ||
		BigInt(guard.decisionHead) > 18446744073709551615n ||
		!["to-source", "to-target"].includes(guard.decision) ||
		guard.contract !== "hobo.budget-fence-guard/v1"
	)
		throw new Error("invalid fenced route guard");
	return JSON.stringify([
		"hobo.budget-fence-route/v1",
		identity(reservation),
		guard.dataset,
		guard.scopeTenant,
		guard.operationId,
		guard.fenceTokenDigest,
		guard.receiverKeyId,
		guard.receiverPublicKey,
		guard.financeKeyId,
		guard.financePublicKey,
		guard.logicalCampId,
		location(guard.source),
		location(guard.destination),
		guard.decision,
		guard.executionDigest,
		guard.expectedRouteGeneration,
		guard.currentSetId,
		guard.desiredSetId,
		guard.migrationId,
		guard.decisionHead,
	]);
}
function routeDigest(
	reservation: BudgetReservation,
	guard: BudgetFenceSettlementGuard,
): string {
	return `sha256:${createHash("sha256").update(routePayload(reservation, guard)).digest("hex")}`;
}

/** Capture independently authenticated public enrollment once, before replay. */
export function createBudgetFenceVerifier(trust?: BudgetFenceTrust) {
	const receivers = new Map<
		string,
		{
			key: string;
			tenantId: string;
			sourceScopeTenant: string;
			dataset: string;
			source: readonly string[];
			destination: readonly string[];
		}
	>();
	const finance = new Map<
		string,
		{
			key: string;
			tenantId: string;
			budgetId: string;
			accounts: ReadonlyMap<string, string>;
		}
	>();
	for (const row of trust?.receivers ?? []) {
		if (
			!text(row.keyId) ||
			!text(row.tenantId) ||
			!text(row.dataset) ||
			(row.sourceScopeTenant !== "" && !text(row.sourceScopeTenant)) ||
			receivers.has(row.keyId)
		)
			throw new Error("invalid or duplicate fenced receiver enrollment");
		receivers.set(row.keyId, {
			key: publicKeyBytes(row.publicKey),
			tenantId: row.tenantId,
			sourceScopeTenant: row.sourceScopeTenant,
			dataset: row.dataset,
			source: location(row.source),
			destination: location(row.destination),
		});
	}
	for (const row of trust?.finance ?? []) {
		if (
			!text(row.keyId) ||
			!text(row.tenantId) ||
			!text(row.budgetId) ||
			finance.has(row.keyId) ||
			row.providerAccounts.length === 0 ||
			row.providerAccounts.some(
				(account) =>
					!text(account.providerId) || !text(account.providerAccountId),
			) ||
			new Set(row.providerAccounts.map((account) => account.providerAccountId))
				.size !== row.providerAccounts.length
		)
			throw new Error("invalid or duplicate fence finance enrollment");
		finance.set(row.keyId, {
			key: publicKeyBytes(row.publicKey),
			tenantId: row.tenantId,
			budgetId: row.budgetId,
			accounts: new Map(
				row.providerAccounts.map((account) => [
					account.providerAccountId,
					account.providerId,
				]),
			),
		});
	}
	function validate(reservation: BudgetReservation): void {
		const guard = reservation.fenceSettlementGuard;
		if (!guard) return;
		const receiver = receivers.get(guard.receiverKeyId);
		const financier = finance.get(guard.financeKeyId);
		const accounts = reservation.providerAccounts.map(
			(row) => row.providerAccountId,
		);
		if (
			guard.destination &&
			guard.destination.planHash !== reservation.financialPlanHash
		)
			throw new Error(
				"fenced destination financial plan differs from the Broker reservation",
			);
		if (
			!receiver ||
			!financier ||
			receiver.key !== guard.receiverPublicKey ||
			financier.key !== guard.financePublicKey ||
			receiver.key === financier.key ||
			receiver.tenantId !== reservation.identity?.tenantId ||
			receiver.sourceScopeTenant !== guard.scopeTenant ||
			receiver.dataset !== guard.dataset ||
			JSON.stringify(receiver.source) !==
				JSON.stringify(location(guard.source)) ||
			financier.tenantId !== reservation.identity?.tenantId ||
			financier.budgetId !== reservation.identity?.budgetId ||
			JSON.stringify(receiver.destination) !==
				JSON.stringify(location(guard.destination)) ||
			!guard.source ||
			!guard.destination ||
			!accounts.includes(guard.source.providerAccountId) ||
			!accounts.includes(guard.destination.providerAccountId) ||
			financier.accounts.get(guard.source.providerAccountId) !==
				guard.source.providerId ||
			financier.accounts.get(guard.destination.providerAccountId) !==
				guard.destination.providerId ||
			accounts.some((account) => !financier.accounts.has(account)) ||
			guard.routeDigest !== routeDigest(reservation, guard)
		)
			throw new Error(
				"fenced route does not match independently enrolled receiver, finance authority and budget",
			);
		if (
			reservation.executionDigest &&
			reservation.executionDigest !== guard.executionDigest
		)
			throw new Error("fenced execution identity changed");
	}
	function createGuard(
		reservation: BudgetReservation,
		input: BudgetFenceGuardRequest,
	): BudgetFenceSettlementGuard {
		const receiver = receivers.get(input.receiverKeyId);
		const financier = finance.get(input.financeKeyId);
		if (!receiver || !financier)
			throw new Error("independently enrolled fence authorities required");
		const guard = create(BudgetFenceSettlementGuardSchema, {
			contract: "hobo.budget-fence-guard/v1",
			dataset: input.dataset,
			scopeTenant: receiver.sourceScopeTenant,
			operationId: input.operationId,
			fenceTokenDigest: input.fenceTokenDigest,
			receiverKeyId: input.receiverKeyId,
			receiverPublicKey: receiver.key,
			financeKeyId: input.financeKeyId,
			financePublicKey: financier.key,
			logicalCampId: input.logicalCampId,
			source: create(BudgetFencedPlacementSchema, input.source),
			destination: create(BudgetFencedPlacementSchema, input.destination),
			decision: input.decision,
			executionDigest: input.executionDigest,
			expectedRouteGeneration: input.expectedRouteGeneration,
			currentSetId: input.currentSetId,
			desiredSetId: input.desiredSetId,
			migrationId: input.migrationId,
			decisionHead: input.decisionHead,
		});
		guard.routeDigest = routeDigest(reservation, guard);
		const guarded = { ...reservation, fenceSettlementGuard: guard };
		validate(guarded);
		return guard;
	}
	function settle(
		reservation: BudgetReservation,
		actualMicros: number,
		evidence: Evidence,
	): void {
		const guard = reservation.fenceSettlementGuard;
		if (!guard) return;
		validate(reservation);
		if (
			!reservation.executionDigest ||
			reservation.executionDigest !== guard.executionDigest
		)
			throw new Error("fenced route was not claimed for execution");
		const payload = canonicalBudgetFenceSettlement(
			reservation,
			actualMicros,
			evidence,
		);
		const receipt = parseReceipt(evidence.fenceOperationReceiptJson);
		const { signature: signed, ...body } = receipt;
		if (
			!verify(
				null,
				Buffer.from(canonicalFenceOperationReceipt(body)),
				enrollmentKey(guard.receiverPublicKey),
				signature(signed),
			)
		)
			throw new Error("fenced route receiver signature invalid");
		if (
			!evidence.financeSignature ||
			!verify(
				null,
				Buffer.from(payload),
				enrollmentKey(guard.financePublicKey),
				signature(evidence.financeSignature),
			)
		)
			throw new Error("fenced route financial settlement signature invalid");
	}
	return { createGuard, validate, settle };
}

function parseReceipt(value: string | undefined) {
	if (!value || value.length > 16384)
		throw new Error("fenced route terminal receipt required");
	let parsed: unknown;
	try {
		parsed = JSON.parse(value);
	} catch {
		throw new Error("invalid fenced route receipt");
	}
	return receiptSchema.parse(parsed);
}

/** Canonical finance statement signed by the independently enrolled finance
 * authority after verifying final charges and source retirement. */
export function canonicalBudgetFenceSettlement(
	reservation: BudgetReservation,
	actualMicros: number,
	evidence: Evidence,
): string {
	const guard = reservation.fenceSettlementGuard;
	if (
		!guard ||
		!Number.isSafeInteger(actualMicros) ||
		actualMicros < 0 ||
		!text(evidence.usageEvidenceRef) ||
		!text(evidence.sourceStoppedEvidenceRef)
	)
		throw new Error("complete fenced settlement required");
	const receipt = parseReceipt(evidence.fenceOperationReceiptJson);
	const { signature: signed, ...body } = receipt;
	const receiptPayload = canonicalFenceOperationReceipt(body);
	if (
		receipt.scope.dataset !== guard.dataset ||
		receipt.scope.tenant !== guard.scopeTenant ||
		receipt.operationId !== guard.operationId ||
		receipt.routeDigest !== guard.routeDigest ||
		receipt.receiverKeyId !== guard.receiverKeyId ||
		receipt.fenceTokenDigest !== guard.fenceTokenDigest ||
		guard.routeDigest !== routeDigest(reservation, guard)
	)
		throw new Error("fenced route receipt scope mismatch");
	const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
	const accounts = [...(evidence.providerAccounts ?? [])]
		.map((row) => [row.providerAccountId, row.liabilityMicros] as const)
		.sort((a, b) => compare(a[0], b[0]));
	const claims = [...(evidence.entitlementClaims ?? [])]
		.map((row) => [row.bucketId, row.unit, row.units] as const)
		.sort((a, b) => compare(a[0], b[0]));
	if (
		accounts.some(
			([id, amount]) =>
				!text(id) || !Number.isSafeInteger(amount) || amount < 0,
		) ||
		claims.some(
			([id, unit, count]) =>
				!text(id) || !text(unit) || !Number.isSafeInteger(count) || count < 0,
		)
	)
		throw new Error("invalid fenced settlement dimensions");
	if (
		new Set(accounts.map((row) => row[0])).size !== accounts.length ||
		new Set(claims.map((row) => row[0])).size !== claims.length
	)
		throw new Error("duplicate fenced settlement dimensions");
	return JSON.stringify([
		"hobo.budget-fence-settlement/v1",
		identity(reservation),
		guard.routeDigest,
		guard.financeKeyId,
		actualMicros,
		evidence.usageEvidenceRef,
		evidence.sourceStoppedEvidenceRef,
		accounts,
		claims,
		receiptPayload,
		signed,
	]);
}
