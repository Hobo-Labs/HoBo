/**
 * The `AuthorityBus` shape local mode hands the enrollment state machine and
 * the fleet commands (L33, private). Local mode has no bus (§6.2, D6): only
 * the in-process registry and its publisher are real. Every other port is
 * absent: a publish or read rejects with an error naming the port, and a subscription delivers nothing. The one-active register keeps
 * its log in the members' own stores, not here (§6.10).
 */
import type { AuthorityBus, Subscription } from "../ports.js";
import type { LocalRegistry } from "./registry.js";

const NOTHING: Subscription = { async stop() {} };

function absent(port: string): () => Promise<never> {
	return async () => {
		throw new Error(`local mode has no bus: ${port} is absent`);
	};
}

const none = (): Subscription => NOTHING;

export function createLocalBus(registry: LocalRegistry): AuthorityBus {
	return {
		registry: registry.view,
		publisher: registry.publisher,
		observations: {
			publish: absent("observations.publish"),
			read: absent("observations.read"),
		},
		claims: {
			claim: absent("claims.claim"),
			holder: absent("claims.holder"),
			subscribe: none,
			remove: absent("claims.remove"),
		},
		offers: { publish: absent("offers.publish"), subscribe: none },
		submissions: { publish: absent("submissions.publish"), subscribe: none },
		orders: {
			deliver: absent("orders.deliver"),
			subscribe: none,
			observeAll: none,
		},
		events: { publish: absent("events.publish"), subscribe: none },
		control: { send: absent("control.send"), subscribe: none },
		relay: { send: absent("relay.send"), subscribe: none },
		audit: {
			append: absent("audit.append"),
			appendCheckpoint: absent("audit.appendCheckpoint"),
			entries: absent("audit.entries"),
			onWitnessed: none,
			proposeTrust: absent("audit.proposeTrust"),
			onTrustProposed: none,
			onTrustWitnessed: none,
		},
		replay: { firstUse: absent("replay.firstUse") },
		status: () => "closed",
		close: async () => {},
	};
}
