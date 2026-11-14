/** Durable cross-Yard handoff, backed by data-core's single-authority copy. */
import { createHash } from "node:crypto";
import {
	type CopyMigrationOptions,
	canonicalEncode,
	type EngineBinding,
	fenceTokenDigest,
	foldMigration,
	getPattern,
	isJsonString,
	MIGRATION_EVENTS,
	type MigrationJournal,
	type PolicyVerdict,
	parseDatasetSchema,
	runOfflineCopy,
	runSnapshotAndTail,
	type WriteFencePort,
} from "@hobo/data-core";
import type {
	DataMigrationJournal,
	MigrationFact,
} from "./migration-executor.js";

// The engine remains opaque at the Trails boundary. The existing data-engine
// SDK binding supplies the actual ports; Trails does not re-export its types.
/* oxlint-disable anti-slop/no-unknown-returns -- Trails intentionally seals the data-engine SDK boundary: concrete engine ports own their results and data-core validates and consumes them. */
export interface HandoverEngine {
	readonly declaration: Readonly<{ engine: string; fenceEnforcement: string }>;
	readonly datasets: Readonly<{
		ensureDataset: (...args: never[]) => unknown;
		describeDataset: (...args: never[]) => unknown;
	}>;
	readonly records: Readonly<{
		write: (...args: never[]) => unknown;
		read: (...args: never[]) => unknown;
	}>;
	readonly snapshot?: object;
	readonly capture?: object;
	readonly apply?: object;
	readonly verify?: object;
	readonly fence?: object;
	readonly retire?: object;
	readonly nativeTransfer?: object;
	close: (...args: never[]) => unknown;
}
/* oxlint-enable anti-slop/no-unknown-returns */

export type HandoverEndpoint = Readonly<{
	yard: string;
	provider: string;
	accountId: string;
	resourceId: string;
	engine: HandoverEngine;
}>;

export type HandoverSchema = Readonly<{
	contract: "hobo.dataset-schema/v1";
	name: string;
	version: number;
	keyFields: readonly string[];
	fields: readonly Readonly<{
		name: string;
		type:
			| "bool"
			| "int64"
			| "float64"
			| "decimal"
			| "string"
			| "bytes"
			| "timestamp"
			| "date"
			| "uuid"
			| "json"
			| "encrypted";
		nullable: boolean;
	}>[];
	open: boolean;
}>;

export type HandoverPhase =
	| "plan"
	| "gate"
	| "prepare"
	| "seed"
	| "converge"
	| "verify"
	| "shift-reads"
	| "fence-and-flip"
	| "soak"
	| "finalize";
export type HandoverRole =
	| "source"
	| "target"
	| "event-log"
	| "staging-artifact"
	| "relay"
	| "capture-log"
	| "rollback-snapshot"
	| "retiring-source"
	| "target-event-log";
export type HandoverVerdict = Readonly<{
	contract: "hobo.data-migration-policy-verdict/v1";
	ok: boolean;
	classification: "public" | "internal" | "pii" | "phi" | "pci" | "secret";
	findings: readonly Readonly<{
		code: string;
		point: string;
		role: HandoverRole | "path";
		detail: string;
		remediation: string;
	}>[];
	roles: readonly HandoverRole[];
	custodyDigest: `sha256:${string}`;
	evaluatedAt: string;
}>;

export type DataHandoverResult = Readonly<{
	migrationId: string;
	status: "completed" | "held" | "rolled-back" | "failed";
	phase: HandoverPhase;
	reason?: string;
	facts: readonly MigrationFact[];
}>;

export type DataHandoverInput = Readonly<{
	tenant: string;
	campId: string;
	setId: string;
	source: HandoverEndpoint;
	target: HandoverEndpoint;
	schema: HandoverSchema;
	scope: Readonly<{ dataset: string; tenant: string }>;
	journal: DataMigrationJournal;
	clock: () => string;
	/** Reauthorize the exact producer and consumer bindings, Junctions and Broker hold. */
	revalidate: (phase: HandoverPhase) => void | Promise<void>;
	policy: (phase: HandoverPhase) => HandoverVerdict | Promise<HandoverVerdict>;
	/** The router must durably compare-and-set on migrationId and head. */
	flipAuthority: (
		input: Readonly<{
			migrationId: string;
			head: number;
			direction: "to-source" | "to-target";
			fenceToken: string;
		}>,
	) => void | Promise<void>;
	/** Retirement occurs only when the independently observed soak says finalize. */
	soakDecision: () =>
		| "finalize"
		| "rollback"
		| "hold"
		| Promise<"finalize" | "rollback" | "hold">;
	pattern?: "snapshot-and-tail" | "offline-copy";
	pauseAfter?: HandoverPhase;
}>;

