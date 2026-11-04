/**
 * `hobo-code` CLI — coding harness + multi-node compute (ADR-0139).
 *
 * App-building agent CLI (not a control-plane management tool).
 *   dispatch (default) | init | status | resources | session | attach | tasks | guide |
 *   scaffold | template | dev | isolate | promote | env | auth | models | cost | harness |
 *   edit | config | agent | agents | help
 *
 * Binary name: hobo-code (dash permitted).
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as totalAccess from "@hobo/core/total-access";
import { initStation, persistStationCapabilityManifest } from "@hobo/stations";
import { runAgentsCli } from "./agent-harness-init.js";
import { defaultProbes, detectAgents } from "./agent-registry.js";
import { seatShellCommand } from "./agent-seat.js";
import { agentHumanSummary, inspectAgentSurface } from "./agent-surface.js";
import { allocateAgentWorkspaces } from "./agent-workspaces.js";
import {
	authLogin,
	authStatus,
	clearAuthSession,
	confirmRemoteLogin,
	readAuthSession,
	resolveAuthenticatedStationId,
} from "./auth.js";
import { inspectBindleProject } from "./bindle-inspect.js";
import {
	type ChatSessionRecord,
	resolveChatSession,
	saveChatSession,
} from "./chat-sessions.js";
import {
	claudeCodeGuide,
	renderClaudeCodeGuideText,
} from "./claude-code-guide.js";
import { compactTranscript } from "./compact.js";
import {
	type ConfigStackId,
	configHumanSummary,
	inspectConfigSurface,
	isConfigStackId,
} from "./config-surface.js";
import { costHumanSummary, inspectCost } from "./cost.js";
import { cursorGuide, renderCursorGuideText } from "./cursor-guide.js";
import {
	type DevBrowserSession,
	startDevBrowserSession,
} from "./dev-browser.js";
import {
	DEV_MACHINES_FILE,
	loadDevMachines,
	machinesForAgent,
	resolveMachine,
	sshDestination,
} from "./dev-machines.js";
import {
	codeDevStation,
	isCodeDevScenario,
	stationInitArgsFromDeclaration,
} from "./dev-stations.js";
import { defaultDevenvProbes, devenvSummary, inspectDevenv } from "./devenv.js";
import {
	computeTaskPath,
	describeDistributedCompute,
	dispatchComputeTask,
} from "./distributed.js";
import { dogfoodSummary } from "./dogfood.js";
import {
	type BridgeMode,
	editorBridgeHumanSummary,
	editorBridgeOpenScript,
	inspectEditorBridge,
	type PaneLayout,
} from "./editor-bridge.js";
import { describeEveSubagentSurface } from "./eve.js";
import { debugViewUrl } from "./evidence-overlay.js";
import { matchExampleRequest, materializeExample } from "./example-catalog.js";
import {
	buildTasksSurface,
	grokBuildParity,
	renderGrokBuildFooter,
	renderTasksBoardText,
} from "./grok-build-parity.js";
import {
	applySettingsToSeatCommand,
	loadHarnessSettings,
} from "./harness-settings.js";
import {
	harnessHumanSummary,
	inspectHarnessSurface,
} from "./harness-surface.js";
import { hermeticEnvSummary, inspectHermeticEnv } from "./hermetic-env.js";
import { runAliasCli, runHistoryCli } from "./history-cli.js";
import {
	cleanupIsolation,
	createIsolationContext,
	listSandboxOrphans,
} from "./isolation.js";
import {
	cloneAsJson,
	isJsonObject,
	isJsonString,
	type JsonObject,
} from "./json.js";
import { createLocalSessionControl } from "./local-session-control.js";
import {
	defaultMachineProbes,
	discoverMachine,
	type MachineDiscoveryProbes,
	matchMachineToStation,
	persistMachineDiscoveryReport,
} from "./machine-discovery.js";
import {
	brokerPaneSession,
	brokerPanes,
	describePane,
	type OpenedGateway,
	openStationGateway,
	type ResolvedSshIdentity,
} from "./machine-sessions.js";
import { inspectModels, modelsHumanSummary } from "./models.js";
import {
	applyMux,
	attachCommand,
	type MuxRunner,
	type MuxTarget,
	planMux,
	safeWindowName,
	tmuxRunner,
} from "./mux.js";
import { loopbackFetchUrl } from "./occupancy-endpoints.js";
import {
	CODE_FEATURE_DEFAULTS,
	CODE_FEATURE_FLAGS,
	type CodeFeaturePort,
	composeCodePlatform,
	createMemoryFeaturePort,
} from "./platform.js";
import { runProjectGates } from "./promotion-gates.js";
import {
	type CodeRemoteMode,
	describeDevTerminalAttach,
	shortNamedHost,
} from "./remote.js";
import {
	type RemoteSessionServe,
	runResidentSessionCli,
} from "./resident-session-cli.js";
import { residentSessionTmuxName } from "./resident-session-runtime.js";
import { runReviewCommand } from "./review/review-command.js";
import { type PromotionGate, promoteIsolation } from "./sandbox-promote.js";
import { describeSecureSandboxStack } from "./sandbox-stack.js";
import { scaffoldHighValueTemplate } from "./scaffolding.js";
import { startCodeSession } from "./session.js";
import { startLocalDashboard } from "./session-dashboard.js";
import {
	occupancyFlowIsActive,
	persistOccupancyRun,
} from "./session-resource-control.js";
import {
	assembleSessionResources,
	filterSessionResources,
	formatSessionResources,
	type ResourceKind,
	recordDevDeployment,
} from "./session-resources.js";
import {
	describeAuthedStationSession,
	stationDevEnv,
} from "./station-session.js";
import {
	releaseStationSidecars,
	sidecarsEnabled,
	stopStationSidecars,
} from "./station-sidecars.js";
import { runTemplateCommand } from "./template-command.js";
import {
	buildMultiplexerStatus,
	createPane,
	herdrMuxCapabilities,
	renderHerdrCapabilityFooter,
	renderStatusChip,
	renderStatusText,
} from "./tui.js";
import {
	runVirtualPane,
	VIRTUAL_PANE_COMMANDS,
	virtualPaneCommand,
} from "./virtual-pane.js";
import { findWorkspaceRoot } from "./workspace.js";
import {
	liveEndpointLines,
	matchWorkspaceAction,
	resolveRunnableProject,
} from "./workspace-actions.js";
import { describeCodeWorlds } from "./worlds.js";

export const HOBO_CODE_VERBS = [
	"dispatch",
	"init",
	"vshell",
	"machines",
	"status",
	"resources",
	"history",
	"alias",
	"dashboard",
	"session",
	"attach",
	"resume",
	"compact",
	"mux",
	"tasks",
	"guide",
	"scaffold",
	"template",
	"review",
	"dev",
	"isolate",
	"promote",
	"env",
	"auth",
	"models",
	"cost",
	"harness",
	"edit",
	"config",
	"agent",
	"agents",
	"help",
] as const;

/**
 * Closed human panel: title band, soft underline, body rows, bottom rule.
 * Pure presentation — used by every non-status verb.
 * Single body row: soft band omitted (3-line panel).
 * Rule width tracks content (12–20) so short panels stay tight.
 */
function panel(title: string, rows: readonly string[]): string {
	// Single-space body indent — denser than two-space columns.
	const body = rows.map((row) =>
		row.startsWith(" ") || row.startsWith("  ") ? row : ` ${row}`,
	);
	const widest = Math.max(title.length, ...body.map((r) => r.length));
	const ruleW = Math.max(12, Math.min(20, widest));
	const rule = "─".repeat(ruleW);
	// Happy-path one-scan panels drop soft twin (title · body · rule).
	if (body.length === 1) {
		return [title, ...body, rule].join("\n");
	}
	const soft = "·".repeat(ruleW);
	return [title, soft, ...body, rule].join("\n");
}

export type HoboCodeVerb = (typeof HOBO_CODE_VERBS)[number];

function chatPreview(session: ChatSessionRecord): readonly string[] {
	const lines: string[] = [];
	const lastOf = (role: "user" | "assistant"): string | undefined => {
		for (let i = session.messages.length - 1; i >= 0; i -= 1) {
			const message = session.messages[i];
			if (message?.role !== role) continue;
			const oneLine = message.text.replace(/\s+/gu, " ").trim();
			if (oneLine.length === 0) continue;
			return oneLine.length > 72 ? `${oneLine.slice(0, 71)}…` : oneLine;
		}
		return undefined;
	};
	const user = lastOf("user");
	const assistant = lastOf("assistant");
	if (user) lines.push(`you · ${user}`);
	if (assistant) lines.push(`Bo · ${assistant}`);
	return lines;
}

async function resolveResidentResume(
	hoboHome: string,
	wanted: string,
): Promise<{ sessionId: string; sessionName: string } | undefined> {
	const control = createLocalSessionControl({ hoboHome });
	try {
		const sessions = await control.list();
		const hits = sessions.filter((snapshot) => {
			const id = snapshot.session?.id;
			return id === wanted || id?.startsWith(wanted);
		});
		const id = hits.length === 1 ? hits[0]?.session?.id : undefined;
		if (!id) return undefined;
		return { sessionId: id, sessionName: residentSessionTmuxName(id) };
	} finally {
		control.close();
	}
}

const VERB_SET = new Set<string>(HOBO_CODE_VERBS);

/** Levenshtein distance for near-miss verb detection (DX typo feedback). */
function editDistance(a: string, b: string): number {
	const m = a.length;
	const n = b.length;
	const dp: number[][] = Array.from({ length: m + 1 }, () =>
		Array.from({ length: n + 1 }, () => 0),
	);
	for (let i = 0; i <= m; i++) totalAccess.must(dp[i])[0] = i;
	for (let j = 0; j <= n; j++) totalAccess.first(dp)[j] = j;
	for (let i = 1; i <= m; i++) {
		// Hoist both rows: the inner loop then indexes a row directly instead of
		// walking `dp` twice per cell.
		const prev = totalAccess.must(dp[i - 1]);
		const cur = totalAccess.must(dp[i]);
		for (let j = 1; j <= n; j++) {
			const cost = a[i - 1] === b[j - 1] ? 0 : 1;
			cur[j] = Math.min(
				totalAccess.must(prev[j]) + 1,
				totalAccess.must(cur[j - 1]) + 1,
				totalAccess.must(prev[j - 1]) + cost,
			);
		}
	}
	return totalAccess.must(totalAccess.must(dp[m])[n]);
}

/**
 * If a single bare token looks like a mistyped verb (not a multi-word prompt),
 * return the closest known verb; otherwise null (dispatch as prompt).
 */
export function suggestVerbTypo(token: string): string | null {
	const t = token.trim().toLowerCase();
	if (!t || t.includes(" ") || t.length < 3) return null;
	// Multi-word / free-text prompts stay dispatch.
	if (!/^[a-z][a-z0-9_-]*$/i.test(t)) return null;
	if (VERB_SET.has(t)) return null;
	let best: string | null = null;
	let bestD = Infinity;
	for (const v of HOBO_CODE_VERBS) {
		if (v === "help" || v === "dispatch") continue;
		const d = editDistance(t, v);
		// Allow distance 1 always; distance 2 only for longer tokens.
		const maxD = t.length <= 4 ? 1 : 2;
		if (d > 0 && d <= maxD && d < bestD) {
			bestD = d;
			best = v;
		}
	}
	return best;
}

/**
 * CLI-shaped single tokens that are not verbs (hyphen/underscore idioms).
 * GUI-native users often invent command names; celebrating them as dispatch
 * is deceptive magic. One-word natural language (no separators) still dispatches.
 */
export function looksLikeUnknownVerbAttempt(token: string): boolean {
	const t = token.trim().toLowerCase();
	if (!t || t.includes(" ") || t.length < 3) return false;
	if (!/^[a-z][a-z0-9_-]*$/i.test(t)) return false;
	if (VERB_SET.has(t)) return false;
	return t.includes("-") || t.includes("_");
}

export interface HoboCodeCliResult {
	readonly ok: boolean;
	readonly status: string;
	readonly code: string;
	readonly message: string;
	readonly remediation?: readonly string[];
	readonly data?: JsonObject;
	readonly exitCode: number;
}

export interface HoboCodeCliDeps {
	readonly env?: NodeJS.ProcessEnv;
	readonly hoboHome?: string;
	readonly cwd?: string;
	readonly features?: CodeFeaturePort;
	readonly json?: boolean;
	/**
	 * Opt-in glyph/idiom chrome (power-user strip + ultra-short verb tails).
	 * Default is plain/legible help and full verb titles for unfamiliar devs.
	 * Also: HOBO_CODE_DENSE=1 or --dense / -D.
	 */
	readonly dense?: boolean;
	readonly openStationGateway?: (
		context: Parameters<typeof openStationGateway>[0],
	) => Promise<OpenedGateway>;
	readonly muxRunner?: MuxRunner;
	readonly allocateWorkspaces?: typeof allocateAgentWorkspaces;
	/** Injectable machine probes for `init` discovery (tests / harnesses). */
	readonly machineProbes?: MachineDiscoveryProbes;
	readonly startDevSession?: typeof startDevBrowserSession;
	readonly onDevSession?: (session: DevBrowserSession) => void;
	readonly fetch?: typeof globalThis.fetch;
	/**
	 * Standard input for verbs that read it. Defaults to `process.stdin`.
	 *
	 * `vshell` owns stdin for the life of its pane and returns when stdin
	 * closes, which is correct for a terminal but leaves it running forever
	 * under a harness whose stdin never ends — so a caller that wants a bounded
	 * run supplies one that does. `runVirtualPane` already documents this seam;
	 * this threads it through the CLI so the verb is reachable the same way.
	 */
	readonly input?: NodeJS.ReadableStream;
}

export type FormatHoboCodeOptions = {
	readonly json?: boolean;
	readonly dense?: boolean;
};

function defaultHoboHome(env: NodeJS.ProcessEnv): string {
	if (isJsonString(env.HOBO_HOME) && env.HOBO_HOME.length > 0) {
		return env.HOBO_HOME;
	}
	return join(env.HOME ?? tmpdir(), ".hobo");
}

// SAFETY: parsed or fixture value is the named domain type after this assertion.
/** Flags that consume the next token as their value (strict parsing). */
const VALUE_FLAGS = new Set([
	"home",
	"workspace",
	"tier",
	"source",
	"session",
	"host",
	"cwd",
	"tenant",
	"domain",
	"station",
	"pool",
	"hive", // legacy alias of --pool
	"stack",
	"path",
	"bridge",
	"layout",
	"editor",
	"e", // alias of --editor
	"complete",
	"run",
	"kind",
	"from",
	"name",
	"out",
	"isolation",
	"mode",
	"port",
	"debug-port",
	"id",
	"target",
	"base",
	"head",
	"format",
	"params",
	"kind",
	"author",
	"exit",
	"maturity",
	"top-k",
	"language",
	"context",
	"scenario",
]);

/** Boolean flags (never consume the next token). */
const BOOL_FLAGS = new Set([
	"json",
	"dense",
	"help",
	"agent",
	"force",
	"mock",
	"complete-remote",
	"print-cmd",
	"printcmd",
	"cursor",
	"dry-run",
	"shared",
	"virtual",
	"approve",
	"once",
	"failed",
	"all",
	"yes",
	"non-interactive",
	"reconfigure",
	"apply",
	"explain",
	"no-dense",
]);

export interface CliFlagMap {
	[name: string]: string | boolean;
}

export class UnknownFlagError extends Error {
	constructor(readonly flag: string) {
		super(
			`Unknown flag "--${flag}". Run "hobo-code help" to see supported flags.`,
		);
		this.name = "UnknownFlagError";
	}
}

function parseArgv(argv: readonly string[]) {
	const flags: CliFlagMap = {};
	const positional: string[] = [];
	for (let i = 0; i < argv.length; i++) {
		const a = totalAccess.must(argv[i]);
		if (a === "--") {
			positional.push(...argv.slice(i + 1));
			break;
		}
		if (a === "--json") {
			flags.json = true;
			continue;
		}
		if (a === "--dense" || a === "-D") {
			flags.dense = true;
			continue;
		}
		if (a === "--help" || a === "-h") {
			flags.help = true;
			continue;
		}
		if (a === "--yes" || a === "-y") {
			flags.yes = true;
			continue;
		}
		if (a === "--non-interactive") {
			flags["non-interactive"] = true;
			continue;
		}
		if (a.startsWith("--") && a.includes("=")) {
			const eq = a.indexOf("=");
			const name = a.slice(2, eq);
			if (!VALUE_FLAGS.has(name) && !BOOL_FLAGS.has(name)) {
				throw new UnknownFlagError(name);
			}
			flags[name] = a.slice(eq + 1);
			continue;
		}
		if (a.startsWith("--")) {
			const name = a.slice(2);
			if (VALUE_FLAGS.has(name)) {
				const value = argv[i + 1];
				if (value === undefined || value.startsWith("-")) {
					throw new Error(
						`Flag "--${name}" requires a value. Run "hobo-code help" to see supported flags.`,
					);
				}
				flags[name] = value;
				i += 1;
				continue;
			}
			if (BOOL_FLAGS.has(name)) {
				flags[name] = true;
				continue;
			}
			throw new UnknownFlagError(name);
		}
		positional.push(a);
	}

	if (positional[0] === "templates") {
		positional[0] = "template";
		if (positional.length === 1) positional.push("list");
	}
	const first = positional[0];
	// `hobo-code platform --help` keeps verb=platform (subcommand help).
	// Bare `--help` / `help` → top-level help.
	if (flags.help === true) {
		if (first && VERB_SET.has(first) && first !== "help") {
			return {
				// SAFETY: parsed or fixture value is the named domain type after this assertion.
				verb: first as HoboCodeVerb,
				args: positional.slice(1),
				flags,
				defaultedVerb: false,
			};
		}
		return { verb: "help", args: positional, flags, defaultedVerb: false };
	}

	if (first && VERB_SET.has(first)) {
		return {
			// SAFETY: parsed or fixture value is the named domain type after this assertion.
			verb: first as HoboCodeVerb,
			args: positional.slice(1),
			flags,
			defaultedVerb: false,
		};
	}
	// Default verb: dispatch. Entire positional list is the prompt.
	return { verb: "dispatch", args: positional, flags, defaultedVerb: true };
}

/**
 * Power-user dense help: intentional glyph/tail idioms (opt-in via --dense).
 * Full keys still available with --json.
 */
function helpTextDense(): string {
	const flags = Object.values(CODE_FEATURE_FLAGS);
	const ofShort = flags
		.map((f) => {
			const tail = f.replace(/^code\./, "").replace(/\..*$/, "");
			if (tail === "harness") return "h";
			if (tail === "evidence") return "e";
			if (tail === "monetization") return "m";
			if (tail === "isolation") return "r";
			if (tail === "distributed") return "d";
			return tail[0] ?? tail;
		})
		.join("");
	return [
		`hobo-code★●${ofShort}`,
		"★d·st·se·sc·i·pr",
		"ev·au·mo",
		"",
		"dense chrome (--dense | -D | HOBO_CODE_DENSE=1)",
		"plain help: hobo-code help   ·   json: hobo-code help --json",
		"",
		"tails: ★d=dispatch-default  st=status  se=session  sc=scaffold",
		"       i=isolate  pr=promote  ev=env  au=auth  mo=models",
		`OF ●${ofShort}: h=harness e=evidence m=monetization r=rift d=distributed`,
	].join("\n");
}

/**
 * Default human-readable help (legible for unfamiliar devs).
 * Full feature-flag keys live in the JSON data payload.
 */
