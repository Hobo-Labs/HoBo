// ApprovalPort adapters: A2H (agent-to-human handoff through NotificationPort,
// decided by an authorized human) and a CloudEvents webhook approver whose
// answer arrives on a signed callback (HMAC-SHA256 over the request id and
// expiry, keyed by a secret the CredentialResolver supplies and that never
// enters a record). Both persist requests and decisions as saga facts on the
// promotion stream the subject names, so the promotion saga, the approvers
// and replay read one journal. There is no second approval system: every
// decision is authorized as the governed `approve` action (D15).
import { createHmac, timingSafeEqual } from "node:crypto";
import type { DurableEventStore, HttpTransport, JsonObject } from "@hobo/core";
import { createSagaStepEmittedEvent } from "@hobo/events";
import { CD_STREAMS } from "../events.js";
import type {
	ApprovalPort,
	ApprovalStatus,
	CdAuthorizer,
	CdContext,
	CredentialResolver,
	FeedRequest,
	FeedResponse,
	NotificationPort,
	Outcome,
	TelemetrySink,
} from "../ports.js";
import {
	appendOnce,
	emitMetric,
	isJsonObject,
	isNumber,
	iso,
	isText,
	principalName,
	readStream,
	toJsonValue,
} from "../promotion/journal.js";
import { PROMOTION_METRIC, reason } from "../promotion/reasons.js";
import { SAGA_FACT, STEP, sagaIdOf } from "../promotion/state.js";

// public-contract: approval subjects are `promotion:<promotionId>/<scope>`,
// where scope is a Camp id, optionally followed by `/<stage>` (rollouts).
export const APPROVAL_SUBJECT_PREFIX = "promotion:" as const;

// public-contract: refusal codes of the approval adapters.
export const APPROVAL_REASON = Object.freeze({
	subjectInvalid: "approval-subject-invalid",
	unknownRequest: "approval-request-unknown",
	alreadyDecided: "approval-already-decided",
	expired: "approval-expired",
	unauthorized: "approval-unauthorized",
	signatureInvalid: "approval-signature-invalid",
	journalConflict: "approval-journal-conflict",
} as const);

// public-contract: CloudEvents type the webhook approver sends.
export const APPROVAL_REQUESTED_TYPE =
	"dev.cdeventsx.hobo.approval.requested" as const;

export type ApprovalSubject = Readonly<{ promotionId: string; scope: string }>;

export function approvalSubject(promotionId: string, scope: string): string {
	return `${APPROVAL_SUBJECT_PREFIX}${promotionId}/${scope}`;
}

/** Parse `promotion:<promotionId>/<scope>`; undefined when malformed. */
export function parseApprovalSubject(
	subject: string,
): ApprovalSubject | undefined {
	if (!subject.startsWith(APPROVAL_SUBJECT_PREFIX)) return undefined;
	const rest = subject.slice(APPROVAL_SUBJECT_PREFIX.length);
	const slash = rest.indexOf("/");
	if (slash <= 0 || slash === rest.length - 1) return undefined;
	const promotionId = rest.slice(0, slash);
	const scope = rest.slice(slash + 1);
	if (/[|\s]/.test(promotionId) || /[|\s]/.test(scope)) return undefined;
	return { promotionId, scope };
}

type ApprovalFacts = Readonly<{
	requestedExpiresAtMs: number | undefined;
	decision: "approved" | "denied" | undefined;
	decidedBy: string;
}>;

