import {
	evaluatePolicyPack,
	type PolicyDecisionRequest,
} from "@hobo/contracts";
import type {
	EventEnvelope,
	EventStore,
	JsonObject,
	PrincipalRef,
} from "@hobo/core";
import type { ChaosDeclaration } from "./chaos.js";
import { SdkDeclarationError } from "./errors.js";
import type { SdkPolicyPack } from "./policy.js";
import { type WaiverDeclaration, waiver } from "./waiver.js";

export interface OperatorExecutionContext {
	readonly store: EventStore;
	readonly tenant: string;
	readonly actor: PrincipalRef;
	/** Roles verified by the host authentication boundary, never accepted from a method argument. */
	readonly actorRoles?: readonly string[];
	/** Action grants verified by the host authentication boundary. */
	readonly actorScopes?: readonly string[];
	readonly now: () => string;
}

async function history(
	context: OperatorExecutionContext,
	stream: string,
): Promise<EventEnvelope[]> {
	const events: EventEnvelope[] = [];
	for await (const event of context.store.read(stream)) {
		if (event.tenant !== context.tenant)
			throw new Error("SDK execution tenant mismatch");
		events.push(event);
	}
	return events;
}

async function append(
	context: OperatorExecutionContext,
	stream: string,
	type: string,
	data: JsonObject,
	expectedSeq?: number,
): Promise<void> {
	const events = await history(context, stream);
	await context.store.append(stream, [{ type, data }], {
		expectedSeq: expectedSeq ?? events.at(-1)?.seq ?? 0,
		actor: context.actor,
		tenant: context.tenant,
	});
}

export interface WaiverState {
	readonly revision: number;
	readonly decisionId: string;
	readonly status: "missing" | "requested" | "approved" | "expired" | "revoked";
	readonly requester?: string;
	readonly approvedBy?: string;
	readonly declaration?: WaiverDeclaration;
	readonly policyFingerprint?: string;
}

/** Project durable approval facts; expiry is checked on every authorization, never by a best-effort timer. */
export function replayWaiver(events: readonly EventEnvelope[]): WaiverState {
	let state: WaiverState = { decisionId: "", status: "missing", revision: 0 };
	for (const event of events) {
		// SAFETY: these event payloads are the persisted output of this module's parsed declaration boundary.
		const data = event.data as {
			decisionId: string;
			declaration: WaiverDeclaration;
			requester: string;
			approvedBy: string;
			policyFingerprint: string;
		};
		if (event.type === "policy.WaiverRequested")
			state = {
				decisionId: data.decisionId,
				revision: event.seq,
				status: "requested",
				requester: data.requester,
				declaration: data.declaration,
				policyFingerprint: data.policyFingerprint,
			};
		if (event.type === "policy.WaiverApproved")
			state = { ...state, status: "approved", approvedBy: data.approvedBy };
		if (event.type === "policy.WaiverExpired")
			state = { ...state, status: "expired" };
		if (event.type === "policy.WaiverRevoked")
			state = { ...state, status: "revoked" };
		state = { ...state, revision: event.seq };
	}
	return state;
}

function waiverPolicyFingerprint(pack: SdkPolicyPack): string {
	return JSON.stringify({
		id: pack.id,
		version: pack.version,
		mandatory: pack.mandatory,
		rules: pack.rules.map((rule) => ({
			id: rule.id,
			phase: rule.phase,
			when: rule.whenClause,
			effect: rule.effect,
		})),
	});
}

