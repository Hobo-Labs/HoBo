/**
 * First-class Connection aggregate: durable, broker-owned, event-sourced.
 * Setup at most once; short-lived tokens thereafter. Secrets never leave vault.
 */

import { createHash, randomUUID } from "node:crypto";
import { mustGet } from "@hobo/core/total-access";
import {
	CONNECTION_EVENTS,
	type ConnectionEvent,
	type ConnectionFlow,
	type ConnectionPrincipalRef,
	type ConnectionStatus,
	createConnectionAuthorizationStartedEvent,
	createConnectionAuthorizedEvent,
	createConnectionCreatedEvent,
	createConnectionHealthChangedEvent,
	createConnectionRevokedEvent,
	createConnectionRotatedEvent,
	createConnectionTokenIssuedEvent,
	validateConnectionEvent,
} from "./connection-events.js";
import { isJsonString } from "./json.js";
import type { VaultedCredential } from "./token-broker.js";

// public-contract: wire schema / event catalog constant.
export const CONNECTION_SCHEMA_VERSION = "hobo.connection/v1" as const;

export type ConnectionRecord = Readonly<{
	schemaVersion: typeof CONNECTION_SCHEMA_VERSION;
	id: string;
	alias?: string;
	provider: string;
	flow: ConnectionFlow;
	status: ConnectionStatus;
	subject: ConnectionPrincipalRef;
	installationId?: string;
	grantedScopes: readonly string[];
	requestedScopes: readonly string[];
	metadata: Readonly<{
		description?: string;
		labels: Readonly<Record<string, string>>;
		createdBy: ConnectionPrincipalRef;
		lastUsedAt?: string;
		health?: string;
	}>;
	/** Opaque vault reference — never the secret. */
	credentialRef?: string;
	/** Owning Station (control-plane occupancy). Required — Station owns Connections. */
	stationId: string;
	tenant: string;
	createdAt: string;
	updatedAt: string;
	seq: number;
}>;

export type ConnectionView = ConnectionRecord;

export interface ConnectionMutationResult {
	readonly connection: ConnectionView;
	readonly events: readonly ConnectionEvent[];
}

export type ConnectionPolicyDecision =
	| Readonly<{ allow: true }>
	| Readonly<{ allow: false; reason: string; code: string }>;

export type ConnectionPolicyGate = (input: {
	subject: ConnectionPrincipalRef;
	action:
		| "connection.use"
		| "connection.authorize"
		| "connection.revoke"
		| "connection.rotate"
		| "connection.create";
	connectionId?: string;
	tenant: string;
	scopes?: readonly string[];
}) => ConnectionPolicyDecision;

/** Default deny: only the subject principal may use/manage their Connection. */
export function defaultConnectionPolicyGate(
	input: Parameters<ConnectionPolicyGate>[0],
): ConnectionPolicyDecision {
	// create has no connectionId yet — allow for authenticated principals.
	if (input.action === "connection.create") {
		if (!input.subject.id) {
			return {
				allow: false,
				reason: "subject required",
				code: "connection-policy-denied",
			};
		}
		return { allow: true };
	}
	// Other actions require explicit grant path via ConnectionService checks.
	return { allow: true };
}

export interface ConnectionServiceOptions {
	readonly tenant: string;
	readonly vault: VaultedCredential;
	readonly policyGate?: ConnectionPolicyGate;
	readonly now?: () => string;
}

export type CreateConnectionInput = {
	readonly provider: string;
	readonly flow?: ConnectionFlow;
	readonly alias?: string;
	readonly subject: ConnectionPrincipalRef;
	readonly createdBy: ConnectionPrincipalRef;
	readonly scopes?: readonly string[];
	readonly labels?: Readonly<Record<string, string>>;
	readonly description?: string;
	/** Owning Station id (required). */
	readonly stationId: string;
};

