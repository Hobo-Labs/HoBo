/**
 * Cross-env grants, elevated access capabilities, and break-glass model.
 * Network membership is never sufficient alone for elevated/production access.
 */
import {
	ACCESS_EVENTS,
	type AccessEvent,
	createAccessEvent,
} from "./events.js";
import {
	BREAK_GLASS_TTL_SECONDS,
	ELEVATED_CAPABILITY_TTL_SECONDS,
	type IsolationClass,
	isExpired,
} from "./types.js";

// public-contract: cross-env grant schema.
export const CROSS_ENV_GRANT_SCHEMA = "hobo.cross-env-grant/v1" as const;
// public-contract: elevated access capability schema.
export const ELEVATED_ACCESS_SCHEMA = "hobo.elevated-access/v1" as const;
// public-contract: break-glass grant schema.
export const BREAK_GLASS_SCHEMA = "hobo.break-glass/v1" as const;

export type CrossEnvGrant = Readonly<{
	schemaVersion: typeof CROSS_ENV_GRANT_SCHEMA;
	id: string;
	fromClass: IsolationClass;
	toClass: IsolationClass;
	principalIds: readonly string[];
	reason: string;
	issuedAt: string;
	expiresAt: string;
	issuedBy: string;
	dualControlApprovers: readonly string[];
	obligations: readonly string[];
}>;

export type ElevatedAccessCapability = Readonly<{
	schemaVersion: typeof ELEVATED_ACCESS_SCHEMA;
	id: string;
	subject: string;
	audience: string;
	isolationClass: IsolationClass;
	issuedAt: string;
	expiresAt: string;
	priorAuthnClass?: IsolationClass;
	obligations: readonly string[];
	/** Opaque token ref (JWT-SVID jti or tokenref). */
	tokenRef: string;
}>;

export type BreakGlassGrant = Readonly<{
	schemaVersion: typeof BREAK_GLASS_SCHEMA;
	id: string;
	subject: string;
	isolationClass: IsolationClass;
	reason: string;
	requestedAt: string;
	grantedAt?: string;
	expiresAt?: string;
	requester: string;
	approvers: readonly string[];
	status: "requested" | "granted" | "expired" | "reviewed";
	obligations: readonly string[];
	reviewDue?: string;
}>;

export class CrossEnvGrantStore {
	private readonly grants = new Map<string, CrossEnvGrant>();
	readonly events: AccessEvent[] = [];
	private n = 0;
	private readonly now: () => string;
	private readonly tenant: string;

	constructor(options: {
		readonly tenant: string;
		readonly now?: () => string;
	}) {
		this.tenant = options.tenant;
		this.now = options.now ?? (() => new Date().toISOString());
	}

	issue(input: {
		readonly fromClass: IsolationClass;
		readonly toClass: IsolationClass;
		readonly principalIds?: readonly string[];
		readonly reason: string;
		readonly issuedBy: string;
		readonly dualControlApprovers?: readonly string[];
		readonly ttlSeconds?: number;
		readonly obligations?: readonly string[];
	}): CrossEnvGrant {
		if (input.fromClass === input.toClass) {
			throw new TypeError("cross-env grant requires distinct classes");
		}
		const t = this.now();
		const ttl = input.ttlSeconds ?? ELEVATED_CAPABILITY_TTL_SECONDS;
		const approvers = Object.freeze([...(input.dualControlApprovers ?? [])]);
		if (input.toClass === "production" && approvers.length < 1) {
			throw Object.assign(
				new Error("production cross-env grant requires dual control approver"),
				{ code: "dual-control-required" },
			);
		}
		this.n += 1;
		const id = `xenv_${this.n}`;
		const grant: CrossEnvGrant = Object.freeze({
			schemaVersion: CROSS_ENV_GRANT_SCHEMA,
			id,
			fromClass: input.fromClass,
			toClass: input.toClass,
			principalIds: Object.freeze([...(input.principalIds ?? [])]),
			reason: input.reason,
			issuedAt: t,
			expiresAt: new Date(Date.parse(t) + ttl * 1000).toISOString(),
			issuedBy: input.issuedBy,
			dualControlApprovers: approvers,
			obligations: Object.freeze([
				...(input.obligations ?? ["audit-session", "time-bound"]),
			]),
		});
		this.grants.set(id, grant);
		this.events.push(
			createAccessEvent({
				type: ACCESS_EVENTS.CrossEnvGranted,
				tenant: this.tenant,
				actor: input.issuedBy,
				time: t,
				data: {
					grantId: id,
					fromClass: grant.fromClass,
					toClass: grant.toClass,
					expiresAt: grant.expiresAt,
					reason: grant.reason,
				},
			}),
		);
		return grant;
	}

	getActive(id: string, now?: string): CrossEnvGrant | null {
		const g = this.grants.get(id);
		if (!g) return null;
		if (isExpired(g.expiresAt, now ?? this.now())) {
			this.events.push(
				createAccessEvent({
					type: ACCESS_EVENTS.CrossEnvExpired,
					tenant: this.tenant,
					actor: "system",
					data: { grantId: id },
				}),
			);
			this.grants.delete(id);
			return null;
		}
		return g;
	}

	/** Whether a principal may cross from→to under any active grant. */
	allows(input: {
		readonly principalId: string;
		readonly fromClass: IsolationClass;
		readonly toClass: IsolationClass;
		readonly now?: string;
	}): boolean {
		const t = input.now ?? this.now();
		for (const g of this.grants.values()) {
			if (isExpired(g.expiresAt, t)) continue;
			if (g.fromClass !== input.fromClass || g.toClass !== input.toClass) {
				continue;
			}
			if (
				g.principalIds.length > 0 &&
				!g.principalIds.includes(input.principalId)
			) {
				continue;
			}
			return true;
		}
		return false;
	}
}

