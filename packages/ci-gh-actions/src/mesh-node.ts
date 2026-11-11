/**
 * What every kind of mesh node shares, whatever it does besides: an identity
 * key kept on its own disk, the trust settings it reads from the mesh, its
 * reliability record in its own journal, and the disk it measures. (What the
 * mesh looks like is answered by `mesh-nodes-reader.ts`, which reads a board
 * and no file.)
 *
 * A box worker takes jobs through the mesh (`mesh-worker.ts`). A developer's
 * machine running jobs for one repository and a relay host do not, but both
 * are nodes: they advertise, are listed, and can list the others. For those
 * two, `createMeshNode` is the whole of their membership.
 */
import { statfsSync } from "node:fs";
import { chmod, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
	assessMeshTrust,
	createMeshMonitor,
	createTrustedMeshBoard,
	decayMeshReliability,
	effectiveMeshTrust,
	generateMeshIdentity,
	MESH_RELIABILITY_DEFAULTS,
	type MeshBoard,
	type MeshConfigStore,
	type MeshEvent,
	type MeshFree,
	type MeshIdentity,
	type MeshMonitorEvent,
	type MeshNode,
	type MeshOutcome,
	type MeshPlatform,
	type MeshReliability,
	type MeshReliabilityOptions,
	type MeshReliabilitySamples,
	type MeshTrustPolicy,
	meshIdentityFromPem,
	meshReliabilityScore,
	newMeshReliability,
	recordMeshOutcome,
	signMeshAdvert,
} from "@hobo/ci/mesh";
import { createMeshNodesReader } from "./mesh-nodes-reader.js";
import {
	meshReliabilityRecordJson,
	meshTrustConfigJson,
	parseMeshReliabilityRecord,
	parseMeshTrustConfig,
} from "./mesh-records.js";

export {
	createMeshNodesReader,
	type MeshNodesReader,
} from "./mesh-nodes-reader.js";

type Fields = Readonly<Record<string, string | number | boolean>>;

export type MeshNodeEvent =
	| MeshEvent
	| MeshMonitorEvent
	| "hobo_ci_mesh_trust_unreadable"
	| "hobo_ci_mesh_trust_changed";

/** The file operations loading an identity key needs; replaced in tests. */
export type MeshKeyFiles = Readonly<{
	chmod: typeof chmod;
}>;

/** The system error code an fs call failed with, when it was a system error. */
function errorCode(error: Error | undefined): string | undefined {
	return error && "code" in error ? String(error.code) : undefined;
}

/**
 * The node's identity key, read from `path` or made there on first start.
 * The file holds the private key as PKCS#8 PEM and is readable by its owner
 * only; it is never published, logged or sent. Losing it gives the node a
 * new identity, which the mesh's operator must list again to trust.
 *
 * The directory holding it must not be writable by group or others (anyone
 * who can write there can swap the key): that is refused, not repaired. A
 * key file others can read or write is tightened to 0600; if it cannot be,
 * the key is refused. A key already private is never touched, so one on a
 * read-only filesystem loads.
 */
export async function loadMeshIdentity(
	path: string,
	files: MeshKeyFiles = { chmod },
): Promise<MeshIdentity> {
	const directory = dirname(path);
	await mkdir(directory, { recursive: true, mode: 0o700 });
	if ((await stat(directory)).mode & 0o022)
		throw new Error(
			`mesh identity key directory ${directory} is writable by group or others; make it private (chmod go-w) or set HOBO_CI_MESH_KEY_FILE elsewhere`,
		);
	let text: string | undefined;
	try {
		text = await readFile(path, "utf8");
	} catch (error) {
		if (errorCode(error instanceof Error ? error : undefined) !== "ENOENT")
			throw error;
	}
	if (text !== undefined) {
		const identity = meshIdentityFromPem(text);
		if ((await stat(path)).mode & 0o077)
			try {
				await files.chmod(path, 0o600);
			} catch (error) {
				throw new Error(
					`mesh identity key ${path} is readable by others and could not be made private (${errorCode(error instanceof Error ? error : undefined) ?? "unknown"}); chmod 600 it`,
				);
			}
		return identity;
	}
	const created = generateMeshIdentity();
	try {
		// `wx`: two processes starting together must not each write a key.
		await writeFile(path, created.privateKeyPem, { mode: 0o600, flag: "wx" });
		return created.identity;
	} catch (error) {
		if (errorCode(error instanceof Error ? error : undefined) !== "EEXIST")
			throw error;
		return meshIdentityFromPem(await readFile(path, "utf8"));
	}
}

/**
 * Disk a job could use right now on the filesystem holding `path`, in MiB:
 * the blocks an unprivileged process may still take. Nothing when the
 * filesystem cannot be asked, so the node says "unknown" and not zero.
 */
