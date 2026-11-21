/** Durable receiver for cross-migration Camp write authority. */
import { createHash } from "node:crypto";
import {
	canonicalEncode,
	fenceTokenDigest,
	isJsonNumber,
	isJsonObject,
	isJsonString,
} from "@hobo/data-core";
import type { JsonObject, JsonValue as TrailsJsonValue } from "./json.js";
import type { DataMigrationJournal } from "./migration-executor.js";

export interface HandoverRouteEndpoint extends JsonObject {
	readonly yard: string;
	readonly provider: string;
	readonly accountId: string;
	readonly resourceId: string;
}
export interface HandoverRouteScope extends JsonObject {
	readonly tenant: string;
	readonly campId: string;
	readonly dataset: string;
	readonly scopeTenant: string;
}
export interface HandoverRouteMove {
	readonly migrationId: string;
	readonly head: number;
	readonly direction: "to-source" | "to-target";
	readonly fenceToken: string;
}
export type FencedHandoverFlip = (
	move: HandoverRouteMove,
) => void | Promise<void>;
type RecordState = {
	generation: number;
	current: HandoverRouteEndpoint;
	active?: {
		migrationId: string;
		source: HandoverRouteEndpoint;
		target: HandoverRouteEndpoint;
		head: number;
		direction?: "to-source" | "to-target";
	};
};
type Bound = Readonly<{
	scope: HandoverRouteScope;
	migrationId: string;
	source: HandoverRouteEndpoint;
	target: HandoverRouteEndpoint;
}>;
const boundReceivers = new WeakMap<FencedHandoverFlip, Bound>();
function endpoint(value: TrailsJsonValue): HandoverRouteEndpoint {
	if (
		!isJsonObject(value) ||
		Object.keys(value).sort().join(",") !==
			"accountId,provider,resourceId,yard" ||
		![value.yard, value.provider, value.accountId, value.resourceId].every(
			(part) =>
				isJsonString(part) &&
				!!part &&
				part.length <= 512 &&
				!/\p{Cc}/u.test(part),
		)
	)
		throw new Error("invalid handover route endpoint");
	return Object.freeze({
		yard: String(value.yard),
		provider: String(value.provider),
		accountId: String(value.accountId),
		resourceId: String(value.resourceId),
	});
}
function same(a: HandoverRouteEndpoint, b: HandoverRouteEndpoint): boolean {
	return (
		a.yard === b.yard &&
		a.provider === b.provider &&
		a.accountId === b.accountId &&
		a.resourceId === b.resourceId
	);
}
function scopeOf(input: HandoverRouteScope): HandoverRouteScope {
	const scope = {
		tenant: input.tenant,
		campId: input.campId,
		dataset: input.dataset,
		scopeTenant: input.scopeTenant,
	};
	if (
		Object.values(scope).some(
			(part) =>
				!isJsonString(part) || part.length > 512 || /\p{Cc}/u.test(part),
		) ||
		!scope.tenant ||
		!scope.campId ||
		!scope.dataset
	)
		throw new Error("invalid handover route scope");
	return Object.freeze(scope);
}

/** Runtime validation rejects arbitrary callbacks that cannot fence a stale
 * cross-migration route at the receiver. */
export function assertFencedHandoverFlip(
	flip: FencedHandoverFlip,
	expected: Bound,
): void {
	const bound = boundReceivers.get(flip);
	if (
		!bound ||
		bound.migrationId !== expected.migrationId ||
		bound.scope.tenant !== expected.scope.tenant ||
		bound.scope.campId !== expected.scope.campId ||
		bound.scope.dataset !== expected.scope.dataset ||
		bound.scope.scopeTenant !== expected.scope.scopeTenant ||
		!same(bound.source, expected.source) ||
		!same(bound.target, expected.target)
	)
		throw new Error(
			"data handover requires its exact durable fenced routing receiver",
		);
}