function helpTextPlain(): string {
	const lines = [
		"hobo-code — HoBo coding harness CLI",
		"You are in HoBo’s world · plain by default · --dense is opt-in power chrome",
		"Entry contract: bare hobo-code needs a TTY; pipes/non-TTY must provide a prompt or use help.",
		"",
		"Usage:",
		"  hobo-code <prompt>                 dispatch (default)",
		"  hobo-code <verb> [args] [flags]",
		"  hobo-code help | hobo-code --help",
		"  hobo-code <verb> --help            help for one verb (e.g. auth)",
		// SAFETY: parsed or fixture value is the named domain type after this assertion.
		"  hobo-code help <verb>              same as <verb> --help",
		"  hobo-code help --dense             power-user glyph strip + legend",
		"",
		"Start here:",
		"  guide      Claude Code / Cursor → hobo-code maps (plain English)",
		"  auth       Login to a Station (local auto, or tenant+domain)",
		"  dispatch   Build / refine the app (default when given a prompt)",
		"  help       This message",
		"",
		"Session & status:",
		"  status     Session / agent panes in plain words (dense glyphs with --dense)",
		"  resources  Session topology + real endpoints for this login × env",
		"  history    Station-scoped command search (SQLite sidecar)",
		"  alias      Station aliases + env vars (dotfiles export)",
		"  dashboard  Local Aspire SPA + OTel + start/stop (ADR-0111)",
		"  session    Isolation session + handback",
		"  attach     Dev-terminal attach (tmux/mosh/Tailscale-shaped)",
		"  resume     Reopen the last (or given) interactive chat",
		"  compact    Shrink working context; keep the durable journal",
		"  tasks      Claimed work under each subagent (Agents board)",
		"",
		"Craft & cost:",
		"  scaffold   Copy a shipped repo example (hello-world, barebones, …)",
		"  dev        Deploy the current web app with browser evidence controls",
		"  isolate    Mediated sandbox for agent work",
		"  promote    Promote a run through gate checklist",
		"  edit       Open [neo]vim in managed harness pane (CLI-native)",
		"  cost       Budget, $0 path, savings, free/local routing",
		"  models     Active model + BYOK / open-model env (no secrets)",
		"  config     Env/flags inventory by stack (setup critique)",
		"",
		"Agent & harness:",
		"  agent      Agent-native: human-free auth, MCP/ACP, unattended",
		"  agents     Register coding harnesses (Vercel-shaped init + Eve VFS)",
		"  harness    Pi/Flue dual surface, skills, self-improve, brain",
		"  env        Hermetic shell + durable vs sandbox layout",
		"",
		"Flags:",
		"  --json              Machine-readable envelope (stdout)",
		"  --dense, -D         Power-user dense glyph chrome (opt-in)",
		"  --home <path>       Override HOBO_HOME",
		"  --cwd <path>        Project root (hermetic markers, isolate)",
		"  --help, -h          Show this help (plain by default)",
		"",
		"Env:",
		"  HOBO_HOME           Durable home (default: $HOME/.hobo)",
		"                      Prefer a path outside the Nix store",
		// SAFETY: parsed or fixture value is the named domain type after this assertion.
		"  HOBO_CODE_DENSE=1   Same as --dense for the process",
		"  HOBO_CODE_AGENT=1   Unattended / no-elicitation agent contract",
		"",
		"First run:",
		"  hobo-code                         # bare TTY → InteractiveShell (Bo + chat + /)",
		"  hobo-code resume [session_id]      # reopen the last (or given) chat",
		"  hobo-code guide | guide --cursor   # Claude Code / Cursor maps",
		"  hobo-code auth login               # Station identity (local auto)",
		"  hobo-code auth login --agent       # human-free agent path",
		'  hobo-code "add a settings page"    # dispatch (default verb)',
		"  hobo-code config | agent           # setup + agent-native inventory",
		"  hobo-code status | resources | tasks | attach | cost | harness | edit",
		"  hobo-code isolate my-run && hobo-code promote my-run",
		"",
		"Examples:",
		'  hobo-code "refine the openui bindle"',
		"  hobo-code scaffold --name demo",
		"  hobo-code dev --cwd demo",
		"  hobo-code config --stack cost-budget",
		"  hobo-code agent --json            # MCP/ACP + unattended contract",
		"  hobo-code edit src/cli.ts        # neovim/vim managed pane",
		"  hobo-code models                # BYOK / open models (no secrets)",
		"  hobo-code cost                  # $0 path + savings",
		"  hobo-code harness               # Pi/Flue dual surface + skills",
		"  hobo-code env --json            # optional hermetic / durable layout",
		"  hobo-code guide --cursor --json # Cursor feature map (machine)",
		"",
		"Notes:",
		"  · Binary is hobo-code (not `hobo code`). Plain help default; --dense opt-in.",
		"  · Bare TTY opens HoBo InteractiveShell (Bo + chat + slash) — not stock Pi UI.",
		"  · Escape hatch only: HOBO_CODE_TUI=pi or hobo-code --pi (engine experiments).",
		"  · Setup: hobo-code config (stacks: agent-native, cost-budget, editor-vim, …).",
		"  · Agents: hobo-code agents init (register CLIs + Eve). Inventory: hobo-code agent.",
		"  · Maps: guide · edit (nvim) · tasks · attach · status · cost · harness · models.",
		"  · CLI-native: prefer keyboard verbs; nvim bridge: packages/code/editor/hobo-code.nvim",
		"  · Nix/devenv optional (never monorepo IaC). Full payloads: hobo-code help --json",
	];
	return lines.join("\n");
}

function helpText(dense: boolean): string {
	return dense ? helpTextDense() : helpTextPlain();
}

