/**
 * A trusted temporary vault: where a process keeps a secret it holds for one
 * run. It is the only sanctioned place for one between the secret store it
 * came from and the call that spends it.
 *
 * It is memory and nothing else: no file, no temporary directory, no
 * environment variable, no argument. A temporary file or an environment
 * variable is readable by every process of the same user (and an environment
 * variable by every child), which is what an untrusted process needs to take
 * it; process memory is not. So:
 *
 * - **Values are buffers that are wiped.** `clear`, an expiry and the process's
 *   `exit` overwrite each buffer with zeros before dropping it, so a value
 *   does not outlive its use in a heap that is later paged or dumped.
 * - **Nothing serializes it.** `JSON.stringify`, `util.inspect` and string
 *   conversion print the entry names only, so a vault that reaches a log or a
 *   result says what it holds, never a value.
 * - **Every value expires** (`ttlMs`, default 15 minutes): a run that forgets to
 *   clear still drops what it held.
 * - **Reading is explicit.** `reveal` is the one way a value leaves, named so a
 *   reviewer can find every place one does.
 */

// public-contract: the default lifetime of a value in a trusted vault.
export const TRUSTED_VAULT_DEFAULT_TTL_MS = 15 * 60_000;

export interface TrustedVault {
	put(name: string, value: string): void;
	has(name: string): boolean;
	/** The value, or undefined when absent or expired. */
	reveal(name: string): string | undefined;
	/** Wipe and drop one value. */
	drop(name: string): void;
	names(): readonly string[];
	/** Wipe and drop every value. */
	clear(): void;
}

type Entry = { readonly bytes: Buffer; readonly expiresAt: number };

const open = new Set<TrustedVault>();
let exitHooked = false;

function wipeAllOnExit(): void {
	if (exitHooked) return;
	exitHooked = true;
	process.once("exit", () => {
		for (const vault of open) vault.clear();
	});
}

const NAME = /^[A-Za-z_][A-Za-z0-9_.:-]{0,127}$/u;

/** Make a vault. Values live in this process's memory only. */
export function createTrustedVault(
	options: Readonly<{ ttlMs?: number; now?: () => number }> = {},
): TrustedVault {
	const ttlMs = options.ttlMs ?? TRUSTED_VAULT_DEFAULT_TTL_MS;
	const now = options.now ?? Date.now;
	const entries = new Map<string, Entry>();
	const wipe = (name: string) => {
		const entry = entries.get(name);
		if (entry === undefined) return;
		entry.bytes.fill(0);
		entries.delete(name);
	};
	const live = (name: string): Entry | undefined => {
		const entry = entries.get(name);
		if (entry === undefined) return undefined;
		if (now() >= entry.expiresAt) {
			wipe(name);
			return undefined;
		}
		return entry;
	};
	const describe = () =>
		`[TrustedVault ${[...entries.keys()].sort().join(", ") || "empty"}]`;
	const vault: TrustedVault & {
		toJSON(): { trustedVault: readonly string[] };
		toString(): string;
	} = {
		put(name, value) {
			if (!NAME.test(name)) throw new TypeError("trusted vault: bad entry name");
			wipe(name);
			entries.set(name, {
				bytes: Buffer.from(value, "utf8"),
				expiresAt: now() + ttlMs,
			});
		},
		has: (name) => live(name) !== undefined,
		reveal: (name) => live(name)?.bytes.toString("utf8"),
		drop: wipe,
		names: () => [...entries.keys()].filter((name) => live(name) !== undefined).sort(),
		clear() {
			// Deleting the entry being visited is safe while iterating a Map.
			for (const name of entries.keys()) wipe(name);
		},
		toJSON: () => ({ trustedVault: [...entries.keys()].sort() }),
		toString: describe,
	};
	Object.defineProperty(vault, Symbol.for("nodejs.util.inspect.custom"), {
		value: describe,
		enumerable: false,
	});
	open.add(vault);
	wipeAllOnExit();
	return vault;
}
