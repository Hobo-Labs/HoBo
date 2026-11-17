/* oxlint-disable anti-slop/no-runtime-typeof, anti-slop/no-conditional-empty-object-spread, anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns -- SAFETY: this module validates runtime authority receipts and deliberately omits absent optional fields. */
/** A durable route authority must be shared by every target for the same tenant. */
export interface IacRoutePermit {
	readonly tenantId: string;
	readonly requestId: string;
	readonly targetId: string;
	readonly inventoryHash: string;
	/** Random capability; never publish it in logs or user-facing receipts. */
	readonly attemptId: string;
}

export interface IacRouteIdentity {
	readonly tenantId: string;
	readonly requestId: string;
}

export interface IacRouteOutcome {
	readonly status: "selected" | "denied" | "uncertain" | "replay";
	readonly targetId?: string;
}

type MaybePromise<T> = T | Promise<T>;
export type IacRouteClaim =
	| (IacRouteIdentity & {
			readonly status: "claimed";
			readonly claimToken: string;
	  })
	| (IacRouteIdentity & {
			readonly status: "existing";
			readonly phase: "running" | "finished";
			readonly targetId?: string;
			readonly outcome?: IacRouteOutcome;
	  });

export interface IacRouteSnapshot extends IacRouteIdentity {
	readonly phase: "running" | "finished";
	readonly outcome?: IacRouteOutcome;
	readonly attempts: readonly {
		readonly targetId: string;
		readonly inventoryHash: string;
		readonly status: "running" | "denied" | "finished";
	}[];
}

/** Host boundary: implement all mutations and checks with a shared transactional CAS. */
export interface IacRouteAuthority {
	readonly persistence: "durable-cas";
	claim(input: IacRouteIdentity): MaybePromise<IacRouteClaim>;
	inspect(input: IacRouteIdentity): MaybePromise<IacRouteSnapshot | undefined>;
	beginAttempt(
		input: IacRouteIdentity & {
			readonly claimToken: string;
			readonly targetId: string;
			readonly inventoryHash: string;
		},
	): MaybePromise<IacRoutePermit>;
	denyAttempt(
		input: IacRouteIdentity & {
			readonly claimToken: string;
			readonly permit: IacRoutePermit;
		},
	): MaybePromise<{ readonly status: "denied" }>;
	finish(
		input: IacRouteIdentity & {
			readonly claimToken: string;
			readonly outcome: IacRouteOutcome;
		},
	): MaybePromise<{
		readonly status: "finished";
		readonly outcome: IacRouteOutcome;
	}>;
	/** Atomically consume an attempt capability exactly once before admission. */
	consumeAttempt(permit: IacRoutePermit): MaybePromise<boolean>;
	verifyAttempt(permit: IacRoutePermit): MaybePromise<boolean>;
}

export interface IacRouteController {
	beginAttempt(input: {
		readonly targetId: string;
		readonly inventoryHash: string;
	}): Promise<IacRoutePermit>;
	/** Call only after a verified denial proving this attempt made no reservation and no effect. */
	denyAttempt(permit: IacRoutePermit): Promise<void>;
}

export type IacRouteExecution<T> =
	| { readonly status: "executed"; readonly value: T }
	| {
			readonly status: "uncertain" | "replay";
			readonly code: string;
			readonly targetId?: string;
	  };

