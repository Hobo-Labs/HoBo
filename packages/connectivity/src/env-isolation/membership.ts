/**
 * High-integrity control-plane env membership.
 * Isolation-critical env: tags cannot be self-assigned by clients.
 *
 * A membership bound to a device (`nodeId`) is a HoBo Fleet member
 * (ADR-0182): it counts only while that member is `ACTIVE` in the fleet
 * registry, as last read by `refresh()`. A suspended, revoked or unknown
 * member, or any device membership when no registry is given, is absent.
 */
import { type MemberId, MemberState, type RegistryView } from "@hobo/fleet";
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

// public-contract: env membership record schema.
export const ENV_MEMBERSHIP_SCHEMA = "hobo.env-membership/v1" as const;

export type EnvMembership = Readonly<{
	schemaVersion: typeof ENV_MEMBERSHIP_SCHEMA;
	id: string;
	principalId: string;
	/** The fleet member (device) this membership is bound to. */
	nodeId?: MemberId;
	isolationClass: IsolationClass;
	assignedAt: string;
	assignedBy: string;
	expiresAt?: string;
	dualControlRequired: boolean;
	dualControlApprovers: readonly string[];
	/** Client-supplied env: tags alone never set this true. */
	controlPlaneGated: true;
}>;

export type AssignMembershipInput = Readonly<{
	principalId: string;
	isolationClass: IsolationClass;
	assignedBy: string;
	nodeId?: MemberId;
	expiresAt?: string;
	dualControlApprovers?: readonly string[];
	/** Second approver for production dual control. */
	secondApprover?: string;
	now?: string;
}>;

export class EnvMembershipService {
	private readonly members = new Map<string, EnvMembership>();
	/** Device members last read ACTIVE from the registry. */
	private readonly activeNodes = new Set<MemberId>();
	readonly events: AccessEvent[] = [];
	private readonly now: () => string;
	private readonly tenant: string;
	private readonly registry: RegistryView | undefined;
	private n = 0;

	constructor(options: {
		readonly tenant: string;
		readonly now?: () => string;
		/** The fleet registry device memberships are checked against. */
		readonly registry?: RegistryView;
	}) {
		this.tenant = options.tenant;
		this.now = options.now ?? (() => new Date().toISOString());
		this.registry = options.registry;
	}

	/**
	 * Re-reads, from the fleet registry, the state of every device a
	 * membership is bound to. A member the registry cannot answer for is not
	 * ACTIVE.
	 */
	async refresh(): Promise<void> {
		const nodes = new Set<MemberId>();
		for (const record of this.members.values())
			if (record.nodeId !== undefined) nodes.add(record.nodeId);
		const active = new Set<MemberId>();
		for (const node of nodes) {
			const record = await this.registry?.member(node).catch(() => undefined);
			if (record?.state === MemberState.ACTIVE) active.add(node);
		}
		this.activeNodes.clear();
		for (const node of active) this.activeNodes.add(node);
	}

	/**
	 * Control-plane assign. Production requires dual control (assignedBy + secondApprover).
	 * Client-side tag self-assignment is rejected by never exposing a path that sets
	 * controlPlaneGated without assignedBy from the control plane.
	 */
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
			// dual means distinct second party
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
				: // SAFETY: assertion required at this I/O or test boundary.
					Object.freeze([]),
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

	/**
	 * Lookup active membership. Expired, or bound to a device that was not
	 * ACTIVE at the last `refresh()` → absent (fail-closed).
	 * Client-supplied env:production without a record does not authorize.
	 */
	getActive(
		principalId: string,
		isolationClass: IsolationClass,
		now?: string,
	): EnvMembership | null {
		const rec = this.members.get(membershipKey(principalId, isolationClass));
		if (!rec) return null;
		if (rec.nodeId !== undefined && !this.activeNodes.has(rec.nodeId))
			return null;
		if (isExpired(rec.expiresAt, now ?? this.now())) {
			this.members.delete(membershipKey(principalId, isolationClass));
			return null;
		}
		return rec;
	}

	/**
	 * Resolve principal's active isolation class from control-plane records.
	 * Prefer production > staging > development > … for multi-membership (rare).
	 */
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

/**
 * Reject free client self-tagging for isolation-critical labels.
 * Tags may advertise intent; authorization requires control-plane membership.
 */
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