export function createWaiverService(context: OperatorExecutionContext) {
	const currentTime = () => {
		const value = Date.parse(context.now());
		if (!Number.isFinite(value))
			throw new Error("waiver authorization clock is invalid");
		return value;
	};
	const stream = (id: string) =>
		`sdk-waiver:${JSON.stringify([context.tenant, id])}`;
	async function status(decisionId: string): Promise<WaiverState> {
		let state = replayWaiver(await history(context, stream(decisionId)));
		if (
			(state.status === "requested" || state.status === "approved") &&
			state.declaration !== undefined &&
			Date.parse(state.declaration.expires) <= currentTime()
		) {
			await append(
				context,
				stream(decisionId),
				"policy.WaiverExpired",
				{
					executionId: decisionId,
					kind: "waiver",
					step: "expiry",
					status: "expired",
					decisionId,
				},
				state.revision,
			);
			state = replayWaiver(await history(context, stream(decisionId)));
		}
		return state;
	}
	return {
		status,
		async request(
			declaration: WaiverDeclaration,
			request: PolicyDecisionRequest,
			pack: SdkPolicyPack,
		): Promise<WaiverState> {
			const parsed = waiver(declaration.decisionId, declaration);
			const evaluated = evaluatePolicyPack({ request, pack });
			if (evaluated.event.id !== parsed.decisionId)
				throw new Error(
					"waiver decision id does not match the policy decision",
				);
			if (
				request.subject.id !== context.actor.id ||
				request.subject.kind !== context.actor.kind ||
				!context.actorScopes?.includes(request.action)
			)
				throw new Error("waiver cannot grant missing base access");
			if (pack.mandatory || evaluated.decision.effect !== "deny")
				throw new Error("only default policy denials can be waived");
			if (Date.parse(parsed.expires) <= currentTime())
				throw new Error("waiver expiry must be in the future");
			const existing = await status(parsed.decisionId);
			if (existing.status !== "missing")
				throw new Error("waiver request already exists");
			await append(
				context,
				stream(parsed.decisionId),
				"policy.WaiverRequested",
				{
					executionId: parsed.decisionId,
					kind: "waiver",
					step: "request",
					status: "requested",
					decisionId: parsed.decisionId,
					requester: context.actor.id,
					declaration: { ...parsed },
					policyFingerprint: waiverPolicyFingerprint(pack),
				},
				existing.revision,
			);
			return status(parsed.decisionId);
		},
		async approve(
			decisionId: string,
			approver: PrincipalRef & { readonly roles?: readonly string[] },
		): Promise<WaiverState> {
			const state = await status(decisionId);
			if (state.status !== "requested" || state.declaration === undefined)
				throw new Error("only pending, unexpired waivers can be approved");
			if (state.requester === approver.id)
				throw new Error("waiver separation of duties forbids self-approval");
			if (
				approver.id !== context.actor.id ||
				approver.kind !== context.actor.kind
			)
				throw new Error(
					"waiver approval must use the authenticated service actor",
				);
			const required = state.declaration.approver;
			const authorized = required.startsWith("role:")
				? context.actorRoles?.includes(required.slice(5)) === true
				: required === `${approver.kind}:${approver.id}` ||
					required === approver.id;
			if (!authorized) throw new Error("waiver approver is not authorized");
			await append(
				context,
				stream(decisionId),
				"policy.WaiverApproved",
				{
					executionId: decisionId,
					kind: "waiver",
					step: "approve",
					status: "approved",
					decisionId,
					approvedBy: approver.id,
				},
				state.revision,
			);
			return status(decisionId);
		},
		async revoke(decisionId: string): Promise<WaiverState> {
			const state = await status(decisionId);
			if (state.status !== "approved" && state.status !== "requested")
				throw new Error("waiver is not revocable");
			if (
				context.actor.id !== state.requester &&
				context.actor.id !== state.approvedBy
			)
				throw new Error("waiver revocation requires requester or approver");
			await append(
				context,
				stream(decisionId),
				"policy.WaiverRevoked",
				{
					executionId: decisionId,
					kind: "waiver",
					step: "revoke",
					status: "revoked",
					decisionId,
				},
				state.revision,
			);
			return status(decisionId);
		},
		async evaluate(request: PolicyDecisionRequest, pack: SdkPolicyPack) {
			const evaluated = evaluatePolicyPack({ request, pack });
			const state = await status(evaluated.event.id);
			const mayAct =
				request.subject.id === context.actor.id &&
				request.subject.kind === context.actor.kind &&
				context.actorScopes?.includes(request.action) === true;
			const approved =
				!pack.mandatory &&
				request.subject.id === state.requester &&
				request.subject.id === context.actor.id &&
				request.subject.kind === context.actor.kind &&
				context.actorScopes?.includes(request.action) === true &&
				state.status === "approved" &&
				state.policyFingerprint === waiverPolicyFingerprint(pack);
			return {
				effect: !mayAct
					? ("deny" as const)
					: approved
						? ("allow" as const)
						: evaluated.decision.effect,
				reason: !mayAct
					? "authenticated actor lacks base access"
					: approved
						? "approved unexpired default-policy waiver"
						: evaluated.decision.reason,
				state,
				evaluation: evaluated,
			};
		},
	};
}

