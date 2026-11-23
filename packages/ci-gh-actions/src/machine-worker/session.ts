import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { create } from "@bufbuild/protobuf";
import type { MeshIdentity } from "@hobo/ci/mesh";
import { generateMeshIdentity, meshIdentityFromPem } from "@hobo/ci/mesh";
import { z } from "zod";
import type { MachineProfile } from "./advert.js";
import { pause } from "./executor.js";
import type { MachineGithub } from "./jobs.js";
import {
	defineStoredMachine,
	type ParsedMachineWorkerRecord,
	parseStoredMachine,
	type StoredMachine,
	StoredMachineSchema,
	storedMachineJson,
} from "./records.js";
import type { MachineWorker, MachineWorkerStatus } from "./worker.js";

// public-contract: the file under the machine directory that holds its id and name.
export const MACHINE_FILE = "machine.json";
// public-contract: the file under the machine directory that holds its private key (mode 0600).
export const MACHINE_KEY_FILE = "machine-key.pem";
// public-contract: how often a connected machine's worker ticks.
export const MACHINE_TICK_MS = 1_000;

export type LoadedMachine = Readonly<{
	id: string;
	name: string;
	identity: MeshIdentity;
	created: boolean;
}>;

export async function loadMachine(
	directory: string,
	options: Readonly<{ name: string | undefined; defaultName: string }>,
): Promise<LoadedMachine> {
	const file = join(directory, MACHINE_FILE);
	const keyFile = join(directory, MACHINE_KEY_FILE);
	const stored = await readFile(file, "utf8").catch(() => undefined);
	const pem = await readFile(keyFile, "utf8").catch(() => undefined);
	if (stored !== undefined && pem !== undefined) {
		let kept: ParsedMachineWorkerRecord<StoredMachine>;
		try {
			kept = parseStoredMachine(stored);
		} catch (error) {
			throw new Error(
				`${file} is not a machine HoBo CI wrote: ${error instanceof Error ? error.message : "unreadable"}`,
			);
		}
		const name = options.name ?? kept.name;
		if (name !== kept.name)
			await writeFile(file, storedMachineJson(storedMachine(kept.id, name)), {
				mode: 0o600,
			});
		return {
			id: kept.id,
			name,
			identity: meshIdentityFromPem(pem),
			created: false,
		};
	}
	const machine = storedMachine(
		`m-${randomBytes(6).toString("hex")}`,
		options.name ?? options.defaultName,
	);
	const generated = generateMeshIdentity();
	await mkdir(directory, { recursive: true, mode: 0o700 });
	await writeFile(keyFile, generated.privateKeyPem, { mode: 0o600 });
	await writeFile(file, storedMachineJson(machine), { mode: 0o600 });
	return {
		id: machine.id,
		name: machine.name,
		identity: generated.identity,
		created: true,
	};
}

function storedMachine(
	id: string,
	name: string,
): ParsedMachineWorkerRecord<StoredMachine> {
	return defineStoredMachine(create(StoredMachineSchema, { id, name }));
}

export type MachinePlatform =
	| Readonly<{ supported: true; os: "linux"; arch: "x64" | "arm64" }>
	| Readonly<{ supported: false; reason: string }>;

export function machinePlatform(
	platform: string,
	arch: string,
): MachinePlatform {
	if (platform !== "linux")
		return {
			supported: false,
			reason: `Only Linux machines can connect yet (this one is ${platform}); the pinned runner archives are for Linux.`,
		};
	if (arch !== "x64" && arch !== "arm64")
		return {
			supported: false,
			reason: `Only x64 and arm64 machines can connect (this one is ${arch}).`,
		};
	return { supported: true, os: "linux", arch };
}

const User = z.object({
	id: z.number().int().positive(),
	login: z.string().min(1),
});

export async function githubOwner(
	github: MachineGithub,
): Promise<Pick<MachineProfile, "ownerId" | "ownerLogin"> | undefined> {
	const response = await github.request("/user");
	if (!response.ok) return undefined;
	const parsed = User.safeParse(await response.json());
	return parsed.success
		? { ownerId: String(parsed.data.id), ownerLogin: parsed.data.login }
		: undefined;
}

export type MachineSession = Readonly<{
	stop(): void;
	togglePause(): Promise<boolean>;
	done: Promise<MachineWorkerStatus>;
}>;

export function runMachineSession(
	options: Readonly<{
		worker: MachineWorker;
		tickEveryMs?: number;
		wait?: (ms: number, signal: AbortSignal) => Promise<void>;
		onError?: (error: Error) => void;
	}>,
): MachineSession {
	const { worker } = options;
	const everyMs = options.tickEveryMs ?? MACHINE_TICK_MS;
	const wait = options.wait ?? pause;
	const stopping = new AbortController();
	let requested: "drain" | "hand_off" | undefined;
	let ticking: Promise<void> = Promise.resolve();
	let handingOff: Promise<void> | undefined;

	async function loop(): Promise<MachineWorkerStatus> {
		while (!stopping.signal.aborted && worker.status().refused === undefined) {
			ticking = worker.tick().catch((error: Error) => {
				options.onError?.(error);
			});
			await ticking;
			if (stopping.signal.aborted) break;
			await wait(everyMs, stopping.signal);
		}
		if (worker.status().refused !== undefined && requested === undefined)
			await worker.handOff();
		else if (requested !== undefined) await worker.drain();
		if (handingOff) await handingOff;
		return worker.status();
	}

	return {
		stop() {
			if (requested === undefined) {
				requested = "drain";
				stopping.abort();
				return;
			}
			if (requested === "drain") {
				requested = "hand_off";
				handingOff = ticking.then(() => worker.handOff());
			}
		},
		async togglePause() {
			const next = !worker.status().paused;
			await worker.setPaused(next);
			return next;
		},
		done: loop(),
	};
}