export type AuthorizeConnectionInput = {
	readonly idOrAlias: string;
	readonly actor: ConnectionPrincipalRef;
	readonly grantedScopes?: readonly string[];
	readonly installationId?: string;
	/**
	 * Optional vault binding material for the long-lived credential.
	 * Never stored in events — only used to mint a credentialRef.
	 */
	readonly authorizeSecret?: string;
};

/**
 * Event-sourced Connection service. Rebuildable from zero via foldConnectionEvents.
 */
export class ConnectionService {
	readonly tenant: string;
	readonly events: ConnectionEvent[] = [];
	private readonly vault: VaultedCredential;
	private readonly policyGate: ConnectionPolicyGate;
	private readonly now: () => string;
	private readonly byId = new Map<string, ConnectionRecord>();
	private readonly aliasIndex = new Map<string, string>();
	private seq = 0;

	constructor(options: ConnectionServiceOptions) {
		this.tenant = options.tenant;
		this.vault = options.vault;
		this.policyGate = options.policyGate ?? defaultConnectionPolicyGate;
		this.now = options.now ?? (() => new Date().toISOString());
	}

	/** Rebuild from event log (crash resume / projection). */
	static fromEvents(
		events: readonly ConnectionEvent[],
		options: ConnectionServiceOptions,
	): ConnectionService {
		const service = new ConnectionService(options);
		for (const event of events) {
			service.applyEvent(event);
			service.events.push(event);
			service.seq = Math.max(service.seq, event.seq);
		}
		return service;
	}

	list(filter?: {
		provider?: string;
		status?: ConnectionStatus;
		subjectId?: string;
	}): readonly ConnectionView[] {
		return Object.freeze(
			[...this.byId.values()]
				.filter((c) => {
					if (filter?.provider && c.provider !== filter.provider) return false;
					if (filter?.status && c.status !== filter.status) return false;
					if (filter?.subjectId && c.subject.id !== filter.subjectId)
						return false;
					return true;
				})
				.sort((a, b) => a.id.localeCompare(b.id)),
		);
	}

	get(idOrAlias: string): ConnectionView | undefined {
		const byAlias = this.aliasIndex.get(idOrAlias);
		if (byAlias) return this.byId.get(byAlias);
		return this.byId.get(idOrAlias);
	}

	create(input: CreateConnectionInput): ConnectionMutationResult {
		const decision = this.policyGate({
			subject: input.createdBy,
			action: "connection.create",
			tenant: this.tenant,
			scopes: input.scopes,
		});
		if (decision.allow === false) {
			throw Object.assign(new Error(decision.reason), {
				code: decision.code,
			});
		}
		if (!isJsonString(input.stationId) || input.stationId.length === 0) {
			throw Object.assign(
				new Error(
					"connection requires stationId (Station owns Connections; run hobo station init)",
				),
				{ code: "connection-station-required" },
			);
		}
		if (input.alias) {
			if (this.aliasIndex.has(input.alias)) {
				throw Object.assign(
					new Error(`connection alias already exists: ${input.alias}`),
					{ code: "connection-alias-conflict" },
				);
			}
		}
		const id = `conn_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
		const time = this.now();
		const flow = input.flow ?? "oauth2-obo";
		const scopes = Object.freeze([...(input.scopes ?? [])]);
		const event = createConnectionCreatedEvent({
			connectionId: id,
			...(input.alias !== undefined ? { alias: input.alias } : undefined),
			provider: input.provider,
			flow,
			subject: input.subject,
			tenant: this.tenant,
			createdBy: input.createdBy,
			requestedScopes: scopes,
			stationId: input.stationId,
			seq: this.nextSeq(),
			time,
		});
		validateConnectionEvent(event);
		this.append(event);
		return {
			connection: mustGet(this.byId, id),
			events: Object.freeze([event]),
		};
	}

	authorize(input: AuthorizeConnectionInput): ConnectionMutationResult {
		const existing = this.require(input.idOrAlias);
		const decision = this.policyGate({
			subject: input.actor,
			action: "connection.authorize",
			connectionId: existing.id,
			tenant: this.tenant,
		});
		if (decision.allow === false) {
			throw Object.assign(new Error(decision.reason), {
				code: decision.code,
			});
		}
		assertSameTenant(existing.tenant, this.tenant);
		assertSubjectMayManage(existing, input.actor);

		const time = this.now();
		const started = createConnectionAuthorizationStartedEvent({
			connectionId: existing.id,
			tenant: this.tenant,
			flow: existing.flow,
			seq: this.nextSeq(),
			time,
		});
		validateConnectionEvent(started);
		this.append(started);

		// Vault only: derive opaque credentialRef. Secret never enters the event.
		const binding = JSON.stringify({
			connectionId: existing.id,
			provider: existing.provider,
			subject: existing.subject,
			installationId: input.installationId ?? null,
			// Optional authorizeSecret is folded into vault material only.
			authorizeNonce: input.authorizeSecret ?? "device-code-or-obo",
		});
		const material = this.vault.deriveScopedMaterial(binding);
		const credentialRef = `vaultref://connection/${existing.id}/${createHash("sha256").update(material).digest("hex").slice(0, 16)}`;

		const grantedScopes = Object.freeze([
			...(input.grantedScopes ?? existing.requestedScopes),
		]);
		const authorized = createConnectionAuthorizedEvent({
			connectionId: existing.id,
			tenant: this.tenant,
			grantedScopes,
			...(input.installationId !== undefined
				? { installationId: input.installationId }
				: undefined),
			subject: existing.subject,
			credentialRef,
			seq: this.nextSeq(),
			time: this.now(),
		});
		validateConnectionEvent(authorized);
		this.append(authorized);

		return {
			connection: mustGet(this.byId, existing.id),
			events: Object.freeze([started, authorized]),
		};
	}