export function freeDiskMb(path: string): number | undefined {
	try {
		const stats = statfsSync(path);
		const megabytes = Math.floor((stats.bavail * stats.bsize) / (1024 * 1024));
		return Number.isSafeInteger(megabytes) && megabytes >= 0
			? Math.min(megabytes, 1_073_741_824)
			: undefined;
	} catch {
		return undefined;
	}
}

/** The journal calls a node's reliability record is kept through. */
export type MeshJournal = Readonly<{
	controlRecord(
		key: string,
	):
		| Promise<{ bodyJson: string } | undefined>
		| { bodyJson: string }
		| undefined;
	putControlRecord(
		key: string,
		accountId: string,
		bodyJson: string,
		at: string,
	): Promise<void> | void;
}>;

/** Control records need an owner; this one belongs to the node, not an account. */
const JOURNAL_OWNER = "hobo-ci-mesh";

/**
 * The reset an operator asked for, from `HOBO_CI_MESH_RELIABILITY_RESET`:
 * unset or `0` asks for none; any other value (`1`, a date) is a token, and
 * the record is cleared once per token.
 */
export function meshReliabilityResetToken(
	value: string | undefined,
): string | undefined {
	if (value === undefined || value === "" || value === "0") return undefined;
	if (!/^[A-Za-z0-9._:-]{1,64}$/.test(value))
		throw new Error(
			"invalid HOBO_CI_MESH_RELIABILITY_RESET: 0, or a token of letters, digits, . _ : -",
		);
	return value;
}

/**
 * A node's reliability record in its SQLite journal, so the record of the
 * jobs it dropped outlives the process. Reading or writing never fails the
 * node: without the journal it carries on with what it has in memory.
 *
 * `resetToken` clears the record at load, once: the token is kept with the
 * record, and a load with the token already applied leaves the record as
 * it is. So a reset variable left set does not clear every restart.
 */
export function meshReliabilityJournal(
	journal: MeshJournal,
	nodeId: string,
	onError?: (message: string) => void,
	resetToken?: string | undefined,
) {
	const key = `mesh-reliability:${nodeId}`;
	const failed = (error: Error | undefined) =>
		onError?.(error?.message ?? "unknown");
	/** The token kept with every write: the one applied, or the one found. */
	let token = "";
	const write = async (record: MeshReliability) => {
		try {
			await journal.putControlRecord(
				key,
				JOURNAL_OWNER,
				meshReliabilityRecordJson(record, token),
				new Date(record.atMs).toISOString(),
			);
		} catch (error) {
			failed(error instanceof Error ? error : undefined);
		}
	};
	return {
		/**
		 * The record kept, or nothing to start from: none kept, or a reset
		 * just applied. `reset` says which.
		 */
		async load(
			nowMs: number = Date.now(),
		): Promise<{ record: MeshReliability | undefined; reset: boolean }> {
			let stored: ReturnType<typeof parseMeshReliabilityRecord>;
			try {
				const row = await journal.controlRecord(key);
				stored = row ? parseMeshReliabilityRecord(row.bodyJson) : undefined;
			} catch (error) {
				failed(error instanceof Error ? error : undefined);
				return { record: undefined, reset: false };
			}
			token = stored?.resetToken ?? "";
			if (resetToken !== undefined && resetToken !== token) {
				token = resetToken;
				// Recorded now, so a crash before the first job does not reset again.
				await write({ delivered: 0, dropped: 0, atMs: nowMs });
				return { record: undefined, reset: true };
			}
			return { record: stored?.record, reset: false };
		},
		save: write,
	};
}

/**
 * A node's count of the jobs it delivered and dropped, for a node whose
 * outcomes are simple to tell (a box worker keeps its own, with the cases a
 * queue adds). It starts from what the journal kept and hands every change
 * to `persist`.
 */
export function createMeshReliabilityLedger(options: {
	initial?: MeshReliability | undefined;
	scoring?: MeshReliabilityOptions;
	persist?: (record: MeshReliability) => void;
	now?: () => number;
}) {
	const now = options.now ?? Date.now;
	const scoring = options.scoring ?? MESH_RELIABILITY_DEFAULTS;
	let record = options.initial ?? newMeshReliability(now());
	return {
		count(outcome: MeshOutcome): void {
			record = recordMeshOutcome(record, outcome, now(), scoring);
			try {
				options.persist?.(record);
			} catch {
				// The count in memory stands; the next one is written again.
			}
		},
		score: (): number => meshReliabilityScore(record, now(), scoring),
		samples(): MeshReliabilitySamples {
			const current = decayMeshReliability(record, now(), scoring);
			return {
				delivered: Math.round(current.delivered * 100) / 100,
				dropped: Math.round(current.dropped * 100) / 100,
			};
		},
	};
}

