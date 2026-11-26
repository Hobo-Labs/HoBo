import { createHash } from "node:crypto";
import { evaluatePolicyPack, type PolicyPack } from "@hobo/contracts";
import type {
	EventEnvelope,
	EventStore,
	JsonObject,
	JsonValue,
	PrincipalRef,
} from "@hobo/core";
import type {
	RunbookDiagnosis as RunbookDiagnosisRecord,
	RunbookExecutionResult as RunbookExecutionRecord,
} from "./_generated/sdk_pb.js";
import type { RunbookDeclaration, RunbookFixStep } from "./runbook.js";
import { RUNBOOK_SCHEMA } from "./schema.js";

// Domain views retain the generated record field family while keeping evidence
// parsed as JSON and statuses narrowed at this execution boundary.
export type RunbookDiagnosis = Readonly<
	Pick<RunbookDiagnosisRecord, "conditions">
> & { readonly evidence: JsonValue };
export type RunbookExecutionResult = Readonly<
	Pick<RunbookExecutionRecord, "executionId" | "reason">
> & {
	readonly status: "completed" | "blocked" | "unmatched";
	readonly completedActions: readonly string[];
};
/** An action owns its actual effect and an independently observed postcondition. */
export interface RunbookAction {
	execute(args: RunbookFixStep["args"], executionId: string): Promise<void>;
	verify(
		args: RunbookFixStep["args"],
		executionId: string,
	): Promise<{ readonly satisfied: boolean; readonly evidence: JsonValue }>;
}
export interface RunbookExecutionOptions {
	readonly store: EventStore;
	readonly tenant: string;
	readonly actor: PrincipalRef;
	readonly executionId: string;
	readonly incident: { readonly alert: string; readonly severity: string };
	readonly queries: Readonly<Record<string, () => Promise<RunbookDiagnosis>>>;
	readonly actions: Readonly<Record<string, RunbookAction>>;
	readonly policyPack: PolicyPack;
	/** Verifies the exact approval in the host's authorization plane, never defaults to allow. */
	readonly authorizeApproval?: (input: {
		readonly executionId: string;
		readonly action: string;
		readonly actor: PrincipalRef;
	}) => Promise<boolean>;
}
export class RunbookExecutionError extends Error {
	readonly code: string;
	constructor(code: string, message: string) {
		super(message);
		this.name = "RunbookExecutionError";
		this.code = code;
	}
}

function severityMatches(floor: string | undefined, actual: string): boolean {
	if (floor === undefined) return true;
	const expected = /^(>=)?SEV([0-9])$/u.exec(floor);
	const received = /^SEV([0-9])$/u.exec(actual);
	if (!expected || !received)
		throw new RunbookExecutionError(
			"SDK_RUNBOOK_SEVERITY_INVALID",
			"Severity must be SEV0 through SEV9, with an optional >= floor",
		);
	// Lower severity numbers denote greater impact.
	return expected[1]
		? Number(received[1]) <= Number(expected[2])
		: received[1] === expected[2];
}
const tagOf = Object.prototype.toString;
function isString(value: JsonValue | undefined): value is string {
	return tagOf.call(value) === "[object String]";
}
function eventData(event: EventEnvelope): JsonObject {
	const json: JsonValue = JSON.parse(JSON.stringify(event.data));
	return object(json);
}
function object(value: JsonValue | undefined): JsonObject {
	if (tagOf.call(value) === "[object Object]") {
		// SAFETY: event-store JSON payloads are parsed at this event boundary.
		return value as JsonObject;
	}
	throw new RunbookExecutionError(
		"SDK_RUNBOOK_EVENT_INVALID",
		"Runbook event payload must be an object",
	);
}
function stringList(value: JsonValue | undefined): string[] {
	if (!Array.isArray(value) || value.some((entry) => !isString(entry)))
		throw new RunbookExecutionError(
			"SDK_RUNBOOK_EVENT_INVALID",
			"Expected string array in runbook projection",
		);
	// SAFETY: every array item was checked at the persisted event boundary.
	return value as string[];
}

