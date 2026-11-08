/**
 * Global setup for this package's suite: a guard that fails the run when a
 * real HoBo home changed during it.
 *
 * `test/isolate-user-home.ts` and the root's `test/setup/isolate-hobo-home.ts`
 * point HOME and HOBO_HOME at directories inside the run's root of throwaway
 * homes (the root's `test/setup/hobo-test-homes.ts`, the global setup before
 * this one), so an in-process call that omits its home lands there. That cannot reach a child
 * process started with an environment of its own, or a path built from a
 * literal. The guard covers both: before the run it lists what is already in
 * each real HoBo home and starts watching it, and after the run it names
 * whatever changed.
 *
 * The homes it watches are the ones a stray write lands in:
 *  - `/tmp/.hobo` and `<os.tmpdir()>/.hobo`, the old fallbacks for an
 *    environment with no HOME;
 *  - `<HOME>/.hobo` for the HOME this run was started with, and
 *    `<account home>/.hobo` for a child whose environment names no HOME;
 *  - the HOBO_HOME the runner exported, which the isolation replaced.
 *
 * They may already hold a developer's own state, and on a shared machine they
 * may hold evidence of an earlier leak, so the guard compares against what was
 * there when the run started and never requires them to be absent or empty.
 * It walks each home one directory at a time: a directory a live session
 * removed between being listed and being read is listed again if it is back
 * and recorded as gone if not, so one vanished `sandboxes/<runId>` never turns
 * the rest of the home into "new" entries. It still reports any entry that was
 * not there when its first walk passed.
 * A symlink to a directory is walked through, once, and never back into the
 * home or up to an ancestor of it (`real-home-snapshot.ts`).
 * It reports entries that appeared, entries that were removed, and entries
 * that changed: another kind, inode or mode, a symlink's new target, or a
 * file's size, mtime or ctime (so an overwrite that put the bytes and mtime
 * back is still seen; a directory's own times move with its entries, so only
 * those are compared). It also watches each home for the whole run
 * (`real-home-watch.ts`) and reports a path written there that the snapshot
 * after the run cannot show, such as a file written and removed again. It
 * cannot tell who wrote an entry, so a HoBo session, or
 * another checkout's suite without this isolation, writing there during the
 * run fails it too; the chat and session files it names carry the `cwd` of
 * the process that wrote them.
 *
 * The account's home and the runner's real HOME are watched whatever
 * HOBO_HOME says, and so is the HOBO_HOME the runner exported: every test file
 * gets a throwaway home in its place (`test/setup/isolate-hobo-home.ts`),
 * whether it was `$HOME/.hobo`, as the product's docs suggest, or
 * `$HOME/.local/state/hobo`, and a write into the replaced one still fails
 * the run. `HOBO_TEST_HOBO_HOME` is the deliberate way to run against a real
 * home, and the guard reports what that run wrote there.
 */
import { realpathSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join, resolve, sep } from "node:path";
import {
	AMBIENT_HOME_ENV,
	REAL_HOME_ENV,
	recordRealHome,
} from "../../../test/setup/hobo-test-homes.js";
import {
	changedEntries,
	gainedEntries,
	removedEntries,
	snapshotHomes,
} from "./real-home-snapshot.js";
import { watchHomes } from "./real-home-watch.js";

function canonical(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		return resolve(path);
	}
}

/**
 * The account's home from the password database, or none: a uid with no
 * passwd entry (a container's `--user 4242`) has no account home to watch
 * beyond HOME, and `os.userInfo()` throws for it.
 */
/** Asks the password database for this account's home; `os.userInfo()` throws for a uid it lacks. */
export type PasswdHome = () => string;

const passwdHome: PasswdHome = () => userInfo().homedir;

function accountHome(passwd: PasswdHome): string | undefined {
	try {
		return passwd() || undefined;
	} catch {
		return undefined;
	}
}

/** The temp directories whose `.hobo` an environment with no HOME once fell back to. */
function defaultTempDirs(): string[] {
	return ["/tmp", tmpdir()];
}

/** The real HoBo homes a stray write lands in, for this process's environment. */
export function watchedHomes(
	env: NodeJS.ProcessEnv = process.env,
	passwd: PasswdHome = passwdHome,
	tempDirs: readonly string[] = defaultTempDirs(),
): string[] {
	const account = accountHome(passwd);
	const recorded = env[REAL_HOME_ENV]?.trim() ? env[REAL_HOME_ENV] : undefined;
	const home = recorded ?? (env.HOME?.trim() ? env.HOME : account);
	const ambient = ambientHome(env, home);
	const candidates = [
		...tempDirs.map((dir) => join(dir, ".hobo")),
		...(home ? [join(home, ".hobo")] : []),
		...(account ? [join(account, ".hobo")] : []),
		...(ambient ? [ambient] : []),
	].map(canonical);
	return [...new Set(candidates)];
}