export function routeName(value: string): boolean {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		value.length <= 200 &&
		value.trim() === value &&
		!/[\p{Cc}]/u.test(value)
	);
}
export function routeDigest(value: string): boolean {
	return typeof value === "string" && /^sha256:[a-f0-9]{64}$/u.test(value);
}
export function routeSecret(value: string): boolean {
	return typeof value === "string" && /^[A-Za-z0-9_-]{43}$/u.test(value);
}
function data(input: unknown, key: string): unknown {
	if (typeof input !== "object" || input === null || Array.isArray(input))
		return undefined;
	const descriptor = Object.getOwnPropertyDescriptor(input, key);
	if (descriptor === undefined) return undefined;
	if (!("value" in descriptor))
		throw new Error("authority receipt contains an accessor");
	return descriptor.value;
}
function copyPermit(
	input: unknown,
	identity: IacRouteIdentity,
	targetId: string,
	inventoryHash: string,
): IacRoutePermit | undefined {
	const tenantId = data(input, "tenantId");
	const requestId = data(input, "requestId");
	const target = data(input, "targetId");
	const inventory = data(input, "inventoryHash");
	const attemptId = data(input, "attemptId");
	if (
		tenantId !== identity.tenantId ||
		requestId !== identity.requestId ||
		target !== targetId ||
		inventory !== inventoryHash ||
		typeof attemptId !== "string" ||
		!routeSecret(attemptId)
	)
		return undefined;
	return Object.freeze({
		tenantId,
		requestId,
		targetId,
		inventoryHash,
		attemptId,
	});
}
function samePermit(left: IacRoutePermit, right: IacRoutePermit): boolean {
	return (
		left.tenantId === right.tenantId &&
		left.requestId === right.requestId &&
		left.targetId === right.targetId &&
		left.inventoryHash === right.inventoryHash &&
		left.attemptId === right.attemptId
	);
}
function copyOutcome(input: unknown): IacRouteOutcome | undefined {
	const status = data(input, "status");
	const targetId = data(input, "targetId");
	if (
		(status !== "selected" &&
			status !== "denied" &&
			status !== "uncertain" &&
			status !== "replay") ||
		(targetId !== undefined &&
			(typeof targetId !== "string" || !routeName(targetId)))
	)
		return undefined;
	return { status, ...(typeof targetId === "string" ? { targetId } : {}) };
}
function copyClaim(
	input: unknown,
	identity: IacRouteIdentity,
): IacRouteClaim | undefined {
	if (
		data(input, "tenantId") !== identity.tenantId ||
		data(input, "requestId") !== identity.requestId
	)
		return undefined;
	const status = data(input, "status");
	if (status === "claimed") {
		const claimToken = data(input, "claimToken");
		return typeof claimToken === "string" && routeSecret(claimToken)
			? { ...identity, status, claimToken }
			: undefined;
	}
	if (status !== "existing") return undefined;
	const phase = data(input, "phase");
	const targetId = data(input, "targetId");
	const outcomeInput = data(input, "outcome");
	const outcome =
		outcomeInput === undefined ? undefined : copyOutcome(outcomeInput);
	if (
		(phase !== "running" && phase !== "finished") ||
		(targetId !== undefined &&
			(typeof targetId !== "string" || !routeName(targetId))) ||
		(phase === "running" && outcomeInput !== undefined) ||
		(phase === "finished" && outcome === undefined) ||
		(outcome?.targetId !== undefined && outcome.targetId !== targetId)
	)
		return undefined;
	return {
		...identity,
		status,
		phase,
		...(typeof targetId === "string" ? { targetId } : {}),
		...(outcome === undefined ? {} : { outcome }),
	};
}