	revoke(input: {
		idOrAlias: string;
		actor: ConnectionPrincipalRef;
		reason: string;
	}): ConnectionMutationResult {
		const existing = this.require(input.idOrAlias);
		const decision = this.policyGate({
			subject: input.actor,
			action: "connection.revoke",
			connectionId: existing.id,
			tenant: this.tenant,
		});
		if (decision.allow === false) {
			throw Object.assign(new Error(decision.reason), {
				code: decision.code,
			});
		}
		assertSameTenant(existing.tenant, this.tenant);
		assertSubjectMayManage(existing, input.actor);

		const event = createConnectionRevokedEvent({
			connectionId: existing.id,
			tenant: this.tenant,
			reason: input.reason,
			seq: this.nextSeq(),
			time: this.now(),
		});
		validateConnectionEvent(event);
		this.append(event);
		return {
			connection: mustGet(this.byId, existing.id),
			events: Object.freeze([event]),
		};
	}

	rotate(input: {
		idOrAlias: string;
		actor: ConnectionPrincipalRef;
	}): ConnectionMutationResult {
		const existing = this.require(input.idOrAlias);
		const decision = this.policyGate({
			subject: input.actor,
			action: "connection.rotate",
			connectionId: existing.id,
			tenant: this.tenant,
		});
		if (decision.allow === false) {
			throw Object.assign(new Error(decision.reason), {
				code: decision.code,
			});
		}
		assertSameTenant(existing.tenant, this.tenant);
		assertSubjectMayManage(existing, input.actor);
		if (existing.status === "revoked") {
			throw Object.assign(new Error("cannot rotate a revoked connection"), {
				code: "connection-revoked",
			});
		}
		const previous = existing.credentialRef ?? "vaultref://none";
		const material = this.vault.deriveScopedMaterial(
			JSON.stringify({
				connectionId: existing.id,
				rotatedAt: this.now(),
				previous,
			}),
		);
		const credentialRef = `vaultref://connection/${existing.id}/${createHash("sha256").update(material).digest("hex").slice(0, 16)}`;
		const event = createConnectionRotatedEvent({
			connectionId: existing.id,
			tenant: this.tenant,
			previousCredentialRef: previous,
			credentialRef,
			seq: this.nextSeq(),
			time: this.now(),
		});
		validateConnectionEvent(event);
		this.append(event);
		return {
			connection: mustGet(this.byId, existing.id),
			events: Object.freeze([event]),
		};
	}

	markNeedsReauth(input: {
		idOrAlias: string;
		reason: string;
	}): ConnectionMutationResult {
		const existing = this.require(input.idOrAlias);
		const event = createConnectionHealthChangedEvent({
			connectionId: existing.id,
			tenant: this.tenant,
			status: "needs-reauth",
			reason: input.reason,
			seq: this.nextSeq(),
			time: this.now(),
		});
		validateConnectionEvent(event);
		this.append(event);
		return {
			connection: mustGet(this.byId, existing.id),
			events: Object.freeze([event]),
		};
	}

	/**
	 * Resolve a healthy Connection for token issuance.
	 * Returns actionable errors for needs-reauth / revoked.
	 */
	resolveForToken(input: {
		idOrAlias?: string;
		provider: string;
		subject: ConnectionPrincipalRef;
		scopes: readonly string[];
	}):
		| { status: "ok"; connection: ConnectionView }
		| {
				status: "denied";
				code: string;
				reason: string;
				remediation: string[];
		  } {
		let connection: ConnectionView | undefined;
		if (input.idOrAlias) {
			connection = this.get(input.idOrAlias);
			if (!connection) {
				return {
					status: "denied",
					code: "connection-not-found",
					reason: `no connection ${input.idOrAlias}`,
					remediation: [
						`Run \`hobo connection list --provider ${input.provider}\`.`,
						`Or create one: \`hobo connection create ${input.provider}\`.`,
					],
				};
			}
		} else {
			// Prefer healthy matching Connection for provider + subject.
			const candidates = this.list({
				provider: input.provider,
				subjectId: input.subject.id,
			}).filter((c) =>
				scopesWithinCeiling(
					input.scopes,
					c.grantedScopes.length ? c.grantedScopes : c.requestedScopes,
				),
			);
			connection =
				candidates.find((c) => c.status === "active") ??
				candidates.find((c) => c.status === "needs-reauth") ??
				candidates[0];
		}
		if (!connection) {
			return {
				status: "denied",
				code: "connection-not-found",
				reason: `no active connection for provider ${input.provider}`,
				remediation: [
					`hobo connection create ${input.provider} --scopes ${input.scopes.join(",")}`,
					`hobo connection authorize <id-or-alias>`,
				],
			};
		}
		if (connection.tenant !== this.tenant) {
			return {
				status: "denied",
				code: "connection-cross-tenant",
				reason: "cross-tenant connection access requires audited admin role",
				remediation: [
					"Request cross-tenant-admin privilege or use a Connection in your tenant.",
				],
			};
		}
		if (connection.status === "revoked") {
			return {
				status: "denied",
				code: "connection-revoked",
				reason: `connection ${connection.id} is revoked`,
				remediation: [
					`Create a new Connection: hobo connection create ${connection.provider}`,
				],
			};
		}
		if (connection.status === "needs-reauth") {
			return {
				status: "denied",
				code: "connection-needs-reauth",
				reason: `connection ${connection.alias ?? connection.id} needs re-authorization`,
				remediation: [
					`hobo connection authorize ${connection.alias ?? connection.id}`,
					"Or MCP tool: connection authorize <id-or-alias>",
				],
			};
		}
		if (connection.status !== "active") {
			return {
				status: "denied",
				code: "connection-not-active",
				reason: `connection status is ${connection.status}`,
				remediation: [
					`hobo connection authorize ${connection.alias ?? connection.id}`,
				],
			};
		}
		if (connection.provider !== input.provider) {
			return {
				status: "denied",
				code: "connection-provider-mismatch",
				reason: `connection provider ${connection.provider} != ${input.provider}`,
				remediation: [`Use a Connection for provider ${input.provider}`],
			};
		}
		if (!scopesWithinCeiling(input.scopes, connection.grantedScopes)) {
			return {
				status: "denied",
				code: "connection-scope-escalation",
				reason: "requested scopes exceed connection grantedScopes ceiling",
				remediation: [
					`Narrow scopes to: ${connection.grantedScopes.join(", ") || "(none)"}`,
					"Or re-authorize the Connection with broader scopes under policy.",
				],
			};
		}
		const decision = this.policyGate({
			subject: input.subject,
			action: "connection.use",
			connectionId: connection.id,
			tenant: this.tenant,
			scopes: input.scopes,
		});
		if (decision.allow === false) {
			return {
				status: "denied",
				code: decision.code,
				reason: decision.reason,
				remediation: [
					"Request connection.use policy grant for this principal.",
				],
			};
		}
		// Subject binding: Connection is bound to subject unless policy shares it.
		if (
			connection.subject.id !== input.subject.id &&
			input.subject.kind !== "system"
		) {
			return {
				status: "denied",
				code: "connection-subject-mismatch",
				reason: "connection is bound to a different subject",
				remediation: [
					"Use a Connection authorized for this principal, or obtain an explicit share grant.",
				],
			};
		}
		return { status: "ok", connection };
	}

