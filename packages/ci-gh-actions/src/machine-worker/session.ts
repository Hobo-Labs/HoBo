/**
 * One `hobo ci machine connect` session (ADR-0183): who the machine is, who
 * connected it, and the loop that keeps the worker going until its owner
 * stops it.
 *
 * The machine's id and Ed25519 key live in a directory under HOBO_HOME and
 * are made on the first connect, so a machine keeps one id and one key the
 * registry pins. The owner is the GitHub user whose token the CLI was given
 * (`GET /user`). The loop ticks the worker every second; the first stop
 * drains it (running jobs finish), a second hands off (running jobs are
 * stopped), and either way the machine goes offline at once.
 */
import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { MeshIdentity } from "@hobo/ci/mesh";
import { generateMeshIdentity, meshIdentityFromPem } from "@hobo/ci/mesh";
import { z } from "zod";
import type { MachineProfile } from "./advert.js";
import { pause } from "./executor.js";
import type { MachineGithub } from "./jobs.js";
import type { MachineWorker, MachineWorkerStatus } from "./worker.js";

// public-contract: the file under the machine directory that holds its id and name.
export const MACHINE_FILE = "machine.json";
// public-contract: the file under the machine directory that holds its private key (mode 0600).
export const MACHINE_KEY_FILE = "machine-key.pem";
// public-contract: how often a connected machine's worker ticks.
export const MACHINE_TICK_MS = 1_000;

const MachineFile = z.object({
	id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/u),
	name: z.string().min(1).max(100),
});

const Json = z.json();

/** The machine as it is stored between connects. */
export type StoredMachine = Readonly<{
	id: string;
	name: string;
	identity: MeshIdentity;
	/** Made on this connect. */
	created: boolean;
}>;

/**
 * The machine kept in `directory`, made there when none is: a new id
 * (`m-` and 12 hex digits) and a new Ed25519 key, written owner-only. A name
 * given now replaces the stored one; the id and key never change.
 */
export async function loadMachine(
	directory: string,
	options: Readonly<{ name: string | undefined; defaultName: string }>,
): Promise<StoredMachine> {
	const file = join(directory, MACHINE_FILE);
	const keyFile = join(directory, MACHINE_KEY_FILE);
	const stored = await readFile(file, "utf8").catch(() => undefined);
	const pem = await readFile(keyFile, "utf8").catch(() => undefined);
	if (stored !== undefined && pem !== undefined) {
		const parsed = MachineFile.safeParse(parseJson(stored));
		if (!parsed.success)
			throw new Error(`${file} is not a machine HoBo CI wrote`);
		const name = options.name ?? parsed.data.name;
		if (name !== parsed.data.name)
			await writeFile(
				file,
				`${JSON.stringify({ id: parsed.data.id, name })}\n`,
				{ mode: 0o600 },
			);
		return {
			id: parsed.data.id,
			name,
			identity: meshIdentityFromPem(pem),
			created: false,
		};
	}
	const machine = MachineFile.parse({
		id: `m-${randomBytes(6).toString("hex")}`,
		name: options.name ?? options.defaultName,
	});
	const generated = generateMeshIdentity();
	await mkdir(directory, { recursive: true, mode: 0o700 });
	await writeFile(keyFile, generated.privateKeyPem, { mode: 0o600 });
	await writeFile(file, `${JSON.stringify(machine)}\n`, { mode: 0o600 });
	return { ...machine, identity: generated.identity, created: true };
}

function parseJson(text: string): z.infer<typeof Json> {
	try {
		return Json.parse(JSON.parse(text));
	} catch {
		return null;
	}
}

/** The OS and architecture labels of a Linux machine, or why it cannot connect yet. */
export function machinePlatform(
	platform: string,
	arch: string,
): Readonly<{ os: "linux"; arch: "x64" | "arm64" }> | string {
	if (platform !== "linux")
		return `Only Linux machines can connect yet (this one is ${platform}); the pinned runner archives are for Linux.`;
	if (arch !== "x64" && arch !== "arm64")
		return `Only x64 and arm64 machines can connect (this one is ${arch}).`;
	return { os: "linux", arch };
}

const User = z.object({
	id: z.number().int().positive(),
	login: z.string().min(1),
});

/** The GitHub user the token belongs to (`GET /user`), or undefined when GitHub says no. */
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

/** A running session: stop it, pause it, and wait for it to end. */
export type MachineSession = Readonly<{
	/** The first stop drains; a second hands off. */
	stop(): void;
	/** Pause when running, resume when paused; resolves with the new state. */
	togglePause(): Promise<boolean>;
	/** Ends once the machine is offline, or the registry refused it for good. */
	done: Promise<MachineWorkerStatus>;
}>;

/**
 * Tick `worker` every `tickEveryMs` until stopped. A tick that throws (GitHub
 * or the registry unreachable) is reported and the next one tries again.
 */
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
		if (requested !== undefined) await worker.drain();
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
				// After the tick in flight, so no job it starts is missed.
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