export class BreakGlassService {
	private readonly grants = new Map<string, BreakGlassGrant>();
	readonly events: AccessEvent[] = [];
	private n = 0;
	private readonly now: () => string;
	private readonly tenant: string;

	constructor(options: {
		readonly tenant: string;
		readonly now?: () => string;
	}) {
		this.tenant = options.tenant;
		this.now = options.now ?? (() => new Date().toISOString());
	}

	request(input: {
		readonly subject: string;
		readonly isolationClass: IsolationClass;
		readonly reason: string;
		readonly requester: string;
	}): BreakGlassGrant {
		const t = this.now();
		this.n += 1;
		const id = `bg_${this.n}`;
		const grant: BreakGlassGrant = Object.freeze({
			schemaVersion: BREAK_GLASS_SCHEMA,
			id,
			subject: input.subject,
			isolationClass: input.isolationClass,
			reason: input.reason,
			requestedAt: t,
			requester: input.requester,
			// SAFETY: assertion required at this I/O or test boundary.
			approvers: Object.freeze([] as string[]),
			status: "requested",
			obligations: Object.freeze([
				"dual-control",
				"full-session-recording",
				"auto-expiry",
				"post-incident-review",
			]),
		});
		this.grants.set(id, grant);
		this.events.push(
			createAccessEvent({
				type: ACCESS_EVENTS.BreakGlassRequested,
				tenant: this.tenant,
				actor: input.requester,
				time: t,
				data: {
					grantId: id,
					subject: input.subject,
					isolationClass: input.isolationClass,
					reason: input.reason,
				},
			}),
		);
		return grant;
	}

	/**
	 * Dual-approve break-glass. Approver must differ from requester.
	 */
	approve(input: {
		readonly grantId: string;
		readonly approver: string;
		readonly secondApprover?: string;
		readonly ttlSeconds?: number;
	}): BreakGlassGrant {
		const prev = this.grants.get(input.grantId);
		if (prev?.status !== "requested") {
			throw Object.assign(new Error("break-glass grant not requestable"), {
				code: "break-glass-invalid",
			});
		}
		if (input.approver === prev.requester) {
			throw Object.assign(
				new Error("break-glass approver must differ from requester"),
				{ code: "dual-control-required" },
			);
		}
		const approvers = Object.freeze([
			input.approver,
			...(input.secondApprover && input.secondApprover !== input.approver
				? [input.secondApprover]
				: []),
		]);
		const t = this.now();
		const ttl = input.ttlSeconds ?? BREAK_GLASS_TTL_SECONDS;
		const expiresAt = new Date(Date.parse(t) + ttl * 1000).toISOString();
		const reviewDue = new Date(Date.parse(t) + 7 * 86_400_000).toISOString();
		const granted: BreakGlassGrant = Object.freeze({
			...prev,
			status: "granted" as const,
			grantedAt: t,
			expiresAt,
			approvers,
			reviewDue,
		});
		this.grants.set(input.grantId, granted);
		this.events.push(
			createAccessEvent({
				type: ACCESS_EVENTS.BreakGlassGranted,
				tenant: this.tenant,
				actor: input.approver,
				time: t,
				data: {
					grantId: granted.id,
					subject: granted.subject,
					isolationClass: granted.isolationClass,
					expiresAt,
					approvers: [...approvers],
				},
			}),
		);
		return granted;
	}

	getActive(grantId: string, now?: string): BreakGlassGrant | null {
		const g = this.grants.get(grantId);
		if (g?.status !== "granted") return null;
		if (isExpired(g.expiresAt, now ?? this.now())) {
			const expired: BreakGlassGrant = Object.freeze({
				...g,
				status: "expired" as const,
			});
			this.grants.set(grantId, expired);
			this.events.push(
				createAccessEvent({
					type: ACCESS_EVENTS.BreakGlassExpired,
					tenant: this.tenant,
					actor: "system",
					data: { grantId },
				}),
			);
			return null;
		}
		return g;
	}

	/** Active break-glass for subject → isolationClass. */
	allows(input: {
		readonly subject: string;
		readonly isolationClass: IsolationClass;
		readonly now?: string;
	}): BreakGlassGrant | null {
		const t = input.now ?? this.now();
		for (const g of this.grants.values()) {
			if (g.status !== "granted") continue;
			if (g.subject !== input.subject) continue;
			if (g.isolationClass !== input.isolationClass) continue;
			if (isExpired(g.expiresAt, t)) continue;
			return g;
		}
		return null;
	}

	markReviewed(input: {
		readonly grantId: string;
		readonly reviewer: string;
		readonly notes?: string;
	}): BreakGlassGrant {
		const prev = this.grants.get(input.grantId);
		if (!prev) {
			throw Object.assign(new Error("break-glass grant missing"), {
				code: "break-glass-missing",
			});
		}
		const reviewed: BreakGlassGrant = Object.freeze({
			...prev,
			status: "reviewed" as const,
		});
		this.grants.set(input.grantId, reviewed);
		this.events.push(
			createAccessEvent({
				type: ACCESS_EVENTS.BreakGlassReviewed,
				tenant: this.tenant,
				actor: input.reviewer,
				data: {
					grantId: input.grantId,
					...(input.notes !== undefined ? { notes: input.notes } : undefined),
				},
			}),
		);
		return reviewed;
	}
}
