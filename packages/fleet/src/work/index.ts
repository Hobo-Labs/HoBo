/* oxlint-disable no-unused-vars -- contract commit: entry-point stubs keep their final signatures until a lane implements them. */
/**
 * `@hobo/fleet/work` (L04): many-active work (§6.9): digests, trust class and
 * sandbox tier, order and claim checks, the start fence, the dispatcher and
 * executor loops, and the `oci-command` work kind.
 *
 * Contract commit: every body throws `FleetNotImplemented`; L04 replaces them.
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
import { FleetNotImplemented } from "../errors.js";
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

export function workDigest(kind: string, workKey: string): WorkDigest {
	throw new FleetNotImplemented("workDigest");
}

export function deriveTrustClass(
	offer: WorkOffer,
	self: MemberRecord,
): TrustClass {
	throw new FleetNotImplemented("deriveTrustClass");
}

export function requiredSandbox(
	trust: TrustClass,
	deviceClass: DeviceClass,
	policy: FleetPolicy,
	repository: string,
): SandboxTier | "never" {
	throw new FleetNotImplemented("requiredSandbox");
}

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
	throw new FleetNotImplemented("checkOrder");
}

/** The start fence. */
export function checkAssignment(
	order: WorkOrder,
	observed: ObservedAssignment,
	self: MemberRecord,
	policy: FleetPolicy,
	tier: SandboxTier,
): boolean {
	throw new FleetNotImplemented("checkAssignment");
}

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
	throw new FleetNotImplemented("checkClaim");
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
	throw new FleetNotImplemented("createDispatcher");
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
	throw new FleetNotImplemented("createExecutor");
}

export function createOciCommandSource(bus: FleetBus): WorkSource {
	throw new FleetNotImplemented("createOciCommandSource");
}

export function createOciCommandRunner(): WorkRunner {
	throw new FleetNotImplemented("createOciCommandRunner");
}