/** Execute declared diagnosis and verified remediation through a replayable EventStore actor. */
export async function executeRunbook(
	declaration: RunbookDeclaration,
	options: RunbookExecutionOptions,
): Promise<RunbookExecutionResult> {
	if (
		declaration.schema !== RUNBOOK_SCHEMA ||
		options.executionId.trim() === "" ||
		options.tenant.trim() === ""
	)
		throw new RunbookExecutionError(
			"SDK_RUNBOOK_INPUT_INVALID",
			"Runbook schema, execution id and tenant are required",
		);
	const stream = `sdk-runbook:${JSON.stringify([options.tenant, options.executionId])}`;
	const digest = createHash("sha256")
		.update(JSON.stringify(declaration))
		.digest("hex");
	let seq = 0;
	let triggered = false;
	const diagnosed: string[] = [];
	const diagnosedQueries = new Set<string>();
	const completed: string[] = [];
	const started = new Set<string>();
	for await (const event of options.store.read(stream)) {
		seq = event.seq;
		if (event.tenant !== options.tenant)
			throw new RunbookExecutionError(
				"SDK_RUNBOOK_TENANT_MISMATCH",
				"Execution stream belongs to another tenant",
			);
		if (event.type === "policy.Decided") continue;
		const data = eventData(event);
		const detail = object(data.detail);
		if (event.type === "runbook.Triggered") {
			if (
				detail.digest !== digest ||
				detail.alert !== options.incident.alert ||
				detail.severity !== options.incident.severity
			)
				throw new RunbookExecutionError(
					"SDK_RUNBOOK_REPLAY_MISMATCH",
					"Execution id is already bound to another runbook or incident",
				);
			triggered = true;
		}
		if (event.type === "runbook.Diagnosed") {
			diagnosed.push(...stringList(detail.conditions));
			if (isString(data.step)) diagnosedQueries.add(data.step);
		}
		if (event.type === "runbook.RemediationStarted" && isString(data.step))
			started.add(data.step);
		if (event.type === "runbook.RemediationCompleted" && isString(data.step))
			completed.push(data.step);
		if (event.type === "runbook.Completed")
			return {
				executionId: options.executionId,
				status: "completed",
				completedActions: completed,
				reason: "replayed-completed",
			};
	}
	const append = async (
		type: string,
		step: string,
		status: string,
		detail: JsonObject,
	): Promise<void> => {
		const result = await options.store.append(
			stream,
			[
				{
					type,
					data: {
						executionId: options.executionId,
						kind: "runbook",
						step,
						status,
						detail,
					},
				},
			],
			{ expectedSeq: seq, tenant: options.tenant, actor: options.actor },
		);
		seq = result.appended.at(-1)?.seq ?? seq;
	};
	if (
		options.incident.alert !== declaration.on.alert ||
		!severityMatches(declaration.on.severity, options.incident.severity)
	)
		return {
			executionId: options.executionId,
			status: "unmatched",
			completedActions: [],
			reason: "trigger-does-not-match",
		};
	if (!triggered)
		await append("runbook.Triggered", "trigger", "started", {
			digest,
			alert: options.incident.alert,
			severity: options.incident.severity,
		});
	for (const query of declaration.diagnose) {
		if (diagnosedQueries.has(query)) continue;
		const read = options.queries[query];
		if (!read)
			throw new RunbookExecutionError(
				"SDK_RUNBOOK_QUERY_MISSING",
				`No read-only diagnosis implementation registered for ${query}`,
			);
		const result = await read();
		if (
			result.conditions.some(
				(condition) => !isString(condition) || condition === "",
			)
		)
			throw new RunbookExecutionError(
				"SDK_RUNBOOK_DIAGNOSIS_INVALID",
				"Diagnosis must return named conditions",
			);
		diagnosed.push(...result.conditions);
		await append("runbook.Diagnosed", query, "observed", {
			conditions: [...result.conditions],
			evidence: result.evidence,
		});
	}
	let selected = 0;
	for (const [index, fix] of declaration.fix.entries()) {
		if (!diagnosed.includes(fix.when)) continue;
		selected++;
		const key = `${declaration.name}:${index}:${fix.do}`;
		if (completed.includes(key)) continue;
		const action = options.actions[fix.do];
		if (!action)
			throw new RunbookExecutionError(
				"SDK_RUNBOOK_ACTION_MISSING",
				`No verified remediation implementation registered for ${fix.do}`,
			);
		const request = {
			subject: { kind: options.actor.kind, id: options.actor.id },
			action: fix.do,
			resource: { kind: "runbook", id: declaration.name },
			phase: "apply",
			context: { executionId: options.executionId, condition: fix.when },
		};
		const policy = evaluatePolicyPack({ request, pack: options.policyPack });
		const policyAppend = await options.store.append(
			stream,
			[
				{
					type: "policy.Decided",
					data: policy.decision,
					meta: { executionId: options.executionId, step: key },
				},
			],
			{ expectedSeq: seq, tenant: options.tenant, actor: options.actor },
		);
		seq = policyAppend.appended.at(-1)?.seq ?? seq;
		const effect = policy.decision.effect;
		if (effect !== "allow" && effect !== "require-approval") {
			await append("runbook.FixBlocked", key, "blocked", {
				reason: `policy-${effect}`,
			});
			return {
				executionId: options.executionId,
				status: "blocked",
				completedActions: completed,
				reason: `policy-${effect}`,
			};
		}
		if (
			(fix.gate === "require-approval" || effect === "require-approval") &&
			!(await options.authorizeApproval?.({
				executionId: options.executionId,
				action: key,
				actor: options.actor,
			}))
		) {
			await append("runbook.FixBlocked", key, "blocked", {
				reason: "approval-required",
			});
			return {
				executionId: options.executionId,
				status: "blocked",
				completedActions: completed,
				reason: "approval-required",
			};
		}
		if (started.has(key)) {
			const observed = await action.verify(fix.args, options.executionId);
			if (!observed.satisfied)
				throw new RunbookExecutionError(
					"SDK_RUNBOOK_EFFECT_AMBIGUOUS",
					"An interrupted effect is not verified; refusing to repeat a possibly committed mutation",
				);
			await append("runbook.RemediationCompleted", key, "verified", {
				evidence: observed.evidence,
				recovered: true,
			});
			completed.push(key);
			continue;
		}
		await append("runbook.RemediationStarted", key, "started", {});
		try {
			await action.execute(fix.args, options.executionId);
			const observed = await action.verify(fix.args, options.executionId);
			if (!observed.satisfied)
				throw new RunbookExecutionError(
					"SDK_RUNBOOK_EFFECT_UNVERIFIED",
					"Remediation returned without satisfying its observed postcondition",
				);
			await append("runbook.RemediationCompleted", key, "verified", {
				evidence: observed.evidence,
			});
			completed.push(key);
		} catch (error) {
			await append("runbook.Failed", key, "failed", {
				code:
					error instanceof RunbookExecutionError
						? error.code
						: "SDK_RUNBOOK_EFFECT_FAILED",
			});
			throw error;
		}
	}
	if (selected === 0) {
		await append("runbook.FixBlocked", "classification", "blocked", {
			reason: "no-matching-fix",
		});
		return {
			executionId: options.executionId,
			status: "blocked",
			completedActions: completed,
			reason: "no-matching-fix",
		};
	}
	await append("runbook.Completed", "complete", "completed", {
		completedActions: completed,
	});
	await options.store.snapshot(
		stream,
		{
			completedActions: completed,
			status: "completed",
			executionId: options.executionId,
		},
		seq,
	);
	return {
		executionId: options.executionId,
		status: "completed",
		completedActions: completed,
		reason: "verified",
	};
}
