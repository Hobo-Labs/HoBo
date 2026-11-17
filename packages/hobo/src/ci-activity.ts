/**
 * `hobo ci activity`: each relay job, where it ran and why, read from a
 * connected relay's route journal (ADR-0183).
 *
 *     hobo ci activity [--repo owner/name] [--since 90d] [--runner <step>]
 *                      [--outcome routed|waiting|none|pending] [--machine <id>]
 *                      [--limit <n>] [--cursor <next>] [--json]
 *
 * The relay is the one `hobo ci status` asks: `--relay`, else the checkout's
 * `.hobo/ci.json`, else `HOBO_CI_RELAY_URL`, else the link `hobo ci setup`
 * saved; the credential is
 * `HOBO_CI_ACCOUNT_TOKEN` or the file `--token-file` / `HOBO_CI_ACCOUNT_TOKEN_FILE`
 * names. The command reads the journal entries through the read API's
 * `routes` path and builds the entries with `activityFeed` from `@hobo/ci`,
 * the same projection the relay, the MCP tool and the dashboard use. A relay
 * that keeps no journal (the stateless hosted relay) has no activity, and the
 * command says so instead of guessing from GitHub.
 *
 * This file also holds the read API client `hobo ci usage` and
 * `hobo ci performance` share.
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { fromJsonString } from "@bufbuild/protobuf";
import {
	ACTIVITY_OUTCOMES,
	type ActivityCursor,
	type ActivityEntry,
	type ActivityOutcome,
	activityFeed,
	parseRunnerRouteEvent,
	type RunnerRouteEvent,
} from "@hobo/ci";
import { loadCiProjectFromDirectory } from "@hobo/ci-gh-actions/cli-serve";
import type { CommandResult } from "@hobo/cli";
import { z } from "zod";
import { CiRepositoryLinkSchema } from "./_generated/composition_pb.js";
import type { CiCommand, CiCommandContext } from "./ci-commands.js";
import { defaultHoboHome } from "./hobo-home.js";

const DAY_MS = 86_400_000;

// public-contract: how far back `hobo ci activity` reads when --since is not given: the journal's retention.
export const ACTIVITY_DEFAULT_WINDOW_MS = 90 * DAY_MS;
/**
 * Journal entries read before the start time, so a job asked just before it
 * and answered after it keeps its request.
 */
const REQUEST_SLACK_MS = 60 * 60_000;
// public-contract: journal entries one read API page holds (the read API's most).
export const RELAY_ROUTES_PAGE = 200;
// public-contract: the deepest a read API list may be read (the read API's most).
export const RELAY_ROUTES_MAX_DEPTH = 1000;

const ACTIVITY_HELP = [
	"hobo ci activity [--repo owner/name] [--since 90d] [--runner <step>] [--outcome <outcome>]",
	"                 [--machine <id>] [--limit <n>] [--cursor <next>] [--json]",
	"Each relay job from the relay's route journal: where it ran, why, and every step passed over.",
	"  --since    90d, 12h, 30m or a date (default 90d, the journal's retention)",
	"  --runner   the order step that took the job: machine, github, blacksmith, depot, ...",
	`  --outcome  ${ACTIVITY_OUTCOMES.join(", ")}`,
	"Relay: --relay <https-origin>, else .hobo/ci.json, HOBO_CI_RELAY_URL, then the hobo ci setup link; credential: HOBO_CI_ACCOUNT_TOKEN or --token-file.",
].join("\n");

/** A command result that ends the command, raised from deep in a read. */
export class CiCommandStop extends Error {
	constructor(readonly result: CommandResult) {
		super(result.message);
	}
}

export function ciUsage(message: string, help: string): CiCommandStop {
	return new CiCommandStop({
		ok: false,
		status: "usage",
		code: "HOBO_CLI_USAGE",
		message: help ? `${message}\n${help}` : message,
	});
}

/**
 * Epoch milliseconds from `90d`, `12h`, `30m` (before `nowMs`) or a date.
 * Undefined for anything else.
 */