/** Per-verb help (plain). Used by `hobo-code <verb> --help` and `hobo-code help <verb>`. */
const VERB_HELP_PLAIN = {
	dispatch: [
		"hobo-code dispatch — app-building agent dispatch",
		"",
		"Usage:",
		"  hobo-code dispatch <prompt…>",
		"  hobo-code <prompt…>                 # same (default verb)",
		"",
		"Flags:",
		"  --json              Machine-readable envelope",
		"  --pool <id>         Compute pool (advanced)",
		"  --home <path>       Override HOBO_HOME",
		"  --help, -h          Show this help",
		"",
		"Requires: hobo-code auth login (local Station auto-resolves).",
		"",
		"Examples:",
		'  hobo-code "add a login form to the bindle"',
		'  hobo-code dispatch "refine the openui scaffold"',
		"",
		"See also: hobo-code auth · hobo-code scaffold · hobo-code session",
	],
	init: [
		"hobo-code init — machine discovery + Station occupancy seed",
		"",
		"Inspects the machine hobo-code is running on and matches the evidence",
		"against the default localhost capability set declared on the dev-scenario",
		"Station (ADR-0155). Required capabilities gate init (fail-closed);",
		"optional ones degrade with a remediation line. Writes the discovery",
		"report and the matched capability manifest beside the Station data.",
		"",
		"Usage:",
		"  hobo-code init                   # discover, match, init station:local",
		"  hobo-code init --dry-run         # discover + match only; write nothing",
		"  hobo-code init --scenario ephemeral",
		"  hobo-code init --json",
		"",
		"What is probed (evidence-based, auditable):",
		"  · Node.js version · git · isolation platform matrix (rift/worktree)",
		"  · local model server (ollama) · devenv/nix toolchain",
		// SAFETY: parsed or fixture value is the named domain type after this assertion.
		"  · installed coding harnesses (same detection as `agents`)",
		"",
		"Flags:",
		"  --scenario <id>     Dev scenario: local-dev (default) | ephemeral | preview",
		"  --dry-run           Discover and match only; never write",
		"  --station <id>      Explicit station id (default from scenario)",
		"  --tenant <id>       Tenant recorded on the Station (default local)",
		"  --json              Machine-readable envelope",
		"  --help, -h          Show this help",
		"",
		"See also: hobo-code agents init · hobo-code status · hobo station init",
	],
	status: [
		"hobo-code status — session / agent multiplexer chrome",
		"",
		"Usage:",
		"  hobo-code status                 # plain English hierarchy (default)",
		"  hobo-code status --dense         # power-user glyph box chrome",
		"  hobo-code status --json",
		"",
		"What you see (plain default):",
		"  · Agent list with idle / working / blocked / done words",
		"  · Summary counts, theme, and a clear Next: line",
		"  · Dense glyph box only with --dense (○ ● ▲ ✓ · ▸ focus)",
		"",
		"What you see (--dense):",
		"  · Pane fold with semantic state glyphs; ≤4 panes per fold line",
		"  · Footer legend: herdr · panes · detach · highlight→copy",
		"  · --json exposes copyOnHighlight, detachable, theme, panes, capabilities",
		"",
		"Herdr differentiators (vs single-stream agent CLIs):",
		"  · Multi-pane mux with background-ready agent states",
		"  · Detachable session model (session verb persists handback)",
		"  · Highlight-to-copy: select text in a pane → highlightBuffer / ↳ clip",
		"",
		"Flags:",
		"  --dense, -D         Glyph box chrome (opt-in)",
		"  --json              Machine-readable status + herdr capabilities",
		"  --help, -h          Show this help",
		"",
		"See also: hobo-code session · hobo-code auth status · hobo-code resources",
	],
	resources: [
		"hobo-code resources — session topology + real endpoints",
		"",
		"Shows every station, junction, yard, camp, and bindle in the current",
		"logged-in Station occupancy for HOBO_ENV, with named URLs, backend",
		"listen URLs, and resolved network addresses. Read-only.",
		"",
		"Usage:",
		"  hobo-code resources",
		"  hobo-code resources --kind bindle",
		"  hobo-code resources --json",
		"",
		"What you see:",
		"  · Occupied Station header (not a topology parent)",
		"  · In-scope junctions / yards / camps / bindles",
		"  · Endpoints: preferred URL · resolved addresses · fidelity · freshness",
		"  · Missing layers named with a next step (never silently omitted)",
		"",
		"Flags:",
		"  --kind <kind>      Filter: station | junction | yard | camp | bindle",
		// SAFETY: parsed or fixture value is the named domain type after this assertion.
		"  --json              Same projection as the TUI /resources pane",
		"  --help, -h          Show this help",
		"",
		"Env:",
		"  HOBO_ENV / HOBO_PROJECT / HOBO_BRANCH   Occupancy filter",
		"",
		"See also: hobo-code auth · hobo-code dev · hobo-code dashboard",
	],
	history: [
		"hobo-code history — Station-scoped command search",
		"",
		"SQLite memory on the occupied Station (not Atuin, not synced off-box).",
		"Records and ranks commands with frecency (recency + frequency + cwd).",
		"",
		"Usage:",
		"  hobo-code history [query]",
		"  hobo-code history record <command>",
		"  hobo-code history --failed --author agent",
		"  hobo-code history --json",
		"",
		"See also: hobo-code alias · hobo-code resources",
	],
	alias: [
		"hobo-code alias — Station aliases + env (dotfiles)",
		"",
		"Occupancy-scoped aliases and environment variables. Export a shell",
		"snippet; secrets are refused. Not a general dotfile manager.",
		"",
		"Usage:",
		"  hobo-code alias",
		"  hobo-code alias set gs git status",
		"  hobo-code alias rm gs",
		"  hobo-code alias env",
		"  hobo-code alias env set HOBO_THEME ink",
		"  hobo-code alias env rm HOBO_THEME",
		"  hobo-code alias export",
		"",
		"See also: hobo-code history · hobo-code env",
	],
	dashboard: [
		"hobo-code dashboard — local Aspire-style resource board",
		"",
		"Co-launches the ADR-0111 local SPA (default http://dashboard.code.local.hobo.localhost:8787)",
		"over the session occupancy projection, plus OTLP ingest :4317/:4318.",
		"Start/stop/restart launch and kill the Bindle /dev process. Ready means",
		"the health probe passed. Fleet is local once a Camp exists.",
		"",
		"Usage:",
		"  hobo-code dashboard",
		"  hobo-code dashboard --once --json",
		"",
		"Flags:",
		"  --port <n>          Dashboard listen port (HOBO_DEV_DASHBOARD_PORT)",
		"  --once              Bind, print URLs, close",
		"  --json              Machine-readable listen envelope",
		"  --help, -h          Show this help",
		"",
		"See also: hobo-code resources · hobo-code dev",
	],
	session: [
		"hobo-code session — resident tmux agent sessions + durable handback",
		"",
		"Usage:",
		"  hobo-code session list | create <name> [branch]",
		"  hobo-code session show | attach | switch | detach <sessionId>",
		"  hobo-code session replay <sessionId>  # read-only synchronized timeline",
		"  hobo-code session fork <sessionId> [checkpointId] [name]",
		"  hobo-code session tab <sessionId> <title>",
		"  hobo-code session pane <sessionId> <tabId> <title> [command…]",
		"  hobo-code session split <sessionId> <paneId> <horizontal|vertical> <title> [command…]",
		"  hobo-code session focus | close-pane <sessionId> <paneId>",
		"  hobo-code session prompt <sessionId> <paneId> <text…>",
		"  hobo-code session agent-start <sessionId> <paneId> <provider> <command> [-- <command-args…>]",
		"  hobo-code session agent-stop <sessionId> <agentRunId>",
		"  hobo-code session checkpoint <sessionId> <label>",
		"  hobo-code session restore <sessionId> <checkpointId>",
		"  hobo-code session commit | push | pr | stack | merge … --approve",
		"  hobo-code session stop | delete <sessionId>",
		"  hobo-code session serve [--port <port>]",
		"    Resident terminal tabs plus a lazygit-style Git workbench",
		"  hobo-code session git <sessionId>  # native ANSI pane inside tmux",
		"  hobo-code session serve --host <declared-machine> --port <port>",
		"  hobo-code session              # legacy one-shot handback",
		"",
		"Resident controls:",
		"  One branch-backed worktree per session; tabs, panes, agents, input,",
		"  checkpoints, delivery, detach/reattach, and browser control share",
		"  the same revisioned command/snapshot boundary.",
		"",
		"Persistence:",
		"  SQLite snapshots live under $HOBO_HOME/durable/code/sessions; tmux",
		"  owns PTYs, so sessions survive client and control-server restarts.",
		"",
		"Flags:",
		"  --approve           Required for commit, push, PR, stack, and merge",
		"  --host <machine>    Station-authorized declared dev machine",
		"  --port <port>       Fixed loopback port (required with --host)",
		"  --json              Machine-readable snapshots",
		"  --home <path>       Override HOBO_HOME",
		"  --help, -h          Show this help",
		"",
		"Remote browser serving asks that Station to authorize and audit access,",
		"then gates the installed SSH agent for that lease and opens local",
		"forwarding. No key or session token is copied; denial has no fallback.",
		"",
		"See also: hobo-code attach · hobo-code auth · hobo-code isolate · hobo-code status",
	],
	guide: [
		"hobo-code guide — Claude Code / Cursor → hobo-code maps (plain English)",
		"",
		"For Claude Code advanced users and Cursor power users who want a cheat sheet.",
		"",
		"Usage:",
		"  hobo-code guide                 # Claude Code map (default)",
		"  hobo-code guide --cursor        # Cursor Agent/Composer/Background/BugBot map",
		"  hobo-code guide --json",
		"  hobo-code guide --cursor --json",
		"",
		"Claude Code map (default):",
		"  workflows · remote connect · channels · routines",
		"  automated/ultrareview · browser/Chrome · deep-research",
		"  fork · btw · plan · login",
		"",
		"Cursor map (--cursor):",
		"  Agent mode · Composer · Tab · Background Agent · BugBot",
		"  MCP · Rules · Hooks · Memories · Automations · multi-model · CLI",
		"",
		"Each row shows status (supported / partial / residual) and a try command.",
		"Honest gaps are listed under Residual.",
		"",
		"Flags:",
		"  --cursor            Cursor power-user map (instead of Claude Code)",
		// SAFETY: parsed or fixture value is the named domain type after this assertion.
		"  --from cursor       Same as --cursor",
		"  --json              Full structured map + residual list",
		"  --help, -h          Show this help",
		"",
		"Examples:",
		"  hobo-code guide",
		"  hobo-code guide --cursor",
		"  hobo-code guide --cursor --json",
		"  hobo-code auth login   # then scaffold / dispatch",
		"",
		"See also: hobo-code help · hobo-code scaffold · hobo-code tasks · hobo-code isolate",
	],
	tasks: [
		"hobo-code tasks — claimed work under each subagent (same Agents board)",
		"",
		"Usage:",
		"  hobo-code tasks",
		"  hobo-code tasks --json",
		"",
		"For AI-native Grok Build users:",
		"  · Grok Build: fullscreen mouse TUI, tasks pane, click still-running,",
		"    workflows overlay, subagents, headless -p, Plan Mode",
		"  · hobo-code tasks: Agents board with tasks nested under the claiming",
		"    subagent, clickable task-row story, durable Local World workflow steps,",
		"    grokBuild parity JSON card",
		"",
		"What you see:",
		"  · Subagent/task/watcher rows with semantic glyphs (○ idle · ● work · …)",
		"  · Legend: grok-build · click · tasks · workflows",
		"  · --json: clickableRegions, backgroundTasks, workflows, compare.grokBuild",
		"",
		"Flags:",
		"  --json              Full tasks surface + Grok Build parity card",
		"  --home <path>       Override HOBO_HOME",
		"  --help, -h          Show this help",
		"",
		"Examples:",
		"  hobo-code tasks",
		"  hobo-code tasks --json",
		"  hobo-code status    # mux chrome; herdr footer + clickableRegions in data",
		"",
		"See also: hobo-code status · hobo-code session · hobo-code help",
	],
	machines: [
		"hobo-code machines — dev machines panes may reach",
		"",
		"A remote pane used to be `ssh -t <whatever was typed>`: an arbitrary",
		"host, an ambient key, and no record. Machines are declared instead, in",
		`${DEV_MACHINES_FILE} beside the devenv files, so the reachable set is`,
		"reviewable alongside the toolchain.",
		"",
		"Usage:",
		"  hobo-code machines",
		"  hobo-code machines --json",
		"",
		"Each entry needs an id, a host (tailnet name), and an isolationClass;",
		"`user` and `agents` are optional. Entries that do not parse are listed",
		// SAFETY: parsed or fixture value is the named domain type after this assertion.
		"as rejected rather than dropped.",
		"",
		"`hobo-code mux --host <id>` places panes on one. Sessions are brokered",
		"by the Station's privileged-access gateway, which applies the target's",
		"isolation-class policy and audits every session; a pane the Station did",
		"not authorise is refused rather than opened.",
		"",
		"Each Station authorization gates a lease-bound local SSH-agent",
		"socket backed by SSH_AUTH_SOCK. Keys and tokens are never copied into",
		"the pane; redemption and lease termination drain to Station Yard audit.",
	],
	vshell: [
		"hobo-code vshell — a virtual pane: virtual terminal over a virtual filesystem",
		"",
		"What a normal pane gives an agent is a real shell in a real directory.",
		"rift separates the tree so agents cannot collide, but an agent can still",
		"curl | sh, read ~/.aws/credentials by absolute path, or rm -rf its way",
		"out. A virtual pane closes that: bash is interpreted in-process, so a",
		"command that is not on the allow-list does not exist — there is no",
		"execve behind it to escape to.",
		"",
		"Usage:",
		"  hobo-code vshell                         virtual pane over the current project",
		"  hobo-code vshell --workspace DIR         mount a specific directory",
		"  hobo-code vshell --name claude           name the pane",
		"  hobo-code vshell --tier T --source DIR   from a rift record (see below)",
		"",
		"Inside the pane:",
		"  commands        list what exists here",
		"  exit | Ctrl-D   leave",
		"",
		"Reads come from the real tree; writes stay in memory until promotion.",
		"No path resolves outside the mounted root, and there are no network",
		"commands at all.",
		"",
		"--tier/--source come from `hobo-rift create --json`, and are for running",
		"vshell OUTSIDE the workspace's namespace: an overlay path is empty to a",
		"process outside it, so the source is mounted instead.",
		"",
		"Do NOT pass them when vshell runs inside `hobo-rift exec` (which is what",
		"`mux --virtual` does): there the merged path is real, and mounting the",
		"source would hand the agent the SHARED tree instead of its own — exactly",
		"the collision rift exists to prevent.",
		"",
		"Not a VM: this bounds what an agent can name and touch, not what",
		"hostile native code could do.",
	],
	mux: [
		"hobo-code mux — herdr-style multi-pane tmux session",
		"",
		"Seats every agent found on this machine in its own tmux window.",
		"Local agents, local inference and ssh hosts are the same kind of",
		"target: a command in a pane, so detach/reattach works identically.",
		"",
		"Usage:",
		"  hobo-code mux                     detect agents, create/reuse session 'hobo'",
		"  hobo-code mux --session work      name the session",
		"  hobo-code mux --host box.example  run the same panes over ssh",
		"  hobo-code mux --virtual           panes get a virtual terminal + filesystem",
		"  hobo-code mux --dry-run           show the plan without touching tmux",
		"",
		"--virtual replaces each pane's shell with an interpreter over a virtual",
		"filesystem: commands off the allow-list do not exist, there is no network",
		"and no execve, and writes stay off the checkout until promotion.",
		"",
		"Detection is evidence-based: a binary on PATH and/or a known config",
		"directory. See hobo-code agent for what was found and why.",
		"",
		"Stay in this TTY (hobo-code · chat first). Optional out-of-session: tmux attach -t hobo",
	],
	attach: [
		"hobo-code attach — dev-terminal attach (tmux / mosh / Tailscale-shaped)",
		"",
		"Usage:",
		"  hobo-code attach",
		"  hobo-code attach --mode local|overlay",
		"  hobo-code attach --json",
		"",
		"Mental model (preferred setups):",
		"  · tmux     → detach/reattach coding sessions after SSH drop",
		"  · cmux     → concurrent panes (see hobo-code status / session)",
		"  · mosh     → optional UDP roaming on lossy mobile links",
		"  · Tailscale→ --mode overlay named endpoint on the tailnet (ADR-0130)",
		"",
		"What you get:",
		"  · Deterministic named endpoint host (local .hobo.localhost or overlay)",
		"  · Attach / reattach steps + ssh/mosh hints",
		"  · Link to session durable handback under $HOBO_HOME",
		"  · Not a control-plane admin surface (no platform/budget/hive)",
		"",
		"Flags:",
		"  --mode local|overlay   Endpoint mode (default: local)",
		"  --json                 Full registration + compare + attach steps",
		"  --home <path>          Override HOBO_HOME",
		"  --help, -h             Show this help",
		"",
		"Examples:",
		"  hobo-code attach",
		"  hobo-code attach --mode overlay --json",
		"  hobo-code session   # open work on the box, then re-attach later",
		"",
		"See also: hobo-code session · hobo-code status · hobo-code auth",
	],
	resume: [
		"hobo-code resume — reopen a previous interactive chat",
		"",
		"Usage:",
		"  hobo-code resume",
		"  hobo-code resume <session_id>",
		"  hobo-code resume --json",
		"",
		"  No id resumes the latest chat for this working directory",
		"  (then the latest chat overall). A prefix is enough when unique.",
		"  On a TTY the InteractiveShell reopens with that transcript.",
		"  If the id matches a resident tmux session instead, attach to it.",
		"",
		"Flags:",
		"  --json              Session record + resume action",
		"  --home <path>       Override HOBO_HOME",
		"  --cwd <path>        Prefer chats from this project root",
		"  --help, -h          Show this help",
		"",
		"Examples:",
		"  hobo-code resume",
		"  hobo-code resume chat-abc123",
		"  hobo-code resume --json",
		"",
		"See also: hobo-code attach · hobo-code session · hobo-code help",
	],
	compact: [
		"hobo-code compact — shrink working context, keep the journal",
		"",
		"Usage:",
		"  hobo-code compact",
		"  hobo-code compact <session_id> [focus…]",
		"  hobo-code compact --json",
		"",
		"  Deterministic extract (no LLM). Cuts on user-turn boundaries.",
		"  The durable journal is never rewritten; only the working pane shrinks.",
		"  Optional focus words pin what the briefing must keep.",
		"",
		"Flags:",
		"  --json              Compact plan + session record",
		"  --home <path>       Override HOBO_HOME",
		"  --cwd <path>        Prefer chats from this project root",
		"  --help, -h          Show this help",
		"",
		"Examples:",
		"  hobo-code compact",
		"  hobo-code compact chat-abc keep the named URL",
		"",
		"See also: hobo-code resume · hobo-code session",
	],
	scaffold: [
		"hobo-code scaffold — copy a shipped repo example (hello-world, barebones, …)",
		"",
		"Usage:",
		"  hobo-code scaffold [--name <name>] [--out <dir>]",
		"  hobo-code scaffold hello-world",
		"",
		'A chat prompt like "hello world app" does the same thing — no hobo CLI.',
		"",
		"Flags:",
		"  --name <name>       App / folder name",
		"  --out <dir>         Output directory",
		"  --json              Machine-readable result",
		"  --help, -h          Show this help",
		"",
		"Examples:",
		"  hobo-code scaffold --name demo",
		"",
		"See also: hobo-code dispatch · hobo-code help",
	],
	template: [
		"hobo-code template — local pattern search/render (zero LLM tokens)",
		"",
		"Usage:",
		// SAFETY: parsed or fixture value is the named domain type after this assertion.
		"  hobo-code template            # same as list",
		"  hobo-code template list",
		"  hobo-code template search <query>",
		"  hobo-code template show <pattern-id>",
		"  hobo-code template render <pattern-id-or-query>",
		"  hobo-code template explain <pattern-id-or-query>",
		"  hobo-code template compose <query>",
		"  hobo-code template apply <pattern-id-or-query> --out <isolation-root>",
		"  hobo-code template --id bindle.web-only --json",
		"  hobo-code template render bindle.web-api --name greeter",
		'  hobo-code template "web frontend backed by an api"',
		"",
		"Flags:",
		"  --id <pattern-id>   Exact catalog or atom id",
		"  --name <id>         Typed name param for snippets",
		"  --format <kind>     snippet|file|project|markdown|vscode|effects",
		"  --params <json>     Typed render params",
		"  --top-k <n>         Candidate cap",
		"  --kind <kind>       Hard filter: concept|starter|guidance|transform",
		"  --maturity <name>   Hard filter: stable|partial|experimental|legacy",
		"  --language <id>     Hard filter",
		"  --context <id>      Hard filter",
		"  --target <path>     Isolation-relative apply path",
		"  --out <dir>         Isolation root for apply",
		"  --apply             Explicit mutation (still isolation-only)",
		"  --explain           Channel evidence",
		"  --no-dense          Disable optional dense retrieval",
		"  --json              Machine-readable receipt",
		"",
		"Lists and renders reviewed catalog patterns and atomic snippets.",
		"Does not start a model turn. Chat phrases stay on the session.",
		"Zero-token means 0 LLM calls / input / output tokens, not zero CPU.",
	],
	review: [
		"hobo-code review — durable local/PR/stack review (exact-effect publish)",
		"",
		"Usage:",
		"  hobo-code review start [--target working-tree|index|range|commit]",
		"  hobo-code review show --id <reviewId>",
		"  hobo-code review mark --id <reviewId> <fileId>",
		"  hobo-code review thread --id <reviewId> <body>",
		"",
		"Review state is a separate EventStore aggregate (hobo-code-reviews).",
		"Forge publish binds the pending-review digest and expected HEAD.",
	],
	dev: [
		"hobo-code dev — run the project Bindle on a local Yard with Evidence",
		"",
		"Usage:",
		"  hobo-code dev [--cwd <app>] [--port <port>] [--debug-port <port>]",
		"  hobo-code dev --once --json       # bounded deployment probe",
		"",
		"This delegates to hobo dev: the project's Bindle is placed on a local Yard",
		"bound to the Station you are logged into (hobo-code auth login).",
		"Its real web endpoint receives Evidence controls and session replay.",
		"",
		"Flags:",
		"  --cwd <app>         HoBo project root (src/bindle.ts or dist/bindle.js)",
		"  --port <port>       Local Yard port (default 4173; 0 chooses a free port)",
		"  --debug-port <port> Evidence controls port (default 4174; 0 chooses free)",
		"  --once              Probe the Bindle and Evidence surfaces, then stop",
		"  --json              Machine-readable deployment URLs and evidence path",
		"",
		"Interactive: /dev or /hobo yard status",
		"See also: hobo dev · hobo-code harness · hobo-code session",
	],
	isolate: [
		"hobo-code isolate — mediated sandbox for agent work",
		"",
		"Usage:",
		"  hobo-code isolate [runId]",
		"",
		"Flags:",
		"  --json              Isolation context + layout",
		"  --cwd <path>        Project root",
		"  --home <path>       Override HOBO_HOME",
		"  --help, -h          Show this help",
		"",
		"Examples:",
		"  hobo-code isolate my-run",
		"  hobo-code promote my-run",
		"",
		"See also: hobo-code promote · hobo-code session",
	],
	promote: [
		"hobo-code promote — promote a run through gate checklist",
		"",
		"Usage:",
		"  hobo-code promote <runId>",
		"  hobo-code promote --run <runId>",
		"",
		"Flags:",
		"  --run <runId>       Run id",
		"  --json              Machine-readable result",
		"  --help, -h          Show this help",
		"",
		"Examples:",
		"  hobo-code isolate my-run && hobo-code promote my-run",
		"",
		"See also: hobo-code isolate · hobo-code status",
	],
	env: [
		"hobo-code env — hermetic shell + durable layout",
		"",
		"Usage:",
		"  hobo-code env",
		"  hobo-code env --json",
		"",
		"Flags:",
		"  --json              Full hermetic report",
		"  --cwd <path>        Project root",
		"  --home <path>       Override HOBO_HOME",
		"  --help, -h          Show this help",
		"",
		"See also: hobo-code help · hobo-code auth status",
	],
	models: [
		"hobo-code models — active model + BYOK / open models",
		"",
		"Usage:",
		"  hobo-code models",
		"  hobo-code models --json",
		"",
		"Shows the active provider/model (HOBO_CODE_MODEL or default) and which",
		"BYOK env *names* are set — never prints secret values.",
		"",
		"GHCP-parity notes:",
		"  · Open models via BYOK env keys (OpenAI, Anthropic, Google, xAI, …)",
		"  · Interactive animated title on bare TTY `hobo-code`",
		"  · Sandbox via isolate/session after auth login",
		"",
		"$0 / free-local (cost-conscious):",
		"  · export HOBO_CODE_MODEL=ollama/qwen2.5-coder:7b",
		"  · or OPENAI_BASE_URL=http://127.0.0.1:… for local OpenAI-compatible / OrnithAI-class",
		"  · see hobo-code cost for budget + savings scoreboard",
		"",
		"Flags:",
		"  --json              Full models payload",
		"  --help, -h          Show this help",
		"",
		"Examples:",
		"  export HOBO_CODE_MODEL=openai/gpt-4.1",
		"  export OPENAI_API_KEY=…   # value never shown by models",
		"  hobo-code models",
		"",
		"See also: hobo-code cost · hobo-code auth · hobo-code help",
	],
	config: [
		"hobo-code config — env/flags inventory by stack (setup critique)",
		"",
		"Personas judge setup from preferred stacks. This command lists knobs,",
		"presence (never secret values), and a setup checklist.",
		"",
		"Usage:",
		"  hobo-code config",
		"  hobo-code config --stack cost-budget|editor-vim|hermetic-nix|…",
		"  hobo-code config --json",
		"",
		"Stacks:",
		"  core · auth · models-byok · cost-budget · hermetic-nix",
		"  isolation · remote-attach · editor-vim · harness-pi-flue",
		"  chrome-dense · monetization",
		"",
		"Flags:",
		"  --stack <id>        Filter knobs to one stack",
		"  --json              Full inventory",
		"  --cwd <path>        Project root for file markers",
		"  --help, -h          Show this help",
		"",
		"Examples:",
		"  hobo-code config",
		"  hobo-code config --stack editor-vim",
		"  hobo-code config --stack cost-budget --json",
		"",
		"See also: hobo-code env · hobo-code cost · hobo-code models · hobo-code edit",
	],
	edit: [
		"hobo-code edit — open [neo]vim in a managed harness pane",
		"",
		"For CLI-native engineers who live in vim/neovim (keyboard-first).",
		"",
		"Usage:",
		"  hobo-code edit [path]",
		"  hobo-code edit --editor nvim|vim|hx",
		"  hobo-code edit --bridge tmux-send|direct-exec|stdio-jsonrpc|acp",
		"  hobo-code edit --layout split-right|split-below|float|replace",
		"  hobo-code edit --json [path]",
		"  hobo-code edit --print-cmd [path]   # print open script only (shell eval)",
		"",
		"Bridge:",
		"  · tmux-send (default when tmux on PATH) — split pane titled hobo-code·nvim",
		"  · direct-exec — spawn editor in this TTY",
		"  · stdio-jsonrpc — neovim plugin ↔ hobo-code JSON",
		"  · acp — ACP-shaped (partial)",
		"",
		"Extension:",
		"  packages/code/editor/hobo-code.nvim  →  :HoboOpen :HoboStatus :HoboIsolation",
		"",
		"CLI navigation (no GUI):",
		"  status · tasks · isolate · edit · promote · attach",
		"",
		"Flags:",
		"  --editor <bin>      nvim | vim | hx | $EDITOR binary",
		"  --bridge <mode>     tmux-send | direct-exec | stdio-jsonrpc | acp",
		"  --layout <layout>   split-right | split-below | float | replace",
		"  --print-cmd         Print open command only (no panel)",
		"  --json              Full bridge contract",
		"  --help, -h          Show this help",
		"",
		"Examples:",
		"  hobo-code edit src/cli.ts",
		"  hobo-code isolate my-run && hobo-code edit .",
		"  hobo-code edit --bridge tmux-send --print-cmd path",
		"",
		"See also: hobo-code status · hobo-code isolate · hobo-code attach · hobo-code harness",
	],
	harness: [
		"hobo-code harness — Pi/Flue dual surface, skills, self-improve, brain",
		"",
		"For AI automation engineers who live in harnesses (Pi terminal + Flue durable).",
		"",
		"Usage:",
		"  hobo-code harness",
		"  hobo-code harness --json",
		"",
		"Shows:",
		"  · Dual surface: Pi TUI path + flue run hobo-code",
		"  · Shared customization (harness-customization.ts — ADR-0139)",
		"  · Skill roots (.agents/skills, .claude/skills) + presence",
		"  · Eve-shaped subagents (investigator · implementer · reviewer)",
		"  · Self-improve loop: isolate → evidence → promote → durable",
		"  · Brain notes: Serena · gbrain · durable handback · GraphRAG residual",
		"",
		"Pi vs Flue (mental model):",
		"  · Pi  — lightweight terminal coding-agent harness (tools loop)",
		"  · Flue — TypeScript framework on Pi: describe knowledge, durable run",
		"",
		"Flags:",
		"  --json              Full harness inventory",
		"  --cwd <path>        Project root for skill-root presence",
		"  --home <path>       Override HOBO_HOME (worlds hint)",
		"  --help, -h          Show this help",
		"",
		"Examples:",
		"  hobo-code harness",
		"  hobo-code harness --json",
		'  flue run hobo-code --input \'{"message":"status"}\'',
		"",
		"See also: hobo-code session · hobo-code tasks · hobo-code isolate · hobo-code cost",
	],
	cost: [
		"hobo-code cost — budget, $0 path, savings, free/local routing",
		"",
		"For cost-conscious open-source devs on a tight or $0 budget.",
		"",
		"Usage:",
		"  hobo-code cost",
		"  hobo-code cost --json",
		"",
		"Shows:",
		"  · Spend / cap / remaining (HOBO_CODE_BUDGET_USD)",
		"  · Routing policy (cheapest-capable by default)",
		"  · Active model + local/free hint",
		"  · Savings vs illustrative always-frontier baseline",
		"  · Free/local recipes (Ollama, OpenAI-compatible local, OrnithAI-class)",
		"  · Token-tool stack (RTK, headroom, caveman, Serena, ponytail)",
		"  · Monetization disable path (never inspects code/prompts)",
		"",
		"Env:",
		"  HOBO_CODE_BUDGET_USD=5          Cap (default 5)",
		"  HOBO_CODE_ROUTING=cheapest-capable|pinned|fallback-chain",
		"  HOBO_CODE_MONETIZATION=0        Force monetization off",
		"  HOBO_CODE_MODEL=ollama/…        Free/local model id",
		"  OPENAI_BASE_URL / OLLAMA_HOST   Local endpoint",
		"",
		"Flags:",
		"  --json              Full cost payload",
		"  --help, -h          Show this help",
		"",
		"Examples:",
		"  export HOBO_CODE_MONETIZATION=0",
		"  export HOBO_CODE_MODEL=ollama/qwen2.5-coder:7b",
		"  hobo-code cost",
		"",
		"See also: hobo-code models · hobo-code help",
	],
	auth: [
		"hobo-code auth — login to a Station (app agent identity)",
		"",
		"Usage:",
		"  hobo-code auth login",
		"  hobo-code auth login --tenant <id> --domain <host>",
		"  hobo-code auth login --complete <device-code>",
		"  hobo-code auth status",
		"  hobo-code auth logout",
		"  hobo-code auth whoami",
		"",
		"Local Station (default):",
		"  Auto-resolves station:local (or the only local Station), inits if needed.",
		"  Similar to a happy-path local copilot login — no browser required.",
		"",
		"Agent / human-free (preferred for coding agents):",
		"  hobo-code auth login --agent",
		"  Sets HOBO_CODE_AGENT contract: no browser, no elicitation, session-ref.",
		"  Or: export HOBO_CODE_SESSION_REF=… / prior durable session.json",
		"",
		"Remote Station (human bootstrap residual for agents):",
		"  Provide --tenant and --domain (station host).",
		"  Prints a one-time device code + verification URL (RFC 8628-shaped).",
		"  Complete with: hobo-code auth login --complete <code>",
		"  Steady-state agents should prefer local/session-ref over device-code.",
		"",
		"Flags:",
		"  --agent             Human-free local login + agent contract",
		"  --tenant <id>       Tenant (required for remote)",
		"  --domain <host>     Station domain (triggers remote login)",
		"  --station <id>      Explicit station id",
		"  --complete <code>   Finish remote device-code login",
		"  --json              Machine-readable envelope",
		"  --help, -h          Show this help",
		"",
		"Examples:",
		"  hobo-code auth login",
		"  hobo-code auth login --agent",
		"  hobo-code auth login --tenant acme --domain stations.acme.example",
		"  hobo-code auth status",
		"  hobo-code auth logout",
		"",
		"See also: hobo-code agent · hobo-code session · hobo-code dispatch",
	],
	agent: [
		"hobo-code agent — agent-native readiness (AX)",
		"",
		"For coding agents that need:",
		"  · Human-free auth (local Station / session-ref; not browser-only)",
		"  · Safe unattended iterate (isolate→promote, no elicitation)",
		"  · Learn from mistakes (self-improve + durable handback)",
		"  · Native protocols (MCP tools, ACP stdio, --json)",
		"",
		"Usage:",
		"  hobo-code agent",
		"  hobo-code agent --json",
		"",
		"Standards inventory (honest status):",
		"  · MCP — tools/resources; stdio env credentials; HTTP OAuth 2.1 residual",
		"  · ACP — editor↔agent JSON-RPC 2.0 over stdio (partial host)",
		"  · stdio-jsonrpc / cli-json — unattended verb contract",
		"  · Device-code / CIBA — human bootstrap residual",
		"",
		"Env:",
		"  HOBO_CODE_AGENT=1              Enable agent contract",
		"  HOBO_CODE_NO_ELICITATION=1     Same (no prompts)",
		"  HOBO_CODE_SESSION_REF=…        Pre-bound session (never printed)",
		"",
		"Examples:",
		"  export HOBO_CODE_AGENT=1",
		"  hobo-code auth login --agent",
		"  hobo-code agent --json",
		"  hobo-code isolate --json && hobo-code promote --run <id> --json",
		"",
		"See also: hobo-code harness · hobo-code config --stack agent-native · auth",
	],
	agents: [
		"hobo-code agents — register coding harnesses (Vercel-shaped)",
		"",
		"Analog of `vercel ai-gateway coding-agents setup`. Station occupancy is",
		"the destination — no Vercel key, no minted secret. Writes env_key +",
		"base URL into each harness's native config. Eve trees register at",
		"/agents/<id> in the virtual filesystem.",
		"",
		"Usage:",
		"  hobo-code agents                 # detected + registered",
		"  hobo-code agents list",
		"  hobo-code agents status",
		"  hobo-code agents init            # TTY: check/uncheck then write",
		"  hobo-code agents init --dry-run",
		"  hobo-code agents init --yes",
		"  hobo-code agents init --non-interactive",
		"  hobo-code agents init --all --yes",
		"  hobo-code agents init codex eve",
		"",
		"Flags:",
		"  --yes, -y            Write without a checklist (never mints a cloud key)",
		// SAFETY: parsed or fixture value is the named domain type after this assertion.
		"  --non-interactive    Same as --yes — scripts/CI default write",
		"  --dry-run            Show the plan only; never write",
		"  --all            Include every known harness, not just detected",
		"  --reconfigure    Rewrite even when already configured",
		"  --base <url>     Override destination listen URL",
		"  --json           Machine-readable envelope",
		"",
		"Destination ladder: --base → HOBO_CODE_LOCAL_BASE_URL → OPENAI_BASE_URL",
		"→ OLLAMA_HOST → live probe of http://127.0.0.1:11434. No listen URL → refuse.",
		"",
		"See also: hobo-code agent · hobo-code models · hobo-code mux",
	],
};

