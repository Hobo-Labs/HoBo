import {
	type DurableMessagingConformanceCase,
	type DurableMessagingConformanceHarness,
	type DurableMessagingConformanceReport,
	runDurableMessagingConformance,
} from "@hobo/conformance";
import {
	createRivetDurableTopicClient,
	type RivetDurableTopicClient,
	type RivetDurableTopicClientOptions,
} from "../../src/durable-topic-client.js";

/** Host controls must drive the real process, durable actor and requested faults. */
export interface RivetMessagingConformanceHost {
	open(
		tenant: "tenant-a" | "tenant-b",
	): Promise<RivetDurableTopicClientOptions>;
	readonly controls: Omit<DurableMessagingConformanceHarness, "connect">;
}

function requireFull(client: RivetDurableTopicClient): void {
	const cap = client.actorCapabilities;
	if (
		!cap.topicCreation ||
		!cap.publish ||
		!cap.compaction ||
		!cap.auditEvents ||
		!cap.consumerGroups ||
		!cap.leases ||
		!cap.acknowledgement ||
		!cap.deadLetter
	)
		throw new Error("Rivet actor does not advertise a complete durable bus");
}

/**
 * Construct the generic suite against independently supplied host controls.
 * This cannot prove the host really restarted a process, isolated tenants,
 * injected a fault at commit, or fenced prior owners. The suite's evidence
 * remains unverified until an independent runner attests those claims.
 */
export async function createRivetMessagingConformanceHarness(
	host: RivetMessagingConformanceHost,
): Promise<DurableMessagingConformanceHarness> {
	let first: RivetDurableTopicClient;
	try {
		first = createRivetDurableTopicClient(await host.open("tenant-a"));
		requireFull(first);
	} catch (error) {
		await host.controls.close();
		throw error;
	}
	let available: RivetDurableTopicClient | undefined = first;
	const controls = host.controls;
	let epoch = 0;
	let closed = false;
	let changing = false;
	const active = () => {
		if (closed || changing)
			throw new Error("conformance host is not available");
	};
	const transition = async (run: () => Promise<void>) => {
		active();
		changing = true;
		epoch++;
		available = undefined;
		try {
			await run();
			if (closed) throw new Error("conformance host closed during transition");
		} catch (error) {
			closed = true;
			throw error;
		} finally {
			changing = false;
		}
	};
	return {
		async connect(tenant) {
			active();
			if (tenant === "tenant-a" && available !== undefined) {
				const current = available;
				available = undefined;
				return current;
			}
			const observed = epoch;
			const options = await host.open(tenant);
			if (closed || changing || epoch !== observed)
				throw new Error("conformance owner changed during connection");
			const client = createRivetDurableTopicClient(options);
			requireFull(client);
			return client;
		},
		restart: () => transition(() => controls.restart()),
		close: async () => {
			closed = true;
			epoch++;
			available = undefined;
			await controls.close();
		},
		nowMs: () => {
			active();
			return controls.nowMs();
		},
		advanceMs: (delta) => {
			active();
			return controls.advanceMs(delta);
		},
		loseNextMutationResponse: (point) => {
			active();
			return controls.loseNextMutationResponse(point);
		},
		loseNextMutationTransport: (mode) => {
			active();
			return controls.loseNextMutationTransport(mode);
		},
		rejectNextDeadLetterWrite: () => {
			active();
			return controls.rejectNextDeadLetterWrite();
		},
		blockNextReceiptLookup: (reason) => {
			active();
			return controls.blockNextReceiptLookup(reason);
		},
		switchAuthority: (mode) => transition(() => controls.switchAuthority(mode)),
		holdNextMutation: (point) => {
			active();
			return controls.holdNextMutation(point);
		},
		holdConcurrentMutations: () => {
			active();
			return controls.holdConcurrentMutations();
		},
	};
}

/** Run bounded generic scenarios; results retain the generic runner's unverified evidence. */
export async function runRivetMessagingConformance(
	createHost: (
		name: DurableMessagingConformanceCase,
	) => Promise<RivetMessagingConformanceHost>,
	options: {
		readonly case?: DurableMessagingConformanceCase;
		readonly caseTimeoutMs?: number;
	} = {},
): Promise<DurableMessagingConformanceReport> {
	return runDurableMessagingConformance(
		async (name) =>
			createRivetMessagingConformanceHarness(await createHost(name)),
		options,
	);
}