export function parseSince(text: string, nowMs: number): number | undefined {
	const relative = /^(\d{1,5})([dhm])$/u.exec(text.trim());
	if (relative?.[1] && relative[2]) {
		const unit =
			relative[2] === "d" ? DAY_MS : relative[2] === "h" ? 3_600_000 : 60_000;
		return nowMs - Number(relative[1]) * unit;
	}
	if (!/^\d{4}-\d{2}-\d{2}/u.test(text)) return undefined;
	const ms = Date.parse(text);
	return Number.isNaN(ms) ? undefined : ms;
}

/** Where a relay's read API is, and the account credential to read it with. */
export type RelayReadTarget = Readonly<{ origin: string; token: string }>;

function relayOrigin(value: string, allowLoopback: boolean): string {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw ciUsage("Select a valid HTTPS relay origin.", "");
	}
	const loopback =
		allowLoopback &&
		url.protocol === "http:" &&
		(url.hostname === "localhost" || url.hostname === "127.0.0.1");
	if (
		(url.protocol !== "https:" && !loopback) ||
		url.username ||
		url.password ||
		url.pathname !== "/" ||
		url.search ||
		url.hash
	)
		throw ciUsage(
			"Select an HTTPS relay origin without a path or credentials.",
			"",
		);
	return url.origin;
}

/** The relay a `hobo ci setup` link saved for this checkout, when it names `repository`. */
async function savedLinkOrigin(
	context: CiCommandContext,
	root: string,
	repository: string | undefined,
): Promise<string | undefined> {
	const path = join(
		defaultHoboHome(context.env),
		"ci",
		"links",
		`${createHash("sha256").update(resolve(root)).digest("hex")}.json`,
	);
	let text: string;
	try {
		text = await readFile(path, "utf8");
	} catch {
		return undefined;
	}
	let link: ReturnType<typeof fromJsonString<typeof CiRepositoryLinkSchema>>;
	try {
		link = fromJsonString(CiRepositoryLinkSchema, text.slice(0, 8192));
	} catch {
		throw ciUsage(
			"The saved CI link is invalid. Run hobo ci enable with --relay and --repo to reconnect.",
			"",
		);
	}
	if (
		repository === undefined ||
		link.repository.toLowerCase() !== repository.toLowerCase()
	)
		return undefined;
	return link.relayOrigin;
}

/**
 * The relay these commands read, chosen as `hobo ci status` chooses it:
 * `--relay`, the checkout's `.hobo/ci.json`, `HOBO_CI_RELAY_URL`, then the link
 * `hobo ci setup` saved for this checkout. Only a project file that allows
 * insecure loopback may name an `http://127.0.0.1` relay. Undefined when none
 * is selected.
 */
