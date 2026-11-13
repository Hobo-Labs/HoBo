/**
 * `@hobo/fleet/agent` (L07): the device agent core (design §6.5, §6.7–§6.9,
 * §6.12, §9 F1/F4/F7/F16/F18/F19).
 *
 * - `enroll` generates nothing itself: it opens the key store, builds and
 *   signs the key bundle, enrolls through the typed client with a bare proof
 *   made by the identity key, pins the trust record the authority answered
 *   with, and returns the whole `EnrollmentResponse`.
 * - `start` refreshes credentials (the nonce is on disk before the request
 *   leaves; a lost answer is retried with the same generation and nonce),
 *   renews the bundle at three quarters of its life, accepts a changed trust
 *   record only through `acceptTrust`, connects to the bus with the session
 *   ticket and resumes after a lost connection, publishes its own and its
 *   sponsored members' observations every 10 s, follows control messages, and
 *   composes the dispatcher, the executor and the session server by role.
 * - The executor queues receipts in `AgentState.pendingReceipts` and flushes
 *   them on start and every 10 s, so a bus outage loses none (F4).
 */
import { clone, create, fromBinary } from "@bufbuild/protobuf";
import {
	ControlKind,
	CredentialRequestSchema,
	type CredentialResponse,
	type EnrollmentRequest,
	EnrollmentRequestSchema,
	type EnrollmentResponse,
	Health,
	MemberControlSchema,
	type MemberRecord,
	MemberRecordSchema,
	MemberState,
	type Observation,
	ObservationSchema,
	Role,
	SandboxTier,
	SessionTicketSchema,
	type SignedEnvelope,
	type TrustRecord,
	TrustRecordSchema,
	type WitnessedEnvelope,
	WitnessedEnvelopeSchema,
} from "../_generated/fleet_pb.js";
import { createFleetClient } from "../client/index.js";
import { CONTROL_CONTEXT, MEMBER_RECORD_CONTEXT } from "../contexts.js";
import { parseMemberId } from "../ids.js";
import { acceptTrust, parsePublicJwk, verifyEnvelope } from "../keys/index.js";
import { buildObservation } from "../observation/index.js";
import type {
	AgentDeps,
	DeviceKeys,
	FleetClient,
	FleetTransport,
	Outcome,
	Sandbox,
	Subscription,
} from "../ports.js";
import { serveSessions } from "../transport/index.js";
import { createDispatcher, createExecutor } from "../work/index.js";
import {
	buildBundle,
	DEFAULT_BUNDLE_HOURS,
	decodeBundle,
	HOUR_MS,
	lifetimeOf,
	renewalDue,
	SHORT_BUNDLE_HOURS,
	transportOf,
} from "./bundle.js";
import { createBusLink } from "./link.js";
import { createStateGate } from "./state.js";

/** §6.8: the observation beat. */
export const BEAT_MS = 10_000;
/** How long an observation asks to be believed. */
const OBSERVATION_TTL_MS = 60_000;
/** §6.5: refresh five minutes before the SVID expires. */
const REFRESH_LEAD_MS = 5 * 60_000;
const RETRY_MIN_MS = 5_000;
const RETRY_MAX_MS = 60_000;
/** A session ticket this close to expiry is refreshed before it is presented. */
const TICKET_MARGIN_MS = 60_000;
/** F16: skew against the authority's `Date` header worth reporting. */
const SKEW_REPORT_MS = 5_000;
const NONCE_BYTES = 16;

type Executor = ReturnType<typeof createExecutor>;
type Dispatcher = ReturnType<typeof createDispatcher>;
type Credentials = Readonly<{
	svid: string;
	svidExpiresAtMs: number;
	ticket: SignedEnvelope;
	ticketExpiresAtMs: number;
}>;

const iso = (ms: number) => new Date(ms).toISOString();

