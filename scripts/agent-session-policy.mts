import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import * as z from "zod";

export const MAX_OPEN_PULL_REQUESTS_PER_SESSION = 3;
export const PULL_REQUEST_LEDGER = "hobo-agent/pull-requests.json";

const KILL_COMMANDS = new Set([
	"kill",
	"pkill",
	"killall",
	"taskkill",
	"stop-process",
]);
const BROAD_PATTERNS = new Set(["node", "tsx", "nodejs"]);
const OWNER_SUBMISSION_HOLDER =
	/hobo[-_ ]?mcp|mcp-owner-page|owner[-_ ]page|hobo\.js\s+mcp|bin\/hobo(?:\.[jt]s)?["']?\s+mcp/iu;
const COMMAND_PREFIXES = new Set([
	"sudo",
	"exec",
	"command",
	"nohup",
	"xargs",
	"env",
	"timeout",
	"doas",
]);

export const OWNER_SUBMISSION_REFUSAL =
	"This command stops HoBo's MCP server or the owner page driver. That process holds the owner's open form or sealed submission in memory, and only it can unseal what the owner entered; stopping it loses their submission and makes them do it again. Let the form finish: wait until the owner submits and pass the sealed result on, or until the page expires. Never ask the owner to test or sign in again because of a restart you caused. See the hobo-setup skill.";

function words(segment: string): string[] {
	return segment
		.replaceAll(/["'`]/gu, " ")
		.split(/\s+/u)
		.filter((word) => word !== "");
}

function commandWord(segment: string): string | undefined {
	const tokens = words(segment);
	let index = 0;
	while (index < tokens.length) {
		const token = tokens[index] ?? "";
		const name = token.split("/").at(-1)?.toLowerCase() ?? "";
		if (
			COMMAND_PREFIXES.has(name) ||
			token.startsWith("-") ||
			/^\w+=/u.test(token) ||
			/^\d+[smhd]?$/u.test(token)
		) {
			index += 1;
			continue;
		}
		return name;
	}
	return undefined;
}

export function stopsOwnerSubmissionHolder(command: string): boolean {
	return command.split(/;|&&|\|\||\n/u).some((statement) =>
		statement.split("|").some((part) => {
			const verb = commandWord(part);
			if (verb === undefined || !KILL_COMMANDS.has(verb)) return false;
			if (OWNER_SUBMISSION_HOLDER.test(statement)) return true;
			if (verb !== "pkill" && verb !== "killall") return false;
			return words(part)
				.slice(1)
				.some((word) => BROAD_PATTERNS.has(word.toLowerCase()));
		}),
	);
}

const LedgerEntry = z.object({
	head: z.string(),
	workstream: z.string(),
	commit: z.string().optional(),
});

export type PullRequestRecord = Readonly<z.infer<typeof LedgerEntry>>;

export interface PullRequestLedger {
	open(workstream: string): readonly PullRequestRecord[];
	record(entry: PullRequestRecord): void;
}

export type SessionContext = Readonly<{
	currentBranch: () => string | undefined;
	commitOf: (head: string) => string | undefined;
	ledger: PullRequestLedger;
}>;

export function workstreamOf(head: string): string {
	const branch = head.replace(/^[^:/]+:/u, "");
	const slash = branch.lastIndexOf("/");
	const last = branch.slice(slash + 1);
	const dash = last.lastIndexOf("-");
	return dash > 0 ? branch.slice(0, slash + 1 + dash) : branch;
}

function optionValue(tokens: readonly string[], names: readonly string[]) {
	for (const [index, token] of tokens.entries()) {
		for (const name of names) {
			if (token === name) return tokens[index + 1];
			if (token.startsWith(`${name}=`)) return token.slice(name.length + 1);
		}
	}
	return undefined;
}

export type PullRequestCreation = Readonly<{ head: string | undefined }>;

export function pullRequestCreation(
	tool: string,
	requestedHead: string | undefined,
	commands: readonly string[],
	currentBranch: () => string | undefined,
): PullRequestCreation | undefined {
	if (/(?:^|__)create_pull_request$/u.test(tool)) {
		return { head: requestedHead };
	}
	for (const command of commands)
		for (const segment of command.split(/;|&&|\|\||\n/u)) {
			const tokens = words(segment);
			const gh = tokens.findIndex((token) => /(?:^|\/)gh$/u.test(token));
			if (gh < 0) continue;
			const rest = tokens.slice(gh + 1);
			if (rest[0] === "pr" && rest[1] === "create")
				return {
					head: optionValue(rest, ["--head", "-H"]) ?? currentBranch(),
				};
			if (rest[0] !== "api") continue;
			const endpoint = rest.find((token) => /(?:^|\/)pulls\/?$/u.test(token));
			if (endpoint === undefined) continue;
			const method = optionValue(rest, ["-X", "--method"])?.toUpperCase();
			const fields = rest.filter((token, index) =>
				["-f", "-F", "--field", "--raw-field"].includes(rest[index - 1] ?? ""),
			);
			const inline = rest
				.filter((token) => /^(?:-f|-F|--field|--raw-field)=/u.test(token))
				.map((token) => token.slice(token.indexOf("=") + 1));
			const given = [...fields, ...inline];
			if (method !== "POST" && (method !== undefined || given.length === 0))
				continue;
			const head = given
				.find((field) => field.startsWith("head="))
				?.slice("head=".length);
			return { head };
		}
	return undefined;
}

export function pullRequestRefusal(
	creation: PullRequestCreation,
	context: SessionContext,
): string | undefined {
	if (creation.head === undefined) return undefined;
	const head = creation.head.replace(/^[^:/]+:/u, "");
	const workstream = workstreamOf(head);
	const others = context.ledger
		.open(workstream)
		.filter((entry) => entry.head !== head);
	if (others.length >= MAX_OPEN_PULL_REQUESTS_PER_SESSION)
		return `Refusing a new pull request for ${head}: this session's branches (${workstream}-*) already have ${others.length} pull requests that have not landed on origin/main (${others.map((entry) => entry.head).join(", ")}). CLAUDE.md: one PR per workstream; land or fold work into the existing pull request instead of opening another, and list the workstreams before starting. The count is kept offline in the git directory's ${PULL_REQUEST_LEDGER}, where an entry clears once its head commit is on origin/main after a fetch; a pull request closed without merging is cleared by removing its entry.`;
	const commit = context.commitOf(head);
	context.ledger.record(
		commit === undefined ? { head, workstream } : { head, workstream, commit },
	);
	return undefined;
}

const LedgerFile = z.array(LedgerEntry);

function git(cwd: string, args: readonly string[]) {
	const result = spawnSync("git", args, { cwd, encoding: "utf8" });
	return result.status === 0 ? result.stdout.trim() : undefined;
}

export function gitLedger(cwd: string): PullRequestLedger {
	const common = git(cwd, ["rev-parse", "--git-common-dir"]);
	const file =
		common === undefined
			? undefined
			: join(
					isAbsolute(common) ? common : join(cwd, common),
					PULL_REQUEST_LEDGER,
				);
	const entries = (): PullRequestRecord[] => {
		if (file === undefined) return [];
		try {
			return LedgerFile.parse(JSON.parse(readFileSync(file, "utf8")));
		} catch {
			return [];
		}
	};
	const landed = (entry: PullRequestRecord) =>
		entry.commit !== undefined &&
		spawnSync(
			"git",
			["merge-base", "--is-ancestor", entry.commit, "refs/remotes/origin/main"],
			{ cwd },
		).status === 0;
	return {
		open: (workstream) =>
			entries().filter(
				(entry) => entry.workstream === workstream && !landed(entry),
			),
		record(entry) {
			if (file === undefined) return;
			const kept = entries().filter(
				(existing) => existing.head !== entry.head && !landed(existing),
			);
			mkdirSync(dirname(file), { recursive: true });
			const temporary = `${file}.${process.pid}`;
			writeFileSync(
				temporary,
				`${JSON.stringify([...kept, entry], null, "\t")}\n`,
			);
			renameSync(temporary, file);
		},
	};
}

export function gitSessionContext(cwd: string): SessionContext {
	return {
		currentBranch: () =>
			git(cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"]),
		commitOf: (head) =>
			git(cwd, [
				"rev-parse",
				"--verify",
				"--quiet",
				`refs/heads/${head}^{commit}`,
			]) ??
			git(cwd, [
				"rev-parse",
				"--verify",
				"--quiet",
				`refs/remotes/origin/${head}^{commit}`,
			]),
		ledger: gitLedger(cwd),
	};
}

const BROAD_TEST_SCRIPTS = new Set([
	"test",
	"test:all",
	"test:unit",
	"test:unit:quiet",
	"check:all",
	"verify:full",
	"verify:extended",
	"validate:final",
]);

const PACKAGE_RUNNERS = new Set(["pnpm", "npm", "yarn", "mise"]);
const SCOPE_FLAGS = new Set([
	"--filter",
	"-f",
	"--prefix",
	"-c",
	"--dir",
	"--workspace",
]);
const WRAPPER_FLAGS_WITH_VALUE = new Set(["-c", "-n", "-u", "--signal", "-s"]);
const VITEST_FLAGS_WITH_VALUE = new Set([
	"-c",
	"--config",
	"-r",
	"--root",
	"--reporter",
	"--pool",
	"--maxworkers",
	"--testtimeout",
	"--hooktimeout",
	"--shard",
	"--environment",
	"--outputfile",
]);

function hasScopeFlag(tokens: readonly string[]): boolean {
	return tokens.some((token) => {
		const lower = token.toLowerCase();
		if (SCOPE_FLAGS.has(lower)) return true;
		return (
			lower.startsWith("--filter=") ||
			lower.startsWith("-f=") ||
			lower.startsWith("--prefix=") ||
			lower.startsWith("--dir=") ||
			lower.startsWith("--workspace=")
		);
	});
}

function skipCommandWrappers(tokens: readonly string[]) {
	let index = 0;
	let allowBroad = false;
	while (index < tokens.length) {
		const token = tokens[index] ?? "";
		if (token === "HOBO_ALLOW_BROAD_TESTS=1") {
			allowBroad = true;
			index += 1;
			continue;
		}
		if (/^[A-Za-z_][A-Za-z0-9_]*=/u.test(token)) {
			index += 1;
			continue;
		}
		const name = token.split("/").at(-1)?.toLowerCase() ?? "";
		if (
			COMMAND_PREFIXES.has(name) ||
			name === "taskset" ||
			name === "nice" ||
			name === "time"
		) {
			index += 1;
			while (index < tokens.length) {
				const arg = tokens[index] ?? "";
				if (name === "timeout" && /^\d+[smhd]?$/u.test(arg)) {
					index += 1;
					continue;
				}
				if (!arg.startsWith("-")) break;
				index += 1;
				if (WRAPPER_FLAGS_WITH_VALUE.has(arg.toLowerCase())) {
					index += 1;
				}
			}
			continue;
		}
		break;
	}
	return { rest: tokens.slice(index), allowBroad };
}

function matchBroadTurbo(tokens: readonly string[]): string | undefined {
	let index = 0;
	if (tokens[index]?.toLowerCase() === "run") index += 1;
	const hasNarrowFlag = tokens.some((token) => {
		const lower = token.toLowerCase();
		return (
			lower === "--filter" ||
			lower === "-f" ||
			lower === "--affected" ||
			lower.startsWith("--filter=") ||
			lower.startsWith("-f=")
		);
	});
	if (hasNarrowFlag) return undefined;
	const tasks: string[] = [];
	while (index < tokens.length) {
		const token = tokens[index] ?? "";
		if (token.startsWith("-")) {
			index += 1;
			continue;
		}
		tasks.push(token.toLowerCase());
		index += 1;
	}
	if (tasks.length === 0) return undefined;
	if (tasks.includes("build") && tasks.includes("test")) {
		return "turbo run build test";
	}
	const broad = tasks.find((task) => BROAD_TEST_SCRIPTS.has(task));
	return broad === undefined ? undefined : `turbo ${broad}`;
}

function matchBroadVitest(tokens: readonly string[]): string | undefined {
	let index = 0;
	if (tokens[index]?.toLowerCase() === "run") index += 1;
	while (index < tokens.length) {
		const token = tokens[index] ?? "";
		const lower = token.toLowerCase();
		if (
			lower === "-t" ||
			lower === "--testnamepattern" ||
			lower === "--project" ||
			lower === "--related" ||
			lower.startsWith("--testnamepattern=") ||
			lower.startsWith("--project=") ||
			lower.startsWith("--related=")
		) {
			return undefined;
		}
		if (token.startsWith("-")) {
			index += 1;
			if (!token.includes("=") && VITEST_FLAGS_WITH_VALUE.has(lower)) {
				index += 1;
			}
			continue;
		}
		return undefined;
	}
	return "vitest run";
}

function matchBroadStatement(statement: string): string | undefined {
	const rawTokens = words(statement);
	const { rest, allowBroad } = skipCommandWrappers(rawTokens);
	if (allowBroad || rest.length === 0) return undefined;

	const first = rest[0]?.split("/").at(-1)?.toLowerCase() ?? "";
	const args = rest.slice(1);

	if (first === "turbo") return matchBroadTurbo(args);
	if (first === "vitest") return matchBroadVitest(args);
	if (first === "npx" || first === "pnpx") {
		let subIndex = 0;
		while (subIndex < args.length) {
			const candidate = args[subIndex] ?? "";
			if (candidate === "--") {
				subIndex += 1;
				break;
			}
			if (candidate.startsWith("-")) {
				subIndex += 1;
				if (
					(candidate.startsWith("-p") || candidate.startsWith("--package")) &&
					!candidate.includes("=") &&
					!candidate.startsWith("--package=")
				) {
					subIndex += 1;
				}
				continue;
			}
			break;
		}
		const sub = args[subIndex]?.split("/").at(-1)?.toLowerCase() ?? "";
		if (sub === "turbo") return matchBroadTurbo(args.slice(subIndex + 1));
		if (sub === "vitest") return matchBroadVitest(args.slice(subIndex + 1));
		return undefined;
	}
	if (!PACKAGE_RUNNERS.has(first)) return undefined;
	if (hasScopeFlag(args)) return undefined;

	let index = 0;
	while (index < args.length) {
		const token = args[index] ?? "";
		if (token === "--") break;
		if (token.startsWith("-")) {
			index += 1;
			continue;
		}
		const lower = token.toLowerCase();
		if (lower === "turbo") {
			return matchBroadTurbo(args.slice(index + 1));
		}
		if (lower === "exec" || lower === "dlx") {
			let execIndex = index + 1;
			while (execIndex < args.length) {
				const candidate = args[execIndex] ?? "";
				if (candidate === "--") {
					execIndex += 1;
					break;
				}
				if (candidate.startsWith("-")) {
					execIndex += 1;
					continue;
				}
				break;
			}
			const execCmd = args[execIndex]?.split("/").at(-1)?.toLowerCase() ?? "";
			if (execCmd === "turbo")
				return matchBroadTurbo(args.slice(execIndex + 1));
			if (execCmd === "vitest")
				return matchBroadVitest(args.slice(execIndex + 1));
			return undefined;
		}
		if (lower === "run") {
			index += 1;
			continue;
		}
		if (BROAD_TEST_SCRIPTS.has(lower)) {
			return `${first} ${lower}`;
		}
		return undefined;
	}
	return undefined;
}

export function broadTestSweepIn(
	command: string,
	env: Readonly<Record<string, string | undefined>> = process.env,
): string | undefined {
	if (env.HOBO_ALLOW_BROAD_TESTS === "1") return undefined;
	for (const statement of command.split(/;|&&|\|\||\n/u)) {
		const matched = matchBroadStatement(statement);
		if (matched !== undefined) return matched;
	}
	return undefined;
}

export function broadTestSweepRefusal(matched: string): string {
	return `Refusing broad test sweep (${matched}): run only tests related to your changes instead of full unrelated suites. Use pnpm --filter <pkg> exec vitest run <file>, pnpm --filter <pkg> test, pnpm exec turbo run test --filter=./packages/<pkg>, pnpm run test:changed, pnpm run test:affected, node --import tsx --test scripts/test/<file>.test.ts, or pnpm run agent:check -- --staged. If the user explicitly requested a full-repo sweep, prefix the command with HOBO_ALLOW_BROAD_TESTS=1.`;
}

export function sessionPolicyRefusal(
	tool: string,
	requestedHead: string | undefined,
	commands: readonly string[],
	context: () => SessionContext,
	env: Readonly<Record<string, string | undefined>> = process.env,
): string | undefined {
	if (commands.some(stopsOwnerSubmissionHolder))
		return OWNER_SUBMISSION_REFUSAL;
	for (const command of commands) {
		const broad = broadTestSweepIn(command, env);
		if (broad !== undefined) return broadTestSweepRefusal(broad);
	}
	let session: SessionContext | undefined;
	const lazy = () => {
		session ??= context();
		return session;
	};
	const creation = pullRequestCreation(tool, requestedHead, commands, () =>
		lazy().currentBranch(),
	);
	return creation === undefined
		? undefined
		: pullRequestRefusal(creation, lazy());
}