/** One journal for both approvers: facts on the subject's promotion stream. */
export function createApprovalLedger(
	d: Readonly<{ store: DurableEventStore; tenant: string; now: () => number }>,
) {
	async function facts(subject: ApprovalSubject): Promise<ApprovalFacts> {
		let requestedExpiresAtMs: number | undefined;
		let decision: ApprovalFacts["decision"];
		let decidedBy = "";
		for (const event of await readStream(
			d.store,
			CD_STREAMS.promotion(subject.promotionId),
		)) {
			if (event.type !== SAGA_FACT.stepEmitted || !isJsonObject(event.data))
				continue;
			if (event.data.sagaId !== sagaIdOf(subject.promotionId)) continue;
			const step = isText(event.data.step) ? String(event.data.step) : "";
			const handle = isText(event.data.emittedType)
				? String(event.data.emittedType)
				: "";
			if (
				step === `${subject.scope}|${STEP.approvalRequested}` &&
				requestedExpiresAtMs === undefined
			) {
				const ms = Number(handle.split(" ").at(-1));
				requestedExpiresAtMs = Number.isFinite(ms) ? ms : 0;
			}
			if (decision !== undefined) continue;
			if (step === `${subject.scope}|${STEP.approved}`) {
				decision = "approved";
				decidedBy = handle;
			} else if (step === `${subject.scope}|${STEP.approvalDenied}`) {
				decision = "denied";
				decidedBy = handle;
			}
		}
		return { requestedExpiresAtMs, decision, decidedBy };
	}

	async function append(
		subject: ApprovalSubject,
		step: string,
		handle: string,
		ctx: CdContext,
	): Promise<boolean> {
		const event = await appendOnce({
			store: d.store,
			streamId: CD_STREAMS.promotion(subject.promotionId),
			type: SAGA_FACT.stepEmitted,
			data: toJsonValue(
				createSagaStepEmittedEvent({
					sagaId: sagaIdOf(subject.promotionId),
					step: `${subject.scope}|${step}`,
					emittedType: handle,
				}).data,
			),
			idempotencyKey: `step:${subject.scope}:${step}`,
			tenant: d.tenant,
			actor: ctx.principal,
		});
		return event !== undefined;
	}

	return {
		facts,
		async request(
			subject: ApprovalSubject,
			expiresAtMs: number,
			ctx: CdContext,
		): Promise<boolean> {
			return append(
				subject,
				STEP.approvalRequested,
				`${approvalSubject(subject.promotionId, subject.scope)} ${expiresAtMs}`,
				ctx,
			);
		},
		async status(subject: ApprovalSubject): Promise<ApprovalStatus> {
			const known = await facts(subject);
			if (known.decision !== undefined) return known.decision;
			if (
				known.requestedExpiresAtMs !== undefined &&
				d.now() >= known.requestedExpiresAtMs
			)
				return "expired";
			return "pending";
		},
		async decide(
			subject: ApprovalSubject,
			approve: boolean,
			by: string,
			ctx: CdContext,
		): Promise<Outcome<ApprovalStatus>> {
			const known = await facts(subject);
			if (known.requestedExpiresAtMs === undefined)
				return {
					ok: false,
					reasons: [
						reason(
							APPROVAL_REASON.unknownRequest,
							`no approval was requested for ${approvalSubject(subject.promotionId, subject.scope)}`,
							"Approve a request the promotion is waiting on (its record is AWAITING_APPROVAL).",
							subject.promotionId,
						),
					],
				};
			if (known.decision !== undefined)
				return known.decision === (approve ? "approved" : "denied")
					? { ok: true, value: known.decision }
					: {
							ok: false,
							reasons: [
								reason(
									APPROVAL_REASON.alreadyDecided,
									`request was already ${known.decision} by ${known.decidedBy}`,
									"A decision is final; request a new promotion to change it.",
									subject.promotionId,
								),
							],
						};
			if (ctx.now() >= known.requestedExpiresAtMs)
				return {
					ok: false,
					reasons: [
						reason(
							APPROVAL_REASON.expired,
							`request expired at ${iso(known.requestedExpiresAtMs)}`,
							"Promote again to open a fresh approval request.",
							subject.promotionId,
						),
					],
				};
			const ok = await append(
				subject,
				approve ? STEP.approved : STEP.approvalDenied,
				by,
				ctx,
			);
			if (!ok)
				return {
					ok: false,
					reasons: [
						reason(
							APPROVAL_REASON.journalConflict,
							"the decision could not be journaled",
							"Retry; another writer holds the promotion stream.",
							subject.promotionId,
						),
					],
				};
			return { ok: true, value: approve ? "approved" : "denied" };
		},
	};
}

type Ledger = ReturnType<typeof createApprovalLedger>;

function subjectOrThrow(subject: string): ApprovalSubject {
	const parsed = parseApprovalSubject(subject);
	if (!parsed)
		throw new Error(
			`${APPROVAL_REASON.subjectInvalid}: approval subject must be ${APPROVAL_SUBJECT_PREFIX}<promotionId>/<scope>, got ${subject}`,
		);
	return parsed;
}

export interface HumanApprover extends ApprovalPort {
	/** The human's answer (CLI/MCP), authorized as the governed `approve` action. */
	decide(
		input: Readonly<{ requestId: string; approve: boolean }>,
		ctx: CdContext,
	): Promise<Outcome<ApprovalStatus>>;
}