/** Internal routing model, not a public production receiver. All writers and readers must
 * use this record. Every generation change and route flip is one conditional
 * append, so a delayed request cannot overwrite a later Camp generation.
 * Native-fence readback and this CAS are on different providers and are not
 * atomic together. The production host must hold a receiver-enforced Camp
 * operation lock and funding through completion, or keep this path disabled. */
export function createDurableHandoverRouter(options: {
	readonly journal: DataMigrationJournal;
	readonly scope: HandoverRouteScope;
	/** Independent read of the exact native source fence under funded Camp authority. */
	readonly verifyNativeFence: (
		input: Readonly<{
			scope: HandoverRouteScope;
			source: HandoverRouteEndpoint;
			target: HandoverRouteEndpoint;
			migrationId: string;
			generation: number;
			head: number;
			direction: "to-source" | "to-target";
			fenceToken: string;
		}>,
	) => Promise<void>;
}) {
	if (
		!(options.journal?.load instanceof Function) ||
		!(options.journal.append instanceof Function) ||
		!(options.verifyNativeFence instanceof Function)
	)
		throw new Error("handover route requires a compare-and-set journal");
	const journal = options.journal,
		scope = scopeOf(options.scope),
		verifyNativeFence = options.verifyNativeFence;
	// One physical lock per logical Camp. A second dataset or tenant scope
	// cannot silently open a separate generation while this Camp is moving;
	// until a shared multi-dataset route is enrolled it must fail closed.
	const key = `trails-route:${createHash("sha256")
		.update(canonicalEncode({ tenant: scope.tenant, campId: scope.campId }))
		.digest("hex")}`;
	async function read() {
		const facts = await journal.load(key);
		let state: RecordState | undefined;
		for (const fact of facts) {
			const data = fact.data;
			if (fact.type === "trails.RouteInitialized") {
				if (
					state ||
					!isJsonObject(data.scope) ||
					Object.keys(data.scope).sort().join(",") !==
						"campId,dataset,scopeTenant,tenant" ||
					data.scope.tenant !== scope.tenant ||
					data.scope.campId !== scope.campId ||
					data.scope.dataset !== scope.dataset ||
					data.scope.scopeTenant !== scope.scopeTenant
				)
					throw new Error("invalid route genesis");
				state = { generation: 0, current: endpoint(data.source) };
			} else if (fact.type === "trails.RouteGeneration") {
				if (
					!state ||
					!isJsonNumber(data.generation) ||
					data.generation !== state.generation + 1 ||
					!isJsonString(data.migrationId) ||
					!data.migrationId ||
					!same(state.current, endpoint(data.source))
				)
					throw new Error("invalid route generation");
				state = {
					...state,
					generation: data.generation,
					active: {
						migrationId: data.migrationId,
						source: endpoint(data.source),
						target: endpoint(data.target),
						head: 0,
					},
				};
			} else if (fact.type === "trails.RouteFlipped") {
				if (
					!state?.active ||
					data.generation !== state.generation ||
					data.migrationId !== state.active.migrationId ||
					!isJsonNumber(data.head) ||
					!Number.isSafeInteger(data.head) ||
					data.head < 1 ||
					data.head <= state.active.head ||
					(data.direction !== "to-source" && data.direction !== "to-target")
				)
					throw new Error("invalid route flip");
				state = {
					...state,
					current:
						data.direction === "to-source"
							? state.active.source
							: state.active.target,
					active: {
						...state.active,
						head: data.head,
						direction: data.direction,
					},
				};
			} else throw new Error("unknown handover route fact");
		}
		return { state, count: facts.length };
	}
	async function initialize(
		source: HandoverRouteEndpoint,
		verifyFresh: () => Promise<void>,
	) {
		if (!(verifyFresh instanceof Function))
			throw new Error("route genesis requires independent verification");
		const initial = endpoint(source),
			before = await read();
		if (before.state) throw new Error("handover route is already initialized");
		await verifyFresh();
		await journal.append(
			key,
			{ type: "trails.RouteInitialized", data: { scope, source: initial } },
			before.count,
		);
	}
	async function begin(input: {
		readonly migrationId: string;
		readonly source: HandoverRouteEndpoint;
		readonly target: HandoverRouteEndpoint;
		readonly expectedGeneration: number;
		readonly authorize: () => Promise<void>;
	}): Promise<FencedHandoverFlip> {
		const source = endpoint(input.source),
			target = endpoint(input.target),
			before = await read();
		const migrationId = input.migrationId,
			authorize = input.authorize;
		if (
			!before.state ||
			!isJsonString(migrationId) ||
			!migrationId ||
			migrationId.length > 512 ||
			/\p{Cc}/u.test(migrationId) ||
			!Number.isSafeInteger(input.expectedGeneration) ||
			input.expectedGeneration < 0 ||
			input.expectedGeneration >= Number.MAX_SAFE_INTEGER ||
			same(source, target) ||
			!(authorize instanceof Function)
		)
			throw new Error(
				"handover route admission differs from current authority",
			);
		const generation = input.expectedGeneration + 1;
		const recovering =
			before.state.generation === generation &&
			before.state.active?.migrationId === migrationId &&
			same(before.state.active.source, source) &&
			same(before.state.active.target, target);
		if (
			!recovering &&
			(before.state.generation !== input.expectedGeneration ||
				!same(before.state.current, source))
		)
			throw new Error(
				"handover route admission differs from current authority",
			);
		await authorize();
		if (!recovering)
			await journal.append(
				key,
				{
					type: "trails.RouteGeneration",
					data: { generation, migrationId, source, target },
				},
				before.count,
			);
		const binding = Object.freeze({ scope, migrationId, source, target });
		const flip: FencedHandoverFlip = async (move) => {
			const {
				migrationId: requestedMigration,
				head,
				direction,
				fenceToken,
			} = move;
			if (
				requestedMigration !== migrationId ||
				!Number.isSafeInteger(head) ||
				head < 1 ||
				!isJsonString(fenceToken) ||
				!fenceToken ||
				(direction !== "to-source" && direction !== "to-target")
			)
				throw new Error("invalid fenced handover route request");
			await authorize();
			const current = await read();
			if (
				!current.state?.active ||
				current.state.generation !== generation ||
				current.state.active.migrationId !== migrationId
			)
				throw new Error("handover route owner was superseded");
			if (
				head < current.state.active.head ||
				(head === current.state.active.head &&
					direction !== current.state.active.direction)
			)
				throw new Error("handover route decision is stale");
			await authorize();
			const facts = await journal.load(migrationId);
			const decision = facts[head - 1];
			const cutovers = facts
				.slice(0, head)
				.filter((fact) => fact.type === "migration.CutOver");
			const cutover = cutovers.at(-1);
			const expectedType =
				direction === "to-target"
					? "migration.CutOver"
					: "migration.RollbackDecided";
			if (
				!decision ||
				decision.type !== expectedType ||
				decision.data.migrationId !== migrationId ||
				cutovers.length !== 1 ||
				cutover?.data.fenceTokenDigest !== fenceTokenDigest(fenceToken) ||
				facts
					.slice(head)
					.some(
						(fact) =>
							fact.type === "migration.CutOver" ||
							fact.type === "migration.RollbackDecided",
					)
			)
				throw new Error(
					"handover route decision or fence token does not match the migration journal",
				);
			await verifyNativeFence({
				scope,
				source,
				target,
				migrationId,
				generation,
				head,
				direction,
				fenceToken,
			});
			await authorize();
			if (head === current.state.active.head) return;
			await journal.append(
				key,
				{
					type: "trails.RouteFlipped",
					data: { generation, migrationId, head, direction },
				},
				current.count,
			);
		};
		boundReceivers.set(flip, binding);
		return Object.freeze(flip);
	}
	return Object.freeze({
		initialize,
		begin,
		async current() {
			const state = (await read()).state;
			return (
				state &&
				Object.freeze({
					...state,
					...(state.active
						? { active: Object.freeze({ ...state.active }) }
						: undefined),
				})
			);
		},
	});
}