function decodeMember(
	envelope: SignedEnvelope | undefined,
): MemberRecord | undefined {
	if (envelope === undefined || envelope.context !== MEMBER_RECORD_CONTEXT)
		return undefined;
	try {
		return fromBinary(MemberRecordSchema, envelope.payload);
	} catch {
		return undefined;
	}
}

/** The record verifies against the pinned trust's authority keys. */
function signedByAuthority(
	envelope: SignedEnvelope | undefined,
	context: typeof MEMBER_RECORD_CONTEXT | typeof CONTROL_CONTEXT,
	trust: TrustRecord | undefined,
): boolean {
	if (envelope === undefined || trust === undefined) return false;
	const key = trust.authorityKeys.find((ref) => ref.keyId === envelope.keyId);
	return key !== undefined && verifyEnvelope(envelope, context, key);
}

/** Fleet and roles, in a stable order: the executor restarts when this changes. */
function membershipKey(record: MemberRecord | undefined): string {
	return JSON.stringify(
		(record?.memberships ?? [])
			.map((membership) => [membership.fleet, [...membership.roles].sort()])
			.sort(),
	);
}

function hasRole(record: MemberRecord | undefined, role: Role): boolean {
	return (record?.memberships ?? []).some((membership) =>
		membership.roles.includes(role),
	);
}

function randomNonce(): Uint8Array {
	return crypto.getRandomValues(new Uint8Array(NONCE_BYTES));
}

/** The agent behind createFleetAgent (index.ts). */
export function fleetAgent(deps: AgentDeps) {
	const { log } = deps;
	const gate = createStateGate(deps.keys);
	const link = createBusLink();

	let keys: DeviceKeys | undefined;
	let member: MemberRecord | undefined;
	let pinned: TrustRecord | undefined;
	let credentials: Credentials | undefined;
	let started = false;
	let draining = false;
	let tiers: SandboxTier[] = [];
	let transports: FleetTransport[] = [];
	let transportIdentity = "";
	let healthSince = deps.now();
	let lastHealth: Health = Health.UNSPECIFIED;
	let lastIssuedMs = 0;
	const timers = new Set<ReturnType<typeof setTimeout>>();
	let beat: ReturnType<typeof setInterval> | undefined;
	let refreshing: Promise<boolean> | undefined;
	let refreshFailures = 0;
	let connecting: Promise<void> | undefined;
	let connectFailures = 0;
	let controlSubscription: Subscription | undefined;
	let sessions: Subscription | undefined;
	let dispatcher: Dispatcher | undefined;
	const executors: Executor[] = [];
	let composedFor: string | undefined;
	let composing: Promise<void> = Promise.resolve();

	// ── HTTP: the measured fetch and the two clients ─────────────────────────
	const measuredFetch: typeof fetch = async (input, init) => {
		const response = await deps.fetch(input, init);
		const date = response.headers.get("date");
		const authorityMs = date === null ? Number.NaN : Date.parse(date);
		if (Number.isFinite(authorityMs)) {
			const skewMs = deps.now() - authorityMs;
			if (Math.abs(skewMs) >= SKEW_REPORT_MS)
				log("hobo_fleet_clock_skew", { skew_ms: skewMs });
		}
		return response;
	};
	const identityClient = (device: DeviceKeys): FleetClient | undefined => {
		const jwk = parsePublicJwk(device.identityJwk);
		if (!jwk.ok) return undefined;
		return createFleetClient({
			origin: deps.authorityUrl,
			fetch: measuredFetch,
			auth: {
				token: async () => "",
				signer: device.identity,
				publicJwk: jwk.value,
			},
		});
	};
	const deviceClient = (device: DeviceKeys): FleetClient =>
		createFleetClient({
			origin: deps.authorityUrl,
			fetch: measuredFetch,
			auth: {
				token: async () => credentials?.svid ?? "",
				signer: device.sign,
				publicJwk: { kty: "OKP", crv: "Ed25519", x: device.signPublicKey },
			},
		});

	const openKeys = async (): Promise<DeviceKeys> => {
		if (keys === undefined) keys = await deps.keys.open();
		return keys;
	};

	// ── Trust ───────────────────────────────────────────────────────────────
	/** Pins `next` when acceptTrust takes it over the current pin; anything else leaves the pin alone. */
	async function considerTrust(
		next: WitnessedEnvelope | undefined,
	): Promise<void> {
		if (next === undefined || pinned === undefined) return;
		const payload = next.authority?.payload;
		if (payload === undefined) return;
		let sequence: number;
		try {
			sequence = fromBinary(TrustRecordSchema, payload).sequence;
		} catch {
			return;
		}
		if (sequence <= pinned.sequence) return;
		const accepted = acceptTrust(pinned, next);
		if (!accepted.ok) {
			log("hobo_fleet_trust_rotated", {
				accepted: false,
				sequence,
				code: accepted.error.code,
			});
			return;
		}
		pinned = accepted.value;
		await gate.update(() => ({ trust: clone(WitnessedEnvelopeSchema, next) }));
		log("hobo_fleet_trust_rotated", {
			accepted: true,
			sequence: accepted.value.sequence,
		});
	}

	// ── Enrollment ──────────────────────────────────────────────────────────
	async function enroll(
		request: Omit<EnrollmentRequest, "identityJwk" | "keyBundle">,
	): Promise<Outcome<EnrollmentResponse>> {
		const device = await openKeys();
		const client = identityClient(device);
		if (client === undefined)
			return {
				ok: false,
				error: {
					code: "invalid-request",
					message: "the key store's identity key is not a public JWK",
				},
			};
		const transport = await probeTransportIdentity(device);
		const attempt = async (hours: number) =>
			client.enroll(
				create(EnrollmentRequestSchema, {
					...request,
					agentVersion:
						request.agentVersion.length > 0
							? request.agentVersion
							: deps.agentVersion,
					identityJwk: device.identityJwk,
					keyBundle: await buildBundle(device, {
						sequence: 1,
						nowMs: deps.now(),
						lifetimeMs: hours * HOUR_MS,
						transportIdentity: transport,
					}),
				}),
			);
		let outcome = await attempt(DEFAULT_BUNDLE_HOURS);
		if (
			!outcome.ok &&
			outcome.error.code === "fleet-policy" &&
			outcome.error.detail?.rule === "key-bundle-hours"
		)
			outcome = await attempt(SHORT_BUNDLE_HOURS);
		if (!outcome.ok) return outcome;

		const trust = outcome.value.discovery?.trust;
		const self =
			trust === undefined ? undefined : acceptTrust(undefined, trust);
		if (trust === undefined || self === undefined || !self.ok)
			return {
				ok: false,
				error: {
					code: "proof-invalid",
					message: "the authority's answer carries no usable trust record",
				},
			};
		const record = decodeMember(outcome.value.memberRecord);
		if (
			record === undefined ||
			record.memberId !== device.memberId ||
			!signedByAuthority(
				outcome.value.memberRecord,
				MEMBER_RECORD_CONTEXT,
				self.value,
			)
		)
			return {
				ok: false,
				error: {
					code: "proof-invalid",
					message:
						"the member record is not this device's, signed by the pinned authority",
				},
			};
		pinned = self.value;
		member = record;
		await gate.update(() => ({
			generation: 0,
			pendingRefreshNonce: undefined,
			trust,
		}));
		return outcome;
	}

	/** The peer-to-peer endpoint id, or "" when there is no such transport or it reports none. */
	async function probeTransportIdentity(device: DeviceKeys): Promise<string> {
		const p2p = deps.transports.find((transport) => transport.kind === "p2p");
		if (p2p === undefined) return "";
		try {
			const { transportIdentity: identity } = await p2p.start(device);
			await p2p.stop();
			return identity;
		} catch {
			return "";
		}
	}

	// ── Credentials ─────────────────────────────────────────────────────────
	function refresh(): Promise<boolean> {
		if (refreshing === undefined)
			refreshing = refreshOnce().finally(() => {
				refreshing = undefined;
			});
		return refreshing;
	}

	async function refreshOnce(): Promise<boolean> {
		const device = await openKeys();
		// The nonce is on disk before the request leaves; a retry reuses it (F19).
		const state = await gate.update((current) => ({
			pendingRefreshNonce: current.pendingRefreshNonce ?? randomNonce(),
		}));
		const nonce = state.pendingRefreshNonce ?? randomNonce();
		const held = decodeBundle(member?.keyBundle);
		const renewal =
			held !== undefined && renewalDue(held, deps.now())
				? await buildBundle(device, {
						sequence: held.sequence + 1,
						nowMs: deps.now(),
						lifetimeMs: lifetimeOf(held),
						transportIdentity:
							transportIdentity.length > 0
								? transportIdentity
								: transportOf(held),
					})
				: undefined;
		const answer = await deviceClient(device).credentials({
			memberId: device.memberId,
			request: create(CredentialRequestSchema, {
				generation: state.generation,
				refreshNonce: nonce,
				agentVersion: deps.agentVersion,
				keyBundle: renewal,
			}),
		});
		if (!answer.ok) {
			log("hobo_fleet_credentials_issued", {
				ok: false,
				code: answer.error.code,
				generation: state.generation,
			});
			await onRefused(answer.error.code);
			return false;
		}
		await accept(answer.value);
		return true;
	}

	async function accept(response: CredentialResponse): Promise<void> {
		await gate.update(() => ({
			generation: response.generation,
			pendingRefreshNonce: undefined,
		}));
		await considerTrust(response.trust);
		const record = decodeMember(response.memberRecord);
		if (
			record !== undefined &&
			record.memberId === keys?.memberId &&
			signedByAuthority(response.memberRecord, MEMBER_RECORD_CONTEXT, pinned)
		)
			member = record;
		const svidExpiresAtMs = Date.parse(response.svidExpiresAt);
		let ticketExpiresAtMs = svidExpiresAtMs;
		try {
			ticketExpiresAtMs = Date.parse(
				fromBinary(
					SessionTicketSchema,
					response.sessionTicket?.payload ?? new Uint8Array(),
				).expiresAt,
			);
		} catch {
			// An unreadable ticket expires with the SVID.
		}
		if (response.sessionTicket !== undefined)
			credentials = {
				svid: response.svid,
				svidExpiresAtMs,
				ticket: response.sessionTicket,
				ticketExpiresAtMs,
			};
		log("hobo_fleet_credentials_issued", {
			ok: true,
			generation: response.generation,
		});
		recompose();
	}

	async function onRefused(code: string): Promise<void> {
		if (code === "agent-outdated")
			log("hobo_fleet_update_required", { agent_version: deps.agentVersion });
		if (code === "generation-mismatch" || code === "member-locked")
			log("hobo_fleet_member_locked", { member: keys?.memberId ?? "" });
		if (code === "member-revoked") {
			log("hobo_fleet_member_revoked", { member: keys?.memberId ?? "" });
			await stopWork();
		}
	}

	function scheduleRefresh(ok: boolean): void {
		if (!started) return;
		refreshFailures = ok ? 0 : refreshFailures + 1;
		const delay = ok
			? Math.max(
					(credentials?.svidExpiresAtMs ?? deps.now()) -
						REFRESH_LEAD_MS -
						deps.now(),
					RETRY_MIN_MS,
				)
			: Math.min(RETRY_MIN_MS * 2 ** (refreshFailures - 1), RETRY_MAX_MS);
		later(delay, async () =>
			scheduleRefresh(await refresh().catch(() => false)),
		);
	}

	function later(delay: number, run: () => Promise<void>): void {
		const timer = setTimeout(() => {
			timers.delete(timer);
			void run().catch(() => undefined);
		}, delay);
		timers.add(timer);
	}

	// ── The bus ─────────────────────────────────────────────────────────────
	async function ticket(): Promise<SignedEnvelope> {
		if (
			credentials === undefined ||
			credentials.ticketExpiresAtMs - TICKET_MARGIN_MS <= deps.now()
		)
			await refresh();
		if (credentials === undefined) throw new Error("no session ticket");
		return credentials.ticket;
	}

	function connect(): Promise<void> {
		if (connecting === undefined)
			connecting = connectOnce().finally(() => {
				connecting = undefined;
			});
		return connecting;
	}

	async function connectOnce(): Promise<void> {
		if (!started || link.current() !== undefined) return;
		const device = await openKeys();
		const state = await gate.read();
		try {
			if (state.trust === undefined) throw new Error("not enrolled");
			const discovery = await deviceClient(device).discovery({
				tenant: deps.tenant,
			});
			if (!discovery.ok) throw new Error(discovery.error.message);
			await considerTrust(discovery.value.trust);
			const pin = (await gate.read()).trust ?? state.trust;
			const bus = await deps.connector.connect({
				discovery: discovery.value,
				keys: device,
				trust: pin,
				ticket,
				resumeFrom: state.lastSequence,
				log,
			});
			if (!started) {
				await bus.close().catch(() => undefined);
				return;
			}
			link.attach(bus);
			connectFailures = 0;
			log("hobo_fleet_bus_status", { status: "connected" });
			await afterConnect();
		} catch (error) {
			connectFailures += 1;
			log("hobo_fleet_bus_status", {
				status: "disconnected",
				reason: error instanceof Error ? error.message : "connect failed",
			});
			later(
				Math.min(RETRY_MIN_MS * 2 ** (connectFailures - 1), RETRY_MAX_MS),
				connect,
			);
		}
	}

	async function afterConnect(): Promise<void> {
		const device = await openKeys();
		if (controlSubscription === undefined)
			controlSubscription = link.bus.control.subscribe(
				device.memberId,
				"new",
				onControl,
			);
		if (sessions === undefined && transports.length > 0)
			sessions = serveSessions({
				transports,
				registry: link.bus.registry,
				self: device,
				sandboxOf,
				bus: link.bus,
				now: deps.now,
				log,
			});
		if (member === undefined) {
			const record = await link.bus.registry
				.member(device.memberId)
				.catch(() => undefined);
			if (record !== undefined) member = record;
		}
		recompose();
		await observe();
	}

	async function onControl(envelope: SignedEnvelope): Promise<void> {
		if (!signedByAuthority(envelope, CONTROL_CONTEXT, pinned)) return;
		let control: ReturnType<typeof fromBinary<typeof MemberControlSchema>>;
		try {
			control = fromBinary(MemberControlSchema, envelope.payload);
		} catch {
			return;
		}
		if (control.memberId !== keys?.memberId) return;
		switch (control.kind) {
			case ControlKind.DRAIN:
				await drain();
				return;
			case ControlKind.REFRESH_NOW:
				await refresh();
				return;
			case ControlKind.REVOKED:
				log("hobo_fleet_member_revoked", {
					member: control.memberId,
					reason: control.reason,
				});
				await stopWork();
				return;
			case ControlKind.UPDATE_REQUIRED:
				log("hobo_fleet_update_required", {
					agent_version: deps.agentVersion,
					reason: control.reason,
				});
				return;
			default:
				return;
		}
	}

	// ── Roles ───────────────────────────────────────────────────────────────
	function sandboxOf(orderId: string): Sandbox | undefined {
		for (const executor of executors) {
			const sandbox = executor.sandboxOf(orderId);
			if (sandbox !== undefined) return sandbox;
		}
		return undefined;
	}

	/** Starts, restarts or stops the dispatcher and executor to match the member's memberships. */
	function recompose(): void {
		if (
			!started ||
			draining ||
			link.current() === undefined ||
			member === undefined
		)
			return;
		const key = membershipKey(member);
		if (key === composedFor) return;
		composedFor = key;
		const record = member;
		composing = composing.then(() => compose(record)).catch(() => undefined);
	}

	async function compose(record: MemberRecord): Promise<void> {
		const device = await openKeys();
		if (record.state !== MemberState.ACTIVE) return;
		const previous = executors.splice(0);
		for (const executor of previous) {
			await executor.drain();
			await executor.stop();
		}
		if (!started || draining) return;
		if (hasRole(record, Role.EXECUTOR)) {
			const executor = createExecutor({
				self: device,
				state: gate.executorStore,
				bus: link.bus,
				runners: deps.runners,
				sandboxes: deps.sandboxes,
				egress: deps.egress,
				capacity: deps.capacity,
				now: deps.now,
				log,
			});
			executors.push(executor);
			executor.start();
		}
		if (hasRole(record, Role.DISPATCHER) && dispatcher === undefined) {
			dispatcher = createDispatcher({
				self: device,
				bus: link.bus,
				sources: deps.sources,
				report: async (report) => {
					const sent = await deviceClient(device).report(report);
					if (!sent.ok)
						log("hobo_fleet_violation_reported", {
							ok: false,
							code: sent.error.code,
						});
				},
				now: deps.now,
				log,
			});
			dispatcher.start();
		} else if (!hasRole(record, Role.DISPATCHER) && dispatcher !== undefined) {
			const stopping = dispatcher;
			dispatcher = undefined;
			await stopping.stop();
		}
	}

	// ── Observations ────────────────────────────────────────────────────────
	function issuedNow(): number {
		lastIssuedMs = Math.max(deps.now(), lastIssuedMs + 1);
		return lastIssuedMs;
	}

	async function observe(): Promise<void> {
		const device = keys;
		const record = member;
		if (device === undefined || record === undefined) return;
		if (link.bus.status() !== "connected") return;
		const read = await deps.capacity.read().catch(() => undefined);
		const health = draining
			? Health.DRAINING
			: (read?.health ?? Health.UNKNOWN);
		if (health !== lastHealth) {
			lastHealth = health;
			healthSince = deps.now();
		}
		const issued = issuedNow();
		const own = create(ObservationSchema, {
			memberId: device.memberId,
			observerId: device.memberId,
			fleets: record.memberships.map((membership) => membership.fleet),
			health,
			failingForMs:
				health === Health.REACHABLE ? 0 : Math.max(0, issued - healthSince),
			capacity: read?.capacity,
			labels: [...(read?.labels ?? [])],
			platform: record.platform,
			sandboxTiers: [...tiers],
			agentVersion: deps.agentVersion,
			transports: transports.map((transport) => transport.kind),
			region: record.region,
			bundleSequence: decodeBundle(record.keyBundle)?.sequence ?? 0,
			since: iso(healthSince),
			issuedAt: iso(issued),
			validUntil: iso(issued + OBSERVATION_TTL_MS),
		});
		await publishObservation(own, device);
		for (const sponsored of deps.sponsored ?? []) {
			const observed = await sponsored.observe().catch(() => undefined);
			if (observed === undefined) continue;
			const at = issuedNow();
			const validUntilMs = Date.parse(observed.validUntil);
			const next: Observation = create(ObservationSchema, {
				...observed,
				memberId: sponsored.memberId,
				observerId: device.memberId,
				issuedAt: iso(at),
				validUntil:
					Number.isFinite(validUntilMs) &&
					validUntilMs > at &&
					validUntilMs <= at + OBSERVATION_TTL_MS
						? observed.validUntil
						: iso(at + OBSERVATION_TTL_MS),
			});
			await publishObservation(next, device);
		}
	}

	async function publishObservation(
		observation: Observation,
		device: DeviceKeys,
	): Promise<void> {
		const signed = await buildObservation(observation, device.sign);
		if (!("payload" in signed)) return;
		await link.bus.observations
			.publish(signed, device.memberId, parseMemberId(observation.memberId))
			.catch(() => undefined);
	}

	async function onBeat(): Promise<void> {
		if (!started) return;
		if (
			link.bus.status() === "closed" ||
			link.current()?.status() === "closed"
		) {
			await link.detach();
			log("hobo_fleet_bus_status", { status: "closed" });
		}
		if (link.current() === undefined) {
			void connect();
			return;
		}
		const device = await openKeys();
		const record = await link.bus.registry
			.member(device.memberId)
			.catch(() => undefined);
		if (
			record !== undefined &&
			(member === undefined || record.recordSequence >= member.recordSequence)
		)
			member = record;
		recompose();
		await observe();
	}

	// ── Lifecycle ───────────────────────────────────────────────────────────
	async function stopWork(): Promise<void> {
		const stopping = dispatcher;
		dispatcher = undefined;
		await stopping?.stop().catch(() => undefined);
		for (const executor of executors.splice(0))
			await executor.stop().catch(() => undefined);
		composedFor = undefined;
	}

	async function start(): Promise<void> {
		if (started) return;
		const device = await openKeys();
		const state = await gate.read();
		if (state.trust === undefined)
			throw new Error("this device is not enrolled: no trust record is pinned");
		const self = acceptTrust(undefined, state.trust);
		if (!self.ok)
			throw new Error(
				`the pinned trust record is unusable: ${self.error.message}`,
			);
		pinned = self.value;
		started = true;
		draining = false;

		tiers = [];
		for (const driver of deps.sandboxes) {
			const available = await driver.available().catch(() => undefined);
			if (available?.ok === true) {
				if (!tiers.includes(driver.tier)) tiers.push(driver.tier);
			} else
				log("hobo_fleet_sandbox_unavailable", {
					tier: SandboxTier[driver.tier] ?? driver.tier,
				});
		}
		tiers.sort((a, b) => a - b);

		transports = [];
		for (const transport of deps.transports) {
			try {
				const { transportIdentity: identity } = await transport.start(device);
				if (transport.kind === "p2p") transportIdentity = identity;
				transports.push(transport);
			} catch {
				log("hobo_fleet_transport_selected", {
					transport: transport.kind,
					started: false,
				});
			}
		}

		scheduleRefresh(await refresh().catch(() => false));
		await connect();
		beat = setInterval(() => void onBeat().catch(() => undefined), BEAT_MS);
	}

	async function drain(): Promise<void> {
		if (!started) return;
		draining = true;
		await observe().catch(() => undefined);
		const stopping = dispatcher;
		dispatcher = undefined;
		await stopping?.stop().catch(() => undefined);
		await composing;
		for (const executor of executors) await executor.drain();
	}

	async function stop(): Promise<void> {
		if (!started) return;
		started = false;
		if (beat !== undefined) clearInterval(beat);
		beat = undefined;
		for (const timer of timers) clearTimeout(timer);
		timers.clear();
		await composing;
		await stopWork();
		await sessions?.stop().catch(() => undefined);
		sessions = undefined;
		await controlSubscription?.stop().catch(() => undefined);
		controlSubscription = undefined;
		for (const transport of transports)
			await transport.stop().catch(() => undefined);
		transports = [];
		await refreshing?.catch(() => false);
		await link.detach();
		log("hobo_fleet_bus_status", { status: "stopped" });
	}

	return {
		enroll,
		start,
		drain,
		stop,
		bus: () => (started && link.current() !== undefined ? link.bus : undefined),
		status: () => ({
			member,
			bus: started ? link.bus.status() : "stopped",
			tiers: [...tiers],
		}),
	};
}
