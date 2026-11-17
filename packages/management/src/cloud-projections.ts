import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import {
	type CredentialAuditRow,
	credentialAuditProjection,
	type DeploymentViewRow,
	deploymentViewProjection,
	isCredentialAuditEvent,
} from "@hobo/cloud";
import {
	type EventEnvelope,
	type JsonObject,
	type JsonValue,
	parseEventEnvelope,
} from "@hobo/core";
import { createRuntimeLocalEventStore } from "@hobo/runtime-local";

import type { ManagementContext } from "./context.js";
import { type ManagementResult, okResult } from "./result.js";

export type DeploymentViewSource = "yard-eventstore" | "none";

// domain-view:
export type DeploymentViewProjectionView = Readonly<{
	available: boolean;
	source: DeploymentViewSource;
	yards: readonly string[];
	skippedYards: readonly string[];
	deployments: readonly DeploymentViewRow[];
	count: number;
	seq: number;
}>;

export type CredentialAuditSource =
	| "connections-store"
	| "yard-eventstore"
	| "mcp-audit";

// domain-view:
export type CredentialAuditProjectionView = Readonly<{
	available: boolean;
	sources: readonly CredentialAuditSource[];
	partial: boolean;
	skippedSources: readonly string[];
	rows: readonly CredentialAuditRow[];
	count: number;
	seq: number;
}>;

function listYardStores(
	hoboHome: string,
	yard?: string,
): { name: string; dataDir: string }[] {
	if (
		yard !== undefined &&
		(!yard || yard === "." || yard === ".." || /[/\\\0]/u.test(yard))
	)
		throw new TypeError("yard must be a directory name");
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

export async function projectDeploymentView(
	ctx: ManagementContext,
	input: { yard?: string } = {},
): Promise<ManagementResult<DeploymentViewProjectionView>> {
	const stores = listYardStores(ctx.hoboHome, input.yard);
	const yards: string[] = [];
	const skipped: string[] = [];
	const events: EventEnvelope[] = [];
	for (const store of stores) {
		try {
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

function isJsonObject(value: JsonValue | undefined): value is JsonObject {
	return (
		value !== null &&
		value !== undefined &&
		!Array.isArray(value) &&
		Object.prototype.toString.call(value) === "[object Object]"
	);
}

function isJsonString(value: JsonValue | undefined): value is string {
	return Object.prototype.toString.call(value) === "[object String]";
}

function connectionEventToEnvelope(line: string): EventEnvelope {
	const event: JsonValue = JSON.parse(line);
	if (!isJsonObject(event) || !isJsonObject(event.data))
		throw new TypeError("invalid connection audit event");
	const connectionId = isJsonString(event.data.connectionId)
		? event.data.connectionId
		: "unknown";
	return parseEventEnvelope({
		id: event.id,
		type: event.type,
		v: 1,
		streamId: `connection:${connectionId}`,
		seq: event.seq,
		ts: event.time,
		actor: event.actor,
		tenant: event.tenant,
		correlationId: event.correlationId,
		causationId: event.causationId,
		data: event.data,
	});
}

export async function projectCredentialAudit(
	ctx: ManagementContext,
	input: { tenant?: string; yard?: string } = {},
): Promise<ManagementResult<CredentialAuditProjectionView>> {
	const sources: CredentialAuditSource[] = [];
	const skippedSources: string[] = [];
	const events: EventEnvelope[] = [];

	const connectionsPath = join(ctx.hoboHome, "connections", "events.jsonl");
	if (existsSync(connectionsPath)) {
		try {
			const lines = readFileSync(connectionsPath, "utf8").split("\n");
			for (const line of lines) {
				if (!line.trim()) continue;
				try {
					const event = connectionEventToEnvelope(line);
					if (input.tenant === undefined || event.tenant === input.tenant)
						events.push(event);
				} catch {
					if (!skippedSources.includes("connections-store"))
						skippedSources.push("connections-store");
				}
			}
			sources.push("connections-store");
		} catch {
			skippedSources.push("connections-store");
		}
	}

	for (const store of listYardStores(ctx.hoboHome, input.yard)) {
		try {
			for (const event of await collectYardEvents(store.dataDir)) {
				if (
					isCredentialAuditEvent(event) &&
					(input.tenant === undefined || event.tenant === input.tenant)
				)
					events.push(event);
			}
			if (!sources.includes("yard-eventstore")) sources.push("yard-eventstore");
		} catch {
			skippedSources.push(`yard:${store.name}`);
		}
	}
	const mcpDir = join(ctx.hoboHome, "mcp-audit");
	if (existsSync(join(mcpDir, "eventstore.sqlite"))) {
		try {
			for (const event of await collectYardEvents(mcpDir)) {
				if (
					isCredentialAuditEvent(event) &&
					(input.tenant === undefined || event.tenant === input.tenant)
				)
					events.push(event);
			}
			sources.push("mcp-audit");
		} catch {
			skippedSources.push("mcp-audit");
		}
	}

	if (sources.length === 0) {
		return okResult(
			skippedSources.length > 0
				? "credential audit: local sources could not be read"
				: "credential audit: no local credential event source",
			Object.freeze({
				available: false,
				sources: Object.freeze([]),
				partial: skippedSources.length > 0,
				skippedSources: Object.freeze([...skippedSources]),
				rows: Object.freeze([]),
				count: 0,
				seq: 0,
			}),
		);
	}

	const snapshot = credentialAuditProjection.fold(events);
	const rows = credentialAuditProjection
		.query(snapshot)
		.sort(
			(a, b) =>
				(a.tenant ?? "").localeCompare(b.tenant ?? "") ||
				a.correlationId.localeCompare(b.correlationId),
		);
	return okResult(
		`credential audit: ${rows.length} correlation(s) from ${sources.join("+")}${skippedSources.length > 0 ? " (partial)" : ""}`,
		Object.freeze({
			available: true,
			sources: Object.freeze([...sources]),
			partial: skippedSources.length > 0,
			skippedSources: Object.freeze([...skippedSources]),
			rows: Object.freeze(rows),
			count: rows.length,
			seq: snapshot.seq,
		}),
	);
}