function endpointIdentity(endpoint: HandoverEndpoint): readonly string[] {
	return [
		endpoint.yard,
		endpoint.provider,
		endpoint.accountId,
		endpoint.resourceId,
		endpoint.engine.declaration.engine,
	];
}

/**
 * Engine calls that only stop, release or undo, never start a forward effect.
 * They run without reauthorization: a lapsed authorization must not keep a
 * store fenced, a subscription pinned or a transfer delivering.
 */
const UNWINDING_CALLS: ReadonlySet<string> = new Set([
	"close",
	"fence.release",
	"capture.stop",
	"nativeTransfer.pause",
	"nativeTransfer.stop",
	"schema.restore",
]);

/**
 * Facts that record a stop, a compensation or a rollback, or a raise that
 * already happened. Appending one starts nothing, so it is never gated.
 */
const UNWINDING_FACTS: ReadonlySet<string> = new Set([
	MIGRATION_EVENTS.Held,
	MIGRATION_EVENTS.Failed,
	MIGRATION_EVENTS.FenceRaised,
	MIGRATION_EVENTS.RollbackDecided,
	MIGRATION_EVENTS.RolledBack,
]);

/* oxlint-disable anti-slop/no-known-value-widening, anti-slop/no-object-parameters, anti-slop/no-reflect-get, anti-slop/no-reflect-apply, anti-slop/no-runtime-typeof -- The SDK engine has multiple independently owned dynamic ports. This proxy forwards every method with its original receiver and reauthorizes each forward dispatch; an empty target also respects frozen-port Proxy invariants. Data-core validates the engine contract. */
function guardedEngine(
	engine: HandoverEngine,
	revalidate: (call: string) => Promise<void>,
): EngineBinding {
	// Every engine call, including native operations, passes `revalidate`
	// immediately before dispatch, which reauthorizes forward calls only. An
	// already-dispatched request still needs the engine's own fence and the
	// router's compare-and-set to reject a stale writer.
	const wrap = (value: object, port: string): object =>
		new Proxy(
			{},
			{
				get(_target, key) {
					const member = Reflect.get(value, key, value);
					if (typeof member !== "function") return member;
					return async (...args: never[]) => {
						await revalidate(`${port}.${String(key)}`);
						return Reflect.apply(member, value, args);
					};
				},
			},
		);
	const wrapped = new Proxy(
		{},
		{
			get(_target, key) {
				const member = Reflect.get(engine, key, engine);
				if (key === "declaration") return member;
				if (typeof member === "function")
					return async (...args: never[]) => {
						await revalidate(String(key));
						return Reflect.apply(member, engine, args);
					};
				return member !== null &&
					typeof member === "object" &&
					!Array.isArray(member)
					? wrap(member, String(key))
					: member;
			},
		},
	);
	// SAFETY: engine is an enrolled data-engine SDK binding; its opaque ports
	// are checked and consumed by data-core. The proxy preserves each call.
	return wrapped as EngineBinding;
}
/* oxlint-enable anti-slop/no-known-value-widening, anti-slop/no-object-parameters, anti-slop/no-reflect-get, anti-slop/no-reflect-apply, anti-slop/no-runtime-typeof */

function prepared(input: DataHandoverInput) {
	const source = endpointIdentity(input.source),
		target = endpointIdentity(input.target);
	if (
		![input.tenant, input.campId, input.setId, ...source, ...target].every(
			(part) =>
				isJsonString(part) &&
				part.length > 0 &&
				part.length <= 512 &&
				!/\p{Cc}/u.test(part),
		) ||
		JSON.stringify(source) === JSON.stringify(target) ||
		(input.source.provider === input.target.provider &&
			input.source.accountId === input.target.accountId &&
			input.source.resourceId === input.target.resourceId) ||
		(input.source.yard === input.target.yard &&
			(input.source.provider !== input.target.provider ||
				input.source.accountId !== input.target.accountId)) ||
		input.scope.dataset !== input.schema.name ||
		(input.pattern !== undefined &&
			input.pattern !== "snapshot-and-tail" &&
			input.pattern !== "offline-copy") ||
		!(input.clock instanceof Function) ||
		!(input.journal?.load instanceof Function) ||
		!(input.journal?.append instanceof Function) ||
		!(input.revalidate instanceof Function) ||
		!(input.policy instanceof Function) ||
		!(input.flipAuthority instanceof Function) ||
		!(input.soakDecision instanceof Function)
	)
		throw new Error(
			"data handover requires distinct scoped endpoints, a durable journal and authorized routing",
		);
	// Parse and snapshot the schema and scope before any asynchronous work, so
	// a caller cannot change the dataset after its identity was calculated.
	const schema = parseDatasetSchema(structuredClone(input.schema));
	const scope = Object.freeze({ ...input.scope });
	const pattern = input.pattern ?? "snapshot-and-tail";
	const material = canonicalEncode({
		tenant: input.tenant,
		campId: input.campId,
		setId: input.setId,
		source,
		target,
		schema: {
			contract: schema.contract,
			name: schema.name,
			version: schema.version,
			keyFields: schema.keyFields,
			fields: schema.fields.map((field) => ({
				name: field.name,
				type: field.type,
				nullable: field.nullable,
			})),
			open: schema.open,
		},
		scope,
		pattern,
	});
	const migrationId = `trail_${createHash("sha256").update(material).digest("hex")}`;
	return { source, target, schema, scope, pattern, migrationId };
}