export async function selectRelay(
	context: CiCommandContext,
	options: Readonly<{
		relay: string | undefined;
		tokenFile: string | undefined;
		repo: string | undefined;
	}>,
): Promise<RelayReadTarget | undefined> {
	let origin: string | undefined;
	if (options.relay) origin = relayOrigin(options.relay, false);
	else {
		const local = await context
			.localRepository(options.repo)
			.catch(() => ({ root: context.flags.cwd, repository: options.repo }));
		try {
			const project = await loadCiProjectFromDirectory({
				repositoryRoot: local.root,
				env: context.env,
			});
			origin = relayOrigin(
				project.environment.relayOrigin,
				project.environment.allowInsecureLoopback,
			);
		} catch (error) {
			if (error instanceof CiCommandStop) throw error;
			origin = undefined;
		}
		if (origin === undefined && context.env.HOBO_CI_RELAY_URL)
			origin = relayOrigin(context.env.HOBO_CI_RELAY_URL, false);
		if (origin === undefined) {
			const saved = await savedLinkOrigin(
				context,
				local.root,
				local.repository,
			);
			if (saved !== undefined) origin = relayOrigin(saved, false);
		}
	}
	if (origin === undefined) return undefined;
	const tokenFile = options.tokenFile ?? context.env.HOBO_CI_ACCOUNT_TOKEN_FILE;
	if (tokenFile && context.env.HOBO_CI_ACCOUNT_TOKEN)
		throw ciUsage(
			"Choose one CI credential source: a token file or HOBO_CI_ACCOUNT_TOKEN.",
			"",
		);
	let token = context.env.HOBO_CI_ACCOUNT_TOKEN ?? "";
	if (tokenFile) {
		try {
			token = (await readFile(resolve(context.flags.cwd, tokenFile), "utf8"))
				.slice(0, 1024)
				.trimEnd();
		} catch {
			throw new CiCommandStop({
				ok: false,
				status: "authentication-required",
				code: "HOBO_CI_AUTH_REQUIRED",
				message: `The CI account token file ${tokenFile} could not be read. Check the path given by --token-file or HOBO_CI_ACCOUNT_TOKEN_FILE.`,
			});
		}
	}
	if (!token)
		throw new CiCommandStop({
			ok: false,
			status: "authentication-required",
			code: "HOBO_CI_AUTH_REQUIRED",
			message:
				"Set HOBO_CI_ACCOUNT_TOKEN or HOBO_CI_ACCOUNT_TOKEN_FILE to your relay account credential. Human hobo login sessions are separate from CI account credentials.",
		});
	return { origin, token };
}

const RefusalJson = z.looseObject({
	error: z.string(),
	code: z.string(),
	command: z.string().optional(),
});

/**
 * GET one read API path. Throws `CiCommandStop` with the refusal in words;
 * `notStored` words the answer of a relay that keeps no such store.
 */
export async function readRelayApi(
	context: CiCommandContext,
	target: RelayReadTarget,
	path: string,
	params: URLSearchParams,
	notStored: (command: string | undefined) => CommandResult,
): Promise<string> {
	const query = params.toString();
	const url = `${target.origin}/v1/accounts/self${path}${query ? `?${query}` : ""}`;
	let response: Response;
	try {
		response = await context.fetch(url, {
			headers: {
				accept: "application/json",
				authorization: `Bearer ${target.token}`,
			},
		});
	} catch {
		throw new CiCommandStop({
			ok: false,
			status: "unavailable",
			code: "HOBO_CI_RELAY_ERROR",
			message: `The CI relay at ${target.origin} could not be reached. Nothing was changed; retry.`,
		});
	}
	const body = await response.text();
	if (response.ok) return body;
	let refusal: z.infer<typeof RefusalJson> | undefined;
	try {
		const parsed = RefusalJson.safeParse(JSON.parse(body));
		refusal = parsed.success ? parsed.data : undefined;
	} catch {
		refusal = undefined;
	}
	if (response.status === 404 && refusal?.code === "not-stored-here")
		throw new CiCommandStop(notStored(refusal.command));
	if (response.status === 401 || response.status === 403)
		throw new CiCommandStop({
			ok: false,
			status: "authentication-required",
			code: "HOBO_CI_AUTH_REQUIRED",
			message:
				response.status === 401
					? "The CI relay did not accept the account credential. Check HOBO_CI_ACCOUNT_TOKEN."
					: "The CI account credential cannot read this relay's records: it needs the policy:read scope.",
		});
	throw new CiCommandStop({
		ok: false,
		status: response.status === 404 ? "not-found" : "error",
		code: "HOBO_CI_RELAY_ERROR",
		message: `The CI relay refused the read (${response.status}): ${refusal?.error ?? "no reason given"}.`,
	});
}

/** What a relay reply that is not the frozen record means. */
export function relayReplyInvalid(origin: string): CiCommandStop {
	return new CiCommandStop({
		ok: false,
		status: "error",
		code: "HOBO_CI_RELAY_ERROR",
		message: `The CI relay at ${origin} answered with something that is not the read API's record. Check that the relay is up to date.`,
	});
}