export interface ChaosProbe {
	readonly request: Request;
	readonly expectedStatus: number;
}

export interface ChaosFaultLease {
	readonly observedCalls: () => number;
	remove(): Promise<void>;
}

export interface ChaosTarget {
	readonly id: string;
	readonly isolated: true;
	readonly scope?: "camp";
	fetch(request: Request): Promise<Response>;
	inject(fault: string): Promise<ChaosFaultLease>;
}

/** A private, process-local fault membrane. It never changes the underlying handler or any production target. */
export function createFetchChaosTarget(
	id: string,
	handler: (request: Request) => Response | Promise<Response>,
): ChaosTarget {
	let active: { fault: string; calls: number } | undefined;
	return {
		id,
		isolated: true,
		async fetch(request) {
			if (active !== undefined) {
				active.calls += 1;
				if (
					active.fault === "unavailable" ||
					active.fault === "provider-degraded"
				)
					return new Response("injected unavailable", { status: 503 });
				if (active.fault === "error")
					throw new Error("injected request failure");
				await new Promise((resolve) =>
					setTimeout(resolve, Number(active?.fault.slice("latency:".length))),
				);
			}
			return handler(request);
		},
		async inject(fault) {
			if (active !== undefined)
				throw new Error("chaos target already has an active fault");
			if (
				!["unavailable", "provider-degraded", "error"].includes(fault) &&
				!/^latency:(?:[1-9][0-9]{0,3})$/u.test(fault)
			)
				throw new Error(`unsupported fault ${fault}`);
			const injected = { fault, calls: 0 };
			active = injected;
			return {
				observedCalls: () => injected.calls,
				async remove() {
					if (active === injected) active = undefined;
				},
			};
		},
	};
}

/** An isolated Camp membrane: only registered member hosts are reachable; every injection is reverted. */
export function createCampChaosTarget(
	id: string,
	members: readonly ChaosTarget[],
): ChaosTarget {
	if (members.length === 0 || members.length > 64)
		throw new Error("chaos camp must have between 1 and 64 members");
	const targets = new Map<string, ChaosTarget>();
	for (const member of members) {
		if (
			member.isolated !== true ||
			member.scope !== undefined ||
			targets.has(member.id) ||
			!/^[a-z0-9][a-z0-9-]*$/u.test(member.id)
		)
			throw new Error(
				"chaos camp members must have unique DNS-label ids and isolated target scope",
			);
		targets.set(member.id, member);
	}
	return {
		id,
		isolated: true,
		scope: "camp",
		async fetch(request) {
			const member = targets.get(new URL(request.url).hostname);
			if (member === undefined)
				throw new Error("chaos camp refuses an undeclared target host");
			return member.fetch(request);
		},
		async inject(fault) {
			const leases: ChaosFaultLease[] = [];
			const remove = async () => {
				const settled = await Promise.allSettled(
					leases.map((lease) => lease.remove()),
				);
				const failures = settled.filter(
					(result): result is PromiseRejectedResult =>
						result.status === "rejected",
				);
				if (failures.length > 0)
					throw new AggregateError(
						failures.map((result) => result.reason),
						"chaos camp cleanup failed",
					);
			};
			try {
				for (const target of targets.values())
					leases.push(await target.inject(fault));
			} catch (error) {
				await remove();
				throw error;
			}
			return {
				observedCalls: () =>
					leases.reduce((sum, lease) => sum + lease.observedCalls(), 0),
				remove,
			};
		},
	};
}

export interface ChaosExecutionOptions extends OperatorExecutionContext {
	readonly executionId: string;
	readonly target: ChaosTarget;
	readonly pack: SdkPolicyPack;
	readonly authorization: PolicyDecisionRequest;
	readonly checks: Readonly<Record<string, ChaosProbe>>;
}