/** Read the journal without starting or resuming any migration effects. */
export async function inspectDataHandover(input: DataHandoverInput): Promise<
	Readonly<{
		migrationId: string;
		status: "new" | "running" | "cutover-held" | "completed" | "blocked";
	}>
> {
	const { migrationId, pattern } = prepared(input);
	await input.revalidate("plan");
	const facts = await input.journal.load(migrationId);
	await input.revalidate("plan");
	if (facts.length === 0) return { migrationId, status: "new" };
	if (
		facts[0]?.type !== "migration.Planned" ||
		facts[0].data.pattern !== pattern ||
		facts.some((fact) => fact.data.migrationId !== migrationId)
	)
		throw new Error(
			"data handover journal is outside the approved migration scope",
		);
	// `migration.Planned` records plan; only the subsequent phases emit
	// `PhaseApplied` facts.
	const phases = getPattern(pattern).phases.slice(1);
	let last = -1;
	for (const fact of facts) {
		if (fact.type !== "migration.PhaseApplied") continue;
		const phase = phases.find((candidate) => candidate === fact.data.phase);
		const index = phase === undefined ? -1 : phases.indexOf(phase);
		if (index !== last + 1)
			throw new Error("data handover journal has an invalid phase sequence");
		last = index;
	}
	// SAFETY: the Trails journal is the same JSON fact structure used by data-core.
	const state = foldMigration(
		migrationId,
		facts as Parameters<typeof foldMigration>[1],
	);
	const cutovers = facts.filter((fact) => fact.type === "migration.CutOver");
	if (state.status === "completed") {
		if (
			facts.at(-1)?.type !== "migration.Completed" ||
			facts.filter((fact) => fact.type === "migration.Completed").length !==
				1 ||
			!state.cutOver ||
			state.rollbackDecided ||
			cutovers.length !== 1 ||
			!state.completedPhases.includes("finalize") ||
			last !== phases.length - 1
		)
			throw new Error(
				"completed handover lacks a verified cutover and finalization",
			);
		return { migrationId, status: "completed" };
	}
	if (
		state.status === "held" &&
		state.heldAt === "soak" &&
		state.cutOver &&
		!state.rollbackDecided &&
		cutovers.length === 1 &&
		state.completedPhases.includes("fence-and-flip")
	)
		return { migrationId, status: "cutover-held" };
	if (
		state.status === "rolled-back" ||
		state.status === "failed" ||
		state.rollbackDecided
	)
		return { migrationId, status: "blocked" };
	return { migrationId, status: "running" };
}

/**
 * Authorization lapsed while the source was fenced for a cutover that was
 * never decided. Data-core compensates only a failed verification, so a lapse
 * would leave the source refusing writes until a later authorized run. Give
 * authority back the way data-core does: journal the compensating hold, as a
 * compare-and-set, then release the fence this migration proves it raised.
 */