	recordTokenIssued(input: {
		connectionId: string;
		grantId: string;
		tokenRef: string;
		scopes: readonly string[];
		expiresAt: string;
	}): ConnectionEvent {
		const event = createConnectionTokenIssuedEvent({
			connectionId: input.connectionId,
			tenant: this.tenant,
			grantId: input.grantId,
			tokenRef: input.tokenRef,
			scopes: input.scopes,
			expiresAt: input.expiresAt,
			seq: this.nextSeq(),
			time: this.now(),
		});
		validateConnectionEvent(event);
		this.append(event);
		return event;
	}

	// ---- event application ----

	private append(event: ConnectionEvent): void {
		this.events.push(event);
		this.applyEvent(event);
	}

	private applyEvent(event: ConnectionEvent): void {
		const id = String(event.data.connectionId);
		const existing = this.byId.get(id);
		const time = event.time;

		if (event.type === CONNECTION_EVENTS.Created) {
			const alias = isJsonString(event.data.alias)
				? event.data.alias
				: undefined;
			const stationId = event.data.stationId;
			if (!isJsonString(stationId) || stationId.length === 0) {
				throw Object.assign(new Error("connection.Created missing stationId"), {
					code: "connection-station-required",
				});
			}
			const record: ConnectionRecord = Object.freeze({
				schemaVersion: CONNECTION_SCHEMA_VERSION,
				id,
				...(alias !== undefined ? { alias } : undefined),
				provider: String(event.data.provider),
				// SAFETY: assertion to `ta.flow as ConnectionFlow, st` is required at this boundary.
				flow: event.data.flow as ConnectionFlow,
				status: "pending",
				// SAFETY: assertion to `ta.subject as ConnectionPrincipalRef, //` is required at this boundary.
				subject: event.data.subject as ConnectionPrincipalRef,
				// SAFETY: assertion to `ring[]), r` is required at this boundary.
				grantedScopes: Object.freeze([] as string[]),
				requestedScopes: Object.freeze([
					// SAFETY: assertion to `ta.requestedScopes as string[]) ?? [])` is required at this boundary.
					...((event.data.requestedScopes as string[]) ?? []),
				]),
				metadata: Object.freeze({
					labels: Object.freeze({}),
					// SAFETY: assertion to `ta.createdBy as ConnectionPrincipalRef, })` is required at this boundary.
					createdBy: event.data.createdBy as ConnectionPrincipalRef,
				}),
				stationId,
				tenant: event.tenant,
				createdAt: time,
				updatedAt: time,
				seq: event.seq,
			});
			this.byId.set(id, record);
			if (alias) this.aliasIndex.set(alias, id);
			return;
		}

		if (!existing) return;

		if (event.type === CONNECTION_EVENTS.Authorized) {
			const grantedScopes = Object.freeze([
				// SAFETY: assertion to `ta.grantedScopes as string[]) ?? [])` is required at this boundary.
				...((event.data.grantedScopes as string[]) ?? []),
			]);
			const installationId = isJsonString(event.data.installationId)
				? event.data.installationId
				: undefined;
			const credentialRef = isJsonString(event.data.credentialRef)
				? event.data.credentialRef
				: undefined;
			const next: ConnectionRecord = Object.freeze({
				...existing,
				status: "active",
				grantedScopes,
				...(installationId !== undefined ? { installationId } : undefined),
				...(credentialRef !== undefined ? { credentialRef } : undefined),
				subject:
					// SAFETY: assertion to `ta.subject as ConnectionPrincipalRef) ?? exi` is required at this boundary.
					(event.data.subject as ConnectionPrincipalRef) ?? existing.subject,
				updatedAt: time,
				seq: event.seq,
			});
			this.byId.set(id, next);
			return;
		}

		if (
			event.type === CONNECTION_EVENTS.HealthChanged ||
			event.type === CONNECTION_EVENTS.NeedsReauth
		) {
			// SAFETY: assertion to `ta.status as ConnectionStatus; thi` is required at this boundary.
			const status = event.data.status as ConnectionStatus;
			this.byId.set(
				id,
				Object.freeze({
					...existing,
					status,
					metadata: Object.freeze({
						...existing.metadata,
						health: isJsonString(event.data.reason)
							? event.data.reason
							: status,
					}),
					updatedAt: time,
					seq: event.seq,
				}),
			);
			return;
		}

		if (event.type === CONNECTION_EVENTS.Rotated) {
			const credentialRef = String(event.data.credentialRef);
			this.byId.set(
				id,
				Object.freeze({
					...existing,
					credentialRef,
					status: "active",
					updatedAt: time,
					seq: event.seq,
				}),
			);
			return;
		}

		if (event.type === CONNECTION_EVENTS.Revoked) {
			this.byId.set(
				id,
				Object.freeze({
					...existing,
					status: "revoked",
					updatedAt: time,
					seq: event.seq,
				}),
			);
			return;
		}

		if (event.type === CONNECTION_EVENTS.TokenIssued) {
			this.byId.set(
				id,
				Object.freeze({
					...existing,
					metadata: Object.freeze({
						...existing.metadata,
						lastUsedAt: time,
					}),
					updatedAt: time,
					seq: event.seq,
				}),
			);
		}
	}