export async function executeChaosExperiment(
	declaration: ChaosDeclaration,
	options: ChaosExecutionOptions,
) {
	const stream = `sdk-chaos:${JSON.stringify([options.tenant, options.executionId])}`;
	const record = (
		type: string,
		step: string,
		status: string,
		detail: JsonObject = {},
	) =>
		append(options, stream, type, {
			executionId: options.executionId,
			kind: "chaos",
			step,
			status,
			...detail,
		});
	if ((await history(options, stream)).length > 0)
		throw new Error("chaos execution id has already been used");
	if (
		options.target.id !== declaration.inject.target ||
		options.target.isolated !== true ||
		declaration.blastRadius !== `1 ${options.target.scope ?? "target"}`
	)
		throw new Error(
			"chaos requires a matching isolated target and blast radius matching its scope",
		);
	if (
		options.authorization.subject.id !== options.actor.id ||
		options.authorization.subject.kind !== options.actor.kind ||
		options.actorScopes?.includes("chaos.execute") !== true ||
		options.authorization.action !== "chaos.execute" ||
		options.authorization.resource.id !== options.target.id
	)
		throw new Error("chaos authorization does not match actor/action/target");
	const authorization = evaluatePolicyPack({
		request: options.authorization,
		pack: options.pack,
	});
	await append(options, stream, "policy.Decided", authorization.decision, 0);
	if (authorization.decision.effect !== "allow")
		throw new Error("chaos policy did not allow execution");
	const probe = options.checks[declaration.steadyState];
	if (probe === undefined)
		throw new SdkDeclarationError(
			"chaos",
			"steadyState",
			"no executable check registered",
		);
	const abort =
		declaration.abortIf === undefined
			? undefined
			: options.checks[declaration.abortIf];
	if (declaration.abortIf !== undefined && abort === undefined)
		throw new SdkDeclarationError(
			"chaos",
			"abortIf",
			"no executable check registered",
		);
	const check = async (checkProbe: ChaosProbe) =>
		(await options.target.fetch(checkProbe.request.clone())).status ===
		checkProbe.expectedStatus;
	if (!(await check(probe))) {
		await record("chaos.Aborted", "baseline", "aborted");
		return { status: "aborted" as const, executionId: options.executionId };
	}
	await record("chaos.ExperimentStarted", "start", "running");
	let lease: ChaosFaultLease | undefined;
	let passed = false;
	let failure = "";
	try {
		lease = await options.target.inject(declaration.inject.fault);
		const held = await check(probe);
		const tripped = abort !== undefined && (await check(abort));
		if (lease.observedCalls() === 0)
			throw new Error("fault injection was not observed by a request");
		await record("chaos.FaultInjected", "inject", "observed", {
			fault: declaration.inject.fault,
			observedCalls: lease.observedCalls(),
		});
		passed = held && !tripped;
		await record(
			"chaos.SteadyStateChecked",
			"check",
			passed ? "held" : "breached",
		);
	} catch (error) {
		failure = error instanceof Error ? error.message : String(error);
	} finally {
		if (lease !== undefined) {
			await lease.remove();
			await record("chaos.FaultRemoved", "cleanup", "removed");
		}
	}
	const restored = await check(probe);
	const status =
		passed && restored ? ("completed" as const) : ("aborted" as const);
	await record(
		status === "completed" ? "chaos.ExperimentCompleted" : "chaos.Aborted",
		"complete",
		status,
		{ restored, failure },
	);
	return { status, executionId: options.executionId };
}

export async function replayChaosExecution(
	context: OperatorExecutionContext,
	executionId: string,
) {
	const events = await history(
		context,
		`sdk-chaos:${JSON.stringify([context.tenant, executionId])}`,
	);
	const terminal = events.at(-1);
	return {
		status:
			terminal?.type === "chaos.ExperimentCompleted"
				? ("completed" as const)
				: terminal?.type === "chaos.Aborted"
					? ("aborted" as const)
					: ("incomplete" as const),
		events,
	};
}
