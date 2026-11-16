import { isAbsolute } from "node:path";
import { clone, create } from "@bufbuild/protobuf";
import { AlchemyContext } from "alchemy";
import * as Alchemist from "alchemy/Alchemist";
import type * as Stack from "alchemy/Stack";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import type * as Layer from "effect/Layer";
import {
	type ResourceScope,
	type Target,
	TargetSchema,
} from "./_generated/alchemy_iac_pb.js";
import { AlchemyIacError, digestData, inspectAlchemyPlan } from "./plan.js";
import type {
	FinancialExpectation,
	FinancialPlan,
	FinancialPort,
	HeldFinancialDecision,
	IacDiff,
	IacDriftReport,
	IacProgram,
	IacProvider,
} from "./port.js";

export type { ResourceScope, Target } from "./_generated/alchemy_iac_pb.js";
export {
	ResourceScopeSchema,
	TargetSchema,
} from "./_generated/alchemy_iac_pb.js";
export { AlchemyIacError } from "./plan.js";
export type {
	FinancialDecision,
	FinancialExpectation,
	FinancialPlan,
	FinancialPort,
	HeldFinancialDecision,
	IacDiff,
	IacDriftReport,
	IacProgram,
	IacProvider,
} from "./port.js";

export type AlchemyTargetInput = Omit<Target, "$typeName" | "resources"> & {
	readonly resources: readonly Omit<ResourceScope, "$typeName">[];
};

export function alchemyTarget(input: AlchemyTargetInput): Target {
	return create(TargetSchema, { ...input, resources: [...input.resources] });
}

export interface AlchemyIacProviderOptions<
	Output,
	Requirements,
	Assessment extends object,
> {
	readonly stack: Stack.ConfiguredStack<Output, Requirements>;
	readonly target: Target;
	/** A host-supplied runtime layer, including any credentials and execution services. */
	readonly runtimeLayer: Layer.Layer<
		Alchemist.Services | Requirements,
		unknown,
		never
	>;
	readonly runtimeDirectory: string;
	readonly financial: FinancialPort<Assessment>;
}

export interface AlchemyIacProvider<Assessment extends object>
	extends IacProvider {
	/** A plan-scoped assessment. Ranking this result does not reserve a budget. */
	assessPricing(program: IacProgram): Promise<Assessment & { diff: IacDiff }>;
	/** Includes the admission receipt needed for budget reconciliation. */
	applyWithAdmission(
		program: IacProgram,
		requestId?: string,
		expected?: FinancialExpectation,
	): Promise<{
		outputs: Record<string, string>;
		admission: HeldFinancialDecision;
	}>;
	destroyWithAdmission(
		program: IacProgram,
		requestId?: string,
		expected?: FinancialExpectation,
	): Promise<{ admission: HeldFinancialDecision }>;
}

function name(value: string): boolean {
	return (
		value.length > 0 &&
		value.length <= 200 &&
		value.trim() === value &&
		!/[\p{Cc}]/u.test(value)
	);
}

function reservationName(value: string): boolean {
	return (
		value.length > 0 &&
		value.length <= 204 &&
		value.trim() === value &&
		!/[\p{Cc}]/u.test(value)
	);
}

// HoBo's IaC port exposes bounded string-valued outputs. Never silently drop
// outputs after a provider has run: an unrepresentable result needs recovery.
/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-runtime-typeof -- SAFETY: this parser checks the untrusted provider output before returning bounded string-valued data. */
function readOutputs(value: unknown): Record<string, string> | undefined {
	try {
		if (typeof value !== "object" || value === null || Array.isArray(value))
			return undefined;
		const prototype = Object.getPrototypeOf(value);
		if (prototype !== Object.prototype && prototype !== null) return undefined;
		if (Object.getOwnPropertySymbols(value).length !== 0) return undefined;
		const descriptors = Object.getOwnPropertyDescriptors(value);
		const keys = Object.keys(descriptors);
		if (keys.length > 256) return undefined;
		const entries: [string, string][] = [];
		let size = 0;
		for (const key of keys) {
			const descriptor = descriptors[key];
			if (
				!name(key) ||
				descriptor === undefined ||
				!descriptor.enumerable ||
				!("value" in descriptor) ||
				typeof descriptor.value !== "string" ||
				descriptor.value.length > 65_536
			)
				return undefined;
			size += key.length + descriptor.value.length;
			if (size > 1_048_576) return undefined;
			entries.push([key, descriptor.value]);
		}
		return Object.fromEntries(entries);
	} catch {
		return undefined;
	}
}
/* oxlint-enable anti-slop/no-unknown-parameters, anti-slop/no-runtime-typeof */