export type A2HApproverDeps = Readonly<{
	store: DurableEventStore;
	tenant: string;
	now: () => number;
	notify: NotificationPort;
	authorizer: CdAuthorizer;
	telemetry: TelemetrySink;
	/** NotificationPort channel the handoff is sent on. */
	channel?: string;
}>;

async function authorizedDecision(
	authorizer: CdAuthorizer,
	ledger: Ledger,
	requestId: string,
	approve: boolean,
	by: string,
	ctx: CdContext,
	telemetry: TelemetrySink,
	tenant: string,
): Promise<Outcome<ApprovalStatus>> {
	const subject = parseApprovalSubject(requestId);
	if (!subject)
		return {
			ok: false,
			reasons: [
				reason(
					APPROVAL_REASON.subjectInvalid,
					`malformed approval request id ${requestId}`,
					`Use the request id the promotion recorded (${APPROVAL_SUBJECT_PREFIX}<promotionId>/<camp>).`,
					requestId,
				),
			],
		};
	const authz = await authorizer.authorize(
		"approve",
		{ requestId, approve },
		ctx,
	);
	if (!authz.ok) return authz;
	if (authz.value.proposalOnly)
		return {
			ok: false,
			reasons: [
				reason(
					APPROVAL_REASON.unauthorized,
					`${principalName(ctx.principal)} may only propose; an approval needs a human or granted principal`,
					"Ask an operator with the approve grant to decide (ADR-0094).",
					requestId,
				),
			],
		};
	const result = await ledger.decide(subject, approve, by, ctx);
	emitMetric(telemetry, {
		name: PROMOTION_METRIC.approvalDecided,
		atMs: ctx.now(),
		attributes: { tenant, outcome: result.ok ? result.value : "refused" },
	});
	return result;
}

export function createA2HApprover(d: A2HApproverDeps): HumanApprover {
	const ledger = createApprovalLedger(d);
	const channel = d.channel ?? "a2h";
	return {
		async request(input, ctx) {
			const subject = subjectOrThrow(input.subject);
			await ledger.request(subject, input.expiresAtMs, ctx);
			const handoff: JsonObject = {
				requestId: input.subject,
				summary: input.summary,
				obligations: [...input.obligations],
				expiresAt: iso(input.expiresAtMs),
				answer: "PromotionService.approve or HumanApprover.decide",
			};
			try {
				await d.notify.notify(
					{ channel, subject: input.subject, body: handoff },
					ctx,
				);
			} catch {
				// The request is journaled; the handoff is re-sent by the next request call.
			}
			emitMetric(d.telemetry, {
				name: PROMOTION_METRIC.approvalRequested,
				atMs: ctx.now(),
				attributes: { tenant: d.tenant, approver: "a2h" },
			});
			return { requestId: input.subject };
		},
		async status(requestId) {
			const subject = parseApprovalSubject(requestId);
			return subject ? ledger.status(subject) : "denied";
		},
		decide({ requestId, approve }, ctx) {
			return authorizedDecision(
				d.authorizer,
				ledger,
				requestId,
				approve,
				principalName(ctx.principal),
				ctx,
				d.telemetry,
				d.tenant,
			);
		},
	};
}

export type WebhookApproverDeps = Readonly<{
	store: DurableEventStore;
	tenant: string;
	now: () => number;
	http: HttpTransport;
	/** Where approval requests are POSTed (CloudEvents structured mode). */
	endpoint: string;
	/** Where the approver POSTs its signed answer (served by the CD service). */
	callbackUrl: string;
	source: string;
	secrets: Readonly<{ resolver: CredentialResolver; ref: string }>;
	authorizer: CdAuthorizer;
	telemetry: TelemetrySink;
}>;

export interface WebhookApprover extends ApprovalPort {
	/**
	 * Signed callback: `{ token, decision: "approved" | "denied", approver }`.
	 * The decision is recorded as the authenticated caller principal; the body's
	 * `approver` is recorded as an unverified claim.
	 */
	callback(request: FeedRequest, ctx: CdContext): Promise<FeedResponse>;
}

function b64url(text: string): string {
	return Buffer.from(text, "utf8").toString("base64url");
}

function respond(status: number, body: JsonObject): FeedResponse {
	return {
		status,
		headers: { "content-type": "application/json" },
		body: new TextEncoder().encode(JSON.stringify(body)),
	};
}