function verbHelpText(verb: HoboCodeVerb, dense: boolean): string {
	if (verb === "help") return helpText(dense);
	if (dense) {
		// Compact one-liner pointer + plain block would thrash; keep short.
		const tails = {
			dispatch: "★d",
			init: "in",
			status: "st",
			resources: "rs",
			history: "hi",
			alias: "al",
			dashboard: "db",
			session: "se",
			attach: "at",
			resume: "re",
			compact: "cp",
			tasks: "tk",
			guide: "gd",
			scaffold: "sc",
			template: "tp",
			review: "rv",
			dev: "dv",
			isolate: "i",
			promote: "pr",
			env: "ev",
			auth: "au",
			models: "mo",
			cost: "$",
			harness: "hz",
			edit: "ed",
			config: "cfg",
			agent: "ag",
			agents: "ags",
		};
		let t: string = verb;
		for (const [name, tail] of Object.entries(tails)) {
			if (name === verb) t = tail;
		}
		return [
			`hobo-code ${verb} · dense · tail ${t}`,
			`plain: hobo-code ${verb} --help`,
			`top:   hobo-code help --dense`,
			"",
			...VERB_HELP_PLAIN[verb],
		].join("\n");
	}
	return VERB_HELP_PLAIN[verb].join("\n");
}

function isTopicVerb(token: string): token is Exclude<HoboCodeVerb, "help"> {
	return VERB_SET.has(token) && token !== "help";
}

/**
 * When --dense, compress long verb titles to power-user tails (glyph idioms).
 * Default (plain) leaves messages unchanged for unfamiliar devs.
 */
export function applyDenseChrome(message: string): string {
	const lines = message.split("\n");
	const titleMap = {
		"▣ isolate": "▣ i",
		"✓ promote": "✓ pr",
		"✕ promote": "✕ pr",
		"✕ isolate": "✕ i",
		"✕ session": "✕ se",
		"✕ distributed": "✕ dist",
		"✕ cmd": "✕ ?",
		"? cmd": "? ?",
		"▣ env": "▣ ev",
		"▣ pl": "▣ pl",
		"◎ re": "◎ re",
		"◎ attach": "◎ at",
		"◎ resume": "◎ re",
		"▣ agents": "▣ ag",
		"▣ tasks": "▣ tk",
		"▣ guide": "▣ gd",
		"◈ b": "◈ b",
		"✦ sc": "✦ sc",
		"◈ cost": "◈ $",
		"◈ harness": "◈ hz",
		"◈ edit": "◈ ed",
		"◈ config": "◈ cfg",
	};
	return lines
		.map((line, idx) => {
			if (idx === 0) {
				for (const [name, title] of Object.entries(titleMap)) {
					if (name === line) return totalAccess.must(title);
				}
			}
			// Short next-step idioms
			return line
				.replace(/^ next · hobo-code promote (.+)$/, " next · pr $1")
				.replace(/^ next · hobo-code status$/, " next · st")
				.replace(/^ try · hobo-code help$/, " try · help")
				.replace(/^ did you mean · /, " ≈ ")
				.replace(/^ unknown · /, " ? ");
		})
		.join("\n");
}

/**
 * Run the hobo-code CLI. Dispatch is the default verb when none is given.
 */
