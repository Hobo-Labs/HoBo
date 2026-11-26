/**
 * Three independent state machines.
 *
 * They are modelled separately, advanced by separate commands, and composed
 * only in a read-only snapshot. Success in one NEVER implies another: an
 * authenticated human does not make an agent human-bound, a human-bound agent
 * does not make infrastructure owner-controlled, and owner-controlled
 * infrastructure does not resurrect a revoked agent.
 */
import { authMdError } from "./errors.js";

export type HumanSessionPhase = "anonymous" | "authenticated";
export type HumanSessionCommand = "authenticate" | "signOut";

export type AgentPrincipalPhase =
	| "unregistered"
	| "pre-claim"
	| "human-bound"
	| "revoked";
export type AgentPrincipalCommand =
	| "register"
	| "bindToHuman"
	| "revoke"
	| "reRegister";

export type InfrastructurePhase = "temporary" | "owner-controlled" | "expired";
export type InfrastructureCommand = "claimOwnership" | "expire";

const HUMAN_SESSION_TRANSITIONS: Readonly<
	Record<
		HumanSessionPhase,
		Partial<Record<HumanSessionCommand, HumanSessionPhase>>
	>
> = {
	anonymous: { authenticate: "authenticated" },
	authenticated: { signOut: "anonymous" },
};

const AGENT_PRINCIPAL_TRANSITIONS: Readonly<
	Record<
		AgentPrincipalPhase,
		Partial<Record<AgentPrincipalCommand, AgentPrincipalPhase>>
	>
> = {
	unregistered: { register: "pre-claim" },
	"pre-claim": { bindToHuman: "human-bound", revoke: "revoked" },
	"human-bound": { revoke: "revoked" },
	// Revocation is terminal for this registration; re-registration mints a new
	// one, which is why the only outgoing command lands back in `pre-claim`
	// under a fresh registrationRef.
	revoked: { reRegister: "pre-claim" },
};

const INFRASTRUCTURE_TRANSITIONS: Readonly<
	Record<
		InfrastructurePhase,
		Partial<Record<InfrastructureCommand, InfrastructurePhase>>
	>
> = {
	temporary: { claimOwnership: "owner-controlled", expire: "expired" },
	"owner-controlled": {},
	expired: {},
};

function advance<Phase extends string, Command extends string>(
	table: Readonly<Record<Phase, Partial<Record<Command, Phase>>>>,
	machine: string,
	phase: Phase,
	command: Command,
): Phase {
	const next = table[phase][command];
	if (next === undefined) {
		throw authMdError(
			"AUTHMD_REVOKED",
			`${machine}: command ${command} is not legal from ${phase}`,
			{ machine, phase, command },
		);
	}
	return next;
}

export function advanceHumanSession(
	phase: HumanSessionPhase,
	command: HumanSessionCommand,
): HumanSessionPhase {
	return advance(HUMAN_SESSION_TRANSITIONS, "human-session", phase, command);
}

export function advanceAgentPrincipal(
	phase: AgentPrincipalPhase,
	command: AgentPrincipalCommand,
): AgentPrincipalPhase {
	return advance(
		AGENT_PRINCIPAL_TRANSITIONS,
		"agent-principal",
		phase,
		command,
	);
}

export function advanceInfrastructure(
	phase: InfrastructurePhase,
	command: InfrastructureCommand,
): InfrastructurePhase {
	return advance(INFRASTRUCTURE_TRANSITIONS, "infrastructure", phase, command);
}

/** Read-only composition. Composition is not implication. */
export interface PlaneSnapshot {
	readonly humanSession: HumanSessionPhase;
	readonly agentPrincipal: AgentPrincipalPhase;
	readonly infrastructure: InfrastructurePhase;
}

export function planeSnapshot(
	humanSession: HumanSessionPhase,
	agentPrincipal: AgentPrincipalPhase,
	infrastructure: InfrastructurePhase,
): PlaneSnapshot {
	return Object.freeze({ humanSession, agentPrincipal, infrastructure });
}

/**
 * The safe outcome the design demands be representable: the human owns the
 * infrastructure and the work, while the agent that did the pre-claim work is
 * revoked. Nothing about the human's success re-grants the agent anything.
 */
export function isWorkClaimedByHumanWithRevokedAgent(
	snapshot: PlaneSnapshot,
): boolean {
	return (
		snapshot.humanSession === "authenticated" &&
		snapshot.infrastructure === "owner-controlled" &&
		snapshot.agentPrincipal === "revoked"
	);
}
