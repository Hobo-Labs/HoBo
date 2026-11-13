/**
 * `@hobo/fleet/work` (L04): many-active work (§6.9, §6.11): digests, trust
 * class and sandbox tier, order and claim checks, the start fence, the
 * dispatcher and executor loops, and the `oci-command` work kind.
 *
 * These are the frozen entry points of §7.3; the modules beside this file are
 * private to the lane.
 */
import type {
	DeviceClass,
	FleetPolicy,
	MemberRecord,
	SandboxTier,
	SignedEnvelope,
	TrustClass,
	ViolationReport,
	WorkOffer,
	WorkOrder,
} from "../_generated/fleet_pb.js";
import type { FleetId, MemberId, WorkDigest } from "../ids.js";
import type {
	CapacitySource,
	Clock,
	DeviceKeys,
	EgressProxyFactory,
	FleetBus,
	FleetLog,
	KeyStore,
	ObservedAssignment,
	Outcome,
	RegistryView,
	Sandbox,
	SandboxDriver,
	WorkRunner,
	WorkSource,
} from "../ports.js";
import { claimVerdict, fenceAllows, orderVerdict } from "./checks.js";
import { dispatcher } from "./dispatcher.js";
import { executor } from "./executor.js";
import { ociRunner, ociSource } from "./oci.js";
import { digestOf, sandboxFor, trustClassOf } from "./rules.js";

/** First 32 hex of `sha256(kind ‖ 0x00 ‖ work_key)`. */
export function workDigest(kind: string, workKey: string): WorkDigest {
	return digestOf(kind, workKey);
}

/** §6.11, derived on the device from facts it can check; a dispatcher never asserts `OWN`. */
export function deriveTrustClass(
	offer: WorkOffer,
	self: MemberRecord,
): TrustClass {
	return trustClassOf(offer, self);
}

/** The table of §6.11. */
export function requiredSandbox(
	trust: TrustClass,
	deviceClass: DeviceClass,
	policy: FleetPolicy,
	repository: string,
): SandboxTier | "never" {
	return sandboxFor(trust, deviceClass, policy, repository);
}

/** §6.9 step 6; a refusal names its rule in `detail.check`. */
export function checkOrder(
	order: SignedEnvelope,
	context: Readonly<{
		self: MemberRecord;
		registry: RegistryView;
		heldClaims: ReadonlySet<WorkDigest>;
		seenOrderIds: ReadonlySet<string>;
		nowMs: number;
	}>,
): Promise<
	Outcome<Readonly<{ order: WorkOrder; trust: TrustClass; tier: SandboxTier }>>
> {
	return orderVerdict(order, context);
}

/** The start fence. */
export function checkAssignment(
	order: WorkOrder,
	observed: ObservedAssignment,
	self: MemberRecord,
	policy: FleetPolicy,
	tier: SandboxTier,
): boolean {
	return fenceAllows(order, observed, self, policy, tier);
}

/**
 * §6.9 step 4. With an empty `ranked` (the authority re-checking a report)
 * the claimant's own signed rank is its turn.
 */
export function checkClaim(
	claim: SignedEnvelope,
	subject: Readonly<{ fleet: FleetId; digest: WorkDigest }>,
	offer: WorkOffer,
	context: Readonly<{
		registry: RegistryView;
		ranked: readonly MemberId[];
		nowMs: number;
		stepMs: number;
	}>,
): Promise<"valid" | "discard" | "not-entitled" | "early"> {
	return claimVerdict(claim, subject, offer, context);
}

export function createDispatcher(
	deps: Readonly<{
		self: DeviceKeys;
		bus: FleetBus;
		sources: readonly WorkSource[];
		report(report: ViolationReport): Promise<void>;
		now: Clock;
		log: FleetLog;
	}>,
): Readonly<{ start(): void; stop(): Promise<void> }> {
	return dispatcher(deps);
}

export function createExecutor(
	deps: Readonly<{
		self: DeviceKeys;
		state: KeyStore;
		bus: FleetBus;
		runners: readonly WorkRunner[];
		sandboxes: readonly SandboxDriver[];
		egress: EgressProxyFactory;
		capacity: CapacitySource;
		now: Clock;
		log: FleetLog;
	}>,
): Readonly<{
	start(): void;
	drain(): Promise<void>;
	stop(): Promise<void>;
	sandboxOf(orderId: string): Sandbox | undefined;
}> {
	return executor(deps);
}

export function createOciCommandSource(bus: FleetBus): WorkSource {
	return ociSource(bus);
}

export function createOciCommandRunner(): WorkRunner {
	return ociRunner();
}