/** No relay to ask: what to do about it. */
export function noRelaySelected(extra: string): CommandResult {
	return {
		ok: false,
		status: "usage",
		code: "HOBO_CLI_USAGE",
		message: `Select your CI relay with --relay, .hobo/ci.json, HOBO_CI_RELAY_URL, or hobo ci setup${extra}.`,
	};
}

const RoutesPageJson = z.object({
	routes: z.array(z.looseObject({})),
	next: z.string().optional(),
});

export type RouteEventsRead = Readonly<{
	events: readonly RunnerRouteEvent[];
	/** The read stopped at the read API's depth with more entries left. */
	truncated: boolean;
}>;

/** The route journal entries at or after `sinceMs`, newest first, as deep as the read API reaches. */
export async function readRouteEvents(
	context: CiCommandContext,
	target: RelayReadTarget,
	query: Readonly<{ repository: string | undefined; sinceMs: number }>,
): Promise<RouteEventsRead> {
	const events: RunnerRouteEvent[] = [];
	let cursor: string | undefined;
	for (;;) {
		const params = new URLSearchParams();
		if (query.repository) params.set("repository", query.repository);
		params.set("since", String(Math.max(0, Math.floor(query.sinceMs))));
		params.set("limit", String(RELAY_ROUTES_PAGE));
		if (cursor !== undefined) params.set("cursor", cursor);
		const body = await readRelayApi(context, target, "/routes", params, () => ({
			ok: false,
			status: "unavailable",
			code: "HOBO_CI_NOT_STORED_HERE",
			message:
				"This relay keeps no route journal, so there is no activity to show. Activity needs a relay with a journal: hobo ci serve, a box, or a relay deployed with storage.",
			remediation: ["See one decision without a journal with hobo ci route."],
		}));
		let page: z.infer<typeof RoutesPageJson>;
		try {
			page = RoutesPageJson.parse(JSON.parse(body));
			for (const entry of page.routes)
				events.push(parseRunnerRouteEvent(JSON.stringify(entry)));
		} catch {
			throw relayReplyInvalid(target.origin);
		}
		if (page.next === undefined) return { events, truncated: false };
		const next = Number(page.next);
		if (
			!Number.isSafeInteger(next) ||
			next + RELAY_ROUTES_PAGE > RELAY_ROUTES_MAX_DEPTH
		)
			return { events, truncated: true };
		cursor = page.next;
	}
}

/** A page cursor as text a person can paste back. */
export function encodeActivityCursor(cursor: ActivityCursor): string {
	return Buffer.from(`${cursor.atMs}\n${cursor.key}`, "utf8").toString(
		"base64url",
	);
}

export function decodeActivityCursor(text: string): ActivityCursor | undefined {
	const decoded = Buffer.from(text, "base64url").toString("utf8");
	const split = decoded.indexOf("\n");
	if (split <= 0) return undefined;
	const atMs = Number(decoded.slice(0, split));
	const key = decoded.slice(split + 1);
	return Number.isFinite(atMs) && key ? { atMs, key } : undefined;
}

function isOutcome(value: string): value is ActivityOutcome {
	return ACTIVITY_OUTCOMES.some((outcome) => outcome === value);
}

function when(ms: number): string {
	return new Date(ms).toISOString().slice(0, 16).replace("T", " ");
}

/** One entry as people read it: when, which job, where it went and why. */
export function activityLines(entry: ActivityEntry): readonly string[] {
	const where =
		entry.outcome === "routed" || entry.outcome === "waiting"
			? `${entry.runner} (${entry.step}${entry.machineId ? ` ${entry.machineId}` : ""})`
			: entry.outcome;
	return [
		`${when(entry.atMs)}  ${entry.repository} run ${entry.runId}/${entry.runAttempt} ${entry.job}  ${entry.outcome === "waiting" ? "queued on " : entry.outcome === "routed" ? "ran on " : ""}${where}`,
		`    ${entry.why}`,
		...entry.passedOver.map((line) => `    passed over ${line}`),
	];
}