/** Claim the entire logical route before any target or policy callback runs. */
export async function runIacRoute<T>(input: {
	readonly authority: IacRouteAuthority;
	readonly tenantId: string;
	readonly requestId: string;
	readonly run: (
		route: IacRouteController,
	) => Promise<{ readonly value: T; readonly outcome: IacRouteOutcome }>;
}): Promise<IacRouteExecution<T>> {
	const identity = Object.freeze({
		tenantId: input.tenantId,
		requestId: input.requestId,
	});
	const authority = input.authority;
	if (
		!routeName(identity.tenantId) ||
		!routeName(identity.requestId) ||
		authority?.persistence !== "durable-cas"
	)
		return { status: "uncertain", code: "ROUTE_AUTHORITY_UNAVAILABLE" };
	let claimed: IacRouteClaim | undefined;
	try {
		claimed = copyClaim(await authority.claim(identity), identity);
	} catch {
		return { status: "uncertain", code: "ROUTE_CLAIM_OUTCOME_UNKNOWN" };
	}
	if (claimed === undefined)
		return { status: "uncertain", code: "ROUTE_CLAIM_OUTCOME_UNKNOWN" };
	if (claimed.status === "existing") {
		const finished =
			claimed.outcome?.status === "selected" ||
			claimed.outcome?.status === "denied";
		return {
			status: finished ? "replay" : "uncertain",
			code: finished ? "ROUTE_ALREADY_FINISHED" : "ROUTE_IN_PROGRESS",
			...(claimed.targetId === undefined ? {} : { targetId: claimed.targetId }),
		};
	}
	const claimToken = claimed.claimToken;
	let current: IacRoutePermit | undefined;
	const route: IacRouteController = Object.freeze({
		async beginAttempt(attempt: {
			readonly targetId: string;
			readonly inventoryHash: string;
		}) {
			const { targetId, inventoryHash } = attempt;
			if (
				current !== undefined ||
				!routeName(targetId) ||
				!routeDigest(inventoryHash)
			)
				throw new Error("invalid route attempt");
			const permit = copyPermit(
				await authority.beginAttempt({
					...identity,
					claimToken,
					targetId,
					inventoryHash,
				}),
				identity,
				targetId,
				inventoryHash,
			);
			if (permit === undefined) throw new Error("invalid route permit");
			current = permit;
			return current;
		},
		async denyAttempt(permit: IacRoutePermit) {
			if (current === undefined || !samePermit(current, permit))
				throw new Error("route attempt mismatch");
			const denied = await authority.denyAttempt({
				...identity,
				claimToken,
				permit: current,
			});
			if (denied?.status !== "denied")
				throw new Error("invalid route denial receipt");
			current = undefined;
		},
	});
	try {
		const executed = await input.run(route);
		const outcome = copyOutcome(executed.outcome);
		if (
			outcome === undefined ||
			(outcome.status === "denied" && current !== undefined) ||
			(outcome.status === "selected" &&
				(current === undefined || outcome.targetId !== current.targetId)) ||
			(current !== undefined &&
				outcome.targetId !== undefined &&
				outcome.targetId !== current.targetId)
		)
			throw new Error("invalid route outcome");
		const value = structuredClone(executed.value);
		const finished = await authority.finish({
			...identity,
			claimToken,
			outcome,
		});
		if (
			finished?.status !== "finished" ||
			JSON.stringify(copyOutcome(finished.outcome)) !== JSON.stringify(outcome)
		)
			throw new Error("invalid route completion receipt");
		return { status: "executed", value };
	} catch {
		const outcome: IacRouteOutcome = {
			status: "uncertain",
			...(current === undefined ? {} : { targetId: current.targetId }),
		};
		try {
			await authority.finish({ ...identity, claimToken, outcome });
		} catch {
			/* A lost acknowledgement leaves the route blocked. */
		}
		return {
			status: "uncertain",
			code: "ROUTE_OUTCOME_UNKNOWN",
			...(current === undefined ? {} : { targetId: current.targetId }),
		};
	}
}

/** Bridge direct provider calls to the same authority used by ranked routes. */
export function createDirectRoutePort<Plan>(options: {
	readonly authority: IacRouteAuthority;
	/** Host-owned canonical inventory hash; it must bind the exact plan and target. */
	readonly hashInventory: (plan: Plan) => string | Promise<string>;
}) {
	const authority = options.authority;
	const hashInventory = options.hashInventory;
	return Object.freeze({
		persistence: "durable-cas" as const,
		verifyAttempt: (permit: IacRoutePermit) => authority.verifyAttempt(permit),
		consumeAttempt: (permit: IacRoutePermit) =>
			authority.consumeAttempt(permit),
		async runDirect<T>(
			input: IacRouteIdentity & {
				readonly targetId: string;
				readonly plan: Plan;
			},
			run: (attempt: {
				readonly permit: IacRoutePermit;
				readonly deny: () => Promise<void>;
			}) => Promise<{ readonly value: T; readonly outcome: IacRouteOutcome }>,
		): Promise<IacRouteExecution<T>> {
			const { tenantId, requestId, targetId } = input;
			let plan: Plan;
			try {
				plan = structuredClone(input.plan);
			} catch {
				return { status: "uncertain", code: "ROUTE_INPUT_INVALID" };
			}
			return runIacRoute({
				authority,
				tenantId,
				requestId,
				run: async (route) => {
					const inventoryHash = await hashInventory(plan);
					const permit = await route.beginAttempt({ targetId, inventoryHash });
					return run(
						Object.freeze({ permit, deny: () => route.denyAttempt(permit) }),
					);
				},
			});
		},
	});
}

/* oxlint-enable anti-slop/no-runtime-typeof, anti-slop/no-conditional-empty-object-spread, anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns */
