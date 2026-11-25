import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import {
	type CredentialAuditRow,
	credentialAuditProjection,
	type DeploymentViewRow,
	deploymentViewProjection,
	isCredentialAuditEvent,
} from "@hobo/cloud";
import type { EventEnvelope, PrincipalKind } from "@hobo/core";
import type { ConnectionEvent } from "@hobo/identity";
import { createRuntimeLocalEventStore } from "@hobo/runtime-local";

import type { ManagementContext } from "./context.js";
import { type ManagementResult, okResult } from "./result.js";

// Wrappers exposing the @hobo/cloud read-model folds through the management
// surface (HIGHBALL M2). Both are pure folds over local event sources — the log
// is authoritative, the view is derived, and NOTHING is fabricated:
//
//  * deployment.* / resource.* / match.* facts land in the composed `hobo`
//    binary's durable runtime-local event store. That store is durable under
//    HOBO_HOME only on the bare-metal yard flow
//    (`<HOBO_HOME>/yards/<name>/eventstore.sqlite`); plain `hobo up` writes to
//    an ephemeral OS temp dir that never reaches HOBO_HOME. When no yard store
//    exists we report an honest empty view with `available: false` instead of
//    inventing saga state.
//  * connection.* credential-audit facts land in the station-local connection
//    store (`<HOBO_HOME>/connections/events.jsonl`) — a real local source the
//    credential audit folds today. Yard stores may additionally hold
//    token.Granted/Used/Revoked facts from the orchestrator's broker.

/** Where deployment facts were folded from. */
export type DeploymentViewSource = "yard-eventstore" | "none";

// domain-view: parse-don't-validate derived read-model envelope; row wire form
// is owned by hobo.cloud.v1 (packages/cloud/data-models/cloud.proto).
export type DeploymentViewProjectionView = Readonly<{
	/** False when no local cloud event store exists under HOBO_HOME. */
	available: boolean;
	source: DeploymentViewSource;
	/** Yard store names folded (subdirs of `<HOBO_HOME>/yards`). */
	yards: readonly string[];
	/**
	 * Yard stores that exist but could not be read (locked or corrupt). A
	 * non-empty list means this view is PARTIAL: consumers must say so rather
	 * than render it as the whole estate.
	 */
	skippedYards: readonly string[];
	deployments: readonly DeploymentViewRow[];
	count: number;
	/** Max folded event seq (0 for the empty view). */
	seq: number;
}>;

/** Where credential-audit facts were folded from. */
export type CredentialAuditSource = "connections-store" | "yard-eventstore";

// domain-view: parse-don't-validate derived read-model envelope; row wire form
// is owned by hobo.cloud.v1 (packages/cloud/data-models/cloud.proto).
export type CredentialAuditProjectionView = Readonly<{
	/** False when no local credential event source exists under HOBO_HOME. */
	available: boolean;
	sources: readonly CredentialAuditSource[];
	rows: readonly CredentialAuditRow[];
	count: number;
	/** Max folded event seq (0 for the empty view). */
	seq: number;
}>;

function listYardStores(
	hoboHome: string,
	yard?: string,
): { name: string; dataDir: string }[] {
	const root = join(hoboHome, "yards");
	if (!existsSync(root)) return [];
	const names = yard
		? [yard]
		: readdirSync(root, { withFileTypes: true })
				.filter((entry) => entry.isDirectory())
				.map((entry) => entry.name)
				.sort();
	return names
		.map((name) => ({ name, dataDir: join(root, name) }))
		.filter(({ dataDir }) => existsSync(join(dataDir, "eventstore.sqlite")));
}

async function collectYardEvents(dataDir: string): Promise<EventEnvelope[]> {
	const store = createRuntimeLocalEventStore({ dataDir });
	try {
		const events: EventEnvelope[] = [];
		for await (const positioned of store.readAll()) {
			events.push(positioned.event);
		}
		return events;
	} finally {
		store.close();
	}
}

/**
 * Fold the local yard event store(s) into the DeploymentView saga graph
 * (per-deployment status + per-resource ResourceLifecycle). Pure read-model
 * fold, rebuildable from zero. When no local store exists the view is honestly
 * empty (`available: false`) — see the module comment for why.
 */
export async function projectDeploymentView(
	ctx: ManagementContext,
	input: { yard?: string } = {},
): Promise<ManagementResult<DeploymentViewProjectionView>> {
	const stores = listYardStores(ctx.hoboHome, input.yard);
	const yards: string[] = [];
	// A yard we could not read is NOT the same as a yard with no deployments.
	// Report it so the caller can badge the view as partial instead of drawing
	// a confident picture that is missing half the estate.
	const skipped: string[] = [];
	const events: EventEnvelope[] = [];
	for (const store of stores) {
		try {
			// push(...arr) throws RangeError past the argument limit, which a
			// long-lived yard will cross; append instead.
			for (const event of await collectYardEvents(store.dataDir)) {
				events.push(event);
			}
			yards.push(store.name);
		} catch {
			skipped.push(store.name);
		}
	}

	if (yards.length === 0) {
		return okResult(
			"deployment view: no local cloud event source (deployment facts flow once a durable yard store exists under HOBO_HOME/yards)",
			Object.freeze({
				available: false,
				source: "none" as const,
				yards: Object.freeze([]),
				skippedYards: Object.freeze([...skipped]),
				deployments: Object.freeze([]),
				count: 0,
				seq: 0,
			}),
		);
	}

	const snapshot = deploymentViewProjection.fold(events);
	const deployments = deploymentViewProjection
		.query(snapshot)
		.sort((a, b) => a.deploymentId.localeCompare(b.deploymentId));
	return okResult(
		`deployment view: ${deployments.length} deployment(s) from ${yards.length} yard store(s)`,
		Object.freeze({
			available: true,
			source: "yard-eventstore" as const,
			yards: Object.freeze([...yards]),
			skippedYards: Object.freeze([...skipped]),
			deployments: Object.freeze(deployments),
			count: deployments.length,
			seq: snapshot.seq,
		}),
	);
}

function connectionEventToEnvelope(event: ConnectionEvent): EventEnvelope {
	const connectionId =
		// oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- SAFETY: existing boundary or test contract.
		(event.data as { connectionId?: string }).connectionId ?? "unknown";
	return {
		id: event.id,
		type: event.type,
		v: 1,
		streamId: `connection:${connectionId}`,
		seq: event.seq,
		ts: event.time,
		actor: {
			// oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- SAFETY: existing boundary or test contract.
			kind: (event.actor.kind as PrincipalKind) ?? "service",
			id: event.actor.id,
		},
		tenant: event.tenant,
		correlationId: event.correlationId,
		causationId: event.causationId,
		data: event.data,
	};
}

/**
 * Fold local credential-audit facts (grant -> use -> revoke, keyed by
 * correlation) into the CredentialAudit read model. Sources: the station-local
 * connection store plus any durable yard event stores. Pure fold; empty view
 * with `available: false` when neither source exists.
 */
export async function projectCredentialAudit(
	ctx: ManagementContext,
	input: { tenant?: string; yard?: string } = {},
): Promise<ManagementResult<CredentialAuditProjectionView>> {
	const sources: CredentialAuditSource[] = [];
	const events: EventEnvelope[] = [];

	const connectionsPath = join(ctx.hoboHome, "connections", "events.jsonl");
	if (existsSync(connectionsPath)) {
		const lines = readFileSync(connectionsPath, "utf8")
			.split("\n")
			.filter(Boolean);
		events.push(
			...lines
				// oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- SAFETY: existing boundary or test contract.
				.map((line) => JSON.parse(line) as ConnectionEvent)
				.filter(
					(event) =>
						input.tenant === undefined || event.tenant === input.tenant,
				)
				.map(connectionEventToEnvelope),
		);
		sources.push("connections-store");
	}

	for (const store of listYardStores(ctx.hoboHome, input.yard)) {
		try {
			events.push(
				...(await collectYardEvents(store.dataDir)).filter(
					(event) =>
						isCredentialAuditEvent(event) &&
						(input.tenant === undefined || event.tenant === input.tenant),
				),
			);
			if (!sources.includes("yard-eventstore")) sources.push("yard-eventstore");
		} catch {
			// Locked/corrupt yard store: skip; connection-store facts still fold.
		}
	}

	if (sources.length === 0) {
		return okResult(
			"credential audit: no local credential event source (connection facts flow once a station connection exists)",
			Object.freeze({
				available: false,
				sources: Object.freeze([]),
				rows: Object.freeze([]),
				count: 0,
				seq: 0,
			}),
		);
	}

	const snapshot = credentialAuditProjection.fold(events);
	const rows = credentialAuditProjection
		.query(snapshot)
		.sort((a, b) => a.correlationId.localeCompare(b.correlationId));
	return okResult(
		`credential audit: ${rows.length} correlation(s) from ${sources.join("+")}`,
		Object.freeze({
			available: true,
			sources: Object.freeze([...sources]),
			rows: Object.freeze(rows),
			count: rows.length,
			seq: snapshot.seq,
		}),
	);
}
/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- SAFETY: event and actor payloads are narrowed at this projection boundary. */