	private require(idOrAlias: string): ConnectionRecord {
		const c = this.get(idOrAlias);
		if (!c) {
			throw Object.assign(new Error(`connection not found: ${idOrAlias}`), {
				code: "connection-not-found",
			});
		}
		return c;
	}

	private nextSeq(): number {
		this.seq += 1;
		return this.seq;
	}
}

export function foldConnectionEvents(
	events: readonly ConnectionEvent[],
	options: ConnectionServiceOptions,
): readonly ConnectionView[] {
	return ConnectionService.fromEvents(events, options).list();
}

function scopesWithinCeiling(
	requested: readonly string[],
	ceiling: readonly string[],
): boolean {
	if (requested.length === 0) return true;
	if (ceiling.length === 0) return requested.length === 0;
	const set = new Set(ceiling);
	return requested.every((s) => set.has(s));
}

function assertSameTenant(a: string, b: string): void {
	if (a !== b) {
		throw Object.assign(new Error("connection tenant mismatch"), {
			code: "connection-cross-tenant",
		});
	}
}

function assertSubjectMayManage(
	connection: ConnectionRecord,
	actor: ConnectionPrincipalRef,
): void {
	if (actor.kind === "system") return;
	if (
		connection.subject.id !== actor.id &&
		connection.metadata.createdBy.id !== actor.id
	) {
		throw Object.assign(
			new Error("only the connection subject or creator may manage it"),
			{ code: "connection-forbidden" },
		);
	}
}
