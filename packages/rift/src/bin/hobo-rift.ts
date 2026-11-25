#!/usr/bin/env node
/**
 * hobo-rift — virtual worktrees that work on this machine.
 *
 * Speaks the same shape as upstream rift (`init`, `create --name`, printing
 * the workspace path on stdout) so callers can use either, but picks the best
 * copy-on-write primitive the kernel offers instead of requiring btrfs.
 */
import { detectCapability } from "../capability.js";
import {
	createWorkspace,
	deriveContract,
	execCommand,
	initRoot,
	listDebris,
	pruneDebris,
	quoteVector,
	readRegistry,
	rebuildRegistry,
	removeWorkspace,
	runInWorkspace,
} from "../workspace.js";

const argv = process.argv.slice(2);

/**
 * Everything before `--`. The tail belongs to the command being exec'd, so a
 * `--name` inside it is the caller's argument, not ours.
 */
const sep = argv.indexOf("--");
const ours = sep >= 0 ? argv.slice(0, sep) : argv;

/** Flags that consume the next token; needed to tell a flag value from the verb. */
const VALUE_FLAGS = new Set(["--root", "--name", "--shell"]);

function flag(name: string): string | undefined {
	const i = ours.indexOf(`--${name}`);
	return i >= 0 ? ours[i + 1] : undefined;
}

/**
 * The verb, wherever it sits. `hobo-rift --root /x create` and
 * `hobo-rift create --root /x` are the same request; treating argv[0] as the
 * verb silently turned the first into a help screen with exit 0.
 */
function verb(): string {
	for (let i = 0; i < ours.length; i += 1) {
		const token = ours[i];
		if (token === undefined) {
			continue;
		}
		if (token.startsWith("-")) {
			if (VALUE_FLAGS.has(token)) i += 1;
			continue;
		}
		return token;
	}
	return "help";
}

const command = verb();
const root = flag("root") ?? process.cwd();
const json = ours.includes("--json");

/**
 * Print the human line, or the JSON form under `--json`.
 *
 * `data` is `unknown` because serializing is the only thing done with it. A
 * `JsonValue` parameter would be a promise this function does not need and
 * cannot check, paid for by every caller laundering an ordinary domain record
 * into a JSON view before handing it over.
 */
function emit(human: string, data: unknown): void {
	process.stdout.write(
		json ? `${JSON.stringify(data, null, 2)}\n` : `${human}\n`,
	);
}

if (command === "capability") {
	// Measured here, where both modules are available, rather than asserted in
	// the capability record itself.
	const cap = { ...detectCapability(root), contract: deriveContract() };
	emit(
		`${cap.tier} · ${cap.reason}${cap.isolatesInPlaceWrites ? "" : " · WARNING: in-place writes reach the source"}`,
		cap,
	);
} else if (command === "init") {
	const result = initRoot(root);
	emit(
		`${result.created ? "initialized" : "already registered"} ${result.root}`,
		result,
	);
} else if (command === "create") {
	const name = flag("name") ?? `ws-${Date.now()}`;
	const created = createWorkspace({
		root,
		name,
		copyAll: ours.includes("--copy-all"),
	});
	if (!created.workspace) {
		process.stderr.write(`${created.reason ?? "create failed"}\n`);
		process.exit(1);
	}
	if (created.debris) {
		// stderr, so `create` keeps printing exactly the path on stdout — but
		// an operator whose work was moved must be told where it went.
		process.stderr.write(
			`note: an unrecognised directory was in the way and was moved to ${created.debris} (not deleted)\n`,
		);
	}
	// Path on stdout, matching rift, so callers can capture it directly.
	emit(created.workspace.path, created.workspace);
} else if (command === "list") {
	const registry = readRegistry(root);
	const parked = listDebris(root);
	emit(
		[
			...registry.workspaces.map((w) => `${w.name}\t${w.tier}\t${w.path}`),
			// Parked directories hold real work; silence about them is how they
			// get forgotten and eventually fill a disk.
			...(parked.length > 0
				? [
						`\n${parked.length} parked director${parked.length === 1 ? "y" : "ies"} awaiting review (hobo-rift prune to delete):`,
						...parked.map((p) => `  ${p}`),
					]
				: []),
		].join("\n"),
		{ ...registry, debris: parked },
	);
} else if (command === "prune") {
	const removed = pruneDebris(root);
	emit(
		removed.length === 0
			? "no parked directories"
			: `deleted ${removed.length} parked director${removed.length === 1 ? "y" : "ies"}`,
		{ removed },
	);
} else if (command === "repair") {
	// Rebuild the snapshot from the journal after a torn write.
	const registry = rebuildRegistry(root);
	if (registry.undecidable) process.stderr.write(`${registry.undecidable}\n`);
	emit(
		`registry now lists ${registry.workspaces.length} workspace(s)`,
		registry,
	);
} else if (command === "remove") {
	const name = flag("name");
	if (!name) {
		process.stderr.write("remove needs --name\n");
		process.exit(2);
	}
	const removed = removeWorkspace(root, name);
	emit(removed ? `removed ${name}` : `no workspace named ${name}`, {
		removed,
		name,
	});
	// Reporting success for a workspace that was never there would let a caller
	// believe it had cleaned up something it had not.
	if (!removed) process.exitCode = 1;
} else if (command === "exec") {
	const name = flag("name");
	const vector = sep >= 0 ? argv.slice(sep + 1) : [];
	const snippet = flag("shell");
	// `--` takes an argv *vector*, and each element is quoted when the command
	// is reassembled. Joining with spaces looked equivalent and was not: the
	// caller's quoting is already consumed by their shell, so a workspace path
	// containing a space split into stray positionals, and one containing `;`
	// or `$(…)` executed in the namespace before the workspace command ever
	// ran. `--shell` is the explicit way to ask for shell syntax.
	const inner = snippet !== undefined ? snippet : quoteVector(vector);
	if (!name || inner.length === 0) {
		process.stderr.write(
			"exec needs --name <name> and either -- <cmd> [args…] or --shell <snippet>\n",
		);
		process.exit(2);
	}
	const record = readRegistry(root).workspaces.find((w) => w.name === name);
	if (!record) {
		// Falling back to the source would run an agent's command against the
		// very tree the workspace exists to protect.
		process.stderr.write(`no workspace named ${name} under ${root}\n`);
		process.exit(1);
	}
	if (ours.includes("--print-cmd")) {
		process.stdout.write(`${execCommand(record, inner)}\n`);
	} else {
		process.exitCode = (await runInWorkspace(record, inner)) ?? 1;
	}
} else {
	// An unrecognised verb is a caller error; only an explicit request for help
	// is a success.
	if (command !== "help") process.exitCode = 2;
	process.stdout.write(
		[
			"hobo-rift — virtual worktrees for agent workspaces",
			"",
			"  hobo-rift capability [--root DIR] [--json]   which CoW primitive is available",
			"  hobo-rift init       [--root DIR]            register a source root",
			"  hobo-rift create --name NAME [--copy-all]    make a workspace, print its path",
			"  hobo-rift list       [--root DIR] [--json]   list workspaces",
			"  hobo-rift remove --name NAME                 delete a workspace",
			"  hobo-rift exec --name NAME -- CMD [ARGS…]    run CMD inside the workspace",
			"  hobo-rift exec --name NAME --shell SNIPPET   run a shell snippet there",
			"  hobo-rift repair     [--root DIR]            reconcile the registry with the journal",
			"  hobo-rift prune      [--root DIR]            delete directories parked by create",
			"",
			"Tiers, best first: reflink · overlayfs · hardlink · copy.",
			"",
		].join("\n"),
	);
}