/**
 * The trust settings a node works by: the mesh's stored set when it has
 * one, the node's own key alone when it has none. `refresh` reads the store;
 * between reads, and whenever the store cannot be reached, the last answer
 * stands.
 */
export function createMeshTrust(options: {
	/** Where the mesh keeps its trust settings; absent on a node with no mesh. */
	store?: MeshConfigStore | undefined;
	selfPublicKey?: string | undefined;
	log?: ((event: MeshNodeEvent, fields: Fields) => void) | undefined;
}) {
	let configured: MeshTrustPolicy | undefined;
	/**
	 * Settings are stored and this node has never been able to read them:
	 * it fails closed, trusting only itself and ranking only trusted nodes,
	 * until it reads settings it understands.
	 */
	let unreadable = false;
	/** The revision last read; zero is "nothing stored". */
	let revision: number | undefined;
	const policy = (): MeshTrustPolicy =>
		unreadable && configured === undefined
			? {
					trustedKeys:
						options.selfPublicKey === undefined
							? []
							: [{ publicKey: options.selfPublicKey }],
					requireTrusted: true,
				}
			: effectiveMeshTrust(configured, options.selfPublicKey);
	return {
		policy,
		requireTrusted: () => policy().requireTrusted,
		async refresh(): Promise<void> {
			if (!options.store) return;
			let stored: { value: string; revision: number } | undefined;
			try {
				stored = await options.store.read();
			} catch {
				// Unreachable: the board will say so. Keep what was read last.
				return;
			}
			const next = stored?.revision ?? 0;
			if (next === revision) return;
			const first = revision === undefined;
			revision = next;
			const parsed = stored ? parseMeshTrustConfig(stored.value) : undefined;
			if (stored && !parsed) {
				// Unreadable settings are not half-applied. The last good ones
				// stand; with none, the node fails closed (see `policy`).
				unreadable = true;
				options.log?.("hobo_ci_mesh_trust_unreadable", {
					revision: next,
					failedClosed: configured === undefined,
				});
				return;
			}
			unreadable = false;
			configured = parsed;
			// Nothing stored at the first read is the default, not a change.
			if (first && !parsed) return;
			options.log?.("hobo_ci_mesh_trust_changed", {
				revision: next,
				trustedKeys: parsed?.trustedKeys.length ?? 0,
				requireTrusted: parsed?.requireTrusted ?? false,
			});
		},
	};
}

export type MeshTrustSettings = ReturnType<typeof createMeshTrust>;

/** One edit an operator makes to the mesh's trust settings. */
export type MeshTrustChange = Readonly<
	| {
			kind: "add";
			publicKey: string;
			/** Trust the key for this node id only. */
			nodeId?: string | undefined;
			/**
			 * Trust the key under any node id no entry binds. Required to add a
			 * key without `nodeId`: a key some job could read (a local runner's
			 * is in the repository's checkout tree) must never be trusted so.
			 */
			anyNode?: boolean | undefined;
	  }
	| { kind: "remove"; publicKey: string }
	| { kind: "require"; requireTrusted: boolean }
>;

/**
 * Applies one edit to the trust settings stored in the mesh and resolves to
 * what is stored afterwards. The write names the revision it read, so two
 * operators editing at once cannot silently undo each other: the loser reads
 * again and reapplies. Stored settings this version cannot read are never
 * overwritten; that is refused, for a person to look at.
 *
 * Whoever may write to the mesh's config bucket may change whom the mesh
 * trusts. That bucket's access control is the root of this trust.
 */
export async function changeMeshTrust(
	store: MeshConfigStore,
	change: MeshTrustChange,
): Promise<MeshTrustPolicy> {
	if (change.kind === "add" && change.nodeId === undefined && !change.anyNode)
		throw new Error(
			"a key is trusted for one node id (--node <id>); trusting it under any id needs --any-node",
		);
	for (let attempt = 0; attempt < 5; attempt += 1) {
		const stored = await store.read();
		const current: MeshTrustPolicy | undefined = stored
			? parseMeshTrustConfig(stored.value)
			: { trustedKeys: [], requireTrusted: false };
		if (!current)
			throw new Error("stored mesh trust settings cannot be read; not changed");
		const others = current.trustedKeys.filter(
			(entry) =>
				change.kind === "require" || entry.publicKey !== change.publicKey,
		);
		const next: MeshTrustPolicy =
			change.kind === "require"
				? { ...current, requireTrusted: change.requireTrusted }
				: {
						...current,
						trustedKeys:
							change.kind === "remove"
								? others
								: [
										...others,
										change.nodeId === undefined
											? { publicKey: change.publicKey }
											: { publicKey: change.publicKey, nodeId: change.nodeId },
									],
					};
		const published = await store.publish(
			meshTrustConfigJson(next),
			stored?.revision,
		);
		if (published !== "conflict") return next;
	}
	throw new Error("mesh trust settings kept changing; not changed");
}

