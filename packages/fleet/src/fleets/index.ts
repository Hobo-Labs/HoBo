/**
 * Fleet commands (L32): fleets and policy, sessions, work submission, views
 * and verdicts (§6.2, §6.9, §6.12, §6.13, §7.5). Re-exported by
 * `@hobo/fleet/membership`.
 *
 * State lives only in the `FleetEventStore`: `defineFleet` reads its
 * `fleet-fleet-<FleetId>` stream, decides, and appends with `expectedSeq`,
 * retrying on conflict up to 8 times, so any number of instances on one store
 * agree. Every governed action goes through `decideGoverned`. A defined or
 * changed fleet record is published to the registry at once, so the
 * enrollment commands (which read fleets from the registry) see it before the
 * first enrollment into it.
 */
import { create, equals, toBinary } from "@bufbuild/protobuf";
import {
	FleetListSchema,
	FleetPolicySchema,
	type FleetRecord,
	FleetRecordSchema,
	type FleetView,
	FleetViewSchema,
	type SignedEnvelope,
} from "../_generated/fleet_pb.js";
import { FLEET_RECORD_CONTEXT, FLEET_VIEW_CONTEXT } from "../contexts.js";
import type { FleetId } from "../ids.js";
import { signEnvelope } from "../keys/index.js";
import {
	fleetVerdict as buildFleetVerdict,
	fleetView as buildFleetView,
} from "../observation/index.js";
import type {
	AuthorityDeps,
	FleetCommands,
	Outcome,
	VerifiedToken,
} from "../ports.js";
import {
	createFleetJournal,
	type FleetState,
	fleetEvent,
	fleetStream,
	fleetSubject,
} from "./journal.js";
import { fleetIdOf, validateFleet } from "./policy.js";
import { grantSession } from "./sessions.js";
import { createSubmitter } from "./submit.js";
import {
	append,
	asPerson,
	asReader,
	governed,
	iso,
	logEvent,
	MAX_ATTEMPTS,
	ok,
	principalKey,
	refuse,
} from "./support.js";

/** A fleet record is valid for at most 30 minutes after it is signed (§7.1). */
const RECORD_TTL_MS = 30 * 60 * 1_000;
/** §7.2 labels: at most 80 characters. */
const MAX_LABEL_LENGTH = 80;