export function createWebhookApprover(d: WebhookApproverDeps): WebhookApprover {
	const ledger = createApprovalLedger(d);

	async function key(): Promise<string> {
		const resolved = await d.secrets.resolver.resolve(
			d.secrets.ref,
			"cd.approval.webhook",
		);
		const secret = resolved.secret ?? resolved.value ?? "";
		if (secret === "") throw new Error("approval webhook secret is empty");
		return secret;
	}

	async function sign(payload: string): Promise<string> {
		return createHmac("sha256", await key())
			.update(payload)
			.digest("base64url");
	}

	return {
		async request(input, ctx) {
			const subject = subjectOrThrow(input.subject);
			await ledger.request(subject, input.expiresAtMs, ctx);
			const payload = b64url(
				JSON.stringify({
					requestId: input.subject,
					expiresAtMs: input.expiresAtMs,
				}),
			);
			const token = `${payload}.${await sign(payload)}`;
			const event = {
				specversion: "1.0",
				id: `${input.subject}#${input.expiresAtMs}`,
				source: d.source,
				type: APPROVAL_REQUESTED_TYPE,
				subject: input.subject,
				time: iso(ctx.now()),
				datacontenttype: "application/json",
				data: {
					requestId: input.subject,
					summary: input.summary,
					obligations: [...input.obligations],
					expiresAt: iso(input.expiresAtMs),
					callback: { url: d.callbackUrl, token },
				},
			};
			const response = await d.http({
				method: "POST",
				url: d.endpoint,
				headers: {
					"content-type": "application/cloudevents+json; charset=utf-8",
				},
				body: JSON.stringify(event),
				timeoutMs: 5_000,
				maxResponseBytes: 65_536,
			});
			emitMetric(d.telemetry, {
				name: PROMOTION_METRIC.approvalRequested,
				atMs: ctx.now(),
				attributes: {
					tenant: d.tenant,
					approver: "webhook",
					status: String(response.status),
				},
			});
			if (response.status < 200 || response.status >= 300)
				throw new Error(`approval endpoint answered ${response.status}`);
			return { requestId: input.subject };
		},
		async status(requestId) {
			const subject = parseApprovalSubject(requestId);
			return subject ? ledger.status(subject) : "denied";
		},
		async callback(request, ctx) {
			if (request.method !== "POST")
				return respond(405, { error: "method-not-allowed" });
			let parsed: unknown;
			try {
				parsed = JSON.parse(new TextDecoder().decode(request.body));
			} catch {
				return respond(400, { error: "body-not-json" });
			}
			if (!isJsonObject(parsed))
				return respond(400, { error: "body-not-object" });
			const token = isText(parsed.token) ? String(parsed.token) : "";
			const decision = parsed.decision;
			const approver = isText(parsed.approver) ? String(parsed.approver) : "";
			if ((decision !== "approved" && decision !== "denied") || approver === "")
				return respond(400, { error: "decision-and-approver-required" });
			const dot = token.lastIndexOf(".");
			if (dot <= 0)
				return respond(401, { error: APPROVAL_REASON.signatureInvalid });
			const payload = token.slice(0, dot);
			const expected = Buffer.from(await sign(payload));
			const given = Buffer.from(token.slice(dot + 1));
			if (expected.length !== given.length || !timingSafeEqual(expected, given))
				return respond(401, { error: APPROVAL_REASON.signatureInvalid });
			let claims: unknown;
			try {
				claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
			} catch {
				return respond(401, { error: APPROVAL_REASON.signatureInvalid });
			}
			if (
				!isJsonObject(claims) ||
				!isText(claims.requestId) ||
				!isNumber(claims.expiresAtMs)
			)
				return respond(401, { error: APPROVAL_REASON.signatureInvalid });
			if (ctx.now() >= Number(claims.expiresAtMs))
				return respond(410, { error: APPROVAL_REASON.expired });
			const result = await authorizedDecision(
				d.authorizer,
				ledger,
				String(claims.requestId),
				decision === "approved",
				// The decider is the authenticated caller; the body's approver
				// is self-asserted by whoever holds the token, so it is kept
				// only as an explicitly unverified claim.
				`webhook:${principalName(ctx.principal)} unverified-approver=${approver}`,
				ctx,
				d.telemetry,
				d.tenant,
			);
			if (!result.ok) {
				const code = result.reasons[0]?.code ?? APPROVAL_REASON.unknownRequest;
				const status =
					code === APPROVAL_REASON.alreadyDecided
						? 409
						: code === APPROVAL_REASON.expired
							? 410
							: code === APPROVAL_REASON.unauthorized
								? 403
								: 404;
				return respond(status, { error: code });
			}
			return respond(200, {
				requestId: String(claims.requestId),
				status: result.value,
			});
		},
	};
}