async function releaseLapsedFence(
	input: DataHandoverInput,
	migrationId: string,
	pattern: "snapshot-and-tail" | "offline-copy",
	scope: Readonly<{ dataset: string; tenant: string }>,
): Promise<void> {
	// SAFETY: the SDK binding's fence port is data-core's WriteFencePort.
	const fence = input.source.engine.fence as WriteFencePort | undefined;
	if (fence === undefined) return;
	const facts = await input.journal.load(migrationId);
	// SAFETY: the Trails journal is the same JSON fact structure used by data-core.
	const state = foldMigration(
		migrationId,
		facts as Parameters<typeof foldMigration>[1],
	);
	if (
		state.cutOver ||
		state.rollbackDecided ||
		state.completedPhases.includes("fence-and-flip")
	)
		return;
	let raised = -1;
	facts.forEach((fact, index) => {
		if (
			fact.type === MIGRATION_EVENTS.FenceRaised &&
			fact.data.side === "source" &&
			fact.data.phase === "fence-and-flip"
		)
			raised = index;
	});
	if (raised < 0 || !(await fence.status(scope)).fenced) return;
	// Raising a raised fence answers its token and changes nothing.
	const { fenceToken } = await fence.raise({
		scope,
		reason: `migration ${migrationId}`,
	});
	// A fence this migration cannot prove it raised is left as it stands.
	if (fenceTokenDigest(fenceToken) !== facts[raised]?.data.fenceTokenDigest)
		return;
	if (
		!facts
			.slice(raised + 1)
			.some(
				(fact) =>
					fact.type === MIGRATION_EVENTS.Held && fact.data.compensated === true,
			)
	)
		await input.journal.append(
			migrationId,
			{
				type: MIGRATION_EVENTS.Held,
				data: {
					migrationId,
					phase: pattern === "offline-copy" ? "prepare" : "shift-reads",
					reason:
						"authorization lapsed under the fence; the source remains the authority",
					compensated: true,
					heldAt: input.clock(),
				},
			},
			facts.length,
		);
	await fence.release({ scope, fenceToken });
}

/** Execute or resume the same scoped migration; a different placement gets a different journal. */
export async function executeDataHandover(
	input: DataHandoverInput,
): Promise<DataHandoverResult> {
	const { source, target, schema, scope, pattern, migrationId } =
		prepared(input);
	let phase: HandoverPhase = "plan";
	// A journaled rollback binds (data-core never puts it to policy again):
	// what is left of it hands authority back and releases fences, so none of
	// it waits on reauthorization.
	let unwinding = false;
	let lapsed = false;
	const revalidate = async () => {
		if (
			input.source.engine.declaration.engine !== source[4] ||
			input.target.engine.declaration.engine !== target[4]
		)
			throw new Error("data handover engine identity changed");
		try {
			await input.revalidate(phase);
		} catch (error) {
			lapsed = true;
			throw error;
		}
	};
	const forward = async (call: string) => {
		if (!unwinding && !UNWINDING_CALLS.has(call)) await revalidate();
	};
	const journal: MigrationJournal = {
		async load(id) {
			await revalidate();
			// SAFETY: the Trails journal is the same compare-and-set fact port;
			// committed facts do not contain undefined JSON values.
			const facts = (await input.journal.load(id)) as Awaited<
				ReturnType<MigrationJournal["load"]>
			>;
			if (foldMigration(id, facts).rollbackDecided) unwinding = true;
			return facts;
		},
		async append(id, fact, expectedCount) {
			if (!unwinding && !UNWINDING_FACTS.has(fact.type)) await revalidate();
			await input.journal.append(id, fact, expectedCount);
			if (fact.type === MIGRATION_EVENTS.RollbackDecided) unwinding = true;
		},
	};
	const options: CopyMigrationOptions = {
		runtime: {
			migrationId,
			journal,
			clock: input.clock,
			async policy(next) {
				phase = next;
				await revalidate();
				// SAFETY: the host supplies a data-core custody verdict; these
				// locally declared fields are its structural mirror.
				const verdict = (await input.policy(next)) as PolicyVerdict;
				await revalidate();
				return verdict;
			},
			...(input.pauseAfter === undefined
				? undefined
				: { pauseAfter: input.pauseAfter }),
		},
		source: guardedEngine(input.source.engine, forward),
		target: guardedEngine(input.target.engine, forward),
		schema,
		scope,
		plan: {
			source: source.join("/"),
			target: target.join("/"),
			dataset: scope.dataset,
		},
		async flipAuthority(flip) {
			// Handing authority back to the source only ever finishes a rollback.
			if (flip.direction !== "to-source") await forward("flipAuthority");
			await input.flipAuthority(flip);
		},
		async soakDecision() {
			await revalidate();
			return input.soakDecision();
		},
	};
	let result: Awaited<ReturnType<typeof runSnapshotAndTail>>;
	try {
		result =
			pattern === "offline-copy"
				? await runOfflineCopy(options)
				: await runSnapshotAndTail(options);
	} catch (error) {
		if (!lapsed) throw error;
		try {
			await releaseLapsedFence(input, migrationId, pattern, scope);
		} catch (compensation) {
			throw new AggregateError(
				[error, compensation],
				"data handover authorization lapsed and its fence compensation did not complete",
			);
		}
		throw error;
	}
	return Object.freeze({
		migrationId,
		status: result.status,
		phase: result.phase,
		...(result.reason === undefined ? undefined : { reason: result.reason }),
		facts: result.facts,
	});
}