export async function runHoboCodeCli(
	argv: readonly string[],
	deps: HoboCodeCliDeps = {},
): Promise<HoboCodeCliResult> {
	const env = deps.env ?? process.env;
	let parsed: ReturnType<typeof parseArgv>;
	try {
		parsed = parseArgv(argv);
	} catch (error) {
		// Strict flag parsing: unknown/malformed flags fail with a help pointer.
		const message = error instanceof Error ? error.message : String(error);
		return {
			ok: false,
			status: "failed",
			code: "HOBO_CODE_UNKNOWN_FLAG",
			message: panel("✕ flags", [message, "try · hobo-code help"]),
			remediation: ["hobo-code help", "hobo-code <verb> --help"],
			exitCode: 1,
		};
	}
	const { verb, args, flags, defaultedVerb } = parsed;
	const _json = deps.json === true || flags.json === true;
	const dense =
		deps.dense === true ||
		flags.dense === true ||
		env.HOBO_CODE_DENSE === "1" ||
		env.HOBO_CODE_DENSE === "true";
	const hoboHome =
		(isJsonString(flags.home) && flags.home) ||
		deps.hoboHome ||
		defaultHoboHome(env);
	const projectDir =
		(isJsonString(flags.cwd) && flags.cwd) || deps.cwd || process.cwd();
	const tenant =
		(isJsonString(flags.tenant) && flags.tenant) ||
		(isJsonString(env.HOBO_TENANT) && env.HOBO_TENANT) ||
		"local";
	const stationFlag = isJsonString(flags.station) ? flags.station : undefined;
	const poolId =
		(isJsonString(flags.pool) && flags.pool) ||
		(isJsonString(flags.hive) && flags.hive) || // legacy alias
		"default";
	const features = deps.features ?? createMemoryFeaturePort();

	const authSession = readAuthSession(hoboHome);
	const resolvedStation =
		stationFlag ??
		authSession?.stationId ??
		resolveAuthenticatedStationId(hoboHome);
	const resolvedTenant =
		tenant !== "local" ? tenant : (authSession?.tenant ?? tenant);
	const platform = composeCodePlatform({
		hoboHome,
		...(resolvedStation !== undefined
			? { stationId: resolvedStation }
			: undefined),
		// `init` owns Station creation explicitly (discovery-gated, ADR-0155);
		// composing the snapshot must not pre-empt it with a silent auto-init.
		autoInitStation:
			verb !== "init" && !(verb === "session" && isJsonString(flags.host)),
		tenant: resolvedTenant,
		features,
	});

	const withDense = <T>(data?: T): JsonObject => {
		if (data === undefined) return { dense };
		if (
			data !== null &&
			!Array.isArray(data) &&
			Object.prototype.toString.call(data) === "[object Object]"
		) {
			return Object.assign({ dense }, data);
		}
		return { dense, payload: cloneAsJson(data) };
	};

	const ok = <T>(
		code: string,
		message: string,
		data?: T,
	): HoboCodeCliResult => ({
		ok: true,
		status: "ok",
		code,
		message,
		data: withDense(data),
		exitCode: 0,
	});

	const fail = <T>(
		code: string,
		message: string,
		remediation?: readonly string[],
		data?: T,
	): HoboCodeCliResult => ({
		ok: false,
		status: "failed",
		code,
		message,
		...(remediation !== undefined ? { remediation } : undefined),
		data: withDense(data),
		exitCode: 1,
	});

	// json/dense formatting is applied by formatHoboCodeResult / bin.

	// Bare single-token near-miss / CLI-shaped unknowns → kind recovery, not ★ success.
	if (defaultedVerb && args.length === 1) {
		const raw = String(args[0] ?? "");
		const suggestion = suggestVerbTypo(raw);
		if (suggestion) {
			return fail(
				"HOBO_CODE_UNKNOWN_VERB",
				panel("? cmd", [
					`not a verb · ${raw}`,
					`did you mean · ${suggestion}`,
					"try · hobo-code help",
					`prompt · hobo-code "${raw}"`,
				]),
				[
					`hobo-code ${suggestion} …`,
					"hobo-code help",
					// SAFETY: parsed or fixture value is the named domain type after this assertion.
					`hobo-code "${raw}"  # send as build prompt`,
				],
				{ unknown: raw, suggestion, defaultVerb: "dispatch" },
			);
		}
		if (looksLikeUnknownVerbAttempt(raw)) {
			return fail(
				"HOBO_CODE_UNKNOWN_VERB",
				panel("? cmd", [
					`not a verb · ${raw}`,
					"try · hobo-code help",
					`prompt · hobo-code "${raw}"`,
					"or · hobo-code guide",
				]),
				[
					"hobo-code help",
					// SAFETY: parsed or fixture value is the named domain type after this assertion.
					`hobo-code "${raw}"  # send as build prompt`,
					"hobo-code guide",
					'hobo-code "add a settings page"',
				],
				{ unknown: raw, defaultVerb: "dispatch" },
			);
		}
	}

	const hermetic = inspectHermeticEnv({
		projectRoot: projectDir,
		hoboHome,
		env,
	});

	// Subcommand help: `hobo-code platform --help` or `hobo-code help platform`
	let helpTopic: Exclude<HoboCodeVerb, "help"> | null = null;
	if (verb === "help" && args[0] && isTopicVerb(String(args[0]))) {
		// SAFETY: isTopicVerb proved args[0] is a non-help verb.
		helpTopic = String(args[0]) as Exclude<HoboCodeVerb, "help">;
	} else if (flags.help === true && verb !== "help") {
		// SAFETY: flags.help on a non-help verb names that verb as the topic.
		helpTopic = verb as Exclude<HoboCodeVerb, "help">;
	}

	if (verb === "help" || helpTopic !== null) {
		const topic = helpTopic;
		const message =
			topic !== null ? verbHelpText(topic, dense) : helpText(dense);
		return ok("HOBO_CODE_HELP", message, {
			verbs: [...HOBO_CODE_VERBS],
			defaultVerb: "dispatch",
			dense,
			topic: topic ?? "top",
			defaults: CODE_FEATURE_DEFAULTS,
			distributed: describeDistributedCompute(),
			binary: "hobo-code",
			subagents: describeEveSubagentSurface(),
			secureSandbox: describeSecureSandboxStack(),
			worlds: describeCodeWorlds(hoboHome),
			hermetic,
			hermeticPolicy:
				"Optional devenv/nix for hobo-code hermetic toolchains; not required; durable state stays under HOBO_HOME outside sandboxes.",
		});
	}

	if (verb === "models") {
		const status = inspectModels(env);
		const body = modelsHumanSummary(status);
		const text = panel("▣ models", body.split("\n"));
		return ok("HOBO_CODE_MODELS", text, { models: status, text });
	}

	if (verb === "cost") {
		const status = inspectCost(env);
		const body = costHumanSummary(status);
		const text = panel("◈ cost", body.split("\n"));
		return ok("HOBO_CODE_COST", text, { cost: status, text });
	}

	if (verb === "harness") {
		const status = inspectHarnessSurface({
			cwd: projectDir,
			hoboHome,
		});
		const body = harnessHumanSummary(status);
		const text = panel("◈ harness", body.split("\n"));
		return ok("HOBO_CODE_HARNESS", text, { harness: status, text });
	}

	if (verb === "config") {
		const stackRaw = isJsonString(flags.stack)
			? flags.stack.toLowerCase()
			: args[0] && !args[0].startsWith("-")
				? args[0].toLowerCase()
				: "";
		const stack: ConfigStackId | null = isConfigStackId(stackRaw)
			? stackRaw
			: null;
		if (stackRaw && !stack) {
			return fail(
				"HOBO_CODE_CONFIG_USAGE",
				panel("✕ config", [
					`unknown stack · ${stackRaw}`,
					"try · agent-native | cost-budget | editor-vim | hermetic-nix | harness-pi-flue",
					"list · hobo-code config --help",
				]),
				["hobo-code config --help", "hobo-code config --json"],
			);
		}
		const status = inspectConfigSurface(env, projectDir);
		const body = configHumanSummary(status, stack);
		const text = panel("◈ config", body.split("\n"));
		return ok("HOBO_CODE_CONFIG", text, {
			config: status,
			stack,
			text,
		});
	}

	if (verb === "agent") {
		const status = inspectAgentSurface({
			hoboHome,
			cwd: projectDir,
			env,
		});
		const body = agentHumanSummary(status);
		const text = panel("◈ agent", body.split("\n"));
		return ok("HOBO_CODE_AGENT", text, { agent: status, text });
	}

	if (verb === "agents") {
		const result = await runAgentsCli({
			hoboHome,
			cwd: projectDir,
			env,
			args,
			flags,
			tty: process.stdin.isTTY === true && process.stdout.isTTY === true,
		});
		return result.ok
			? ok(result.code, result.message, result.data)
			: fail(result.code, result.message, undefined, result.data);
	}

	if (verb === "init") {
		const dryRun = flags["dry-run"] === true;
		const scenarioRaw = isJsonString(flags.scenario)
			? flags.scenario
			: "local-dev";
		if (!isCodeDevScenario(scenarioRaw)) {
			return fail(
				"HOBO_CODE_INIT_SCENARIO",
				panel("✕ init", [
					`unknown scenario · ${scenarioRaw}`,
					"known · local-dev | ephemeral | preview",
				]),
				["hobo-code init --scenario local-dev"],
			);
		}
		const declaration = codeDevStation(scenarioRaw, {
			...(resolvedStation !== undefined
				? { name: resolvedStation.replace(/^station:/, "") }
				: undefined),
			tenant: resolvedTenant,
		});
		const probes = deps.machineProbes ?? defaultMachineProbes(env);
		const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
		const report = await discoverMachine({
			probes,
			packageRoot,
			hoboHome,
			cwd: projectDir,
		});
		const manifest = matchMachineToStation({
			stationId: declaration.id,
			report,
			declared: declaration.capabilities,
			env,
		});
		const capabilityRows = manifest.capabilities.map((row) => {
			const mark =
				row.status === "present" ? "✓" : row.capability.required ? "✕" : "·";
			const tail =
				row.status === "present"
					? (row.evidence[0] ?? "")
					: (row.capability.remediation ?? "missing");
			return `${mark} ${row.capability.kind}:${row.capability.slug} · ${tail}`;
		});
		if (!manifest.ok) {
			// Fail closed (ADR-0131 §7 / ADR-0155): a machine missing required
			// localhost capabilities does not get durable Station state.
			return fail(
				"HOBO_CODE_INIT_CAPABILITY",
				panel("✕ init", [
					`station · ${declaration.id} (${scenarioRaw}) — not seeded`,
					...capabilityRows,
					"required capabilities missing — nothing written",
				]),
				manifest.remediation,
				{ report, manifest, dryRun: true },
			);
		}
		if (dryRun) {
			return ok(
				"HOBO_CODE_INIT_DRY_RUN",
				panel("▣ init", [
					`station · ${declaration.id} (${scenarioRaw}) — dry-run`,
					...capabilityRows,
					"nothing written · re-run without --dry-run to seed",
				]),
				{ report, manifest, dryRun: true },
			);
		}
		const seeded = initStation({
			hoboHome,
			...stationInitArgsFromDeclaration(declaration),
		});
		const manifestPath = persistStationCapabilityManifest(
			hoboHome,
			seeded.stationId,
			manifest,
		);
		const reportPath = persistMachineDiscoveryReport(hoboHome, report);
		return ok(
			"HOBO_CODE_INIT",
			panel("✓ init", [
				`station · ${seeded.stationId} (${scenarioRaw}) · ${seeded.created ? "created" : "already present"}`,
				...capabilityRows,
				`manifest · ${manifestPath}`,
				`report · ${reportPath}`,
				"next · hobo-code status",
			]),
			{
				report,
				manifest,
				station: {
					stationId: seeded.stationId,
					created: seeded.created,
					dataDir: seeded.dataDir,
					bootstrapActive: seeded.occupancy.bootstrapActive,
				},
				paths: { manifest: manifestPath, report: reportPath },
				dryRun: false,
			},
		);
	}

	if (verb === "edit") {
		const pathArg =
			args.find((a) => !a.startsWith("-")) ??
			(isJsonString(flags.path) ? flags.path : null);
		const bridgeRaw = isJsonString(flags.bridge)
			? flags.bridge.toLowerCase()
			: "";
		const bridgeModes = [
			"tmux-send",
			"direct-exec",
			"stdio-jsonrpc",
			"acp",
		] as const;
		let bridge: BridgeMode | undefined;
		if (
			bridgeModes.includes(
				// SAFETY: flags.bridge was lowercased; includes() checks the closed set.
				bridgeRaw as (typeof bridgeModes)[number],
			)
		) {
			// SAFETY: includes() proved bridgeRaw is a BridgeMode.
			bridge = bridgeRaw as BridgeMode;
		}
		const layoutRaw = isJsonString(flags.layout)
			? flags.layout.toLowerCase()
			: "";
		const layoutModes = [
			"split-right",
			"split-below",
			"float",
			"replace",
		] as const;
		let layout: PaneLayout | undefined;
		if (
			layoutModes.includes(
				// SAFETY: flags.layout was lowercased; includes() checks the closed set.
				layoutRaw as (typeof layoutModes)[number],
			)
		) {
			// SAFETY: includes() proved layoutRaw is a PaneLayout.
			layout = layoutRaw as PaneLayout;
		}
		const editor = isJsonString(flags.editor)
			? flags.editor
			: isJsonString(flags.e)
				? flags.e
				: undefined;
		const status = inspectEditorBridge({
			env,
			path: pathArg,
			...(editor !== undefined ? { editor } : undefined),
			...(layout !== undefined ? { layout } : undefined),
			...(bridge !== undefined ? { bridge } : undefined),
			isolationRoot: null,
		});
		const openCmd = editorBridgeOpenScript(status);
		if (flags["print-cmd"] === true || flags.printcmd === true) {
			return ok(
				"HOBO_CODE_EDIT",
				openCmd.endsWith("\n") ? openCmd : `${openCmd}\n`,
				{
					editor: status,
					openCommand: openCmd,
					text: openCmd,
				},
			);
		}
		const body = editorBridgeHumanSummary(status);
		const text = panel("◈ edit", [
			...body.split("\n"),
			`cmd · ${openCmd.length > 42 ? `${openCmd.slice(0, 40)}…` : openCmd}`,
			"run · hobo-code edit --print-cmd … | sh   # or eval",
		]);
		return ok("HOBO_CODE_EDIT", text, {
			editor: status,
			openCommand: openCmd,
			text,
		});
	}

	if (verb === "auth") {
		const sub = (args[0] ?? "status").toLowerCase();
		const _completeCode = isJsonString(flags.complete)
			? flags.complete
			: args[0]?.toLowerCase() === "login" && args[1] === "--complete"
				? args[2]
				: undefined;
		// login --complete CODE  or  auth login with --complete flag
		if (
			sub === "login" &&
			(isJsonString(flags.complete) || args[1] === "--complete")
		) {
			const code =
				(isJsonString(flags.complete) && flags.complete) ||
				(args[1] === "--complete" ? args[2] : undefined) ||
				args[1];
			if (!code) {
				return fail(
					"HOBO_CODE_AUTH_USAGE",
					panel("✕ auth", [
						"missing device code",
						"usage · hobo-code auth login --complete <code>",
					]),
					["hobo-code auth login --tenant <t> --domain <host>"],
				);
			}
			const result = confirmRemoteLogin({
				hoboHome,
				userCode: String(code),
			});
			if (!result.ok || result.status !== "logged-in") {
				const codeOut = result.ok ? "HOBO_CODE_AUTH_PENDING" : result.code;
				const msg = result.message;
				const rem = result.ok ? [] : result.remediation;
				return fail(codeOut, panel("✕ auth", [msg]), rem);
			}
			const text = panel("✓ auth", [
				result.message,
				`station · ${result.session.stationId}`,
				'next · hobo-code dispatch "…"',
			]);
			return ok("HOBO_CODE_AUTH", text, { auth: result, text });
		}
		if (sub === "login") {
			const agentLogin =
				flags.agent === true ||
				env.HOBO_CODE_AGENT === "1" ||
				env.HOBO_CODE_AGENT === "true";
			// Agent path refuses remote device-code as steady-state: force local.
			if (
				agentLogin &&
				(isJsonString(flags.domain) || isJsonString(flags.tenant)) &&
				flags.force !== true
			) {
				return fail(
					"HOBO_CODE_AUTH_AGENT_REMOTE",
					panel("✕ auth", [
						"agent login refuses interactive remote device-code",
						"use · local Station (drop --tenant/--domain)",
						"or · pre-bind HOBO_CODE_SESSION_REF / prior session.json",
						"human bootstrap · auth login --tenant … --domain … (no --agent)",
					]),
					[
						"hobo-code auth login --agent",
						"export HOBO_CODE_SESSION_REF=…",
						"hobo-code agent --json",
					],
				);
			}
			const mock =
				env.HOBO_CODE_AUTH_MOCK === "1" ||
				flags.mock === true ||
				flags["complete-remote"] === true;
			const result = authLogin({
				hoboHome,
				...(isJsonString(flags.tenant) && !agentLogin
					? { tenant: flags.tenant }
					: undefined),
				...(isJsonString(flags.domain) && !agentLogin
					? { domain: flags.domain }
					: undefined),
				...(isJsonString(flags.station)
					? { stationId: flags.station }
					: undefined),
				completeRemoteImmediately: mock,
				autoInitLocal: true,
			});
			if (!result.ok) {
				return fail(
					result.code,
					panel("✕ auth", [
						result.message,
						...result.remediation.map((r) => `→ ${r}`),
					]),
					result.remediation,
				);
			}
			if (result.status === "device-code-pending") {
				const text = panel("◎ auth login", [
					"remote device code",
					`code · ${result.userCode}`,
					`open · ${result.verificationUrl}`,
					`then · hobo-code auth login --complete ${result.userCode}`,
				]);
				return ok("HOBO_CODE_AUTH_PENDING", text, { auth: result, text });
			}
			const text = panel("✓ auth login", [
				result.session.mode === "local"
					? `Logged in to Station ${result.session.stationId} (local)`
					: `Logged in to Station ${result.session.displayName}`,
				`tenant · ${result.session.tenant}`,
				...(result.session.domain ? [`domain · ${result.session.domain}`] : []),
				...(agentLogin
					? [
							"agent · human-free · no-elicitation",
							`sessionRef · ${result.session.sessionRef.slice(0, 12)}…`,
							"next · hobo-code agent --json · isolate --json",
						]
					: [
							"sandbox · isolate/session (mediated)",
							"models · hobo-code models",
							'next · hobo-code "build something"',
						]),
			]);
			return ok("HOBO_CODE_AUTH", text, {
				auth: result,
				session: result.session,
				text,
			});
		}
		if (sub === "logout") {
			const occupied = describeAuthedStationSession({
				hoboHome,
				env,
				ensureLocalLogin: false,
			});
			if (occupied.loggedIn && occupied.stationId.length > 0) {
				await stopStationSidecars(hoboHome, occupied.stationId);
			}
			const cleared = clearAuthSession(hoboHome);
			const text = panel("✓ auth logout", [
				cleared ? "signed out" : "already signed out",
				"next · hobo-code auth login",
			]);
			return ok("HOBO_CODE_AUTH", text, { cleared, text });
		}
		// status / whoami / default
		const st = authStatus(hoboHome);
		const text = panel(st.loggedIn ? "✓ auth" : "○ auth", [
			st.message,
			...(st.session
				? [
						`mode · ${st.session.mode}`,
						`station · ${st.session.stationId}`,
						`tenant · ${st.session.tenant}`,
						"sandbox · isolate/session (mediated)",
						"models · hobo-code models",
					]
				: ["next · hobo-code auth login"]),
		]);
		return ok("HOBO_CODE_AUTH", text, { auth: st, text });
	}

	if (verb === "status") {
		const panes = [
			createPane(
				"coord",
				platform.features.harnessEnabled ? "idle" : "blocked",
				platform.features.harnessEnabled
					? platform.provider.id === "flue"
						? "" // idle glyph = ready
						: platform.provider.id
					: "code.harness.enabled=false",
			),
			createPane(
				"station",
				platform.station.present ? "done" : "blocked",
				platform.station.present
					? `${platform.station.stationId.replace(/^station:/, "")}${authSession ? ` · ${authSession.tenant}` : ""}`
					: (platform.station.remediation ?? "miss"),
			),
			createPane(
				"auth",
				authSession ? "done" : "idle",
				authSession
					? authSession.mode === "local"
						? ""
						: authSession.displayName
					: "login",
			),
		];
		const status = buildMultiplexerStatus(panes, {
			remoteReady: true,
			theme: "herdr",
		});
		const herdr = herdrMuxCapabilities(status.theme);
		const grokBuild = grokBuildParity();
		// Plain default: English hierarchy for GUI-native humans.
		// Dense opt-in: glyph box + Herdr/Grok footers (power chrome).
		const text = dense
			? `${renderStatusText(status)}\n${renderHerdrCapabilityFooter(herdr)}\n${renderGrokBuildFooter(grokBuild)}`
			: renderStatusText(status, { plain: true });
		const chip = renderStatusChip(status);
		// Human primary output is the chrome itself, not a one-line summary.
		return ok("HOBO_CODE_STATUS", text, {
			status,
			herdr,
			capabilities: herdr,
			grokBuild,
			text,
			chip,
			dense,
			platform,
			dogfood: dogfoodSummary(platform.station.stationId),
		});
	}

	if (verb === "resources") {
		const inventory = await assembleSessionResources({
			hoboHome,
			env,
			projectDir,
		});
		const kindRaw = (
			isJsonString(flags.kind) ? flags.kind : args[0]
		)?.toLowerCase();
		const kinds: readonly ResourceKind[] = [
			"station",
			"junction",
			"yard",
			"camp",
			"bindle",
		];
		const kind = kinds.find((row) => row === kindRaw);
		const filtered = kind ? filterSessionResources(inventory, kind) : inventory;
		const text = formatSessionResources(filtered);
		return {
			...ok("HOBO_CODE_RESOURCES", text, {
				inventory: filtered,
				text,
			}),
			ok: filtered.ok,
			status: filtered.ok ? "ok" : "failed",
			exitCode: filtered.ok ? 0 : 1,
		};
	}

	if (verb === "history") {
		const result = runHistoryCli({
			hoboHome,
			env,
			args,
			flags,
			cwd: projectDir,
		});
		return result.ok
			? ok(result.code, result.message, result.data)
			: fail(result.code, result.message, undefined, result.data);
	}

	if (verb === "alias") {
		const result = runAliasCli({
			hoboHome,
			env,
			args,
		});
		return result.ok
			? ok(result.code, result.message, result.data)
			: fail(result.code, result.message, undefined, result.data);
	}

	if (verb === "dashboard") {
		const port = Number(flags.port ?? env.HOBO_DEV_DASHBOARD_PORT ?? 8787);
		const dash = await startLocalDashboard({
			hoboHome,
			env,
			projectRoot: projectDir,
			...(Number.isInteger(port) ? { port } : undefined),
		});
		const once = flags.once === true;
		if (once) await dash.close();
		else if (deps.onDevSession) {
			/* keep listening for tests via process lifetime */
		} else {
			const stop = (): void => {
				void dash.close();
			};
			process.once("SIGINT", stop);
			process.once("SIGTERM", stop);
		}
		const text = panel("◎ dashboard", [
			`spa · ${dash.url}`,
			`otlp-http · ${dash.otlpHttpUrl}`,
			`otlp-grpc · ${new URL(dash.otlpHttpUrl).hostname}:${dash.otlpGrpcPort}`,
			`env · ${env.HOBO_ENV ?? "local-dev"}`,
			once ? "probe · bound; stopped" : "live · Ctrl-C to stop",
		]);
		return ok("HOBO_CODE_DASHBOARD", text, {
			dashboard: {
				url: dash.url,
				port: dash.port,
				otlpHttpUrl: dash.otlpHttpUrl,
				otlpHttpPort: dash.otlpHttpPort,
				otlpGrpcPort: dash.otlpGrpcPort,
				stopped: once,
			},
			text,
		});
	}

	if (verb === "tasks") {
		const surface = buildTasksSurface({
			hoboHome,
			...(isJsonString(flags.run) ? { runId: flags.run } : undefined),
			panes: [
				createPane(
					"coord",
					platform.features.harnessEnabled ? "working" : "blocked",
					platform.features.harnessEnabled ? "dispatch" : "harness off",
				),
				createPane("worker", "idle", "standby"),
				createPane("watcher", "idle", "monitor"),
			],
		});
		const text = renderTasksBoardText(surface);
		return ok("HOBO_CODE_TASKS", text, {
			...surface,
			text,
			platform,
		});
	}

	if (verb === "guide") {
		const fromRaw = isJsonString(flags.from) ? flags.from.toLowerCase() : "";
		const wantCursor =
			flags.cursor === true ||
			fromRaw === "cursor" ||
			args.some((a) => a.toLowerCase() === "cursor");
		if (wantCursor) {
			const guide = cursorGuide();
			const text = renderCursorGuideText(guide);
			return ok("HOBO_CODE_GUIDE", text, {
				guide,
				cursor: guide,
				source: "cursor",
				text,
			});
		}
		const guide = claudeCodeGuide();
		const text = renderClaudeCodeGuideText(guide);
		return ok("HOBO_CODE_GUIDE", text, {
			guide,
			claudeCode: guide,
			source: "claude-code",
			text,
		});
	}

	if (verb === "machines") {
		const project = loadDevMachines(projectDir);
		const loaded = project.declared
			? project
			: loadDevMachines(join(dirname(fileURLToPath(import.meta.url)), ".."));
		const rows = loaded.declared
			? [
					...(loaded.machines.length > 0
						? loaded.machines.map(
								(m) =>
									`${m.id} · ${sshDestination(m)} · ${m.isolationClass}${m.agents && m.agents.length > 0 ? ` · ${m.agents.join(",")}` : ""}`,
							)
						: ["no machines declared"]),
					// Never silently drop a bad entry: an operator who wrote one
					// needs to know it is not in the reachable set.
					...loaded.rejected.map(
						(r) => `rejected · ${r.machine}: ${r.problem}`,
					),
					`file · ${loaded.path}`,
				]
			: [
					`no ${DEV_MACHINES_FILE} beside the devenv files`,
					"Declare machines there and panes can reach them; until then",
					"mux runs locally only.",
					`expected · ${loaded.path}`,
				];
		return ok("HOBO_CODE_MACHINES", panel("✓ machines", rows), {
			machines: loaded.machines,
			rejected: loaded.rejected,
			declared: loaded.declared,
			path: loaded.path,
		});
	}

	if (verb === "vshell") {
		// The pane entrypoint. It owns stdin for the life of the pane, so it
		// returns its own result rather than going through the panel path.
		const workspace =
			isJsonString(flags.workspace) && flags.workspace.length > 0
				? flags.workspace
				: projectDir;
		// `--agent` is a boolean flag elsewhere in this CLI, so the pane name
		// rides on `--name` rather than silently parsing as `true`.
		const agentId =
			isJsonString(flags.name) && flags.name.length > 0 ? flags.name : "agent";
		// createVirtualShell throws synchronously on a missing root, and this
		// verb awaits it directly — an unhandled rejection out of the CLI rather
		// than a HOBO_CODE_* result, reachable from the documented flag.
		try {
			await runVirtualPane({
				agentId,
				workspace,
				...(isJsonString(flags.tier) ? { tier: flags.tier } : undefined),
				...(isJsonString(flags.source) ? { source: flags.source } : undefined),
				...(deps.input !== undefined ? { input: deps.input } : undefined),
			});
		} catch (error) {
			return fail(
				"HOBO_CODE_VSHELL_FAILED",
				panel("✕ vshell", [
					error instanceof Error ? error.message : String(error),
					`workspace · ${workspace}`,
					// Only add the mount hint when the mount is what failed;
					// appending it to every error explains the wrong thing.
					...(/namespace/u.test(
						error instanceof Error ? error.message : String(error),
					)
						? []
						: [
								"A virtual pane mounts a real directory; that one could not be read.",
							]),
				]),
				["hobo-code vshell --help", "hobo-code mux --dry-run"],
				{ agentId, workspace },
			);
		}
		return ok("HOBO_CODE_VSHELL", "virtual pane closed", {
			agentId,
			workspace,
		});
	}

	if (verb === "mux") {
		const subcommand = args[0];
		if (
			subcommand !== undefined &&
			!["tab", "pane", "attach", "focus", "detach", "stop", "list"].includes(
				subcommand,
			)
		) {
			return ok(
				"HOBO_CODE_MUX",
				panel("mux", [
					"tab · create or select a tab",
					"pane · split or manage a pane",
					"attach · attach a session",
					"focus · focus a session, tab, or pane",
					"detach · detach a session",
					"stop · stop a session",
					"list · list sessions",
				]),
				{ subcommand },
			);
		}
		if (subcommand === "list") {
			const listed = await (deps.muxRunner ?? tmuxRunner()).run([
				"list-sessions",
				"-F",
				"#{session_name}",
			]);
			const output = listed.code === 0 ? listed.stdout : "no sessions";
			return ok("HOBO_CODE_MUX", output, {
				sessions: output.split("\n").filter((line) => line.length > 0),
			});
		}
		const probes = defaultProbes(env);
		const agents = detectAgents(probes);
		// Agents work in the declared devenv workspace, not wherever the shell
		// happened to be standing.
		const workspace = findWorkspaceRoot(projectDir, env);
		const session =
			isJsonString(flags.session) && flags.session.length > 0
				? flags.session
				: "hobo";
		// Every agent is a target; local inference is not a special case, it is
		// just a target whose kind says where the work runs.
		// One virtual worktree per agent (rift by default) so parallel agents
		// cannot collide in a shared checkout.
		// A remote host has its own filesystem. Local workspace paths mean
		// nothing there, so allocating them would either send this machine's
		// absolute paths to a different one or waste the work outright; the
		// remote's own working directory is the honest answer.
		// `--host` names a *declared* machine, not an arbitrary ssh destination.
		// Resolving it through the registry is what makes the reachable set
		// reviewable; an unknown name is refused with the list of known ones
		// rather than handed to ssh to fail obscurely.
		// The project's own devenv declares its machines; hobo-code's package
		// root is the fallback so the harness can ship defaults for itself.
		const projectMachines = loadDevMachines(projectDir);
		const declaredMachines = projectMachines.declared
			? projectMachines
			: loadDevMachines(join(dirname(fileURLToPath(import.meta.url)), ".."));
		const requestedHost = isJsonString(flags.host) ? flags.host : undefined;
		if (flags.virtual === true && requestedHost) {
			// Before resolution and before brokering: a vshell command names a
			// local workspace path that does not exist on the remote, and
			// checking after the gateway ran would create and discard N sessions
			// plus N audit events for a combination that cannot work.
			return fail(
				"HOBO_CODE_MUX_VIRTUAL_REMOTE",
				panel("✕ mux", [
					"--virtual and --host cannot be combined yet.",
					"A virtual pane mounts a directory on this machine; the remote",
					"has its own filesystem, so the path would not resolve there.",
					"Run --virtual locally, or --host without it.",
				]),
				["hobo-code mux --virtual", `hobo-code mux --host ${requestedHost}`],
				{ requestedHost },
			);
		}
		const resolution = requestedHost
			? resolveMachine(declaredMachines.machines, requestedHost)
			: null;
		if (resolution !== null && "ambiguous" in resolution) {
			return fail(
				"HOBO_CODE_MUX_AMBIGUOUS_MACHINE",
				panel("✕ mux", [
					`"${requestedHost}" is the host of more than one declared machine.`,
					...resolution.ambiguous.map((m) => `  ${m.id} · ${m.isolationClass}`),
					"Name one by its id — choosing for you is how the wrong session",
					"gets brokered against the wrong isolation class.",
				]),
				["hobo-code machines"],
				{ requested: requestedHost, ambiguous: resolution.ambiguous },
			);
		}
		const resolvedMachine =
			resolution !== null && "machine" in resolution
				? resolution.machine
				: undefined;
		if (requestedHost && !resolvedMachine) {
			return fail(
				"HOBO_CODE_MUX_UNKNOWN_MACHINE",
				panel("✕ mux", [
					`"${requestedHost}" is not a declared dev machine.`,
					declaredMachines.declared
						? `known · ${declaredMachines.machines.map((m) => m.id).join(", ") || "none"}`
						: `no ${DEV_MACHINES_FILE} beside the devenv files — declare machines there first`,
					...(declaredMachines.rejected.length > 0
						? declaredMachines.rejected.map(
								(r) => `rejected · ${r.machine}: ${r.problem}`,
							)
						: []),
					"Panes reach only declared machines, so the set an agent can touch",
					"is reviewable, and each session is authorised and audited.",
				]),
				["hobo-code machines", "hobo-code mux --dry-run"],
				{ requested: requestedHost, declared: declaredMachines },
			);
		}
		const remoteHost = resolvedMachine
			? sshDestination(resolvedMachine)
			: undefined;

		// A machine may declare which agents it hosts; honouring that here is
		// what makes the field mean anything. An agent with nowhere to go is
		// named rather than silently placed on a machine that excluded it.
		const placeable = resolvedMachine
			? agents.filter(
					(a) => machinesForAgent([resolvedMachine], a.id).length > 0,
				)
			: agents;
		const excluded = resolvedMachine
			? agents.filter((a) => !placeable.some((p) => p.id === a.id))
			: [];
		if (resolvedMachine && placeable.length === 0) {
			return fail(
				"HOBO_CODE_MUX_NO_PLACEABLE_AGENTS",
				panel("✕ mux", [
					`${resolvedMachine.id} declares agents · ${(resolvedMachine.agents ?? []).join(", ")}`,
					`detected here · ${agents.map((a) => a.id).join(", ") || "none"}`,
					"No detected agent is allowed on that machine.",
				]),
				["hobo-code machines", "hobo-code agent"],
				{ machine: resolvedMachine, detected: agents.map((a) => a.id) },
			);
		}

		// Broker a Station session per remote pane. Doing this before tmux is
		// touched means a denial stops the session from opening at all, rather
		// than leaving panes sitting on a host they were not authorised for.
		let brokered: Awaited<ReturnType<typeof brokerPanes>> | undefined;
		let brokerAudit: readonly string[] = [];
		let resolvedIdentities: readonly ResolvedSshIdentity[] = [];
		if (resolvedMachine) {
			const gateway = await (deps.openStationGateway ?? openStationGateway)({
				hoboHome,
				stationId: platform.station.stationId,
				isolationClass: resolvedMachine.isolationClass,
			});
			try {
				brokered = await brokerPanes(
					placeable.map((a) => ({ machine: resolvedMachine, agentId: a.id })),
					{ broker: gateway.broker, subject: "hobo-code", ttlSeconds: 3600 },
				);
				if (brokered.panes.length > 0) {
					if (flags["dry-run"] === true) {
						resolvedIdentities = brokered.panes.map((pane) => ({
							pane: { ...pane, identityAgent: "<station-agent-socket>" },
							stop: async () => {},
						}));
					} else {
						const identities: ResolvedSshIdentity[] = [];
						try {
							for (const pane of brokered.panes) {
								identities.push(await gateway.handoffSshIdentity(pane));
							}
						} catch (error) {
							await Promise.all(identities.map((identity) => identity.stop()));
							throw error;
						}
						resolvedIdentities = identities;
					}
				}
				brokerAudit = gateway.auditTypes();
			} finally {
				await gateway.close();
			}
			if (brokered.panes.length === 0) {
				return fail(
					"HOBO_CODE_MUX_SESSION_DENIED",
					panel("✕ mux", [
						`the Station refused every session on ${resolvedMachine.id}.`,
						...brokered.failures
							.slice(0, 3)
							.map((f) => `${f.agentId} · ${f.reason}`),
						"Panes are not opened on a host the Station did not authorise;",
						"there is no fallback to an ambient key.",
					]),
					["hobo-code machines", "hobo-code auth"],
					{ machine: resolvedMachine, failures: brokered.failures },
				);
			}
		}
		const retainedIdentityAgents = new Set<string>();
		try {
			const allocation = await (
				deps.allocateWorkspaces ?? allocateAgentWorkspaces
			)({
				workspaceRoot: workspace.path,
				agentIds: agents.map((a) => a.id),
				fallbackRoot: join(hoboHome, "workspaces"),
				env,
				shared: flags.shared === true || remoteHost !== undefined,
				...(remoteHost !== undefined && flags.shared !== true
					? {
							sharedReason: `--host ${remoteHost}: panes run on the remote, which has its own filesystem — local virtual worktrees would not exist there`,
						}
					: undefined),
			});
			const workspaceFor = new Map(
				allocation.workspaces.map((w) => [w.agentId, w]),
			);
			// A virtualized pane runs the harness's own shell over a virtual
			// filesystem instead of the agent binary: the point is that the pane
			// cannot reach anything the allow-list does not name, which a real agent
			// process would immediately step outside of.
			const virtualPanes = flags.virtual === true;
			// Panes come from `placeable`, not `agents`. Filtering only the brokering
			// left every excluded agent with a pane on the machine that excluded it,
			// carrying no credentialRef — i.e. the ambient ~/.ssh key, no session, no
			// audit event. That was worse than before the placement filter existed.
			const targets: MuxTarget[] = placeable.map((a) => {
				const allocated = workspaceFor.get(a.id);
				const baseCommand = virtualPanes
					? virtualPaneCommand(a.id, allocated?.path ?? workspace.path)
					: a.command;
				const seated = virtualPanes
					? baseCommand
					: seatShellCommand({
							agentId: a.id,
							command: baseCommand,
							hoboHome,
							userHome: env.HOME ?? "",
						});
				const settings = loadHarnessSettings(hoboHome, a.id, "harness");
				return {
					name: a.id,
					kind: a.kind === "inference" ? "local-inference" : "local",
					command: applySettingsToSeatCommand(a.id, seated, settings),
					cwd: allocated?.path ?? workspace.path,
					// Namespace-mounted workspaces are unreachable by cd alone.
					...(allocated?.exec ? { exec: allocated.exec } : undefined),
				} satisfies MuxTarget;
			});
			// A remote host turns the same targets into ssh panes — identical shape.
			const host = remoteHost;
			const brokeredFor = new Map(
				resolvedIdentities.map((identity) => [
					identity.pane.agentId,
					identity.pane,
				]),
			);
			const unbrokered = host
				? targets.filter((t) => !brokeredFor.has(t.name))
				: [];
			if (unbrokered.length > 0) {
				// Fail rather than open these panes. An ssh pane with no
				// credentialRef falls back to the ambient ~/.ssh key with no session
				// and no audit event, which is exactly the ungoverned path this
				// replaced — and it would do so silently.
				return fail(
					"HOBO_CODE_MUX_UNBROKERED_PANES",
					panel("✕ mux", [
						`${unbrokered.length} pane(s) have no Station session: ${unbrokered.map((t) => t.name).join(", ")}`,
						"Opening them would mean panes the Station never authorised, with",
						"no session recorded — the ungoverned path this replaced.",
						...(brokered?.failures ?? [])
							.slice(0, 3)
							.map((f) => `denied · ${f.agentId}: ${f.reason}`),
					]),
					["hobo-code machines", "hobo-code auth"],
					{ unbrokered: unbrokered.map((t) => t.name) },
				);
			}
			const remoteTargets: MuxTarget[] = host
				? targets.map(({ cwd: _local, exec: _wrapper, ...t }): MuxTarget => {
						// Non-null by the guard above: every ssh pane carries a session.
						const pane = brokeredFor.get(t.name);
						if (!pane)
							throw new Error(`missing Station identity for pane ${t.name}`);
						return {
							...t,
							kind: "ssh",
							host,
							identityAgent: pane.identityAgent,
							expiresAt: pane.expiresAt,
						};
					})
				: targets;
			const plan = planMux(session, remoteTargets);
			if (agents.length === 0) {
				return ok(
					"HOBO_CODE_MUX",
					panel("mux", [
						"no agents detected on this machine",
						"install one (claude, codex, cursor-agent, opencode, …) or run hobo-code alone",
					]),
					{ agents, plan },
				);
			}
			const applied =
				flags["dry-run"] === true
					? {
							ok: true,
							session: plan.session,
							created: plan.targets.map((t) => t.name),
							existed: false,
							detail: "dry run — no tmux invoked",
						}
					: await applyMux(plan, deps.muxRunner ?? tmuxRunner());
			const created = new Set(applied.created);
			if (flags["dry-run"] !== true) {
				for (const identity of resolvedIdentities) {
					if (created.has(safeWindowName(identity.pane.agentId))) {
						retainedIdentityAgents.add(identity.pane.agentId);
					}
				}
			}
			const text = panel(applied.ok ? "✓ mux" : "✕ mux", [
				applied.detail,
				`workspace · ${workspace.path} (${workspace.source})`,
				`trees · ${allocation.backend}${allocation.reason ? ` — ${allocation.reason}` : ""}`,
				...(excluded.length > 0
					? [
							`excluded · ${excluded.map((a) => a.id).join(", ")} (not declared for ${resolvedMachine?.id})`,
						]
					: []),
				...(brokered
					? [
							`sessions · ${brokered.panes.length} brokered by the Station (${brokerAudit.filter((t) => t === "pam.SessionStarted").length} started)`,
							...brokered.panes.slice(0, 3).map((p) => `  ${describePane(p)}`),
							...brokered.failures.map(
								(f) => `  denied · ${f.agentId}: ${f.reason}`,
							),
						]
					: []),
				...(virtualPanes
					? [
							`shell · virtual (${VIRTUAL_PANE_COMMANDS} commands, no network, no execve)`,
						]
					: []),
				...placeable.map(
					(a) =>
						`  ${a.id} · ${workspaceFor.get(a.id)?.path ?? workspace.path}`,
				),
				host
					? `out-of-session · ${attachCommand(plan.session, host)}`
					: `in-session · stay in hobo-code · chat first · optional ${attachCommand(plan.session)}`,
			]);
			return applied.ok
				? ok("HOBO_CODE_MUX", text, {
						session: plan.session,
						agents,
						plan,
						applied,
					})
				: fail(
						"HOBO_CODE_MUX_FAILED",
						text,
						["tmux -V", "hobo-code mux --dry-run"],
						{
							agents,
							plan,
							applied,
						},
					);
		} finally {
			await Promise.all(
				resolvedIdentities
					.filter(
						(identity) => !retainedIdentityAgents.has(identity.pane.agentId),
					)
					.map((identity) => identity.stop()),
			);
		}
	}

	if (verb === "attach") {
		// Dev-terminal attach (tmux/mosh/Tailscale-shaped) — not control-plane remote admin.
		const modeFlag = isJsonString(flags.mode)
			? flags.mode.toLowerCase()
			: "local";
		const mode: CodeRemoteMode =
			modeFlag === "overlay" ||
			modeFlag === "tailscale" ||
			modeFlag === "tailnet"
				? "overlay"
				: "local";
		const surface = describeDevTerminalAttach({
			mode,
			...(tenant !== "local" ? { tenant, project: "mux" } : undefined),
			stationId: platform.station.stationId,
		});
		const reg = surface.registration;
		const hostShort = shortNamedHost(reg.host);
		const remoteStation = shortStation(platform.station.stationId);
		const urlExtra =
			reg.url === `https://${reg.host}` || reg.url === `http://${reg.host}`
				? null
				: reg.url;
		const text = panel("◎ attach", [
			[hostShort, surface.legend].join(" · "),
			...(urlExtra !== null ? [`url · ${urlExtra}`] : []),
			...(reg.mode === "local" ? [] : [`mode · ● overlay`]),
			...(remoteStation === "local" ? [] : [`station · ${remoteStation}`]),
			"reattach · hobo-code attach | session",
			reg.mode === "overlay"
				? "mosh · optional on lossy link"
				: "local · no Tailscale required",
			"next · hobo-code session",
		]);
		return ok("HOBO_CODE_ATTACH", text, {
			...surface,
			stationId: platform.station.stationId,
			text,
		});
	}

	if (verb === "resume") {
		const wanted = isJsonString(args[0]) ? args[0].trim() : "";
		const chat = resolveChatSession(hoboHome, {
			cwd: projectDir,
			...(wanted.length > 0 ? { id: wanted } : undefined),
		});
		if (chat) {
			const text = panel("◎ resume", [
				chat.id,
				`cwd · ${chat.cwd}`,
				`${chat.messages.length} turn(s)`,
				...chatPreview(chat),
				"next · interactive shell",
			]);
			return ok("HOBO_CODE_RESUME", text, {
				session: chat,
				text,
				terminalAction: {
					kind: "resume-chat",
					sessionId: chat.id,
					messages: chat.workingMessages ?? chat.messages,
					...(chat.workingMessages !== undefined
						? { journal: chat.messages }
						: undefined),
					cwd: chat.cwd,
					hoboHome,
				},
			});
		}
		if (wanted.length > 0) {
			const resident = await resolveResidentResume(hoboHome, wanted);
			if (resident) {
				const text = panel("◎ resume", [
					resident.sessionId,
					"resident tmux session",
					`next · attach ${resident.sessionName}`,
				]);
				return ok("HOBO_CODE_RESUME", text, {
					sessionId: resident.sessionId,
					text,
					terminalAction: {
						kind: "attach-session",
						sessionName: resident.sessionName,
					},
				});
			}
			return fail(
				"HOBO_CODE_RESUME_NOT_FOUND",
				panel("✕ resume", [
					`no session · ${wanted}`,
					"try · hobo-code resume",
					"or · hobo-code session list",
				]),
				["hobo-code resume", "hobo-code session list"],
				{ wanted },
			);
		}
		return fail(
			"HOBO_CODE_RESUME_NONE",
			panel("✕ resume", [
				"no chat session to resume",
				"start · hobo-code",
				"or · hobo-code session list",
			]),
			["hobo-code", "hobo-code session list"],
		);
	}

	if (verb === "compact") {
		const wanted = isJsonString(args[0]) ? args[0].trim() : "";
		const looksLikeId = /^chat-[0-9a-f]+/iu.test(wanted);
		const focus = (looksLikeId ? args.slice(1) : args).join(" ").trim();
		const chat = resolveChatSession(hoboHome, {
			cwd: projectDir,
			...(looksLikeId ? { id: wanted } : undefined),
		});
		if (!chat) {
			return fail(
				"HOBO_CODE_COMPACT_NONE",
				panel("✕ compact", [
					"no chat session to compact",
					"start · hobo-code",
					"or · hobo-code resume",
				]),
				["hobo-code", "hobo-code resume"],
			);
		}
		const plan = compactTranscript({
			messages: chat.messages,
			...(focus ? { focus } : undefined),
			...(chat.stationLabel ? { stationLabel: chat.stationLabel } : undefined),
			...(chat.envLabel ? { envLabel: chat.envLabel } : undefined),
			sessionId: chat.id,
		});
		const saved = saveChatSession(hoboHome, {
			id: chat.id,
			cwd: chat.cwd,
			messages: chat.messages,
			...(plan.droppedCount > 0
				? { workingMessages: plan.working }
				: undefined),
			...(chat.stationLabel !== undefined
				? { stationLabel: chat.stationLabel }
				: undefined),
			...(chat.envLabel !== undefined
				? { envLabel: chat.envLabel }
				: undefined),
			...(chat.modelLabel !== undefined
				? { modelLabel: chat.modelLabel }
				: undefined),
		});
		const text = panel("◎ compact", plan.briefing.split("\n"));
		return ok("HOBO_CODE_COMPACT", text, {
			session: saved,
			plan: {
				droppedCount: plan.droppedCount,
				tokensBefore: plan.tokensBefore,
				tokensAfter: plan.tokensAfter,
				keptFromIndex: plan.keptFromIndex,
			},
			text,
		});
	}

	if (verb === "env") {
		// Nix-terminal parity: inspect hermetic shell + durable layout without activating Nix.
		const summary = hermeticEnvSummary(hermetic);
		const markerBit =
			hermetic.markers.length > 0
				? hermetic.markers.slice(0, 3).join("+")
				: "none";
		const homeDisplay = displayPath(hoboHome, { hoboHome, cwd: projectDir });
		const durableDisplay = displayPath(hermetic.layout.durable, {
			hoboHome,
			cwd: projectDir,
		});
		// Always surface durable path (nix purity analog): declared shells need it too.
		const envText = panel("▣ ev", [
			summary,
			`markers · ${markerBit}`,
			`home · ${homeDisplay}`,
			`durable · ${durableDisplay}`,
			...(hermetic.hermeticActive
				? []
				: hermetic.hermeticDeclared
					? ["enter · devenv shell|direnv allow|nix develop"]
					: ["optional · devenv.nix (never required)"]),
		]);
		// hobo-code declares its own environment with devenv; report whether the
		// toolchain to enter it is actually installed rather than assuming.
		const ownDevenv = inspectDevenv(
			// dist/cli.js -> package root (devenv.nix lives beside package.json)
			join(dirname(fileURLToPath(import.meta.url)), ".."),
			defaultDevenvProbes(env),
		);
		const withDevenv = `${envText}\n${devenvSummary(ownDevenv)}`;
		return ok("HOBO_CODE_ENV", withDevenv, {
			hermetic,
			devenv: ownDevenv,
			text: withDevenv,
			policy:
				"Optional hermetic shell for hobo-code only; durable state under HOBO_HOME outside sandboxes; Nix not monorepo IaC.",
		});
	}

	if (verb === "dev") {
		const port = Number(flags.port ?? 4173);
		const debugPort = Number(flags["debug-port"] ?? 4174);
		if (
			![port, debugPort].every(
				(value) => Number.isInteger(value) && value >= 0 && value <= 65_535,
			)
		) {
			return fail(
				"HOBO_CODE_DEV_USAGE",
				panel("✕ dev", ["ports must be integers from 0 through 65535"]),
				["hobo-code dev --help"],
			);
		}
		let session: DevBrowserSession | undefined;
		try {
			const station = describeAuthedStationSession({
				hoboHome,
				env,
				ensureLocalLogin: true,
			});
			if (!station.loggedIn) {
				return fail(
					"HOBO_CODE_DEV_AUTH",
					panel("✕ dev", ["not logged into a Station", station.message]),
					["hobo-code auth login"],
				);
			}
			if (
				!occupancyFlowIsActive(hoboHome, station.stationId, station.environment)
			) {
				return fail(
					"HOBO_CODE_DEV_HALTED",
					panel("✕ dev", [
						"Yard/Camp flow is halted",
						"start yard:local on the dashboard to resume traffic",
					]),
					["open the Aspire dashboard and start yard:local"],
				);
			}
			session = await (deps.startDevSession ?? startDevBrowserSession)({
				projectDir,
				hoboHome,
				appPort: port,
				debugPort,
				env: { ...env, ...stationDevEnv(station) },
				stationId: station.stationId,
				tenant: station.tenant,
				environment: station.environment,
			});
			const deployed = session;
			const fetchUrl = deps.fetch ?? globalThis.fetch;
			const [appProbe, debugProbe, controlsProbe] = await Promise.all([
				fetchUrl(deployed.appUrl),
				fetchUrl(debugViewUrl(deployed.appUrl)),
				fetchUrl(loopbackFetchUrl(deployed.controlsUrl)),
			]);
			const probes = [appProbe, debugProbe, controlsProbe];
			if (probes.some((probe) => !probe.ok)) {
				throw new Error(
					`Bindle deployment probe failed (${probes.map((probe) => probe.status).join("/")})`,
				);
			}
			const once = flags.once === true;
			if (once) {
				await deployed.close();
				session = undefined;
				await releaseStationSidecars(hoboHome, station.stationId);
			} else if (deps.onDevSession) {
				deps.onDevSession(deployed);
			} else {
				const stop = (exitCode: number): void => {
					process.exitCode = exitCode;
					void deployed
						.close()
						.then(() => releaseStationSidecars(hoboHome, station.stationId));
				};
				process.once("SIGINT", () => stop(130));
				process.once("SIGTERM", () => stop(143));
			}
			try {
				const resolved = resolveRunnableProject(projectDir) ?? projectDir;
				const bindleName =
					inspectBindleProject(resolved)?.name ??
					resolved.split(/[/\\]/u).at(-1) ??
					"app";
				recordDevDeployment({
					hoboHome,
					scope: {
						stationId: station.stationId,
						tenant: station.tenant,
						environment: station.environment,
						...(station.project ? { project: station.project } : undefined),
						...(station.branch ? { branch: station.branch } : undefined),
					},
					bindleName,
					projectDir: resolved,
					appUrl: deployed.appUrl,
					debugUrl: deployed.debugUrl,
					controlsUrl: deployed.controlsUrl,
					reportUrl: deployed.reportUrl,
					...(deployed.namedUrl !== undefined
						? { namedUrl: deployed.namedUrl }
						: undefined),
				});
				persistOccupancyRun({
					hoboHome,
					stationId: station.stationId,
					environment: station.environment,
					projectDir,
					bindleName,
					...(deployed.pid !== undefined ? { pid: deployed.pid } : undefined),
					sessionId: deployed.sessionId,
				});
			} catch {
				// Last-seen persist must never abort a live serve.
			}
			const text = panel("◎ dev", [
				...liveEndpointLines({
					appUrl: deployed.appUrl,
					debugUrl: deployed.debugUrl,
					controlsUrl: deployed.controlsUrl,
					reportUrl: deployed.reportUrl,
					...(deployed.namedUrl !== undefined
						? { namedUrl: deployed.namedUrl }
						: undefined),
					stationId: station.stationId,
					environment: station.environment,
					emphasis: "run",
				}),
				`tenant · ${station.tenant}`,
				`yard · local`,
				`evidence · ${displayPath(deployed.evidencePath, { hoboHome, cwd: projectDir })}`,
				...(once ? ["probe · passed; stopped"] : ["live · Ctrl-C to stop"]),
			]);
			return ok("HOBO_CODE_DEV", text, {
				deployment: {
					mode: "local-bindle",
					deploymentId: deployed.sessionId,
					sessionId: deployed.sessionId,
					appUrl: deployed.appUrl,
					debugUrl: deployed.debugUrl,
					controlsUrl: deployed.controlsUrl,
					reportUrl: deployed.reportUrl,
					stationId: station.stationId,
					environment: station.environment,
					tenant: station.tenant,
					...(deployed.namedUrl !== undefined
						? { namedUrl: deployed.namedUrl }
						: undefined),
					evidencePath: deployed.evidencePath,
					served: {
						appStatus: appProbe.status,
						debugStatus: debugProbe.status,
						controlsStatus: controlsProbe.status,
					},
					stopped: once,
				},
				text,
			});
		} catch (error) {
			await session?.close().catch(() => {});
			return fail(
				"HOBO_CODE_DEV_FAILED",
				panel("✕ dev", [
					error instanceof Error ? error.message : String(error),
				]),
				[
					"ensure the project has src/bindle.ts or dist/bindle.js",
					"build workspace @hobo/hobo (hobo-code calls serveProjectOnLocalYard / createComposedHoboCli in-process — no `hobo` on PATH)",
					"or set HOBO_CODE_HOBO_BIN only when you need an explicit child-process override",
					"choose free ports with --port and --debug-port",
				],
			);
		}
	}

	if (verb === "review") {
		const result = await runReviewCommand({ args, flags });
		return {
			ok: result.ok,
			status: result.ok ? "ok" : "failed",
			code: result.code,
			message: result.message,
			data: withDense(result.data),
			exitCode: result.ok ? 0 : 1,
		};
	}

	if (verb === "template") {
		const result = runTemplateCommand({ args, flags });
		return {
			ok: result.ok,
			status: result.ok ? "ok" : "failed",
			code: result.code,
			message: result.message,
			data: withDense(result.data),
			exitCode: result.ok ? 0 : 1,
		};
	}

	if (verb === "scaffold") {
		const name = args[0] || (isJsonString(flags.name) && flags.name) || "app";
		const out =
			(isJsonString(flags.out) && flags.out) || join(projectDir, name);
		const matched = matchExampleRequest(
			[args[0], isJsonString(flags.name) ? flags.name : ""]
				.filter(Boolean)
				.join(" "),
		);
		if (matched && matched.id !== "openui-astryx-bindle") {
			const copied = materializeExample({
				exampleId: matched.id,
				outputDir: out,
				appName: name,
			});
			const text = panel("✦ sc", [
				[matched.id, shortId(name, 10), `${copied.files.length}f`].join("·"),
			]);
			return ok("HOBO_CODE_SCAFFOLD", text, {
				result: copied,
				stationId: platform.station.stationId,
				text,
			});
		}
		const result = scaffoldHighValueTemplate({
			outputDir: out,
			appName: name,
		});
		const hasFirstPaint = result.files.includes("public/index.html");
		const hasCss = result.files.includes("public/styles.css");
		const outDisplay = displayPath(result.outputDir, {
			hoboHome,
			cwd: projectDir,
		});
		const tmpl =
			result.templateId === "openui-astryx-bindle" ? "ou" : result.templateId;
		// Short pin: flag key tail; omit feature twin when stem matches.
		// visual.primary → primary (domain stem already "openui" on left).
		const flagTail = result.openFeatureFlag
			.replace(/^app\./, "")
			.replace(/^visual\./, "");
		const featureTail = result.gherkinFeature
			.replace(/^features\//, "")
			.replace(/\.feature$/, "")
			.replace(/^visual$/, "primary");
		// primary is the happy-path visual pin — ultra-short.
		const pinRaw =
			flagTail === featureTail ||
			flagTail.startsWith(featureTail) ||
			featureTail.startsWith(flagTail.split(".")[0] ?? "")
				? flagTail
				: `${flagTail} · ${featureTail}`;
		const pin = pinRaw === "primary" ? "p" : pinRaw;
		// ●paint is happy-path default (index+css) — omit; only show when incomplete.
		const assetsBit =
			hasFirstPaint && hasCss
				? null
				: `${hasFirstPaint ? "●" : "○"}index · ${hasCss ? "●" : "○"}css`;
		// Happy-path out is ./name or name under cwd — omit twin.
		const outBit =
			outDisplay === name ||
			outDisplay === `./${name}` ||
			outDisplay === name.replace(/\/$/, "")
				? null
				: outDisplay;
		// Name short for scan; full name in data payload.
		const nameBit = shortId(name, 10);
		const text = panel("✦ sc", [
			// One scan line: template · name · files · pin
			// ★ dispatch is product default next — omit twin
			[
				tmpl,
				nameBit,
				...(outBit !== null ? [shortId(outBit, 12)] : []),
				`${result.files.length}f`,
				...(assetsBit !== null ? [assetsBit] : []),
				pin,
			].join("·"),
		]);
		return ok("HOBO_CODE_SCAFFOLD", text, {
			result,
			stationId: platform.station.stationId,
			text,
		});
	}

	if (verb === "isolate") {
		if (!platform.features.harnessEnabled) {
			return fail(
				"HOBO_CODE_HARNESS_DISABLED",
				panel("✕ isolate", [
					"harness disabled (code.harness.enabled)",
					"enable flag or unset override, then retry",
				]),
				[
					"check OpenFeature / HOBO feature overrides for code.harness.enabled",
					"hobo-code platform --json",
					"hobo-code help",
				],
			);
		}
		const runId = args[0] ?? `run-${Date.now()}`;
		const ctx = await createIsolationContext({
			projectRoot: projectDir,
			hoboHome,
			runId,
			forceWorktree: !platform.features.riftPreferred,
			stationId: platform.station.stationId,
		});
		const backendGlyph = ctx.backend.kind === "rift" ? "◆ rift" : "◇ worktree";
		// Active run is expected under sandboxes/; only other roots are leftovers.
		const orphanCount = listSandboxOrphans(hoboHome).filter(
			(p) => !p.endsWith(`/${ctx.runId}`) && !p.endsWith(`\\${ctx.runId}`),
		).length;
		const rootDisplay = displayPath(ctx.rootPath, {
			hoboHome,
			cwd: projectDir,
		});
		const isoStation = shortStation(
			ctx.stationId ?? platform.station.stationId,
		);
		const branchLabel = shortBranch(ctx.branch);
		// Default root is $HOBO_HOME/sandboxes/<runId> — omit twin on happy path.
		const defaultRoot =
			rootDisplay === `$HOBO_HOME/sandboxes/${ctx.runId}` ||
			rootDisplay.endsWith(`/sandboxes/${ctx.runId}`);
		// run-<ms> → short tail; keep explicit ids.
		const runBit = shortId(ctx.runId, 14);
		const durableDisplay = displayPath(ctx.durableRoot, {
			hoboHome,
			cwd: projectDir,
		});
		// Nix-terminal parity: human chrome must show pure sandbox≠durable split.
		// Next step spelled out (DX): promote the run id after isolation.
		const isolateText = panel("▣ isolate", [
			// Omit worktree happy-path noise.
			...(ctx.backend.kind === "worktree" ? [] : [`backend · ${backendGlyph}`]),
			// Branch only when it differs from run id (code/<run> → run is default).
			...(branchLabel === ctx.runId ||
			branchLabel === shortId(ctx.runId, 28) ||
			branchLabel === runBit
				? []
				: [`branch · ${branchLabel}`]),
			[
				// Title brands isolate — run id bare (no run · twin).
				runBit,
				...(defaultRoot ? [] : [rootDisplay]),
				...(orphanCount > 0 ? [`▲${orphanCount} orphan`] : []),
				"●",
			].join("·"),
			`durable · ${durableDisplay}`,
			`next · hobo-code promote ${ctx.runId}`,
			...(isoStation === "local" ? [] : [`station · ${isoStation}`]),
		]);
		return ok("HOBO_CODE_ISOLATE", isolateText, {
			isolation: ctx,
			platform,
			orphans: orphanCount,
			hermetic,
			durableRoot: ctx.durableRoot,
			layout: {
				sandbox: ctx.rootPath,
				durable: ctx.durableRoot,
				pureSeparation: true as const,
			},
			next: `hobo-code promote ${ctx.runId}`,
			text: isolateText,
		});
	}

	if (verb === "promote") {
		const runId = args[0] || (isJsonString(flags.run) ? flags.run : undefined);
		if (!runId) {
			return fail(
				"HOBO_CODE_USAGE",
				panel("✕ promote", [
					"missing run id",
					"usage · hobo-code promote <runId>",
					"or · hobo-code promote --run <runId>",
					"first · hobo-code isolate <runId>",
				]),
				[
					"hobo-code isolate my-run",
					"hobo-code promote my-run",
					"hobo-code help",
				],
			);
		}
		// Gates must be *run*, not asserted. These were hardcoded `pass: true`,
		// which made "gated, audited" decoration over a literal — the promote
		// path claimed a guarantee nothing was checking.
		const gates: PromotionGate[] = await runProjectGates(projectDir);
		const isolationRoot = join(hoboHome, "sandboxes", runId);
		const result = await promoteIsolation(
			{
				runId,
				isolationRoot,
				targetProject: projectDir,
				gateResults: gates.map((g) => g.name),
				squashOnly: true,
			},
			{ hoboHome, gates },
		);
		const glyph = result.ok ? "✓" : "✕";
		const passed = gates.filter((g) => g.pass).length;
		const allPass = passed === gates.length;
		const shortGate = (name: string) => {
			const base = name.replace(/:.*$/, "");
			if (base === "architecture") return "arch";
			if (base === "standards") return "std";
			return base;
		};
		// All-pass: ●N alone (names live in data payload). Partial keeps fraction.
		const gatesCompact = allPass
			? `●${passed}`
			: `${passed}/${gates.length} pass`;
		const promoStation = shortStation(platform.station.stationId);
		const missingRun = result.code === "HOBO_CODE_PROMOTE_MISSING_RUN";
		const promoteText = panel(`${glyph} promote`, [
			// Code only on fail — success title already carries ✓.
			...(result.ok ? [] : [`code · ${result.code}`]),
			result.ok
				? `${runId}·${result.cleaned ? "●" : "○"}clean·${gatesCompact}`
				: missingRun
					? `no sandbox · ${runId}`
					: `${runId}·${result.cleaned ? "●" : "○"}clean`,
			...(promoStation === "local" ? [] : [`station · ${promoStation}`]),
			...(result.ok
				? ["next · hobo-code status"]
				: missingRun
					? [
							"usage · hobo-code isolate <runId>",
							"then · hobo-code promote <runId>",
						]
					: [
							`gates · ${gatesCompact}`,
							...gates.map(
								(g) =>
									`  ${g.pass ? "✓" : "✕"} ${shortGate(g.name).padEnd(12)} ${g.detail}`,
							),
							`summary · ${result.message}`,
							"next · hobo-code isolate <runId>",
						]),
		]);
		return {
			ok: result.ok,
			status: result.ok ? "ok" : "failed",
			code: result.code,
			message: promoteText,
			...(result.ok
				? undefined
				: {
						remediation: missingRun
							? [
									`hobo-code isolate ${runId}`,
									`hobo-code promote ${runId}`,
									"hobo-code help",
								]
							: [
									"fix failing gates, then re-run promote",
									`hobo-code isolate ${runId}`,
									"hobo-code help",
								],
					}),
			data: withDense({
				result,
				stationId: platform.station.stationId,
				text: promoteText,
				isolationRoot,
			}),
			exitCode: result.ok ? 0 : 1,
		};
	}

	if (verb === "session") {
		if (!platform.features.harnessEnabled) {
			return fail(
				"HOBO_CODE_HARNESS_DISABLED",
				panel("✕ session", [
					"harness disabled (code.harness.enabled)",
					"enable flag or unset override, then retry",
				]),
				[
					"check OpenFeature / HOBO feature overrides for code.harness.enabled",
					"hobo-code platform --json",
					"hobo-code help",
				],
			);
		}
		if (args.length > 0) {
			try {
				const requestedHost =
					args[0] === "serve" && isJsonString(flags.host)
						? flags.host
						: undefined;
				const requestedPort =
					args[0] === "serve" && isJsonString(flags.port)
						? flags.port
						: undefined;
				if (requestedHost && requestedPort === undefined) {
					return fail(
						"HOBO_CODE_SESSION_REMOTE_PORT_REQUIRED",
						panel("✕ session", [
							"remote session serving requires a fixed --port",
							"the same loopback port is used on both sides of the SSH forward",
						]),
						[`hobo-code session serve --host ${requestedHost} --port 4242`],
					);
				}
				const servePort =
					requestedPort !== undefined && /^\d+$/u.test(requestedPort)
						? Number.parseInt(requestedPort, 10)
						: undefined;
				if (
					requestedPort !== undefined &&
					(servePort === undefined || servePort < 1 || servePort > 65_535)
				) {
					return fail(
						"HOBO_CODE_SESSION_INVALID_PORT",
						panel("✕ session", [
							"--port must be an integer from 1 through 65535",
						]),
						["hobo-code session serve --port 4242"],
					);
				}

				let remoteServe: RemoteSessionServe | undefined;
				if (requestedHost && servePort !== undefined) {
					const projectMachines = loadDevMachines(projectDir);
					const declaredMachines = projectMachines.declared
						? projectMachines
						: loadDevMachines(
								join(dirname(fileURLToPath(import.meta.url)), ".."),
							);
					const resolution = resolveMachine(
						declaredMachines.machines,
						requestedHost,
					);
					if (resolution !== null && "ambiguous" in resolution) {
						return fail(
							"HOBO_CODE_SESSION_AMBIGUOUS_MACHINE",
							panel("✕ session", [
								`"${requestedHost}" is the host of more than one declared machine.`,
								...resolution.ambiguous.map(
									(m) => `  ${m.id} · ${m.isolationClass}`,
								),
								"name one by its declared id",
							]),
							["hobo-code machines"],
						);
					}
					const machine =
						resolution !== null && "machine" in resolution
							? resolution.machine
							: undefined;
					if (!machine) {
						return fail(
							"HOBO_CODE_SESSION_UNKNOWN_MACHINE",
							panel("✕ session", [
								`"${requestedHost}" is not a declared dev machine.`,
								declaredMachines.declared
									? `known · ${declaredMachines.machines.map((m) => m.id).join(", ") || "none"}`
									: `no ${DEV_MACHINES_FILE} beside the devenv files`,
								"remote browsers have no fallback to arbitrary SSH hosts",
							]),
							["hobo-code machines"],
						);
					}

					const gateway = await (deps.openStationGateway ?? openStationGateway)(
						{
							hoboHome,
							stationId: platform.station.stationId,
							isolationClass: machine.isolationClass,
						},
					);
					let outcome: Awaited<ReturnType<typeof brokerPaneSession>>;
					outcome = await brokerPaneSession(machine, "resident-browser", {
						broker: gateway.broker,
						subject: "hobo-code",
						ttlSeconds: 3600,
					});
					const auditTypes = gateway.auditTypes();
					if (!outcome.ok) {
						await gateway.close();
						return fail(
							"HOBO_CODE_SESSION_REMOTE_DENIED",
							panel("✕ session", [
								`the Station refused browser access to ${machine.id}`,
								outcome.failure.reason,
								"SSH forwarding was not opened; there is no fallback",
							]),
							["hobo-code machines", "hobo-code auth"],
						);
					}
					if (!auditTypes.includes("pam.SessionStarted")) {
						await gateway.close();
						return fail(
							"HOBO_CODE_SESSION_REMOTE_AUDIT_MISSING",
							panel("✕ session", [
								`the Station authorized ${machine.id} without a start audit event`,
								"SSH forwarding was not opened",
							]),
							["hobo-code auth status"],
						);
					}
					let identity: ResolvedSshIdentity;
					try {
						identity = await gateway.resolveSshIdentity(outcome.pane);
					} catch (error) {
						await gateway.close();
						return fail(
							"HOBO_CODE_SESSION_REMOTE_IDENTITY_UNAVAILABLE",
							panel("✕ session", [
								error instanceof Error ? error.message : String(error),
								"SSH forwarding was not opened; there is no ambient-key fallback",
							]),
							["ssh-add -l", "hobo-code auth status"],
						);
					}
					remoteServe = {
						machine,
						port: servePort,
						authorizationSessionId: outcome.pane.sessionId,
						authorizationExpiresAt: outcome.pane.expiresAt,
						auditTypes,
						identityAgent: identity.pane.identityAgent,
						closeAuthorization: gateway.close,
					};
				}
				const resident = await runResidentSessionCli({
					args,
					hoboHome,
					projectDir,
					approved: flags.approve === true,
					...(servePort !== undefined ? { servePort } : undefined),
					...(remoteServe !== undefined ? { remoteServe } : undefined),
				});
				if (resident) {
					return ok(
						"HOBO_CODE_RESIDENT_SESSION",
						panel("✓ session", resident.message.split("\n")),
						resident.data,
					);
				}
			} catch (error) {
				return fail(
					"HOBO_CODE_SESSION_FAILED",
					panel("✕ session", [
						error instanceof Error ? error.message : String(error),
					]),
					["hobo-code session --help", "hobo-code session list"],
				);
			}
		}
		const sessionHome =
			env.HOBO_CODE_EPHEMERAL_SESSION === "1"
				? mkdtempSync(join(tmpdir(), "hobo-code-session-"))
				: hoboHome;
		const session = await startCodeSession({
			projectRoot: projectDir,
			hoboHome: sessionHome,
			stationId: platform.station.stationId,
			features,
			tenant,
			autoInitStation: true,
			sidecars: sidecarsEnabled(env),
		});
		// Simulate in-session work, then resolve handback before painting mux.
		session.setAgentState("worker", "working", session.platform.provider.id);
		const keepOpen = env.HOBO_CODE_SESSION_KEEP === "1";
		const handback = keepOpen
			? {
					runId: session.isolation.runId,
					ok: true,
					branch: session.isolation.branch,
					// SAFETY: parsed or fixture value is the named domain type after this assertion.
					gates: [] as string[],
					isolationStatus: "open" as const,
					// SAFETY: parsed or fixture value is the named domain type after this assertion.
					orphans: [] as string[],
					message: "session kept open",
				}
			: await session.complete(true, [
					"session:demo",
					`station:${session.platform.station.stationId}`,
					`provider:${session.platform.provider.id}`,
				]);
		// Final mux snapshot must match handback outcome (not stale "working").
		if (keepOpen) {
			// Omit flue happy-path provider noise from pane summaries.
			const provider = session.platform.provider.id;
			const openSummary = provider === "flue" ? "" : provider;
			const workSummary = provider === "flue" ? "" : provider;
			// working glyph alone on flue; provider only when non-default
			session.setAgentState("coordinator", "working", openSummary);
			session.setAgentState("worker", "working", workSummary);
		} else if (handback.ok) {
			session.setAgentState("coordinator", "done", "");
			session.setAgentState("worker", "done", "");
		} else {
			session.setAgentState("coordinator", "blocked", "fail");
			session.setAgentState("worker", "blocked", "fix");
		}
		const status = session.status();
		if (env.HOBO_CODE_EPHEMERAL_SESSION === "1") {
			await cleanupIsolation(session.isolation.runId, {
				hoboHome: sessionHome,
				ok: true,
			});
		}
		// Snapshot kind only when not implied by handback LED (●open=live, ●clean=final).
		const snapshotKind = keepOpen ? null : handback.ok ? null : "failed";
		const backendGlyph =
			session.isolation.backend.kind === "rift" ? "◆ rift" : "◇ worktree";
		// Strip run- prefix; short tail for title.
		const runLabel = shortId(session.isolation.runId.replace(/^run-/, ""), 6);
		const sessionStation = shortStation(session.platform.station.stationId);
		const sessionProvider = session.platform.provider.id;
		// Clean final: st is product default observe — omit next twin.
		// Open/fail: ·pr promote (run already on title).
		const sessionNext = handback.ok && !keepOpen ? null : "pr";
		// Handback LED: ● alone = clean final; ●o = open live; fail keeps text.
		const handbackBit = keepOpen
			? "●o"
			: handback.ok
				? "●"
				: handback.isolationStatus === "cleaned"
					? "●·fail"
					: `${handback.isolationStatus}`;
		const extras = [
			session.isolation.backend.kind === "worktree" ? null : backendGlyph,
			sessionStation === "local" ? null : sessionStation,
			sessionProvider === "flue" ? null : sessionProvider,
		]
			.filter((x): x is string => x !== null && x.length > 0)
			.join("·");
		const orphanBit =
			handback.orphans.length === 0 ? "" : `·▲${handback.orphans.length}`;
		// LED implies snapshot kind — only emit failed explicitly.
		const snapBit = snapshotKind !== null ? `·${snapshotKind}` : "";
		const nextBit = sessionNext !== null ? `·${sessionNext}` : "";
		// Brand se only (hobo-code lives on status chip / other verbs).
		const sessionTitle = `${handback.ok ? "✓" : "✕"} se·${runLabel}·${handbackBit}${extras ? `·${extras}` : ""}${orphanBit}${snapBit}${nextBit}`;
		const chrome = renderStatusText(status, {
			embedded: true,
			title: sessionTitle,
		});
		// Keep dense session box ≤4 lines; Herdr caps + durable path live in --json / --help.
		const sessionText = chrome;
		const herdr = herdrMuxCapabilities(status.theme);
		const durableRoot = session.isolation.durableRoot;
		const persistence = {
			durableRoot,
			handbackArtifact: "session-end.json",
			handbackPath: join(durableRoot, "session-end.json"),
			detachable: true as const,
			sessionPersistence: true as const,
		};
		return {
			ok: handback.ok,
			status: handback.ok ? "ok" : "failed",
			code: handback.ok ? "HOBO_CODE_SESSION" : "HOBO_CODE_SESSION_FAILED",
			message: sessionText,
			data: withDense({
				isolation: session.isolation,
				status,
				herdr,
				capabilities: herdr,
				persistence,
				remote: session.remote,
				platform: session.platform,
				handback,
				mcp: session.harness.exposeMcp(),
				text: sessionText,
			}),
			exitCode: handback.ok ? 0 : 1,
		};
	}

	// ── Multi-node compute (capacity-aware dispatch; not a chat/hive product) ──

	const examplePrompt = args.join(" ");
	const workspaceAction =
		verb === "dispatch" ? matchWorkspaceAction(examplePrompt) : undefined;
	const matchedExample =
		workspaceAction?.kind === "create" ||
		workspaceAction?.kind === "create-and-run"
			? { id: workspaceAction.exampleId }
			: verb === "dispatch"
				? matchExampleRequest(examplePrompt)
				: undefined;
	if (matchedExample) {
		const name = (isJsonString(flags.name) && flags.name) || matchedExample.id;
		const out =
			(isJsonString(flags.out) && flags.out) || join(projectDir, name);
		const copied = materializeExample({
			exampleId: matchedExample.id,
			outputDir: out,
			appName: name,
			intent: examplePrompt,
		});
		if (workspaceAction?.kind === "create-and-run") {
			return runHoboCodeCli(
				["dev", "--cwd", copied.outputDir, "--port", "0", "--debug-port", "0"],
				deps,
			);
		}
		const text = panel("✦ ex", [
			[matchedExample.id, shortId(name, 10), `${copied.files.length}f`].join(
				"·",
			),
		]);
		return ok("HOBO_CODE_EXAMPLE", text, {
			result: copied,
			example: matchedExample.id,
			stationId: platform.station.stationId,
			text,
		});
	}

	if (workspaceAction?.kind === "run" || workspaceAction?.kind === "debug") {
		const target = resolveRunnableProject(projectDir);
		if (target === undefined) {
			return fail(
				"HOBO_CODE_DEV_FAILED",
				panel("✕ run", ["no Bindle to run — create a hello world app first"]),
				['say "create a hello world app"', "hobo-code help"],
			);
		}
		return runHoboCodeCli(
			["dev", "--cwd", target, "--port", "0", "--debug-port", "0"],
			deps,
		);
	}

	if (!platform.features.distributed && verb === "dispatch") {
		return fail(
			"HOBO_CODE_DISTRIBUTED_DISABLED",
			panel("✕ distributed", [
				"dispatch requires code.distributed",
				"enable distributed flag, then retry",
			]),
			["enable code.distributed feature flag", "hobo-code help"],
		);
	}

	// dispatch (default)
	const emptyPrompt = args.length === 0;
	if (emptyPrompt && !process.stdin.isTTY) {
		return fail(
			"HOBO_CODE_INTERACTIVE_REQUIRED",
			panel("✕ input", [
				"bare hobo-code needs a TTY; no prompt was provided",
				"use hobo-code help or provide a prompt",
			]),
			["hobo-code help", 'hobo-code "describe the change"'],
			{ interactiveRequired: true },
		);
	}
	const prompt = emptyPrompt
		? "refine scaffold under ponytail pressure"
		: args.join(" ");
	const result = await dispatchComputeTask({
		hoboHome,
		poolId,
		prompt,
		projectRoot: projectDir,
		executeLocal: true,
		stationId: platform.station.stationId,
	});
	const dispatched =
		result.task.status === "done" || result.task.status === "dispatched";
	const text = renderDispatchSummary({
		taskId: result.task.taskId,
		status: result.task.status,
		...(result.task.nodeId !== undefined
			? { nodeId: result.task.nodeId }
			: undefined),
		prompt,
		poolId,
		defaultVerb: defaultedVerb,
		emptyPrompt,
		dense,
		// Point at the record itself: "recorded a task" is only checkable if
		// the reply says where it landed.
		taskPath: computeTaskPath(hoboHome, poolId, result.task.taskId),
	});
	return {
		ok: dispatched,
		status: result.task.status === "failed" ? "failed" : "ok",
		code: dispatched ? "HOBO_CODE_DISPATCH" : "HOBO_CODE_DISPATCH_FAILED",
		message: text,
		data: withDense({
			task: result.task,
			pool: result.pool,
			defaultVerb: defaultedVerb,
			emptyPrompt,
			text,
			distributed: describeDistributedCompute(),
		}),
		exitCode: dispatched ? 0 : 1,
	};
}

/** Presentation: station:local → local; keep other ids scannable. */
function shortStation(id: string): string {
	if (id === "station:local" || id.endsWith(":local")) return "local";
	return shortId(id.replace(/^station:/, ""), 22);
}

/** Presentation: code/<run> → <run> when code/ prefix. */
function shortBranch(branch: string): string {
	if (branch.startsWith("code/")) return branch.slice("code/".length);
	return shortId(branch, 28);
}

/** Prefer scannable path: $HOBO_HOME…, relative to cwd, else short tail. */
function displayPath(
	path: string,
	opts: { readonly hoboHome?: string; readonly cwd?: string } = {},
): string {
	const home = opts.hoboHome;
	if (home && (path === home || path.startsWith(`${home}/`))) {
		return `$HOBO_HOME${path.slice(home.length)}`;
	}
	const cwd = opts.cwd;
	if (cwd && (path === cwd || path.startsWith(`${cwd}/`))) {
		const rel = path.slice(cwd.length).replace(/^\//, "");
		return rel.length > 0 ? `./${rel}` : ".";
	}
	// Outside cwd/home: keep last two segments only (scan-friendly).
	const parts = path.replace(/\\/g, "/").split("/").filter(Boolean);
	if (parts.length >= 2) {
		return `…/${parts.slice(-2).join("/")}`;
	}
	return shortId(path, 28);
}

function shortId(id: string, max = 22): string {
	if (id.length <= max) return id;
	return `${id.slice(0, Math.max(1, max - 1))}…`;
}

/** Distinguishing node tail (class already shown in inventory). */
function shortNodeTail(nodeId: string): string {
	if (nodeId.includes("local")) {
		const rest = nodeId.replace(/^node-local-?/, "").replace(/^station-?/, "");
		if (rest === "" || rest === "local" || rest === "station-local") {
			return "station";
		}
		return shortId(rest, 14);
	}
	if (nodeId.includes("endpoint") || nodeId.includes("remote")) {
		const rest = nodeId.replace(/^node-endpoint-?/, "");
		if (rest === "" || rest === "remote") return "remote";
		return shortId(rest, 14);
	}
	return shortId(nodeId, 16);
}

/** Prefer class-aware node labels for dispatch scan (local / endpoint / …). */
function shortNodeLabel(nodeId: string): string {
	if (nodeId.includes("local")) {
		return `local · ${shortNodeTail(nodeId)}`;
	}
	if (nodeId.includes("endpoint") || nodeId.includes("remote")) {
		return `endpoint · ${shortNodeTail(nodeId)}`;
	}
	return shortId(nodeId, 22);
}

/**
 * What actually happened, in words.
 *
 * The dense form reads `✓ ★ / hello·st` — a status glyph, eight characters of
 * the user's own prompt echoed back, and a two-letter pointer at another
 * command. It says nothing about what `dispatch` did, and "✓" reads as "your
 * request was carried out" when what happened is that a compute task was
 * recorded. Help promises plain by default; this is that default.
 */
function renderDispatchPlain(input: {
	readonly taskId: string;
	readonly status: string;
	readonly nodeId?: string;
	readonly prompt: string;
	readonly poolId: string;
	readonly defaultVerb: boolean;
	readonly emptyPrompt?: boolean;
	readonly taskPath?: string;
}): string {
	const done = input.status === "done";
	const failed = input.status === "failed";
	const title = failed
		? "✕ dispatch failed"
		: done
			? "✓ dispatch recorded"
			: "· dispatch queued";
	const rows: string[] = [];
	rows.push(
		failed
			? "The compute task could not be recorded."
			: done
				? "Recorded a compute task. No agent has run it yet — dispatch queues work, it does not edit your project."
				: "Queued a compute task; it has not been claimed yet.",
	);
	if (input.emptyPrompt) {
		rows.push("No prompt was given, so the task carries an empty request.");
	}
	rows.push(`task · ${input.taskId}`);
	if (input.taskPath) rows.push(`at · ${input.taskPath}`);
	if (input.nodeId !== undefined) rows.push(`node · ${input.nodeId}`);
	if (input.poolId !== "default") rows.push(`pool · ${input.poolId}`);
	rows.push(
		failed
			? "Next: hobo-code status, or hobo-code tasks for the board."
			: "Next: hobo-code tasks to see the board, or hobo-code status for this session.",
	);
	return panel(title, rows);
}

function renderDispatchSummary(input: {
	readonly taskId: string;
	readonly status: string;
	readonly nodeId?: string;
	readonly prompt: string;
	readonly poolId: string;
	readonly defaultVerb: boolean;
	readonly emptyPrompt?: boolean;
	/** Glyph chrome is opt-in; plain English is the default the help promises. */
	readonly dense?: boolean;
	/** Where the task was written, so the reply points at something real. */
	readonly taskPath?: string;
}): string {
	if (input.dense !== true) return renderDispatchPlain(input);
	const glyph =
		input.status === "done" ? "✓" : input.status === "failed" ? "✕" : "●";
	// Title glyph already marks done — drop body ✓ twin. Fail/in-flight keep trail.
	const pipeline =
		input.status === "done"
			? null
			: input.status === "failed"
				? "queue●→claim●→run●→fail✕"
				: "queue●→claim○→run○→done○";
	const node = input.nodeId !== undefined ? shortNodeLabel(input.nodeId) : "—";
	// local · station is the happy path — omit when done there.
	const omitNode =
		input.status === "done" && (node === "local · station" || node === "—");
	// Title ★ already marks defaulted bare path — body ◆ only for empty seed.
	// ◆empty = empty argv seed (ponytail default in data/docs).
	const defaultBit =
		input.defaultVerb && input.emptyPrompt
			? "◆empty"
			: input.emptyPrompt
				? "empty"
				: null;
	// Empty prompt already named by ◆empty — drop seed text twin.
	const promptBit = input.emptyPrompt ? null : shortId(input.prompt, 8);
	const nextBit = input.status === "failed" ? "nodes" : "st";
	// Happy-path done: one scan line (task + next). In-flight/fail keep node/hive rows.
	// Strip task- prefix (row already says task ·).
	const taskId = shortId(input.taskId.replace(/^task-/, ""), 6);
	// Done happy path: drop task id twin (full id in data); keep prompt/next.
	// In-flight/fail keep id for correlation.
	const omitTaskId = input.status === "done";
	// Compact · without spaces — denser scan.
	const taskRow = [
		...(omitTaskId ? [] : [taskId]),
		...(pipeline !== null ? [pipeline] : []),
		...(defaultBit !== null ? [defaultBit] : []),
		...(promptBit !== null ? [promptBit] : []),
		nextBit,
	].join("·");
	const rows =
		input.status === "done" && omitNode
			? [taskRow]
			: [
					taskRow,
					...(omitNode ? [] : [`node · ${node}`]),
					// Omit hive when default — less noise on the happy path.
					...(input.poolId === "default" ? [] : [`pool · ${input.poolId}`]),
				];
	// Defaulted bare: ★. Explicit: d (matches help tail; full word in data).
	// Product brand lives on status/help; verb panels use glyph+tail.
	const title = input.defaultVerb ? `${glyph} ★` : `${glyph} d`;
	return panel(title, rows);
}

/** Format CLI result for stdout (human or JSON). */
export function formatHoboCodeResult(
	result: HoboCodeCliResult,
	jsonOrOpts: boolean | FormatHoboCodeOptions = false,
): string {
	const opts: FormatHoboCodeOptions =
		jsonOrOpts === true || jsonOrOpts === false
			? { json: jsonOrOpts }
			: jsonOrOpts;
	const json = opts.json === true;
	const denseFromData =
		isJsonObject(result.data) &&
		result.data !== null &&
		// SAFETY: parsed or fixture value is the named domain type after this assertion.
		(result.data as { dense?: boolean }).dense === true;
	const dense = opts.dense === true || denseFromData;

	if (json) {
		return `${JSON.stringify(
			{
				ok: result.ok,
				status: result.status,
				code: result.code,
				message: result.message,
				...(result.remediation !== undefined
					? { remediation: result.remediation }
					: undefined),
				...(result.data !== undefined ? { data: result.data } : undefined),
			},
			null,
			2,
		)}\n`;
	}
	if (result.code === "HOBO_CODE_HELP") {
		// Help already chose plain vs dense in helpText().
		return result.message.endsWith("\n")
			? result.message
			: `${result.message}\n`;
	}

	// Prefer embedded presentation body when present (status chrome, etc.).
	// SAFETY: parsed or fixture value is the named domain type after this assertion.
	const data = result.data as { text?: string } | undefined;
	let body =
		isJsonString(data?.text) && data.text.length > 0
			? data.text
			: result.message;
	if (dense) {
		body = applyDenseChrome(body);
	}

	const lines = [body];
	// Adaptive panel rule is 12–20 ─ (see panel()); detect trailing rule line.
	const ruleMatch = body.match(/\n(─{12,20})\s*$/);
	const trailingRule = ruleMatch?.[1] ?? null;
	const stripTrailingRule = (s: string): string =>
		trailingRule !== null && s.endsWith(trailingRule)
			? s.slice(0, -trailingRule.length)
			: s.endsWith("\n")
				? s
				: `${s}\n`;
	if (result.remediation?.length) {
		// Compact FIX as body row under main panel rule.
		const fixes = result.remediation.map((r) => `→ ${r}`).join(" · ");
		const codeBit =
			!result.ok && result.code !== "HOBO_CODE_HELP"
				? ` · ✕ ${result.code}`
				: "";
		// Attach under panel: replace trailing rule with FIX + rule
		const cur = lines[0] ?? "";
		const rule = trailingRule ?? "─".repeat(16);
		if (trailingRule !== null && cur.endsWith(trailingRule)) {
			lines[0] = `${stripTrailingRule(cur)}FIX  ${fixes}${codeBit}\n${rule}`;
		} else {
			lines.push(`FIX  ${fixes}${codeBit}`);
			lines.push(rule);
		}
	} else if (!result.ok && result.code !== "HOBO_CODE_HELP") {
		// Prefer body-inline FIX · ✕ CODE (closed panel). Else append code row.
		// Short codes (USAGE / DIST_OFF / HARNESS_DISABLED) count as branded.
		const shortCode = result.code.replace(/^HOBO_CODE_/, "");
		if (
			body.includes(result.code) ||
			body.includes(shortCode) ||
			body.includes("FIX →") ||
			body.includes("FIX  →") ||
			/✕\s*\S+/.test(body)
		) {
			// already branded — no twin trailer
		} else {
			const rule = trailingRule ?? "─".repeat(16);
			const withCode =
				trailingRule !== null && body.endsWith(trailingRule)
					? `${stripTrailingRule(body)}✕ ${result.code}\n${rule}`
					: `${body}\n✕ ${result.code}`;
			lines[0] = withCode;
		}
	} else if (result.ok && result.code !== "HOBO_CODE_HELP") {
		// Quiet success code only when the body does not already brand the panel.
		// Closed panel (trailing ─) / box (┌) / se / product brand all count.
		// Short titles (✓ ★ / ▣ pl / …) omit hobo-code twin — rule is the seal.
		const branded =
			body.includes(result.code) ||
			body.includes("hobo-code") ||
			body.includes("┌") ||
			trailingRule !== null ||
			/^[\s✓✕]*se·/m.test(body);
		if (!branded) {
			lines.push("");
			lines.push(`✓ ${result.code}`);
		}
	}
	return `${lines.join("\n")}\n`;
}