/** An external adapter. The host must execute trusted stack code in its sandbox. */
export function createAlchemyIacProvider<
	Output,
	Requirements,
	Assessment extends object,
>(
	options: AlchemyIacProviderOptions<Output, Requirements, Assessment>,
): AlchemyIacProvider<Assessment> {
	const target = clone(TargetSchema, options.target);
	if (
		!isAbsolute(options.runtimeDirectory) ||
		options.stack.stackName !== target.stackName ||
		![
			target.targetId,
			target.tenantId,
			target.stackName,
			target.stage,
			target.programResourceId,
			target.inventoryEvidenceRef,
		].every(name) ||
		!/^sha256:[a-f0-9]{64}$/u.test(target.sourceDigest) ||
		target.resources.length === 0 ||
		target.resources.length > 256 ||
		target.resources.some(
			(entry) =>
				![
					entry.resourceId,
					entry.resourceType,
					entry.providerId,
					entry.providerAccountRef,
					entry.productId,
				].every(name),
		) ||
		new Set(target.resources.map((entry) => entry.resourceId)).size !==
			target.resources.length
	) {
		throw new AlchemyIacError(
			"TARGET_INVALID",
			"a bounded target, complete resource scopes, source digest and absolute runtime directory are required",
		);
	}
	const previews = new Map<string, string>();
	const claimed = new Map<string, string>();
	const checkProgram = (program: IacProgram): string => {
		if (
			![
				program.programId,
				program.deploymentId,
				program.resourceId,
				program.provider,
				program.driver,
				program.stackName,
			].every(name) ||
			program.resourceId !== target.programResourceId ||
			program.stackName !== target.stackName ||
			!["preview", "apply", "destroy"].includes(program.action)
		) {
			throw new AlchemyIacError(
				"PROGRAM_SCOPE_MISMATCH",
				"program does not match the configured target",
			);
		}
		return digestData({
			programId: program.programId,
			deploymentId: program.deploymentId,
			resourceId: program.resourceId,
			provider: program.provider,
			driver: program.driver,
			stackName: program.stackName,
			operation: program.action === "destroy" ? "destroy" : "deploy",
			targetId: target.targetId,
			tenantId: target.tenantId,
		});
	};
	const run = async <A>(
		effect: Effect.Effect<
			A,
			unknown,
			Alchemist.Services | Requirements | import("effect/Scope").Scope
		>,
	): Promise<A> => {
		const supplied = Effect.scoped(
			Effect.provide(effect, options.runtimeLayer).pipe(
				Effect.provideService(AlchemyContext, {
					dotAlchemy: options.runtimeDirectory,
					dev: false,
					adopt: false,
				}),
			),
		);
		// SAFETY: the runtime layer and AlchemyContext supply the declared services, and scoped supplies Scope.
		const complete = supplied as Effect.Effect<A, unknown, never>;
		return Effect.runPromise(complete);
	};
	const planned = (program: IacProgram) =>
		program.action === "destroy"
			? Alchemist.plan({
					stack: options.stack,
					stage: target.stage,
					operation: "destroy",
				})
			: Alchemist.plan({
					stack: options.stack,
					stage: target.stage,
					operation: "deploy",
				});
	const financialInputs = (
		digest: string,
		program: IacProgram,
	): FinancialPlan => ({
		targetId: target.targetId,
		tenantId: target.tenantId,
		planDigest: digest,
		operation: program.action === "destroy" ? "destroy" : "deploy",
		evidenceRef: target.inventoryEvidenceRef,
		resources: target.resources.map(
			({ resourceId, providerId, providerAccountRef, productId }) => ({
				resourceId,
				providerId,
				providerAccountRef,
				productId,
			}),
		),
	});
	const markUncertain = async (reservationId: string): Promise<void> => {
		try {
			await options.financial.uncertain(reservationId);
		} catch {
			/* preserve the durable hold */
		}
	};
	const assessPricing: AlchemyIacProvider<Assessment>["assessPricing"] = async (
		program,
	) => {
		const key = checkProgram(program);
		if (!previews.has(key) && previews.size >= 128)
			throw new AlchemyIacError(
				"PREVIEW_LIMIT",
				"provider preview capacity reached",
			);
		const result = await run(
			Effect.gen(function* () {
				const plan = yield* planned(program);
				try {
					return {
						ok: true as const,
						inspected: inspectAlchemyPlan(plan, target),
					};
				} catch (error) {
					return { ok: false as const, error };
				}
			}),
		);
		if (!result.ok) throw result.error;
		previews.set(key, result.inspected.digest);
		return {
			...options.financial.assess(
				financialInputs(result.inspected.digest, program),
			),
			diff: {
				summary: `${result.inspected.changes} planned resource changes`,
				changes: result.inspected.changes,
			},
		};
	};
	const preview = async (program: IacProgram): Promise<IacDiff> =>
		(await assessPricing(program)).diff;
	const execute = async (
		program: IacProgram,
		requestedId?: string,
		expected?: FinancialExpectation,
	): Promise<{
		outputs: Record<string, string>;
		admission: HeldFinancialDecision;
	}> => {
		const key = checkProgram(program);
		const requestId = requestedId ?? key;
		if (!name(requestId))
			throw new AlchemyIacError(
				"REQUEST_INVALID",
				"a bounded admission request id is required",
			);
		if (program.action === "preview")
			throw new AlchemyIacError(
				"PREVIEW_ONLY",
				"preview programs cannot be applied",
			);
		const priorReservation = claimed.get(key);
		if (priorReservation !== undefined)
			throw new AlchemyIacError(
				"EXECUTION_ALREADY_CLAIMED",
				"execution has already been claimed",
				undefined,
				priorReservation,
			);
		const previewDigest = previews.get(key);
		if (previewDigest === undefined)
			throw new AlchemyIacError(
				"PREVIEW_REQUIRED",
				"preview this program before applying it",
			);
		let heldReservation: string | undefined;
		let result:
			| { error: unknown }
			| { outputs: Record<string, string>; admission: HeldFinancialDecision };
		try {
			result = await run(
				Effect.gen(function* () {
					const plan = yield* planned(program);
					let inspected: ReturnType<typeof inspectAlchemyPlan>;
					try {
						inspected = inspectAlchemyPlan(plan, target);
					} catch (error) {
						return { error };
					}
					if (inspected.digest !== previewDigest)
						return {
							error: new AlchemyIacError(
								"PLAN_CHANGED",
								"the plan changed after preview",
							),
						};
					const admitted = yield* Effect.promise(async () => {
						try {
							return {
								decision: await options.financial.admit(
									requestId,
									financialInputs(inspected.digest, program),
									expected,
								),
							};
						} catch {
							return {
								error: new AlchemyIacError(
									"ADMISSION_OUTCOME_UNKNOWN",
									"admission outcome must be reconciled before retry",
								),
							};
						}
					});
					if ("error" in admitted) return { error: admitted.error };
					const decision = admitted.decision;
					if (
						decision.requestId !== requestId ||
						decision.targetId !== target.targetId
					)
						return {
							error: new AlchemyIacError(
								"ADMISSION_RECEIPT_INVALID",
								"admission belongs to another request or target",
								decision,
							),
						};
					if (decision.status !== "admitted")
						return {
							error: new AlchemyIacError(
								decision.code || "ADMISSION_FAILED",
								decision.message || "target was not admitted",
								decision,
								decision.reservation !== undefined &&
									reservationName(decision.reservation.reservationId)
									? decision.reservation.reservationId
									: undefined,
							),
						};
					if (
						decision.reservation === undefined ||
						!reservationName(decision.reservation.reservationId) ||
						decision.reservation.reservationId !== `iac:${requestId}` ||
						decision.budget?.evaluation !== "allowed" ||
						decision.budget.reservation !== "held"
					) {
						const reservationId = decision.reservation?.reservationId;
						if (reservationId !== undefined && reservationName(reservationId)) {
							yield* Effect.promise(() => markUncertain(reservationId));
						}
						return {
							error: new AlchemyIacError(
								"ADMISSION_RECEIPT_INVALID",
								"admission did not establish a held budget",
								decision,
								reservationId,
							),
						};
					}
					const claimedReservationId = decision.reservation.reservationId;
					heldReservation = claimedReservationId;
					claimed.set(key, claimedReservationId);
					if (
						expected !== undefined &&
						(expected.targetId !== target.targetId ||
							expected.inventoryHash !== decision.inventoryHash ||
							expected.modelHash !== decision.modelHash ||
							expected.quoteHash !== decision.quoteHash)
					) {
						yield* Effect.promise(() => markUncertain(claimedReservationId));
						return {
							error: new AlchemyIacError(
								"ADMISSION_QUOTE_MISMATCH",
								"admission differs from the ranked pricing assessment",
								undefined,
								heldReservation,
							),
						};
					}
					try {
						if (inspectAlchemyPlan(plan, target).digest !== inspected.digest) {
							yield* Effect.promise(() => markUncertain(claimedReservationId));
							return {
								error: new AlchemyIacError(
									"PLAN_CHANGED_AFTER_ADMISSION",
									"plan changed after admission; the reservation is retained",
									undefined,
									heldReservation,
								),
							};
						}
					} catch {
						yield* Effect.promise(() => markUncertain(claimedReservationId));
						return {
							error: new AlchemyIacError(
								"PLAN_UNINSPECTABLE_AFTER_ADMISSION",
								"plan cannot be checked after admission; the reservation is retained",
								undefined,
								heldReservation,
							),
						};
					}
					const outcome = yield* Effect.exit(Alchemist.apply(plan));
					if (Exit.isFailure(outcome)) {
						yield* Effect.promise(() => markUncertain(claimedReservationId));
						return {
							error: new AlchemyIacError(
								"APPLY_OUTCOME_UNKNOWN",
								"provider outcome is unknown; the budget reservation is retained",
								undefined,
								heldReservation,
							),
						};
					}
					const outputs =
						program.action === "destroy" ? {} : readOutputs(outcome.value);
					if (outputs === undefined)
						return {
							error: new AlchemyIacError(
								"APPLY_OUTPUT_UNREPRESENTABLE",
								"the provider completed, but its outputs do not fit HoBo's bounded string output contract; the budget reservation is retained",
								decision,
								heldReservation,
							),
						};
					return {
						outputs,
						admission: {
							...decision,
							budget: {
								evaluation: "allowed" as const,
								reservation: "held" as const,
							},
							reservation: { reservationId: claimedReservationId },
						},
					};
				}),
			);
		} catch (error) {
			if (heldReservation !== undefined) {
				await markUncertain(heldReservation);
				throw new AlchemyIacError(
					"APPLY_OUTCOME_UNKNOWN",
					"provider or runtime outcome is unknown; the reservation is retained",
					undefined,
					heldReservation,
				);
			}
			throw error;
		}
		if ("error" in result) throw result.error;
		return result;
	};
	const destroyWithAdmission: AlchemyIacProvider<Assessment>["destroyWithAdmission"] =
		async (program, requestId, expected) => {
			if (program.action !== "destroy")
				throw new AlchemyIacError(
					"PROGRAM_SCOPE_MISMATCH",
					"destroy requires a destroy program",
				);
			const { admission } = await execute(program, requestId, expected);
			return { admission };
		};
	return {
		id: "alchemy",
		preview,
		assessPricing,
		apply: async (program) => (await execute(program)).outputs,
		applyWithAdmission: execute,
		destroy: async (program) => {
			await destroyWithAdmission(program);
		},
		destroyWithAdmission,
		refresh: async (program): Promise<IacDriftReport> => {
			checkProgram(program);
			const scan = await run(
				Alchemist.Drift.scan({ stack: options.stack, stage: target.stage }),
			);
			const resources = new Map(
				scan.resources.map((entry) => [entry.fqn, entry]),
			);
			if (
				resources.size !== target.resources.length ||
				scan.resources.length !== resources.size ||
				target.resources.some(
					(scope) =>
						resources.get(scope.resourceId)?.resourceType !==
						scope.resourceType,
				) ||
				scan.resources.some((entry) => entry.status === "skipped")
			) {
				throw new AlchemyIacError(
					"DRIFT_CHECK_INCOMPLETE",
					"not every target resource could be inspected for drift",
				);
			}
			return {
				drift: Alchemist.Drift.hasDrift(scan),
				observed: Object.fromEntries(
					scan.resources.map((entry) => [entry.fqn, entry.status]),
				),
			};
		},
	};
}
