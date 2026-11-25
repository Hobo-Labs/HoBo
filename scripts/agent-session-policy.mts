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

export function sessionPolicyRefusal(
	tool: string,
	requestedHead: string | undefined,
	commands: readonly string[],
	context: () => SessionContext,
): string | undefined {
	if (commands.some(stopsOwnerSubmissionHolder))
		return OWNER_SUBMISSION_REFUSAL;
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
