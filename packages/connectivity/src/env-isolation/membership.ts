import {
	ACCESS_EVENTS,
	type AccessEvent,
	createAccessEvent,
} from "./events.js";
import {
	type IsolationClass,
	isExpired,
	isShortLivedClass,
	SHORT_LIVED_MEMBERSHIP_TTL_SECONDS,
} from "./types.js";

export const ENV_MEMBERSHIP_SCHEMA = "hobo.env-membership/v1" as const;

export type EnvMembership = Readonly<{
	schemaVersion: typeof ENV_MEMBERSHIP_SCHEMA;
	id: string;
	principalId: string;
	nodeId?: string;
	isolationClass: IsolationClass;
	assignedAt: string;
	assignedBy: string;
	expiresAt?: string;
	dualControlRequired: boolean;
	dualControlApprovers: readonly string[];
	controlPlaneGated: true;
}>;

export type AssignMembershipInput = Readonly<{
	principalId: string;
	isolationClass: IsolationClass;
	assignedBy: string;
	nodeId?: string;
	expiresAt?: string;
	dualControlApprovers?: readonly string[];
	secondApprover?: string;
	now?: string;
}>;

export class EnvMembershipService {
	private readonly members = new Map<string, EnvMembership>();
	readonly events: AccessEvent[] = [];
	private readonly now: () => string;
	private readonly tenant: string;
	private n = 0;

	constructor(options: {
		readonly tenant: string;
		readonly now?: () => string;
	}) {
		this.tenant = options.tenant;
		this.now = options.now ?? (() => new Date().toISOString());
	}

	assign(input: AssignMembershipInput): EnvMembership {
		const t = input.now ?? this.now();
		const dualRequired = input.isolationClass === "production";
		const approvers = Object.freeze([
			...(input.dualControlApprovers ?? []),
			...(input.secondApprover ? [input.secondApprover] : []),
		]);
		if (dualRequired && approvers.length < 1) {
			throw Object.assign(
				new Error(
					"production env membership requires dual control (secondApprover)",
				),
				{ code: "dual-control-required" },
			);
		}
		if (dualRequired && approvers.includes(input.assignedBy)) {
			const distinct = approvers.filter((a) => a !== input.assignedBy);
			if (distinct.length < 1) {
				throw Object.assign(
					new Error("production dual control requires a distinct approver"),
					{ code: "dual-control-required" },
				);
			}
		}

		let expiresAt = input.expiresAt;
		if (!expiresAt && isShortLivedClass(input.isolationClass)) {
			expiresAt = new Date(
				Date.parse(t) + SHORT_LIVED_MEMBERSHIP_TTL_SECONDS * 1000,
			).toISOString();
		}

		this.n += 1;
		const id = `mem_${this.n}_${input.principalId.slice(0, 8)}`;
		const record: EnvMembership = Object.freeze({
			schemaVersion: ENV_MEMBERSHIP_SCHEMA,
			id,
			principalId: input.principalId,
			...(input.nodeId !== undefined ? { nodeId: input.nodeId } : undefined),
			isolationClass: input.isolationClass,
			assignedAt: t,
			assignedBy: input.assignedBy,
			...(expiresAt !== undefined ? { expiresAt } : undefined),
			dualControlRequired: dualRequired,
			dualControlApprovers: dualRequired
				? Object.freeze(approvers.filter((a) => a !== input.assignedBy))
				: Object.freeze([]),
			controlPlaneGated: true as const,
		});
		this.members.set(
			membershipKey(input.principalId, input.isolationClass),
			record,
		);
		this.events.push(
			createAccessEvent({
				type: ACCESS_EVENTS.MembershipAssigned,
				tenant: this.tenant,
				actor: input.assignedBy,
				time: t,
				data: {
					membershipId: id,
					principalId: input.principalId,
					isolationClass: input.isolationClass,
					...(expiresAt !== undefined ? { expiresAt } : undefined),
					dualControlRequired: dualRequired,
				},
			}),
		);
		return record;
	}

	revoke(input: {
		readonly principalId: string;
		readonly isolationClass: IsolationClass;
		readonly actor: string;
	}): void {
		const key = membershipKey(input.principalId, input.isolationClass);
		const prev = this.members.get(key);
		if (!prev) return;
		this.members.delete(key);
		this.events.push(
			createAccessEvent({
				type: ACCESS_EVENTS.MembershipRevoked,
				tenant: this.tenant,
				actor: input.actor,
				data: {
					membershipId: prev.id,
					principalId: input.principalId,
					isolationClass: input.isolationClass,
				},
			}),
		);
	}

	getActive(
		principalId: string,
		isolationClass: IsolationClass,
		now?: string,
	): EnvMembership | null {
		const rec = this.members.get(membershipKey(principalId, isolationClass));
		if (!rec) return null;
		if (isExpired(rec.expiresAt, now ?? this.now())) {
			this.members.delete(membershipKey(principalId, isolationClass));
			return null;
		}
		return rec;
	}

	resolveClass(principalId: string, now?: string): IsolationClass | null {
		const priority: IsolationClass[] = [
			"production",
			"staging",
			"development",
			"preview",
			"ephemeral",
			"local-dev",
		];
		for (const cls of priority) {
			if (this.getActive(principalId, cls, now)) return cls;
		}
		return null;
	}

	list(): readonly EnvMembership[] {
		return Object.freeze([...this.members.values()]);
	}
}

function membershipKey(principalId: string, cls: IsolationClass): string {
	return `${principalId}::${cls}`;
}

export function assertMembershipIntegrity(input: {
	readonly claimedClass: IsolationClass | null;
	readonly membership: EnvMembership | null;
	readonly principalId: string;
}): { ok: true } | { ok: false; code: string; reason: string } {
	if (!input.claimedClass) {
		return {
			ok: false,
			code: "env-missing",
			reason: "isolation class missing on subject",
		};
	}
	if (!input.membership) {
		return {
			ok: false,
			code: "membership-missing",
			reason: `no control-plane membership for ${input.principalId} in ${input.claimedClass}; client env: tags alone do not authorize`,
		};
	}
	if (input.membership.isolationClass !== input.claimedClass) {
		return {
			ok: false,
			code: "membership-mismatch",
			reason: "claimed isolation class does not match membership record",
		};
	}
	if (input.membership.controlPlaneGated !== true) {
		return {
			ok: false,
			code: "membership-not-gated",
			reason: "membership is not control-plane gated",
		};
	}
	return { ok: true };
}
