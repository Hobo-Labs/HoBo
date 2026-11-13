/**
 * Transport selection (design §6.12, F14): `p2p`, then `overlay`, then
 * `bus-relay`, whatever order the transports were given in. A dial that fails
 * or throws falls through to the next; the first that carries wins.
 */
import type { SignedEnvelope } from "../_generated/fleet_pb.js";
import type { FleetErrorCode } from "../errors.js";
import type {
	FleetLog,
	FleetStream,
	FleetTransport,
	Outcome,
	TransportKind,
} from "../ports.js";

const ORDER: readonly TransportKind[] = ["p2p", "overlay", "bus-relay"];

function inOrder(
	transports: readonly FleetTransport[],
): readonly FleetTransport[] {
	return [...transports].sort(
		(left, right) => ORDER.indexOf(left.kind) - ORDER.indexOf(right.kind),
	);
}

export async function select(
	transports: readonly FleetTransport[],
	grant: SignedEnvelope,
	signal: AbortSignal,
	log: FleetLog,
): Promise<Outcome<FleetStream>> {
	const failures: Record<string, string> = {};
	const codes = new Set<FleetErrorCode>();
	for (const transport of inOrder(transports)) {
		if (signal.aborted) {
			codes.add("unavailable");
			break;
		}
		let outcome: Outcome<FleetStream>;
		try {
			outcome = await transport.dial({ grant, signal });
		} catch (error) {
			outcome = {
				ok: false,
				error: {
					code: "unavailable",
					message: error instanceof Error ? error.message : "the dial threw",
				},
			};
		}
		if (outcome.ok) {
			log("hobo_fleet_transport_selected", {
				transport: transport.kind,
				fallbacks: Object.keys(failures).length,
			});
			return outcome;
		}
		const name =
			failures[transport.kind] === undefined
				? transport.kind
				: `${transport.kind}#${Object.keys(failures).length}`;
		failures[name] = `${outcome.error.code}: ${outcome.error.message}`;
		codes.add(outcome.error.code);
	}
	const [only] = codes;
	return {
		ok: false,
		error: {
			code: codes.size === 1 && only !== undefined ? only : "unavailable",
			message: signal.aborted
				? "the session was aborted"
				: "no transport could open the session",
			detail: failures,
		},
	};
}
