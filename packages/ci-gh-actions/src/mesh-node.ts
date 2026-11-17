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

export type MeshKeyFiles = Readonly<{
	chmod: typeof chmod;
}>;

function errorCode(error: Error | undefined): string | undefined {
	return error && "code" in error ? String(error.code) : undefined;
}

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
		await writeFile(path, created.privateKeyPem, { mode: 0o600, flag: "wx" });
		return created.identity;
	} catch (error) {
		if (errorCode(error instanceof Error ? error : undefined) !== "EEXIST")
			throw error;
		return meshIdentityFromPem(await readFile(path, "utf8"));
	}
}

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

const JOURNAL_OWNER = "hobo-ci-mesh";

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

export function meshReliabilityJournal(
	journal: MeshJournal,
	nodeId: string,
	onError?: (message: string) => void,
	resetToken?: string | undefined,
) {
	const key = `mesh-reliability:${nodeId}`;
	const failed = (error: Error | undefined) =>
		onError?.(error?.message ?? "unknown");
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
				await write({ delivered: 0, dropped: 0, atMs: nowMs });
				return { record: undefined, reset: true };
			}
			return { record: stored?.record, reset: false };
		},
		save: write,
	};
}

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
			} catch {}
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

export function createMeshTrust(options: {
	store?: MeshConfigStore | undefined;
	selfPublicKey?: string | undefined;
	log?: ((event: MeshNodeEvent, fields: Fields) => void) | undefined;
}) {
	let configured: MeshTrustPolicy | undefined;
	let unreadable = false;
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
				return;
			}
			const next = stored?.revision ?? 0;
			if (next === revision) return;
			const first = revision === undefined;
			revision = next;
			const parsed = stored ? parseMeshTrustConfig(stored.value) : undefined;
			if (stored && !parsed) {
				unreadable = true;
				options.log?.("hobo_ci_mesh_trust_unreadable", {
					revision: next,
					failedClosed: configured === undefined,
				});
				return;
			}
			unreadable = false;
			configured = parsed;
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

export type MeshTrustChange = Readonly<
	| {
			kind: "add";
			publicKey: string;
			nodeId?: string | undefined;
			anyNode?: boolean | undefined;
	  }
	| { kind: "remove"; publicKey: string }
	| { kind: "require"; requireTrusted: boolean }
>;

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

export type MeshNodeDescription = Readonly<{
	freeSlots: number;
	totalSlots: number;
	healthy: boolean;
	labels: readonly string[];
	free?: MeshFree | undefined;
	platform?: MeshPlatform | undefined;
	reliability?: number | undefined;
	samples?: MeshReliabilitySamples | undefined;
	repository?: string | undefined;
}>;

export function createHealthSince(now: () => number) {
	let healthy: boolean | undefined;
	let sinceMs = now();
	return (current: boolean): number => {
		if (healthy !== undefined && healthy !== current) sinceMs = now();
		healthy = current;
		return sinceMs;
	};
}

export function createMeshNode(options: {
	nodeId: string;
	identity: MeshIdentity;
	mesh?: Readonly<{ board: MeshBoard; trust: MeshConfigStore }> | undefined;
	describe: () => MeshNodeDescription;
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
		board,
		trust,
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
		reports: createMeshNodesReader({
			board,
			self: () => signMeshAdvert(self(), options.identity),
			assess: (node) => assessMeshTrust(node, trust.policy()),
			requireTrusted: trust.requireTrusted,
			retainLostMs: options.retainLostMs,
			now,
		}),
	};
}

export type MeshNodeHandle = ReturnType<typeof createMeshNode>;