/** What a node says about itself on each beat. */
export type MeshNodeDescription = Readonly<{
	freeSlots: number;
	totalSlots: number;
	healthy: boolean;
	labels: readonly string[];
	free?: MeshFree | undefined;
	platform?: MeshPlatform | undefined;
	reliability?: number | undefined;
	samples?: MeshReliabilitySamples | undefined;
	/** For a machine running jobs for one repository, that repository. */
	repository?: string | undefined;
}>;

/**
 * Since when a node has been in its current health state: the moment it
 * started, and afterwards each moment `healthy` changed.
 */
export function createHealthSince(now: () => number) {
	let healthy: boolean | undefined;
	let sinceMs = now();
	return (current: boolean): number => {
		if (healthy !== undefined && healthy !== current) sinceMs = now();
		healthy = current;
		return sinceMs;
	};
}

/**
 * A node that is in the mesh without taking jobs through it: a developer's
 * machine running jobs for one repository, or a relay host. It signs and
 * advertises what `describe` says, watches the board like any node, and
 * answers what the mesh looks like. With no `mesh` it is offline: it
 * advertises nowhere and still reports itself.
 */
export function createMeshNode(options: {
	nodeId: string;
	identity: MeshIdentity;
	/** The shared board and trust store; absent when no mesh is configured. */
	mesh?: Readonly<{ board: MeshBoard; trust: MeshConfigStore }> | undefined;
	describe: () => MeshNodeDescription;
	/** How long an advertisement is trusted; refresh well inside it. */
	advertTtlMs?: number | undefined;
	retainLostMs?: number | undefined;
	now?: () => number;
	log?: ((event: MeshNodeEvent, fields: Fields) => void) | undefined;
}) {
	const now = options.now ?? Date.now;
	const advertTtlMs = options.advertTtlMs ?? 45_000;
	const since = createHealthSince(now);
	const trust = createMeshTrust({
		store: options.mesh?.trust,
		selfPublicKey: options.identity.publicKey,
		log: options.log,
	});
	const board = options.mesh
		? createTrustedMeshBoard({
				board: options.mesh.board,
				identity: options.identity,
				policy: trust.policy,
			})
		: undefined;
	const self = (): MeshNode => {
		const state = options.describe();
		return {
			id: options.nodeId,
			freeSlots: Math.max(0, Math.floor(state.freeSlots)),
			totalSlots: Math.max(0, Math.floor(state.totalSlots)),
			healthy: state.healthy,
			labels: state.labels,
			validUntilMs: now() + advertTtlMs,
			free: state.free,
			platform: state.platform,
			reliability: state.reliability,
			samples: state.samples,
			sinceMs: since(state.healthy),
			repository: state.repository,
		};
	};
	const monitor = board
		? createMeshMonitor({
				selfId: options.nodeId,
				board,
				requireTrusted: trust.requireTrusted,
				now,
				log: (event, fields) => options.log?.(event, fields),
			})
		: undefined;
	let boardDown = false;
	const reportBoard = (down: boolean, message: string) => {
		if (down === boardDown) return;
		boardDown = down;
		options.log?.(
			down ? "hobo_ci_mesh_board_unreachable" : "hobo_ci_mesh_board_recovered",
			{ message },
		);
	};
	return {
		self,
		publicKey: options.identity.publicKey,
		/** The signing, trust-assessing board; absent when offline. */
		board,
		trust,
		/**
		 * One beat: read the trust settings, advertise, and report what
		 * changed on the board. Never throws; an unreachable board is logged
		 * once and the node tries again on its next beat.
		 */
		async beat(): Promise<void> {
			if (!board) return;
			await trust.refresh();
			try {
				await board.advertise(self());
				reportBoard(false, "");
			} catch (error) {
				reportBoard(true, error instanceof Error ? error.message : "unknown");
			}
			await monitor?.observe();
		},
		/** What the mesh looks like from here; see `createMeshNodesReader`. */
		reports: createMeshNodesReader({
			board,
			// Signed, as it would be on a board: the report then names this
			// node's public key, which is what an operator lists to trust it.
			self: () => signMeshAdvert(self(), options.identity),
			assess: (node) => assessMeshTrust(node, trust.policy()),
			requireTrusted: trust.requireTrusted,
			retainLostMs: options.retainLostMs,
			now,
		}),
	};
}

export type MeshNodeHandle = ReturnType<typeof createMeshNode>;