function parseActivityArgs(args: readonly string[]) {
	try {
		return parseArgs({
			args: [...args],
			allowPositionals: false,
			strict: true,
			options: {
				relay: { type: "string" },
				"token-file": { type: "string" },
				repo: { type: "string" },
				since: { type: "string" },
				runner: { type: "string" },
				outcome: { type: "string" },
				machine: { type: "string" },
				limit: { type: "string" },
				cursor: { type: "string" },
				json: { type: "boolean" },
			},
		}).values;
	} catch (error) {
		throw ciUsage(
			error instanceof Error ? error.message : "Invalid arguments.",
			ACTIVITY_HELP,
		);
	}
}

async function activity(context: CiCommandContext): Promise<CommandResult> {
	const values = parseActivityArgs(context.args);
	const nowMs = context.now();
	const sinceMs =
		values.since === undefined
			? nowMs - ACTIVITY_DEFAULT_WINDOW_MS
			: parseSince(values.since, nowMs);
	if (sinceMs === undefined)
		throw ciUsage("--since takes 90d, 12h, 30m or a date.", ACTIVITY_HELP);
	if (values.outcome !== undefined && !isOutcome(values.outcome))
		throw ciUsage(
			`--outcome is one of ${ACTIVITY_OUTCOMES.join(", ")}.`,
			ACTIVITY_HELP,
		);
	const limit = values.limit === undefined ? undefined : Number(values.limit);
	if (
		limit !== undefined &&
		(!Number.isSafeInteger(limit) || limit < 1 || limit > 500)
	)
		throw ciUsage("--limit is a whole number from 1 to 500.", ACTIVITY_HELP);
	const after =
		values.cursor === undefined
			? undefined
			: decodeActivityCursor(values.cursor);
	if (values.cursor !== undefined && after === undefined)
		throw ciUsage(
			"--cursor takes the next value a previous page printed.",
			ACTIVITY_HELP,
		);
	const target = await selectRelay(context, {
		relay: values.relay,
		tokenFile: values["token-file"],
		repo: values.repo,
	});
	if (!target) return noRelaySelected("; activity is read from its journal");
	const read = await readRouteEvents(context, target, {
		repository: values.repo,
		sinceMs: sinceMs - REQUEST_SLACK_MS,
	});
	const page = activityFeed(read.events, {
		repository: values.repo,
		outcome:
			values.outcome !== undefined && isOutcome(values.outcome)
				? values.outcome
				: undefined,
		step: values.runner,
		machineId: values.machine,
		sinceMs,
		limit,
		after,
	});
	const next =
		page.next === undefined ? undefined : encodeActivityCursor(page.next);
	const scope = values.repo ?? "every connected repository";
	const lines =
		page.entries.length === 0
			? [`No relay job matches since ${when(sinceMs)} in ${scope}.`]
			: [
					`Relay jobs in ${scope} since ${when(sinceMs)}, newest first:`,
					...page.entries.flatMap(activityLines),
				];
	if (next !== undefined)
		lines.push(`More: hobo ci activity ... --cursor ${next}`);
	if (read.truncated)
		lines.push(
			`Only the newest ${RELAY_ROUTES_MAX_DEPTH} journal entries were read; narrow with --since or --repo.`,
		);
	return {
		message: lines.join("\n"),
		data: {
			relay: target.origin,
			sinceMs,
			entries: page.entries,
			next: next ?? null,
			truncated: read.truncated,
		},
	};
}

/** Runs `body`, turning a `CiCommandStop` into its result. */
export async function stopping(
	body: () => Promise<CommandResult>,
): Promise<CommandResult> {
	try {
		return await body();
	} catch (error) {
		if (error instanceof CiCommandStop) return error.result;
		throw error;
	}
}

export const CI_ACTIVITY_COMMAND: CiCommand = {
	name: "activity",
	summary:
		"Each relay job from the relay's route journal: where it ran, why, and every step passed over.",
	run: (context) => stopping(() => activity(context)),
};