/**
 * The HOBO_HOME the runner exported, which every test file's isolation
 * replaced (`test/setup/isolate-hobo-home.ts`): a test writing it anyway wrote
 * whatever state lives there. A leading `~` is the real HOME, as the resolver
 * reads it.
 */
function ambientHome(
	env: NodeJS.ProcessEnv,
	home: string | undefined,
): string | undefined {
	const value = env[AMBIENT_HOME_ENV]?.trim();
	if (!value) return undefined;
	if (home && (value === "~" || value.startsWith("~/")))
		return join(home, value.slice(1));
	return resolve(value);
}

/** How many paths of each kind the failure names before it summarises the rest. */
const LISTED = 20;

function section(title: string, paths: readonly string[]): string[] {
	if (paths.length === 0) return [];
	const listed = paths.slice(0, LISTED).map((path) => `  ${path}`);
	if (paths.length > LISTED)
		listed.push(`  … and ${paths.length - LISTED} more`);
	return [`${title}:`, ...listed];
}

export interface HomeChanges {
	readonly gained: readonly string[];
	readonly changed: readonly string[];
	readonly removed: readonly string[];
	/** Paths the watch heard written during the run that none of the above names. */
	readonly touched: readonly string[];
}

export function describeChanges(changes: HomeChanges): string {
	return [
		"A real HoBo home changed while packages/code tests ran: this run, or",
		"another process during it, wrote there. Give each test its own hoboHome",
		"(or HOME) in a temp dir it removes; if a HoBo session or another",
		"checkout's suite was writing there, run again once it is done.",
		"During the run:",
		...section("appeared", changes.gained),
		...section("changed", changes.changed),
		...section("removed", changes.removed),
		...section("written, then removed or put back", changes.touched),
	].join("\n");
}

/**
 * What the watch heard that the snapshots do not already name: not a changed
 * path, and not one at or under a path that appeared or was removed.
 */
export function untold(
	touched: readonly string[],
	told: Omit<HomeChanges, "touched">,
): string[] {
	const whole = [...told.gained, ...told.removed];
	const changed = new Set(told.changed);
	return touched.filter(
		(path) =>
			!changed.has(path) &&
			!whole.some((dir) => path === dir || path.startsWith(`${dir}${sep}`)),
	);
}

/** How long the teardown waits for the watch's last events to arrive. */
const SETTLE_MS = 100;

/**
 * Where the guard looks, for a run of the guard itself: its own tests probe it
 * with an account home and a temp directory of the probe's, so another process
 * writing the machine's real `~/.hobo` or `/tmp/.hobo` meanwhile cannot fail
 * them. A real run uses the password database and `/tmp` and `os.tmpdir()`.
 */
export interface GuardPorts {
	readonly passwd?: PasswdHome;
	readonly tempDirs?: readonly string[];
}

/**
 * The global setup: snapshot the watched homes and watch them, and fail the
 * run if they changed, or if the watch heard a write the snapshot after the
 * run cannot show.
 */
export function realHomeGuard(
	ports: GuardPorts = {},
): () => () => Promise<void> {
	return () => {
		recordRealHome();
		const homes = watchedHomes(
			process.env,
			ports.passwd ?? passwdHome,
			ports.tempDirs ?? defaultTempDirs(),
		);
		const watch = watchHomes(homes);
		for (const path of watch.unwatched)
			process.stderr.write(
				`real-home guard: cannot watch ${path}; it still compares snapshots\n`,
			);
		const before = snapshotHomes(homes);
		return async () => {
			await new Promise((done) => setTimeout(done, SETTLE_MS));
			watch.close();
			const after = snapshotHomes(homes);
			const told = {
				gained: gainedEntries(before, after),
				changed: changedEntries(before, after),
				removed: removedEntries(before, after),
			};
			const changes = { ...told, touched: untold(watch.touched(), told) };
			if (
				changes.gained.length +
					changes.changed.length +
					changes.removed.length +
					changes.touched.length ===
				0
			)
				return;
			// Vitest logs a teardown error but keeps the exit status it already had.
			process.exitCode = 1;
			throw new Error(describeChanges(changes));
		};
	};
}

export default realHomeGuard();