/** `mode` "authority" refuses ONE_ACTIVE in defineFleet (`fleet-policy`, rule `one-active-authority`, D39); "local" accepts it. The authority and createTestAuthority pass "authority"; createLocalFleet passes "local". */
export function createFleetCommands(
	deps: Pick<
		AuthorityDeps,
		| "tenant"
		| "store"
		| "bus"
		| "policy"
		| "decisions"
		| "recordSigner"
		| "now"
		| "log"
	> &
		Readonly<{ mode: "authority" | "local" }>,
): FleetCommands {
	const journal = createFleetJournal(deps);
	const submit = createSubmitter(deps, () => journal.catchUp());

	const sign = (record: FleetRecord): Promise<SignedEnvelope> => {
		const at = deps.now();
		return signEnvelope(
			deps.recordSigner,
			FLEET_RECORD_CONTEXT,
			toBinary(
				FleetRecordSchema,
				create(FleetRecordSchema, {
					...record,
					issuedAt: iso(at),
					notAfter: iso(at + RECORD_TTL_MS),
				}),
			),
		);
	};

	/** The fleet's journal state, or `fleet-unknown` (a malformed id is unknown too). */
	const known = async (value: string): Promise<Outcome<FleetState>> => {
		const id = fleetIdOf(value);
		const state = id.ok ? (await journal.catchUp()).get(id.value) : undefined;
		return state === undefined
			? refuse("fleet-unknown", `no fleet ${value}`, { fleet: value })
			: ok(state);
	};

	/** The registry's view, or, before the projection has published one, a view built from the registry's members. */
	const viewOf = async (record: FleetRecord): Promise<FleetView> => {
		// SAFETY: every record in the journal index came from a parsed fleet id.
		const id = record.fleetId as FleetId;
		const published = await deps.bus.registry.view(id);
		if (published !== undefined) return published;
		return buildFleetView(
			record,
			await deps.bus.registry.membersOf(id),
			[],
			new Map(),
			deps.now(),
		);
	};

	/** Publishes the signed record to the registry; `unavailable` when the bus refuses. */
	const publish = async (
		record: FleetRecord,
	): Promise<Outcome<SignedEnvelope>> => {
		const signed = await sign(record);
		try {
			// SAFETY: validateFleet parsed this id.
			await deps.bus.publisher.putFleet(signed, record.fleetId as FleetId);
		} catch {
			return refuse(
				"unavailable",
				"the fleet is journalled but the registry could not be written; retry",
			);
		}
		return ok(signed);
	};

	const defineFleet = async (
		request: FleetRecord,
		caller: VerifiedToken | undefined,
	): Promise<Outcome<SignedEnvelope>> => {
		const person = asPerson(deps, caller);
		if (!person.ok) return person;
		const valid = validateFleet(request, deps.tenant, deps.mode);
		if (!valid.ok) return valid;
		// SAFETY: validateFleet parsed the fleet id.
		const id = valid.value.fleetId as FleetId;
		const before = (await journal.catchUp()).get(id);
		if (
			before !== undefined &&
			before.record.coordination !== valid.value.coordination
		)
			return refuse(
				"fleet-policy",
				"a fleet's coordination mode cannot change",
				{ rule: "coordination-immutable" },
			);
		const decision = await governed(
			deps,
			{
				identity: principalKey(person.value.principal),
				tags: person.value.tags,
			},
			before === undefined ? "fleet.define" : "fleet.policy.change",
			{ kind: "fleet", id, fleet: id },
		);
		if (!decision.ok) return decision;

		const by = principalKey(person.value.principal);
		for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
			const current = (await journal.catchUp()).get(id);
			if ((current === undefined) !== (before === undefined))
				return refuse(
					"conflict",
					"the fleet was defined concurrently; send the request again",
				);
			if (current !== undefined) {
				if (current.record.coordination !== valid.value.coordination)
					return refuse(
						"fleet-policy",
						"a fleet's coordination mode cannot change",
						{ rule: "coordination-immutable" },
					);
				if (
					current.record.policy !== undefined &&
					valid.value.policy !== undefined &&
					equals(FleetPolicySchema, current.record.policy, valid.value.policy)
				)
					return publish(current.record);
			}
			const next = create(FleetRecordSchema, {
				fleetId: id,
				tenant: deps.tenant,
				owner: current?.record.owner ?? by,
				coordination: valid.value.coordination,
				policy: valid.value.policy,
				revision: (current?.record.revision ?? 0) + 1,
				updatedAt: iso(deps.now()),
				updatedBy: by,
			});
			const type =
				current === undefined
					? "fleet.FleetDefined"
					: "fleet.FleetPolicyChanged";
			const appended = await append(
				deps,
				fleetStream(id),
				current?.seq ?? 0,
				[fleetEvent(type, next)],
				person.value.principal,
			);
			if (appended === "conflict") continue;
			logEvent(deps, type, fleetSubject(id));
			return publish(next);
		}
		return refuse(
			"conflict",
			"another writer kept winning the compare-and-set",
		);
	};

	return {
		async listFleets(_request, caller) {
			const reader = asReader(deps, caller);
			if (!reader.ok) return reader;
			const records = [...(await journal.catchUp()).values()]
				.map((state) => state.record)
				.sort((a, b) => a.fleetId.localeCompare(b.fleetId));
			return ok(
				create(FleetListSchema, {
					fleets: await Promise.all(records.map((record) => sign(record))),
				}),
			);
		},
		async getFleet(request, caller) {
			const reader = asReader(deps, caller);
			if (!reader.ok) return reader;
			const state = await known(request.fleetId);
			if (!state.ok) return state;
			return ok(await sign(state.value.record));
		},
		defineFleet,
		async fleetView(request, caller) {
			const reader = asReader(deps, caller);
			if (!reader.ok) return reader;
			const state = await known(request.fleetId);
			if (!state.ok) return state;
			const view = await viewOf(state.value.record);
			return ok(
				await signEnvelope(
					deps.recordSigner,
					FLEET_VIEW_CONTEXT,
					toBinary(FleetViewSchema, view),
				),
			);
		},
		async fleetVerdict(request, caller) {
			// "As read, or a GitHub Actions OIDC token for a repository the fleet lists" (§6.15).
			const workload = caller?.kind === "workload" ? caller : undefined;
			if (workload === undefined) {
				const reader = asReader(deps, caller);
				if (!reader.ok) return reader;
			} else if (workload.tenant !== deps.tenant)
				return refuse("forbidden", "the workload token is for another tenant");
			if (request.label.length > MAX_LABEL_LENGTH)
				return refuse("invalid-request", "a label is at most 80 characters");
			const state = await known(request.fleetId);
			if (!state.ok) return state;
			if (
				workload !== undefined &&
				!(state.value.record.policy?.repositories ?? []).some(
					(rule) => rule.repository === workload.repository,
				)
			)
				return refuse(
					"forbidden",
					"the workload's repository is not one the fleet lists",
					{ repository: workload.repository },
				);
			const view = await viewOf(state.value.record);
			return ok(buildFleetVerdict(view, request.label, deps.now()));
		},
		grantSession: (request, caller) =>
			grantSession(deps, () => journal.catchUp(), request, caller),
		submitWork: (request, caller) => submit(request, caller),
	};
}
