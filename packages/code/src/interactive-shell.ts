/**
 * HoBo-owned interactive product shell for bare `hobo-code` TTY.
 *
 * Architecture (ADR note in ARCHITECTURE.md):
 * - **This module owns chrome** (header/Bo, chat, agents+tasks, slash, footer).
 * - Chrome is a retained semantic TUI tree (`tui-tree` + React-style
 *   `tui-components.tsx`). `pi-tui` is only the differential framebuffer.
 * - Frames repaint only when state changes; idle Bo ticks that resolve to the
 *   same sprite frame request no render at all.
 *
 * Pure frame rendering + key reduction are unit-tested. The run loop is a
 * thin driver over TUI + StreamTerminal.
 */

import type { Readable, Writable } from "node:stream";
import { type Component, matchesKey, TUI } from "@earendil-works/pi-tui";
import { resolveHoboHome } from "@hobo/core/hobo-home";
import { must } from "@hobo/core/total-access";
import { HOBO_LOGO_TUI } from "./_generated-art/hobo-logo-tui.js";
import {
	harnessDisplayLabel,
	loadHarnessCatalog,
} from "./agent-harness-catalog.js";
import type { AgentWorkBoard } from "./agent-work.js";
import {
	AGENTS_CATALOG_KEY_LEGEND,
	type AgentsCatalogPick,
	type AgentsCatalogState,
	buildAgentsCatalog,
	discoverProjectEveAgents,
	flattenVisible,
	reduceAgentsCatalogKey,
} from "./agents-catalog.js";
import {
	AGENTS_CONFIGURE_KEY_LEGEND,
	type AgentsConfigureCatalogOptions,
	type AgentsConfigureState,
	formatAgentsConfigureLines,
	openEveConfigure,
	openEveConfigureFromParent,
	openHarnessConfigure,
	openHoboBoConfigure,
	reduceAgentsConfigureKey,
} from "./agents-configure.js";
import {
	EMPTY_TURN,
	reduceTurn,
	// SAFETY: parsed or fixture value is the named domain type after this assertion.
	renderTurn as renderTurnView,
} from "./agui.js";
import {
	answerBtw,
	type BtwSession,
	captureBtwSnapshot,
	isBtwDismiss,
	matchBtwInput,
	parentDelta,
	refreshBtwSnapshot,
} from "./btw.js";
import {
	formatShellCloseout,
	newChatSessionId,
	saveChatSession,
} from "./chat-sessions.js";
import { compactTranscript } from "./compact.js";
import { inspectCost } from "./cost.js";
import {
	buildTasksSurface,
	renderTasksBoardText,
	type TaskBoardRow,
} from "./grok-build-parity.js";
import {
	executeHarnessChromeAction,
	HARNESS_CHROME_KEY_HINT,
	harnessActionFromSlash,
} from "./harness-session-actions.js";
import {
	cycleHarnessFocus,
	cycleHarnessLeaf,
	emptyHarnessSessionView,
	focusedHarnessAgentId,
	focusedHarnessPane,
	formatHarnessSessionLines,
	type HarnessSessionView,
	harnessViewFromLivePanes,
	harnessViewFromSnapshot,
	mergeHarnessSessions,
	syncLivePanesFocus,
} from "./harness-session-view.js";
import { hermeticEnvSummary, inspectHermeticEnv } from "./hermetic-env.js";
import {
	emptyInSessionPanes,
	ensureInSessionPanes,
	focusInSessionLeaf,
	type InSessionPanes,
	isProductPrompt,
	pickSendWindow,
	refreshInSessionPanes,
	sendKeysRawToInSessionPane,
} from "./in-session-panes.js";
import { createLocalSessionControl } from "./local-session-control.js";
import { tmuxRunner } from "./mux.js";
import { preferNamedEndpoint } from "./occupancy-endpoints.js";
import { DEFAULT_OLLAMA_HOST, probeOllama } from "./ollama-engine.js";
import {
	AGENTS_ATTACH_HINT,
	attachTmuxFullscreen,
	isPaneInteractDetach,
	PANE_INTERACT_HINT,
} from "./pane-interact.js";
import { type AccentName, centreBlock } from "./rubberhose.js";
import {
	openSessionEvidencePort,
	recordSessionDecision,
	writeCurrentSessionContext,
} from "./session-evidence.js";
import {
	assembleSessionResources,
	formatSessionResources,
} from "./session-resources.js";
import type {
	EngineTurnEvent,
	EngineTurnResult,
	SandboxChange,
} from "./shell-engine.js";
import { createShellInput } from "./shell-input.js";
import {
	clampScrollState,
	followingLive,
	halfPageStep,
	maxTranscriptOffset,
	pageStep,
	// SAFETY: parsed or fixture value is the named domain type after this assertion.
	scrollFocused as scrollFocusedPure,
	scrollHistoryFooterHint,
	scrollToHome,
	scrollToLive,
	shellViewportRows,
} from "./shell-scroll.js";
import { StreamTerminal } from "./shell-terminal.js";
import {
	BO_IDLE_TICK_MS,
	HOBO_MARK_CONSOLE,
	selectBoIdleFrame,
} from "./splash.js";
import {
	describeAuthedStationSession,
	formatStationStatusBlock,
	formatStationStrap,
} from "./station-session.js";
import {
	formatSidecarStrap,
	type StationSidecars,
	sidecarsEnabled,
	startStationSidecars,
} from "./station-sidecars.js";
import { buildMultiplexerStatus, createPane, renderStatusText } from "./tui.js";
import { BROADCAST_INNER_INSET } from "./tui-broadcast.js";
import {
	AGENTS_KEY_LEGEND,
	AgentPanes,
	AgentsCatalog,
	ApprovalDialog,
	BtwAside,
	ChatTranscript,
	ShellChrome,
	SlashPalette,
	TextPane,
	WelcomeSurface,
} from "./tui-components.js";
import type { InkTableRow } from "./tui-layout.js";
import { clearWrapCache, wrapMessage } from "./tui-layout.js";
import { renderTuiTree } from "./tui-render.js";
import type { TuiNode } from "./tui-tree.js";
import { matchWorkspaceAction } from "./workspace-actions.js";

// ── Types ────────────────────────────────────────────────────────────────

export type ShellFocus =
	| "chat"
	| "agents"
	| "agents-catalog"
	| "status"
	| "resources"
	| "slash"
	| "btw";

export const SHELL_FOCUS_ORDER: readonly ShellFocus[] = [
	"chat",
	"agents",
	"status",
	"resources",
];

export type ShellAgentState = "idle" | "working" | "blocked" | "done";

export interface ShellMessage {
	readonly role: "system" | "user" | "assistant" | "product";
	readonly text: string;
	readonly at: number;
}

export interface ShellSlashItem {
	readonly name: string;
	readonly description: string;
	/** Extra names that resolve to this item (`/templates` → `/template`). */
	readonly aliases?: readonly string[];
	/** When set, shell invokes this CLI argv via the host callback. */
	readonly argv?: readonly string[];
	/** Built-in action id when not a CLI verb. */
	readonly action?:
		| "help"
		| "about"
		| "clear"
		| "quit"
		| "guide-hint"
		| "btw"
		| "resume"
		| "compact"
		| "agents"
		| "mux"
		| "pane-attach"
		| "session-detach"
		| "session-stop"
		| "session-tab"
		| "session-pane"
		| "session-focus";
}

/** A promotion awaiting explicit approval — the sole audited mutation path. */
export interface PendingApproval {
	readonly runId: string;
	readonly sandboxRoot: string;
	readonly changes: readonly SandboxChange[];
}

export interface InteractiveShellState {
	readonly width: number;
	readonly height: number;
	readonly tickMs: number;
	readonly reducedMotion: boolean;
	readonly dense: boolean;
	readonly focus: ShellFocus;
	readonly input: string;
	readonly messages: readonly ShellMessage[];
	// SAFETY: parsed or fixture value is the named domain type after this assertion.
	/** Welcome + occupancy endpoints as a two-column ink table. */
	readonly welcomeTable: readonly InkTableRow[];
	readonly agentState: ShellAgentState;
	readonly slashOpen: boolean;
	readonly slashFilter: string;
	readonly slashIndex: number;
	/** Lines scrolled up from the bottom of the chat / btw transcript. */
	readonly chatScroll: number;
	/**
	 * Agents: lines up from live end (end-origin, like chatScroll).
	 * Status/resources/approval: lines down from the top (start-origin).
	 */
	readonly paneScroll: number;
	/** Cached Agents body line count for scroll clamping. */
	readonly agentsBodyLines: number;
	/**
	 * Full-buffer transcript review (Claude Ctrl+O less-mode). Null = inline
	 * chat viewport. Offset is start-origin lines into the transcript.
	 */
	readonly transcriptMode: { readonly offset: number } | null;
	/**
	 * Promotion approval gate (ADR-0139): engine edits live in a mediated
	 * sandbox and only reach the canonical tree through an explicit human
	 * approval. Non-null means the shell is waiting on y/n.
	 */
	readonly pendingApproval: PendingApproval | null;
	/** Temporary side-chat borrowed from this moment. Null when dismissed. */
	readonly btw: BtwSession | null;
	/** Live session token/cost accounting shown in the footer and /cost. */
	readonly usageLabel: string;
	/** Rows the Editor occupies, so the transcript can size around it. */
	readonly inputRows: number;
	readonly statusPlain: string;
	readonly tasksPlain: string;
	readonly agentBoard: AgentWorkBoard<TaskBoardRow>;
	readonly resourcesPlain: string;
	/** Live tmux agent panes captured into this TTY. Null until seated. */
	readonly livePanes: InSessionPanes | null;
	/**
	 * Herdr-shaped Agents model: Session → Tab → Pane.
	 * Driven from live mux seating and/or resident session snapshots.
	 */
	readonly harnessView: HarnessSessionView;
	/**
	 * When true on Agents, keystrokes forward to the focused tmux pane
	 * (interactive menus). Ctrl+] leaves without quitting the shell.
	 */
	readonly paneInteract: boolean;
	/**
	 * `/agents` harness catalog (picker + browse). Null when closed.
	 */
	readonly agentsCatalog: AgentsCatalogState | null;
	/**
	 * `/agents` configure form (model/effort). Opened via Enter on a catalog row.
	 */
	readonly agentsConfigure: AgentsConfigureState | null;
	/**
	 * Cached local ollama tags for the Bo model catalog (refreshed on /agents).
	 */
	readonly boOllama: {
		readonly host: string;
		readonly models: readonly string[];
	} | null;
	/** True after a subagent turn starts — unlocks the agents tab. */
	readonly agentWork: boolean;
	readonly footerHints: string;
	readonly modelLabel: string;
	readonly costLabel: string;
	readonly hermeticLabel: string;
	/** Logged-in Station chip (`station:local` or `auth:out`). */
	readonly stationLabel: string;
	/** Occupancy environment chip (`env:local-dev`). Empty when logged out. */
	readonly envLabel: string;
	/** Occupied Station sidecar chips (`dash:host:port`). */
	readonly sidecarChips: readonly string[];
	readonly productTitle: string;
	/** Hard product identity — must never be stock Pi chrome. */
	readonly engineLabel: "hobo-shell";
	/** Durable interactive-chat id. Null until the first persistable turn. */
	readonly sessionId: string | null;
	readonly hoboHome: string;
	readonly projectDir: string;
	/** Full journal when the working pane has been compacted. */
	readonly journal: readonly ShellMessage[] | null;
}

export interface RenderShellOptions {
	readonly state: InteractiveShellState;
}

export const DEFAULT_SLASH_ITEMS: readonly ShellSlashItem[] = [
	{ name: "help", description: "Shell keys + product map", action: "help" },
	{
		name: "about",
		description: "What this shell is (and is not)",
		action: "about",
	},
	{
		name: "agents",
		description: "Configure harnesses + subagents (model / effort)",
		action: "agents",
	},
	{
		name: "mux",
		description:
			"Connect to agent terminal sessions (TV · attach · tab · pane · stop)",
		action: "mux",
	},
	{
		name: "tasks",
		aliases: ["task"],
		description: "Session work board (claimed tasks)",
		argv: ["tasks"],
	},
	{
		name: "ide",
		description: "Open your editor on this session (neovim by default)",
		argv: ["edit"],
	},
	{ name: "config", description: "Setup / stack inventory", argv: ["config"] },
	{ name: "cost", description: "$0 path + budget + savings", argv: ["cost"] },
	{
		name: "dev",
		description: "Run this Bindle on a local Yard + Evidence",
		argv: ["dev"],
	},
	{
		name: "hobo",
		description: "Run Bindle, Yard, and control-plane commands",
		argv: ["hobo"],
	},
	{ name: "status", description: "Session / agent panes", argv: ["status"] },
	{
		name: "resources",
		description: "Session topology + real endpoints",
		argv: ["resources"],
	},
	{
		name: "history",
		description: "Station command search",
		argv: ["history"],
	},
	{
		name: "alias",
		description: "Station aliases + env",
		argv: ["alias"],
	},

	{
		name: "dashboard",
		description: "Local Aspire SPA + OTel + start/stop",
		argv: ["dashboard"],
	},
	{
		name: "sessions",
		description: "Resident tmux sessions",
		argv: ["session", "list"],
	},
	{
		name: "env",
		description: "Hermetic shell + durable layout",
		argv: ["env"],
	},
	{
		name: "auth",
		description: "Station auth status",
		argv: ["auth", "status"],
	},
	{
		name: "login",
		description: "Human-free local login",
		argv: ["auth", "login", "--agent"],
	},
	{
		name: "models",
		description: "Model + BYOK (no secrets)",
		argv: ["models"],
	},

	{
		name: "attach",
		description: "tmux/mosh/Tailscale-shaped attach",
		argv: ["attach"],
	},
	{ name: "clear", description: "Clear chat transcript", action: "clear" },
	{
		name: "template",
		aliases: ["templates"],
		description: "List / search / render HoBo patterns (zero LLM)",
		argv: ["template"],
	},
	{
		name: "review",
		description:
			"Durable review session (coverage, threads, exact-effect publish)",
		argv: ["review"],
	},
	{
		name: "btw",
		description: "Temporary side-chat about this moment",
		action: "btw",
	},
	{
		name: "resume",
		description: "This chat id + how to reopen it later",
		action: "resume",
	},
	{
		name: "compact",
		description: "Shrink working context; keep the durable journal",
		action: "compact",
	},
	{ name: "quit", description: "Exit hobo-code shell", action: "quit" },
] as const;

/**
 * Product identity claim. Shown in `/about` and `/help` only — never printed
 * on frames or replies (branding in the answer channel is noise).
 */
// public-contract: shell identity shown by help and about consumers.
export const PRODUCT_NOT_PI = "hobo-code · HoBo shell (not stock Pi Agent)";

/** Footer engine label until a real completion engine is wired (Slice 2). */
// public-contract: stable engine status text rendered by shell clients.
export const ENGINE_NONE_LABEL = "engine:none · dispatch-only";

/** Approval-gate affordance text — y promotes, n/Esc keeps work sandboxed. */
// public-contract: stable approval affordance shared by shell renderers.
export const APPROVAL_PROMPT = "y promote · n keep sandboxed";

// ── Pure helpers ─────────────────────────────────────────────────────────

function clamp(n: number, lo: number, hi: number): number {
	return Math.max(lo, Math.min(hi, n));
}

export { clearWrapCache, peekWrapCache } from "./tui-layout.js";

function slashNames(item: ShellSlashItem): readonly string[] {
	return item.aliases ? [item.name, ...item.aliases] : [item.name];
}

export function filterSlash(
	items: readonly ShellSlashItem[],
	filter: string,
): ShellSlashItem[] {
	const f = filter.trim().toLowerCase().replace(/^\//, "");
	if (!f) return [...items];
	return items.filter((item) => {
		const names = slashNames(item);
		return (
			names.some(
				(name) => name.includes(f) || f.startsWith(name) || name.startsWith(f),
			) || item.description.toLowerCase().includes(f)
		);
	});
}

function slashItemByName(name: string): ShellSlashItem | undefined {
	const key = name.toLowerCase();
	return DEFAULT_SLASH_ITEMS.find((candidate) =>
		slashNames(candidate).includes(key),
	);
}

/** Bare `/template` (and `/templates`) lists; extra words search or subcommand. */
export function resolveSlashArgv(
	item: ShellSlashItem,
	extraArgs: readonly string[] = [],
): readonly string[] | undefined {
	if (!item.argv) return undefined;
	if (item.name === "sessions") {
		return extraArgs.length > 0 ? ["session", ...extraArgs] : item.argv;
	}
	if (item.name === "template") {
		return extraArgs.length > 0
			? ["template", ...extraArgs]
			: ["template", "list"];
	}
	return extraArgs.length > 0 ? [...item.argv, ...extraArgs] : item.argv;
}

/** Mux subcommands under `/mux` — not separate top-level slash rows. */
const MUX_SUBCOMMANDS = {
	tab: "session-tab",
	"new-tab": "session-tab",
	pane: "session-pane",
	"new-pane": "session-pane",
	split: "session-pane",
	detach: "session-detach",
	stop: "session-stop",
	"stop-session": "session-stop",
	focus: "session-focus",
	"focus-pane": "session-focus",
	attach: "pane-attach",
	interact: "pane-attach",
} as const;

function muxSubcommand(sub: string) {
	for (const [name, action] of Object.entries(MUX_SUBCOMMANDS)) {
		if (name === sub) return action;
	}
	return undefined;
}

export const MUX_SLASH_HELP = [
	"/mux          open live agent terminal sessions (TV)",
	"/mux tab      new tab named after the focused agent",
	"/mux pane     split pane under the focused tab",
	"/mux attach   keys → focused pane in TV (Ctrl+\\ leave)",
	"/mux focus    select focused pane in the mux",
	"/mux detach   return to chat (session keeps running)",
	"/mux stop     stop focused harness window/session",
	"Configure model/effort: /agents (not /mux)",
].join("\n");

function resolveMuxSlash(
	item: ShellSlashItem,
	args: readonly string[],
): ShellSlashItem {
	const sub = (args[0] ?? "").toLowerCase();
	if (!sub) {
		return { ...item, action: "mux" };
	}
	const action = muxSubcommand(sub);
	if (!action) {
		return { ...item, action: "mux", argv: args };
	}
	return {
		...item,
		action,
		description: `${item.description} · ${sub}`,
	};
}

export function slashItemForInput(text: string): ShellSlashItem | undefined {
	const [name = "", ...args] = text.slice(1).trim().split(/\s+/);
	const item = slashItemByName(name);
	if (!item) return undefined;
	if (item.action === "btw") return { ...item, argv: args };
	if (item.action === "compact") return { ...item, argv: args };
	if (item.action === "mux") return resolveMuxSlash(item, args);
	if (item.action === "agents") {
		return args.length > 0 ? { ...item, argv: ["agents", ...args] } : item;
	}
	const argv = resolveSlashArgv(item, args);
	return argv ? { ...item, argv } : item;
}

/**
 * Split raw terminal input into atomic key sequences: escape sequences
 * (CSI/SS3/paste blocks) stay whole, printable runs stay whole, single
 * control characters come out alone. Mirrors StdinBuffer's contract for
 * scripted/test input.
 */
export function splitKeySequences(data: string): string[] {
	const out: string[] = [];
	let i = 0;
	while (i < data.length) {
		const ch = must(data[i], "data[i]");
		if (ch === "\x1b") {
			// Bracketed paste block: keep marker + content + end marker whole
			if (data.startsWith("\x1b[200~", i)) {
				const end = data.indexOf("\x1b[201~", i + 6);
				if (end >= 0) {
					out.push(data.slice(i, end + 6));
					i = end + 6;
					continue;
				}
			}
			// CSI: ESC [ params final-byte (0x40–0x7e)
			if (data[i + 1] === "[") {
				let j = i + 2;
				while (
					j < data.length &&
					!(must(data[j], "data[j]") >= "@" && must(data[j], "data[j]") <= "~")
				)
					j += 1;
				out.push(data.slice(i, Math.min(j + 1, data.length)));
				i = j + 1;
				continue;
			}
			// SS3: ESC O final
			if (data[i + 1] === "O" && i + 2 < data.length) {
				out.push(data.slice(i, i + 3));
				i += 3;
				continue;
			}
			out.push(ch);
			i += 1;
			continue;
		}
		if (ch < " " || ch === "\u007f") {
			out.push(ch);
			i += 1;
			continue;
		}
		// Printable run
		let j = i;
		while (
			j < data.length &&
			must(data[j], "data[j]") >= " " &&
			data[j] !== "\u007f"
		)
			j += 1;
		out.push(data.slice(i, j));
		i = j;
	}
	return out;
}

export function buildWelcomeTable(occupancy?: {
	readonly dashboardUrl?: string;
	readonly evidenceUrl?: string;
}): InkTableRow[] {
	const rows: InkTableRow[] = [
		{
			label: "talk",
			value: "Type+Enter stays in chat · Tab into a working subagent to steer",
		},
		{ label: "patterns", value: "/templates lists patterns" },
		{
			label: "focus",
			value: "Tab · chat first · agents hold claimed tasks",
		},
	];
	if (occupancy?.dashboardUrl) {
		rows.push({
			label: "dashboard",
			value: preferNamedEndpoint(occupancy.dashboardUrl, "dashboard"),
		});
	}
	if (occupancy?.evidenceUrl) {
		rows.push({
			label: "evidence",
			value: preferNamedEndpoint(occupancy.evidenceUrl, "evidence"),
		});
	}
	return rows;
}

/**
 * Build initial shell state from env/cwd — pure enough for tests with overrides.
 */
export function createInitialShellState(
	options: {
		readonly width?: number;
		readonly height?: number;
		readonly dense?: boolean;
		readonly reducedMotion?: boolean;
		readonly cwd?: string;
		readonly hoboHome?: string;
		readonly env?: NodeJS.ProcessEnv;
		readonly welcome?: boolean;
		readonly sessionId?: string;
		readonly messages?: readonly ShellMessage[];
		readonly journal?: readonly ShellMessage[];
	} = {},
): InteractiveShellState {
	const env = options.env ?? process.env;
	const width = clamp(options.width ?? 80, 16, 500);
	const height = clamp(options.height ?? 24, 8, 200);
	const dense = options.dense === true;
	const reducedMotion =
		options.reducedMotion === true ||
		env.HOBO_CODE_REDUCED_MOTION === "1" ||
		env.HOBO_CODE_REDUCED_MOTION === "true";

	const hoboHome = options.hoboHome ?? resolveHoboHome(env);
	const hermetic = inspectHermeticEnv({
		projectRoot: options.cwd ?? process.cwd(),
		hoboHome,
		env,
	});
	const cost = inspectCost(env);
	const station = describeAuthedStationSession({ hoboHome, env });
	const stationChips = formatStationStrap(station);

	const panes = [
		createPane("coord", "idle", ""),
		createPane(
			"station",
			station.loggedIn ? "done" : "blocked",
			station.loggedIn ? station.displayName : "login",
		),
		createPane(
			"auth",
			station.loggedIn ? "done" : "idle",
			station.loggedIn
				? station.mode === "local"
					? ""
					: station.displayName
				: "login",
		),
	];
	const mux = buildMultiplexerStatus(panes, {
		remoteReady: true,
		theme: "herdr",
	});
	const statusPlain = [
		formatStationStatusBlock(station),
		renderStatusText(mux, { plain: true }),
	].join("\n");
	const tasks = buildTasksSurface({
		hoboHome,
		panes: mux.panes,
		evidence: openSessionEvidencePort(hoboHome),
	});
	const tasksPlain = renderTasksBoardText(tasks);
	const agentBoard = tasks.board;
	const resourcesPlain = formatSessionResources(
		assembleSessionResources({
			hoboHome,
			env,
			projectDir: options.cwd ?? process.cwd(),
		}),
	);

	const projectDir = options.cwd ?? process.cwd();
	const welcome: ShellMessage[] =
		options.messages !== undefined
			? [...options.messages]
			: options.welcome === false
				? []
				: [
						{
							role: "product",
							text: [
								...centreBlock(
									HOBO_LOGO_TUI.split("\n").filter(
										(line) => line.trim().length > 0,
									),
									Math.min(width - BROADCAST_INNER_INSET, 70),
								),
								"",
								...centreBlock(
									["a coding harness that rides the rails"],
									Math.min(width - BROADCAST_INNER_INSET, 70),
								),
							].join("\n"),
							at: Date.now(),
						},
					];

	return {
		width,
		height,
		tickMs: 0,
		reducedMotion,
		dense,
		focus: "chat",
		input: "",
		messages: welcome,
		welcomeTable:
			options.messages !== undefined || options.welcome === false
				? []
				: buildWelcomeTable(),
		agentState: "idle",
		slashOpen: false,
		slashFilter: "",
		slashIndex: 0,
		chatScroll: 0,
		paneScroll: 0,
		agentsBodyLines: 0,
		transcriptMode: null,
		pendingApproval: null,
		btw: null,
		usageLabel: "",
		inputRows: 1,
		statusPlain,
		tasksPlain,
		agentBoard,
		resourcesPlain,
		livePanes: null,
		harnessView: emptyHarnessSessionView(),
		paneInteract: false,
		agentsCatalog: null,
		agentsConfigure: null,
		boOllama: null,
		agentWork: false,
		footerHints: "Tab focus · / slash · btw aside · ? help · Ctrl+C quit",
		modelLabel: ENGINE_NONE_LABEL,
		costLabel: `$${cost.budget.spendUsd.toFixed(2)}/$${cost.budget.capUsd.toFixed(2)} · ${cost.budget.routingPolicy}`,
		hermeticLabel: hermeticEnvSummary(hermetic).split("\n")[0] ?? "env",
		stationLabel: stationChips[0] ?? "auth:out",
		envLabel: stationChips[1] ?? "",
		sidecarChips: [],
		productTitle: "hobo-code",
		engineLabel: "hobo-shell",
		sessionId: options.sessionId ?? null,
		hoboHome,
		projectDir,
		journal: options.journal ?? null,
	};
}

function persistShellChat(
	state: InteractiveShellState,
	force = false,
): InteractiveShellState {
	if (
		!force &&
		!state.messages.some(
			(message) => message.role === "user" || message.role === "assistant",
		)
	) {
		return state;
	}
	const journal = state.journal ?? state.messages;
	const saved = saveChatSession(state.hoboHome, {
		...(state.sessionId !== null ? { id: state.sessionId } : undefined),
		cwd: state.projectDir,
		messages: journal,
		...(state.journal
			? {
					workingMessages: state.messages.map((message) => ({
						role: message.role,
						text: message.text,
						at: message.at,
					})),
				}
			: undefined),
		...(state.stationLabel ? { stationLabel: state.stationLabel } : undefined),
		...(state.envLabel ? { envLabel: state.envLabel } : undefined),
		...(state.modelLabel ? { modelLabel: state.modelLabel } : undefined),
	});
	const next =
		state.sessionId === saved.id ? state : { ...state, sessionId: saved.id };
	writeCurrentSessionContext(next.hoboHome, {
		sessionId: saved.id,
		cwd: next.projectDir,
		...(next.stationLabel ? { stationLabel: next.stationLabel } : undefined),
		...(next.envLabel ? { envLabel: next.envLabel } : undefined),
		...(next.modelLabel ? { modelLabel: next.modelLabel } : undefined),
	});
	return next;
}

function appendWorking(
	state: InteractiveShellState,
	message: ShellMessage,
): InteractiveShellState {
	return {
		...state,
		messages: [...state.messages, message],
		journal: state.journal ? [...state.journal, message] : state.journal,
	};
}

export function applyCompact(
	state: InteractiveShellState,
	focus = "",
): InteractiveShellState {
	const journal = state.journal ?? state.messages;
	const plan = compactTranscript({
		messages: journal,
		...(focus.trim() ? { focus: focus.trim() } : undefined),
		...(state.stationLabel ? { stationLabel: state.stationLabel } : undefined),
		...(state.envLabel ? { envLabel: state.envLabel } : undefined),
		...(state.sessionId !== null ? { sessionId: state.sessionId } : undefined),
	});
	const next: InteractiveShellState = {
		...state,
		messages: plan.working.map((row) => ({
			role: row.role,
			text: row.text,
			at: row.at,
		})),
		journal: plan.journal.map((row) => ({
			role: row.role,
			text: row.text,
			at: row.at,
		})),
		input: "",
		slashOpen: false,
		slashFilter: "",
		slashIndex: 0,
		chatScroll: 0,
		focus: "chat",
		footerHints:
			plan.droppedCount > 0
				? "compact · journal intact · Esc/scroll still work"
				: state.footerHints,
	};
	return persistShellChat(next, true);
}

/**
 * Render one full-screen frame. Fixed structure for tests:
 * header (logo+Bo) · status line · body (chat|agents|status|resources|slash) · input · footer.
 * Geometry is stable for a given (width, height, dense) — animation frames
 * only change the Bo rows' bytes, never the line count.
 */
/**
 * Bo, reduced to a single animated cell for the status stripe.
 *
 * The mascot's full sprite belongs to the entry title card — a moment, not a
 * permanent 12-row header. Here he is a bindlebug that squashes and stretches
 * only while a turn is in flight (Fleischer bounce, honoring reduced motion).
 */
const BO_MARKERS = ["(••)", "(‥)", "(••)", "(°°)"] as const;

export function boMarker(state: InteractiveShellState): string {
	if (state.agentState !== "working") return "(••)";
	if (state.reducedMotion) return "(••)";
	const tick = Math.floor(state.tickMs / BO_IDLE_TICK_MS);
	return must(
		BO_MARKERS[tick % BO_MARKERS.length],
		"BO_MARKERS[tick % BO_MARKERS.length]",
	);
}

/** Active harness chat label for the status strap (Hobo Bo / Codex / Pi / …). */
export function activeAgentLabel(state: InteractiveShellState): string {
	const ready = ensureHarnessView(state);
	if (ready.focus === "agents") {
		const pane = focusedHarnessPane(ready.harnessView);
		if (pane?.agentLabel) return pane.agentLabel;
		if (pane?.agent) return harnessDisplayLabel(pane.agent);
		const window = ready.livePanes?.windows[ready.livePanes.focused];
		if (window) return harnessDisplayLabel(window.name);
	}
	return "Hobo Bo";
}

/** The one-line strap: who is thinking, on what, at what cost. */
export function statusSegments(state: InteractiveShellState): string[] {
	const modelChip =
		state.modelLabel === ENGINE_NONE_LABEL ? "engine:none" : state.modelLabel;
	const scrollHint = scrollHistoryFooterHint(state);
	return [
		`${boMarker(state)} hobo-code`,
		activeAgentLabel(state),
		...(scrollHint ? [scrollHint] : []),
		state.stationLabel,
		state.envLabel,
		...state.sidecarChips,
		modelChip,
		state.usageLabel || state.costLabel,
		state.agentState,
	];
}

/**
 * Render one frame.
 *
 * Layout (site/DESIGN.md — ink and paper, never flat SaaS chrome):
 *
 *     ▄▄▄████ chat ████▄▄▄         ← cartoon CRT / film bezel
 *   ▄█▀ ▪     ▪     ▪     ▪ ▀█▄
 *   █▌  …                      ▐█▒
 *   ▀█▄ ▪     ▪     ▪     ▪ ▄█▀▒
 *     ▀▀▀████████████████▀▀▀ ▒
 *      ▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒
 *   ❯ prompt█
 *   [ (••) hobo-code · model · cost · state ]   ← one inverse strap
 *
 * Every line is exactly `width` cells and the line count is stable for a
 * given (width, height), so the differential renderer sees no churn.
 */
function snapshotFromState(state: InteractiveShellState) {
	return captureBtwSnapshot({
		focus: state.focus,
		agentState: state.agentState,
		stationLabel: state.stationLabel,
		envLabel: state.envLabel,
		modelLabel: state.modelLabel,
		usageLabel: state.usageLabel,
		slashOpen: state.slashOpen,
		messages: state.messages,
		...(state.pendingApproval
			? {
					pendingApproval: {
						runId: state.pendingApproval.runId,
						changeCount: state.pendingApproval.changes.length,
					},
				}
			: undefined),
	});
}

export function applyBtwPrompt(
	state: InteractiveShellState,
	question: string,
): InteractiveShellState {
	if (state.btw && (question.trim().length === 0 || isBtwDismiss(question))) {
		return {
			...state,
			btw: null,
			focus: "chat",
			input: "",
			slashOpen: false,
			slashFilter: "",
			footerHints: "Tab focus · / slash · btw aside · ? help · Ctrl+C quit",
		};
	}
	const snapshot = snapshotFromState(state);
	const prior = state.btw?.turns ?? [];
	const originMessageCount =
		state.btw?.originMessageCount ?? snapshot.messageCount;
	const now = Date.now();
	const asked = question.trim();
	const userTurns =
		asked.length === 0
			? prior
			: [...prior, { role: "user" as const, text: asked, at: now }];
	const answer = answerBtw(snapshot, asked, prior);
	return {
		...state,
		btw: {
			snapshot,
			turns: [...userTurns, { role: "assistant", text: answer, at: now + 1 }],
			originMessageCount,
		},
		focus: "btw",
		input: "",
		slashOpen: false,
		slashFilter: "",
		slashIndex: 0,
		chatScroll: 0,
		footerHints: "btw overlay · Esc dismisses · parent thread stays visible",
	};
}

function withLiveBtw(state: InteractiveShellState): InteractiveShellState {
	if (!state.btw) return state;
	return {
		...state,
		btw: refreshBtwSnapshot(state.btw, snapshotFromState(state)),
	};
}

function viewportRows(state: InteractiveShellState): number {
	return shellViewportRows(state);
}

/** Retained semantic tree for the current frame (tests / evidence). */
export function buildShellTree(state: InteractiveShellState) {
	state = ensureHarnessView(state);
	const inner = viewportRows(state);
	const innerWidth = state.width - BROADCAST_INNER_INSET;
	let title = "chat";
	let accent: AccentName = "none";
	let surface: TuiNode;

	if (state.transcriptMode) {
		title = "transcript · less";
		const max = maxTranscriptOffset(state);
		const offset = Math.max(0, Math.min(state.transcriptMode.offset, max));
		surface = ChatTranscript({
			messages: state.messages,
			width: innerWidth,
			scroll: offset,
			scrollOrigin: "start",
		});
	} else if (state.pendingApproval) {
		title = `promote ${state.pendingApproval.runId}?`;
		accent = "spark";
		surface = ApprovalDialog({
			runId: state.pendingApproval.runId,
			sandboxRoot: state.pendingApproval.sandboxRoot,
			changes: state.pendingApproval.changes,
			prompt: APPROVAL_PROMPT,
			scroll: state.paneScroll,
		});
		if (state.paneScroll > 0)
			title = `promote ${state.pendingApproval.runId}? ↑${state.paneScroll}`;
	} else if (state.slashOpen) {
		title = "commands";
		const items = filterSlash(DEFAULT_SLASH_ITEMS, state.slashFilter);
		surface = SlashPalette({
			items,
			selectedIndex: state.slashIndex,
		});
	} else if (state.focus === "agents-catalog" && state.agentsConfigure) {
		title = "configure";
		surface = TextPane({
			id: "agents-configure",
			text: formatAgentsConfigureLines(state.agentsConfigure).join("\n"),
			scroll: 0,
		});
	} else if (state.focus === "agents-catalog" && state.agentsCatalog) {
		title =
			state.agentsCatalog.scroll > 0
				? `agents ↑${state.agentsCatalog.scroll}`
				: "agents";
		const rows = flattenVisible(state.agentsCatalog);
		surface = AgentsCatalog({
			rows,
			cursor: state.agentsCatalog.cursor,
			scroll: state.agentsCatalog.scroll,
			viewportRows: inner,
		});
	} else if (state.focus === "agents") {
		state = syncAgentsBodyLines(state);
		const pane = focusedHarnessPane(state.harnessView);
		const label = pane?.agentLabel ?? pane?.title ?? "agents";
		title = state.paneScroll > 0 ? `${label} ↑${state.paneScroll}` : label;
		const agentId = focusedHarnessAgentId(state.harnessView);
		const focusedTasks = agentId ? taskRowsForAgent(state, agentId) : [];
		const taskHint =
			focusedTasks[0] !== undefined
				? focusedTasks
						.map((row) => row.summary)
						.slice(0, 1)
						.join("")
				: undefined;
		const noteParts = [
			state.livePanes?.note,
			taskHint ? `task · ${taskHint}` : undefined,
		].filter((row): row is string => Boolean(row));
		surface = AgentPanes({
			view: state.harnessView,
			empty:
				"no harness sessions yet · chat stays first · a seated coding CLI unlocks this tab",
			...(noteParts.length > 0 ? { note: noteParts.join(" · ") } : undefined),
			scroll: state.paneScroll,
			attached: state.paneInteract,
			contentWidth: Math.max(24, innerWidth),
		});
		if (state.paneInteract) {
			title =
				state.paneScroll > 0
					? `${label} · attached ↑${state.paneScroll}`
					: `${label} · attached`;
		}
	} else if (state.focus === "status") {
		title = state.paneScroll > 0 ? `status ↑${state.paneScroll}` : "status";
		surface = TextPane({
			id: "status-pane",
			text: state.statusPlain,
			scroll: state.paneScroll,
		});
	} else if (state.focus === "resources") {
		title =
			state.paneScroll > 0 ? `resources ↑${state.paneScroll}` : "resources";
		surface = TextPane({
			id: "resources-pane",
			text: state.resourcesPlain,
			scroll: state.paneScroll,
		});
	} else {
		const transcript: string[] = [];
		for (const message of state.messages) {
			transcript.push(...wrapMessage(message, innerWidth));
			transcript.push("");
		}
		const scroll = clamp(
			state.chatScroll,
			0,
			Math.max(0, transcript.length - inner),
		);
		if (scroll > 0) title = `chat ↑${scroll}`;
		const lead = state.messages[0];
		const leadIsArt = lead?.role === "product" && /[█▄▀]/.test(lead.text);
		if (state.welcomeTable.length > 0) {
			surface = WelcomeSurface({
				...(leadIsArt && lead ? { art: lead } : undefined),
				rows: state.welcomeTable,
				rest: leadIsArt ? state.messages.slice(1) : state.messages,
				width: innerWidth,
				scroll,
			});
		} else {
			surface = ChatTranscript({
				messages: state.messages,
				width: innerWidth,
				scroll,
			});
		}
	}

	const phase =
		state.reducedMotion || state.agentState !== "working"
			? 0
			: Math.floor(state.tickMs / BO_IDLE_TICK_MS);
	const live = state.btw ? snapshotFromState(state) : undefined;
	const overlay =
		state.btw && live
			? BtwAside({
					turns: state.btw.turns,
					scroll: state.chatScroll,
					...((live.lastAssistant ?? live.lastUser ?? live.lastProduct)
						? {
								parentLatest:
									live.lastAssistant ?? live.lastUser ?? live.lastProduct,
							}
						: undefined),
					newFromParent: parentDelta({
						...state.btw,
						snapshot: live,
					}),
				})
			: undefined;
	return ShellChrome({
		title,
		accent,
		segments: statusSegments(state),
		viewportRows: inner,
		phase,
		...(state.focus === "agents"
			? {
					railLegend: state.paneInteract
						? PANE_INTERACT_HINT
						: AGENTS_KEY_LEGEND,
				}
			: state.focus === "agents-catalog"
				? {
						railLegend: state.agentsConfigure
							? AGENTS_CONFIGURE_KEY_LEGEND
							: AGENTS_CATALOG_KEY_LEGEND,
					}
				: undefined),
		...(overlay !== undefined ? { overlay } : undefined),
		children: surface,
	});
}

export function renderShellFrame(state: InteractiveShellState): string {
	return renderTuiTree(buildShellTree(state), state.width);
}

/** Assert product identity tokens for persona hard gates. */
export function shellFrameIdentity(frame: string) {
	const lower = frame.toLowerCase();
	return {
		isHoboShell: frame.includes("hobo-shell") && frame.includes("hobo-code"),
		claimsNotPi:
			frame.includes(PRODUCT_NOT_PI) || lower.includes("not stock pi"),
		hasBoArt: /[▀▄█]/.test(frame) || frame.includes(HOBO_MARK_CONSOLE),
		hasPrompt: frame.includes("❯"),
		// Stock Pi product chrome phrases we must not show as our UI
		mentionsStockPiChrome:
			/\bpi coding agent\b/i.test(frame) ||
			/\bpi-agent\b/i.test(frame) ||
			/welcome to pi\b/i.test(frame),
	};
}

const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";

export function reduceShellKey(state: InteractiveShellState, key: string) {
	state = ensureHarnessView(state);
	// `/agents` catalog + configure — modal; keys must not hit the Editor or Tab cycle.
	if (agentsModalActive(state)) {
		state = pinAgentsModalFocus(state);
		if (state.agentsConfigure) {
			return { state: reduceAgentsConfigureShell(state, key) };
		}
		const viewRows = viewportRows(state);
		const result = reduceAgentsCatalogKey(
			must(state.agentsCatalog, "state.agentsCatalog"),
			key,
			viewRows,
		);
		let next: InteractiveShellState = {
			...state,
			agentsCatalog: result.state,
			footerHints: AGENTS_CATALOG_KEY_LEGEND,
		};
		if (result.close) {
			next = {
				...next,
				agentsCatalog: null,
				agentsConfigure: null,
				focus: "chat",
				footerHints: "Tab focus · / slash · btw aside · ? help · Ctrl+C quit",
			};
			if (result.openSlash) {
				next = {
					...next,
					slashOpen: true,
					slashFilter: "",
					slashIndex: 0,
					focus: "slash",
					input: "/",
				};
			}
		}
		if (result.pick) {
			return applyAgentsCatalogPick(next, result.pick);
		}
		return { state: next };
	}
	// Soft attach: keys → focused leaf inside TV chrome. Ctrl+]/Ctrl+\ leave.
	// [ ] still cycles panes while attached (herdr multi-pane).
	// PgUp/PgDn/Home/End scroll the TV capture instead of the nested CLI.
	if (state.paneInteract && state.focus === "agents") {
		if (isPaneInteractDetach(key)) {
			return { state: leavePaneInteract(state) };
		}
		if (key === "[" || key === "]") {
			return {
				state: applyHarnessNav(state, "leaf", key === "]" ? 1 : -1),
			};
		}
		if (matchesKey(key, "pageUp") || matchesKey(key, "pageDown")) {
			state = syncAgentsBodyLines(state);
			return {
				state: scrollFocused(
					state,
					matchesKey(key, "pageUp") ? "up" : "down",
					pageStep(viewportRows(state)),
				),
			};
		}
		if (matchesKey(key, "home")) {
			return { state: scrollToHome(syncAgentsBodyLines(state)) };
		}
		if (matchesKey(key, "end")) {
			return { state: scrollToLive(syncAgentsBodyLines(state)) };
		}
		return { state, forwardPaneKey: key };
	}
	// Ctrl+C
	if (key === "\u0003") {
		return { state, quit: true };
	}
	// Transcript less-mode owns the key context (Claude Ctrl+O).
	if (state.transcriptMode) {
		if (
			matchesKey(key, "ctrl+o") ||
			key === "q" ||
			key === "Q" ||
			key === "\u001b"
		) {
			return { state: exitTranscriptLess(state) };
		}
		if (key === "j" || matchesKey(key, "down")) {
			return { state: scrollTranscriptLess(state, 1) };
		}
		if (key === "k" || matchesKey(key, "up")) {
			return { state: scrollTranscriptLess(state, -1) };
		}
		if (matchesKey(key, "pageUp") || key === "{") {
			return {
				state: scrollTranscriptLess(state, -pageStep(viewportRows(state))),
			};
		}
		if (matchesKey(key, "pageDown") || key === "}") {
			return {
				state: scrollTranscriptLess(state, pageStep(viewportRows(state))),
			};
		}
		if (matchesKey(key, "ctrl+u")) {
			return {
				state: scrollTranscriptLess(state, -halfPageStep(viewportRows(state))),
			};
		}
		if (matchesKey(key, "ctrl+d")) {
			return {
				state: scrollTranscriptLess(state, halfPageStep(viewportRows(state))),
			};
		}
		if (matchesKey(key, "home") || key === "g") {
			return {
				state: clampScrollState({
					...state,
					transcriptMode: { offset: 0 },
				}),
			};
		}
		if (matchesKey(key, "end") || key === "G") {
			return {
				state: clampScrollState({
					...state,
					transcriptMode: { offset: maxTranscriptOffset(state) },
				}),
			};
		}
		// Printable / other keys do not reach the composer.
		return { state };
	}
	// The approval gate is modal: while it is up, no key may reach the input
	// line or a verb. Only an explicit y/n (Esc/Enter decline) resolves it, so
	// a promotion can never be triggered by a stray keystroke.
	if (state.pendingApproval) {
		const pending = state.pendingApproval;
		const cleared = {
			...state,
			pendingApproval: null,
			chatScroll: followingLive(state) ? 0 : state.chatScroll,
		};
		if (key === "y" || key === "Y") {
			return { state: cleared, approve: pending };
		}
		if (
			key === "n" ||
			key === "N" ||
			key === "\u001b" ||
			key === "\r" ||
			key === "\n"
		) {
			return { state: cleared, decline: pending };
		}
		if (matchesKey(key, "up") || matchesKey(key, "down")) {
			return {
				state: scrollFocused(state, matchesKey(key, "up") ? "up" : "down", 1),
			};
		}
		if (matchesKey(key, "pageUp") || matchesKey(key, "pageDown")) {
			const page = pageStep(viewportRows(state));
			return {
				state: scrollFocused(
					state,
					matchesKey(key, "pageUp") ? "up" : "down",
					page,
				),
			};
		}
		if (matchesKey(key, "home")) {
			return { state: scrollToHome(state) };
		}
		if (matchesKey(key, "end")) {
			return { state: scrollToLive(state) };
		}
		return { state };
	}
	// Bracketed paste — insert content as one edit (newlines become spaces;
	// control characters dropped so pasted escapes can't corrupt the input line)
	if (key.startsWith(PASTE_START)) {
		const content = key
			.slice(
				PASTE_START.length,
				key.endsWith(PASTE_END) ? -PASTE_END.length : undefined,
			)
			.replace(/\r?\n/g, " ");
		let stripped = "";
		for (const ch of content) {
			const code = ch.charCodeAt(0);
			if (code <= 31 || code === 127) continue;
			stripped += ch;
		}
		if (!stripped) return { state };
		if (state.slashOpen) {
			const f = state.slashFilter + stripped;
			return {
				state: { ...state, slashFilter: f, slashIndex: 0, input: `/${f}` },
			};
		}
		return { state: { ...state, input: state.input + stripped } };
	}
	// Esc
	if (key === "\u001b") {
		if (state.btw) {
			return { state: applyBtwPrompt(state, "done") };
		}
		if (state.slashOpen) {
			return {
				state: {
					...state,
					slashOpen: false,
					slashFilter: "",
					slashIndex: 0,
					input: "",
					focus: "chat",
				},
			};
		}
		return { state };
	}
	// Arrow up/down — slash palette or scroll (never steal Agents harness focus)
	if (matchesKey(key, "up") || matchesKey(key, "down")) {
		const dirUp = matchesKey(key, "up");
		if (state.slashOpen) {
			const count = filterSlash(DEFAULT_SLASH_ITEMS, state.slashFilter).length;
			if (count === 0) return { state };
			const next = clamp(state.slashIndex + (dirUp ? -1 : 1), 0, count - 1);
			return { state: { ...state, slashIndex: next } };
		}
		if (state.focus === "chat" && state.input.length > 0) {
			return { state };
		}
		if (state.focus === "agents") {
			state = syncAgentsBodyLines(state);
		}
		return {
			state: scrollFocused(state, dirUp ? "up" : "down", 1),
		};
	}
	// PgUp/PgDn — half-viewport page (Claude fullscreen convention)
	if (matchesKey(key, "pageUp") || matchesKey(key, "pageDown")) {
		const dirUp = matchesKey(key, "pageUp");
		if (state.slashOpen) {
			const count = filterSlash(DEFAULT_SLASH_ITEMS, state.slashFilter).length;
			if (count === 0) return { state };
			const page = pageStep(viewportRows(state));
			const next = clamp(
				state.slashIndex + (dirUp ? -page : page),
				0,
				count - 1,
			);
			return { state: { ...state, slashIndex: next } };
		}
		if (state.focus === "agents") {
			state = syncAgentsBodyLines(state);
		}
		const page = pageStep(viewportRows(state));
		return {
			state: scrollFocused(state, dirUp ? "up" : "down", page),
		};
	}
	// Home / End — oldest vs live (chat + Agents) or top vs bottom (documents)
	if (matchesKey(key, "home")) {
		if (state.focus === "agents") state = syncAgentsBodyLines(state);
		return { state: scrollToHome(state) };
	}
	if (matchesKey(key, "end")) {
		if (state.focus === "agents") state = syncAgentsBodyLines(state);
		return { state: scrollToLive(state) };
	}
	// Ctrl+U / Ctrl+D — half-page scroll
	if (matchesKey(key, "ctrl+u")) {
		return {
			state: scrollFocused(state, "up", halfPageStep(viewportRows(state))),
		};
	}
	if (matchesKey(key, "ctrl+d")) {
		return {
			state: scrollFocused(state, "down", halfPageStep(viewportRows(state))),
		};
	}
	// Ctrl+O — enter transcript less-mode
	if (matchesKey(key, "ctrl+o") && !state.slashOpen) {
		return { state: enterTranscriptLess(state) };
	}
	// Tab — cycle focus (never while /agents modal owns the keyboard)
	if (key === "\t") {
		if (agentsModalActive(state)) {
			return { state: pinAgentsModalFocus(state) };
		}
		return { state: cycleFocus({ ...state, slashOpen: false }) };
	}
	if (
		(key === "[" || key === "]") &&
		state.focus === "agents" &&
		state.input.length === 0 &&
		!state.slashOpen &&
		hasAgentWork(state) &&
		state.harnessView.sessions.length > 0
	) {
		return {
			state: applyHarnessNav(state, "leaf", key === "]" ? 1 : -1),
		};
	}
	if (
		(key === "{" || key === "}") &&
		state.focus === "agents" &&
		state.input.length === 0 &&
		!state.slashOpen &&
		hasAgentWork(state) &&
		state.harnessView.sessions.length > 0
	) {
		return {
			state: applyHarnessNav(state, "tab", key === "}" ? 1 : -1),
		};
	}
	if (
		(key === "," || key === ".") &&
		state.focus === "agents" &&
		state.input.length === 0 &&
		!state.slashOpen &&
		hasAgentWork(state) &&
		state.harnessView.sessions.length > 1
	) {
		return {
			state: applyHarnessNav(state, "session", key === "." ? 1 : -1),
		};
	}
	// ?
	if (key === "?" && state.input.length === 0 && !state.slashOpen) {
		const help: ShellMessage = {
			role: "product",
			text: [
				"hobo-code shell help",
				"  Type a prompt to queue a build task (see /about for what runs it).",
				"  / opens the slash palette (↑/↓ to pick, Enter to run).",
				"  btw <question> opens a temporary aside about this moment (Esc dismisses).",
				"  Tab cycles Chat → Mux (live agent TV) → Status → Resources (Mux while a subagent or claimed task exists).",
				"  /agents configures harness model/effort · /mux opens + steers terminal sessions.",
				"  Mux TV is herdr-shaped: Session → Tab → Pane.",
				"  Enter attaches keys to the focused pane · Ctrl+] leaves (shell nav resumes).",
				"  [ ] pane · { } tab (redundant when single-pane) · , . session · ↑↓ scroll.",
				"  Session ops via /mux · /mux <tab|pane|attach|focus|detach|stop> — never steal chat keys.",
				"  ↑/↓ on Mux scrolls capture only — never steals harness focus (unless attached).",
				"  Status strap shows the focused pane agent (Hobo Bo on chat; Codex/Pi on Mux).",
				"  Scroll: ↑/↓ line (chat/status/mux) · PgUp/PgDn half-page · Ctrl+U/D · Home/End · End = live.",
				"  Ctrl+O opens transcript less-mode (j/k · q/Esc exit). Wheel not wired — keyboard-complete.",
				"  Type+Enter in chat stays on Bo. On Mux, type+Enter steers; empty Enter fullscreen-attaches.",
			].join("\n"),
			at: Date.now(),
		};
		return {
			state: clampScrollState({
				...state,
				messages: [...state.messages, help],
				chatScroll: followingLive(state) ? 0 : state.chatScroll,
			}),
		};
	}
	// Enter (legacy \r/\n or Kitty CSI-u)
	if (matchesKey(key, "enter") || key === "\r" || key === "\n") {
		if (state.slashOpen) {
			const items = filterSlash(DEFAULT_SLASH_ITEMS, state.slashFilter);
			const typed = state.input.trim();
			const item =
				(typed.startsWith("/") ? slashItemForInput(typed) : undefined) ??
				items[state.slashIndex] ??
				items[0];
			if (!item) {
				return {
					state: {
						...state,
						slashOpen: false,
						slashFilter: "",
						input: "",
					},
				};
			}
			if (item.action === "btw") {
				const asked = matchBtwInput(state.input)?.question ?? "";
				return { state: applyBtwPrompt(state, asked) };
			}
			if (item.action === "compact") {
				const extra = state.input.trim().replace(/^\/?compact\s*/iu, "");
				return { state: applyCompact(state, extra) };
			}
			if (item.action === "mux") {
				const unknown = (item.argv ?? []).join(" ");
				if (unknown) {
					return {
						state: appendProduct(
							{
								...state,
								input: "",
								slashOpen: false,
								slashFilter: "",
								slashIndex: 0,
							},
							`Unknown /mux ${unknown}.\n${MUX_SLASH_HELP}`,
						),
					};
				}
				return { state: openAgentsSurface(state) };
			}
			if (item.action === "agents" && (item.argv?.length ?? 0) <= 1) {
				return { state: openAgentsCatalog(state) };
			}
			if (item.action === "pane-attach") {
				return {
					state: enterPaneInteract({
						...state,
						input: "",
						slashOpen: false,
						slashFilter: "",
						slashIndex: 0,
						focus: "agents",
						agentWork: true,
					}),
				};
			}
			const sessionAction = harnessActionFromSlash(item.action);
			if (sessionAction) {
				return {
					state: {
						...state,
						input: "",
						slashOpen: false,
						slashFilter: "",
						slashIndex: 0,
						focus: "agents",
						agentWork: true,
						footerHints: `agents · ${HARNESS_CHROME_KEY_HINT}`,
					},
					sessionAction,
				};
			}
			const argv = resolveSlashArgv(item);
			return {
				state: {
					...state,
					slashOpen: false,
					slashFilter: "",
					slashIndex: 0,
					input: "",
					focus: "chat",
					chatScroll: 0,
				},
				slash: argv ? { ...item, argv } : item,
			};
		}
		const text = state.input.trim();
		if (!text) {
			if (state.btw) return { state: applyBtwPrompt(state, "") };
			if (canEnterPaneInteract(state)) {
				return { state: enterPaneInteract(state) };
			}
			return { state };
		}
		const aside = matchBtwInput(text);
		if (aside !== undefined || state.btw) {
			return {
				state: applyBtwPrompt(state, aside?.question ?? text),
			};
		}
		if (text.startsWith("/")) {
			const item = slashItemForInput(text);
			if (item?.action === "compact") {
				return {
					state: applyCompact(state, (item.argv ?? []).join(" ")),
				};
			}
			if (item?.action === "mux") {
				const unknown = (item.argv ?? []).join(" ");
				if (unknown) {
					return {
						state: appendProduct(
							{
								...state,
								input: "",
								slashOpen: false,
								slashFilter: "",
							},
							`Unknown /mux ${unknown}.\n${MUX_SLASH_HELP}`,
						),
					};
				}
				return { state: openAgentsSurface(state) };
			}
			if (item?.action === "agents" && (item.argv?.length ?? 0) <= 1) {
				return { state: openAgentsCatalog(state) };
			}
			if (item?.action === "pane-attach") {
				return {
					state: enterPaneInteract({
						...state,
						input: "",
						slashOpen: false,
						slashFilter: "",
						focus: "agents",
						agentWork: true,
					}),
				};
			}
			const sessionAction = harnessActionFromSlash(item?.action);
			if (sessionAction) {
				return {
					state: {
						...state,
						input: "",
						slashOpen: false,
						slashFilter: "",
						focus: "agents",
						agentWork: true,
						footerHints: `agents · ${HARNESS_CHROME_KEY_HINT}`,
					},
					sessionAction,
				};
			}
			if (item) {
				return {
					state: {
						...state,
						input: "",
						slashOpen: false,
						slashFilter: "",
						chatScroll: 0,
					},
					slash: item,
				};
			}
			return {
				state: {
					...state,
					input: "",
					slashOpen: false,
					slashFilter: "",
					chatScroll: 0,
				},
				submit: text,
			};
		}
		const seated =
			state.focus === "agents" && state.livePanes
				? pickSendWindow(state.livePanes)
				: undefined;
		if (
			seated &&
			!isProductPrompt(text) &&
			matchWorkspaceAction(text) === undefined
		) {
			return {
				state: persistShellChat(
					appendWorking(
						{
							...state,
							input: "",
							chatScroll: 0,
							focus: "agents",
							agentWork: true,
							agentState: "working",
						},
						{
							role: "user",
							text: `→ ${seated.name}: ${text}`,
							at: Date.now(),
						},
					),
				),
				toAgent: { agent: seated.name, text },
			};
		}
		return {
			state: persistShellChat(
				appendWorking(
					{ ...state, input: "", chatScroll: 0, agentState: "working" },
					{ role: "user", text, at: Date.now() },
				),
			),
			submit: text,
		};
	}
	// Backspace
	if (key === "\u007f" || key === "\b") {
		if (state.slashOpen) {
			const f = state.slashFilter.slice(0, -1);
			return {
				state: {
					...state,
					slashFilter: f,
					slashIndex: 0,
					input: f ? `/${f}` : "/",
				},
			};
		}
		return { state: { ...state, input: state.input.slice(0, -1) } };
	}
	// Printable run (single keystroke or fallback paste) — no control chars
	if (key.length >= 1 && !key.includes("\x1b") && key >= " ") {
		if (key === "/" && state.input.length === 0 && !state.slashOpen) {
			return {
				state: {
					...state,
					slashOpen: true,
					slashFilter: "",
					slashIndex: 0,
					input: "/",
					focus: "slash",
				},
			};
		}
		if (state.slashOpen) {
			const f = state.slashFilter + key;
			return {
				state: {
					...state,
					slashFilter: f,
					slashIndex: 0,
					input: `/${f}`,
				},
			};
		}
		return { state: { ...state, input: state.input + key } };
	}
	// Unrecognized escape sequences must never leak into the input line
	return { state };
}

export function hasAgentWork(state: InteractiveShellState): boolean {
	if (state.agentWork === true || state.focus === "agents") return true;
	return state.agentBoard.groups.some((group) => group.claims.length > 0);
}

export function visibleFocusOrder(
	state: InteractiveShellState,
): readonly ShellFocus[] {
	const order: ShellFocus[] = ["chat"];
	if (hasAgentWork(state)) order.push("agents");
	order.push("status", "resources");
	return order;
}

function taskRowsForAgent(
	state: InteractiveShellState,
	agentId: string,
): readonly {
	readonly summary: string;
	readonly state?: string;
	readonly branch?: string;
	readonly isolation?: string;
}[] {
	const group = state.agentBoard.groups.find((row) => row.agentId === agentId);
	if (!group) return [];
	return group.tasks.map((row) => {
		const claim = group.claims.find((entry) => entry.taskId === row.id);
		return {
			summary: row.summary,
			state: String(row.state),
			...(claim
				? { branch: claim.branch, isolation: claim.isolation }
				: undefined),
		};
	});
}

/** Rebuild herdr view from seated mux windows, preserving focus when possible. */
export function withHarnessFromLivePanes(
	state: InteractiveShellState,
	livePanes: InSessionPanes,
): InteractiveShellState {
	const harnessView = harnessViewFromLivePanes(livePanes);
	const next = {
		...state,
		livePanes,
		harnessView,
	};
	return syncAgentsBodyLines(next);
}

/** Count Agents glass lines so paneScroll clamps against real capture height. */
export function syncAgentsBodyLines(
	state: InteractiveShellState,
): InteractiveShellState {
	const ready = ensureHarnessView(state);
	const agentsBodyLines = formatHarnessSessionLines(ready.harnessView, {
		attached: ready.paneInteract,
		contentWidth: Math.max(24, ready.width - BROADCAST_INNER_INSET),
	}).length;
	if (agentsBodyLines === state.agentsBodyLines) {
		return clampScrollState(ready);
	}
	return clampScrollState({ ...ready, agentsBodyLines });
}

/**
 * Tests and partial state updates often set livePanes without harnessView.
 * Derive the herdr model so Agents stays interactive.
 */
export function ensureHarnessView(
	state: InteractiveShellState,
): InteractiveShellState {
	if (state.harnessView.sessions.length > 0) return state;
	if (!state.livePanes || state.livePanes.windows.length === 0) return state;
	return withHarnessFromLivePanes(state, state.livePanes);
}

/** Seated mux panes ready for key-forward attach. */
export function canEnterPaneInteract(state: InteractiveShellState): boolean {
	return (
		state.focus === "agents" &&
		Boolean(state.livePanes?.tmux) &&
		(state.livePanes?.windows.length ?? 0) > 0
	);
}

/** Prefer focused harness pane id (`%N`) when it is a live tmux pane. */
export function resolvePaneInteractTarget(
	state: InteractiveShellState,
): string | undefined {
	const focused = focusedHarnessPane(state.harnessView);
	if (focused?.id.startsWith("%")) return focused.id;
	return state.livePanes ? pickSendWindow(state.livePanes)?.target : undefined;
}

/** Forward keys to the focused tmux pane until Ctrl+] leaves. */
export function enterPaneInteract(
	state: InteractiveShellState,
): InteractiveShellState {
	const ready = ensureHarnessView(state);
	if (!canEnterPaneInteract(ready)) return ready;
	return {
		...ready,
		paneInteract: true,
		slashOpen: false,
		slashFilter: "",
		slashIndex: 0,
		input: "",
		footerHints: PANE_INTERACT_HINT,
	};
}

/** Resume Agents shell nav after attach. */
export function leavePaneInteract(
	state: InteractiveShellState,
): InteractiveShellState {
	if (!state.paneInteract) return state;
	return {
		...state,
		paneInteract: false,
		footerHints:
			"mux · Enter attach · [ ] pane · { } tab · , . · ↑↓ · /agents configure",
	};
}

/**
 * Merge durable resident sessions (persist/auto-resume) with in-session mux
 * seating — herdr workspace list shape.
 */
export async function hydrateHarnessSessions(
	state: InteractiveShellState,
): Promise<InteractiveShellState> {
	const liveNodes =
		state.livePanes && state.livePanes.windows.length > 0
			? [...harnessViewFromLivePanes(state.livePanes).sessions]
			: [];
	let residentNodes: ReturnType<typeof harnessViewFromSnapshot>["sessions"] =
		[];
	try {
		const control = createLocalSessionControl({ hoboHome: state.hoboHome });
		try {
			const snapshots = await control.list();
			residentNodes = snapshots.flatMap(
				(snapshot) => harnessViewFromSnapshot(snapshot).sessions,
			);
		} finally {
			control.close();
		}
	} catch {
		residentNodes = [];
	}
	const nodes = [...liveNodes, ...residentNodes];
	if (nodes.length === 0) return state;
	const focusAgent = focusedHarnessAgentId(state.harnessView);
	let focusedSession = 0;
	let focusedTab = 0;
	let focusedPane = 0;
	if (focusAgent) {
		outer: for (const [si, session] of nodes.entries()) {
			for (const [ti, tab] of session.tabs.entries()) {
				for (const [pi, pane] of tab.panes.entries()) {
					if (pane.agent === focusAgent) {
						focusedSession = si;
						focusedTab = ti;
						focusedPane = pi;
						break outer;
					}
				}
			}
		}
	} else if (liveNodes.length > 0) {
		focusedTab = state.livePanes?.focused ?? 0;
	}
	return {
		...state,
		harnessView: mergeHarnessSessions(nodes, {
			session: focusedSession,
			tab: focusedTab,
			pane: focusedPane,
		}),
	};
}

export function applyHarnessNav(
	state: InteractiveShellState,
	axis: "leaf" | "tab" | "session",
	delta: 1 | -1,
): InteractiveShellState {
	const ready = ensureHarnessView(state);
	if (ready.harnessView.sessions.length === 0) return ready;
	const nextView =
		axis === "leaf"
			? cycleHarnessLeaf(ready.harnessView, delta)
			: cycleHarnessFocus(ready.harnessView, axis, delta);
	const livePanes = ready.livePanes
		? syncLivePanesFocus(ready.livePanes, nextView)
		: ready.livePanes;
	const stayAttached = ready.paneInteract && axis === "leaf";
	return {
		...ready,
		harnessView: nextView,
		livePanes,
		focus: "agents",
		agentWork: true,
		paneScroll: 0,
		// [ ] while attached keeps key-forward on the newly focused leaf.
		paneInteract: stayAttached,
		footerHints: stayAttached
			? PANE_INTERACT_HINT
			: "mux · Enter attach · [ ] pane · { } tab · , . · ↑↓ · /agents configure",
	};
}

export function parentChatContext(
	state: InteractiveShellState,
	limit = 4,
): readonly string[] {
	return state.messages
		.filter((row) => row.role !== "system")
		.slice(-limit)
		.map((row) => {
			const text = row.text.replace(/\s+/gu, " ").trim();
			const clipped = text.length > 72 ? `${text.slice(0, 69)}…` : text;
			return `${row.role}: ${clipped}`;
		});
}

/**
 * True when the Agents catalog (or other shell modal) must consume keys
 * before pi-tui's Editor. Live TTY routes through `tui.addInputListener`;
 * unit tests that only call `reduceShellKey` miss this gate.
 */
export function agentsModalActive(state: InteractiveShellState): boolean {
	return state.agentsCatalog !== null || state.agentsConfigure !== null;
}

export function pinAgentsModalFocus(
	state: InteractiveShellState,
): InteractiveShellState {
	if (!agentsModalActive(state)) return state;
	if (state.focus === "agents-catalog") return state;
	return { ...state, focus: "agents-catalog" };
}

export function shellModalOwnsInput(state: InteractiveShellState): boolean {
	if (state.pendingApproval) return true;
	if (state.transcriptMode) return true;
	if (state.paneInteract && state.focus === "agents") return true;
	if (agentsModalActive(state)) return true;
	return false;
}

export function openAgentsCatalog(
	state: InteractiveShellState,
): InteractiveShellState {
	const specs = loadHarnessCatalog({
		cwd: state.projectDir,
		hoboHome: state.hoboHome,
	});
	const eveTrees = discoverProjectEveAgents(state.projectDir);
	const catalog = buildAgentsCatalog(specs, eveTrees);
	return {
		...state,
		slashOpen: false,
		slashFilter: "",
		slashIndex: 0,
		input: "",
		focus: "agents-catalog",
		agentsCatalog: catalog,
		agentsConfigure: null,
		paneInteract: false,
		footerHints: AGENTS_CATALOG_KEY_LEGEND,
	};
}

function boCatalogOptions(
	state: InteractiveShellState,
): AgentsConfigureCatalogOptions {
	return {
		env: process.env,
		...(state.boOllama
			? { ollama: state.boOllama }
			: {
					ollama: {
						host: process.env.OLLAMA_HOST ?? DEFAULT_OLLAMA_HOST,
						models: [],
					},
				}),
	};
}

/** Probe local ollama and stash tags for the Bo model picker. */
export async function refreshBoOllama(
	state: InteractiveShellState,
): Promise<InteractiveShellState> {
	const host = process.env.OLLAMA_HOST ?? DEFAULT_OLLAMA_HOST;
	const probe = await probeOllama(host, 1200);
	if (!probe.ok) {
		return {
			...state,
			boOllama: { host, models: state.boOllama?.models ?? [] },
		};
	}
	return { ...state, boOllama: { host, models: probe.models } };
}

function applyAgentsCatalogPick(
	state: InteractiveShellState,
	pick: AgentsCatalogPick,
) {
	const base = {
		...state,
		slashOpen: false,
		slashFilter: "",
		slashIndex: 0,
		input: "",
		focus: "agents-catalog" as const,
		footerHints: AGENTS_CONFIGURE_KEY_LEGEND,
	};
	const catalog = boCatalogOptions(state);
	if (pick.kind === "configure-hobo-bo") {
		const eveAgents = discoverProjectEveAgents(state.projectDir);
		return {
			state: {
				...base,
				agentsConfigure: openHoboBoConfigure(
					state.hoboHome,
					eveAgents,
					catalog,
				),
			},
		};
	}
	if (pick.kind === "configure-harness") {
		return {
			state: {
				...base,
				agentsConfigure: openHarnessConfigure(
					state.hoboHome,
					pick.harnessId,
					pick.label,
					catalog,
				),
			},
		};
	}
	return {
		state: {
			...base,
			agentsConfigure: openEveConfigure(
				state.hoboHome,
				{
					id: pick.id,
					path: pick.path,
					source: "hobo-agents",
					...(pick.description !== undefined
						? { description: pick.description }
						: undefined),
					children: [],
				},
				catalog,
			),
		},
	};
}

function reduceAgentsConfigureShell(
	state: InteractiveShellState,
	key: string,
): InteractiveShellState {
	if (!state.agentsConfigure) return state;
	const result = reduceAgentsConfigureKey(
		state.agentsConfigure,
		key,
		state.hoboHome,
		state.projectDir,
	);
	if (result.kind === "back") {
		if (result.toParent) {
			return {
				...state,
				focus: "agents-catalog",
				agentsConfigure: result.toParent,
				footerHints: AGENTS_CONFIGURE_KEY_LEGEND,
			};
		}
		return {
			...state,
			focus: "agents-catalog",
			agentsConfigure: null,
			footerHints: AGENTS_CATALOG_KEY_LEGEND,
		};
	}
	if (result.kind === "created") {
		const specs = loadHarnessCatalog({
			cwd: state.projectDir,
			hoboHome: state.hoboHome,
		});
		const eveAgents = discoverProjectEveAgents(state.projectDir);
		const catalog = boCatalogOptions(state);
		const rebuilt = openHoboBoConfigure(state.hoboHome, eveAgents, catalog);
		const current = state.agentsConfigure;
		const parent = {
			...rebuilt,
			...(current
				? {
						model: current.model,
						modelId: current.modelId,
						via: current.via,
						apiEndpoint: current.apiEndpoint,
						effort: current.effort,
						modelOffers: current.modelOffers,
						modelCursor: current.modelCursor,
					}
				: undefined),
			field: "eve-list" as const,
			eveCursor: Math.max(
				0,
				eveAgents.findIndex((row) => row.id === result.agent.id),
			),
		};
		return appendProduct(
			{
				...state,
				focus: "agents-catalog",
				agentsCatalog: buildAgentsCatalog(specs, eveAgents),
				agentsConfigure: openEveConfigureFromParent(
					state.hoboHome,
					result.agent,
					parent,
				),
				footerHints: AGENTS_CONFIGURE_KEY_LEGEND,
			},
			`created subagent · ${result.agent.id}\n  ${result.agent.path}`,
		);
	}
	if (result.kind === "open-eve") {
		return {
			...state,
			focus: "agents-catalog",
			agentsConfigure: openEveConfigureFromParent(
				state.hoboHome,
				result.agent,
				state.agentsConfigure,
			),
			footerHints: AGENTS_CONFIGURE_KEY_LEGEND,
		};
	}
	if (result.kind === "saved") {
		const note =
			result.scope === "eve"
				? `saved subagent · ${result.settings.id} · model ${result.settings.model || "(unset)"}${result.settings.modelId ? ` · ${result.settings.modelId}` : ""}${result.settings.apiEndpoint ? ` · ${result.settings.apiEndpoint}` : ""} · effort ${result.settings.effort}`
				: `saved ${result.settings.id} · model ${result.settings.model || "(unset)"}${result.settings.modelId ? ` · ${result.settings.modelId}` : ""}${result.settings.apiEndpoint ? ` · ${result.settings.apiEndpoint}` : ""} · effort ${result.settings.effort}`;
		const modelLabel =
			result.scope === "harness" &&
			result.settings.id === "hobo-code" &&
			result.settings.model.trim().length > 0
				? result.settings.model.trim()
				: state.modelLabel;
		if (result.returnTo) {
			return appendProduct(
				{
					...state,
					focus: "agents-catalog",
					agentsConfigure: result.returnTo,
					footerHints: AGENTS_CONFIGURE_KEY_LEGEND,
					modelLabel,
				},
				`${note}\n  ${result.path}`,
			);
		}
		return appendProduct(
			{
				...state,
				focus: "agents-catalog",
				agentsConfigure: null,
				footerHints: AGENTS_CATALOG_KEY_LEGEND,
				modelLabel,
			},
			`${note}\n  ${result.path}`,
		);
	}
	return {
		...state,
		focus: "agents-catalog",
		agentsConfigure: result.state,
	};
}

export function openAgentsSurface(
	state: InteractiveShellState,
): InteractiveShellState {
	const windows = state.livePanes?.windows ?? [];
	const seated = windows.some(
		(row) => row.kind === "coding-agent" || row.kind === "harness",
	);
	const claimed =
		state.agentBoard.groups.some((group) => group.tasks.length > 0) ||
		state.agentBoard.unclaimed.length > 0;
	if (!seated && !state.agentWork && !claimed) {
		return appendProduct(
			{
				...state,
				slashOpen: false,
				slashFilter: "",
				slashIndex: 0,
				input: "",
				focus: "chat",
			},
			"no subagent terminals yet — /agents configures harnesses; /mux connects once a seat exists",
		);
	}
	return {
		...state,
		slashOpen: false,
		slashFilter: "",
		slashIndex: 0,
		input: "",
		focus: "agents",
		agentWork: true,
		paneScroll: 0,
		paneInteract: false,
		harnessView:
			state.livePanes && state.livePanes.windows.length > 0
				? harnessViewFromLivePanes(state.livePanes)
				: state.harnessView,
		footerHints:
			"mux · Enter attach · [ ] pane · { } tab · , . · ↑↓ · /agents configure",
	};
}

/** Tab cycles the visible transcript panes. Agents TV only while work exists. */
export function cycleFocus(
	state: InteractiveShellState,
): InteractiveShellState {
	// Never steal /agents configure or catalog — that is the focus-loss bug.
	if (agentsModalActive(state)) {
		return pinAgentsModalFocus(state);
	}
	const order = visibleFocusOrder(state);
	const from =
		state.focus === "slash" ||
		state.focus === "btw" ||
		state.focus === "agents-catalog"
			? "chat"
			: state.focus;
	const i = order.indexOf(from);
	const next = must(
		order[(i < 0 ? 0 : i + 1) % order.length],
		"order[(i < 0 ? 0 : i + 1) % order.length]",
	);
	return {
		...state,
		focus: next,
		btw: null,
		agentsCatalog: null,
		agentsConfigure: null,
		paneScroll: 0,
		paneInteract: false,
		footerHints: `focus:${next} · Tab cycle · [ ] agents · ↑/↓ scroll · / slash · ? help`,
	};
}

function enterTranscriptLess(
	state: InteractiveShellState,
): InteractiveShellState {
	const max = maxTranscriptOffset(state);
	const offset = followingLive(state)
		? max
		: Math.max(0, max - state.chatScroll);
	return clampScrollState({
		...state,
		transcriptMode: { offset },
		slashOpen: false,
		slashFilter: "",
		slashIndex: 0,
	});
}

function exitTranscriptLess(
	state: InteractiveShellState,
): InteractiveShellState {
	const max = maxTranscriptOffset(state);
	const offset = state.transcriptMode?.offset ?? max;
	return clampScrollState({
		...state,
		transcriptMode: null,
		chatScroll: Math.max(0, max - offset),
	});
}

function scrollTranscriptLess(
	state: InteractiveShellState,
	delta: number,
): InteractiveShellState {
	const mode = state.transcriptMode;
	if (!mode) return state;
	return clampScrollState({
		...state,
		transcriptMode: { offset: Math.max(0, mode.offset + delta) },
	});
}

/** Scroll the focused scene. Up means older/top for chat, top for documents. */
export function scrollFocused(
	state: InteractiveShellState,
	intent: "up" | "down",
	amount: number,
): InteractiveShellState {
	return scrollFocusedPure(state, intent, amount);
}

/** Positive scrolls back through the transcript, negative returns toward now. */
export function scrollChat(
	state: InteractiveShellState,
	delta: number,
): InteractiveShellState {
	return scrollFocused(state, delta >= 0 ? "up" : "down", Math.abs(delta));
}

function followPreservedChatScroll(state: InteractiveShellState): number {
	return followingLive(state) ? 0 : state.chatScroll;
}

export function appendAssistant(
	state: InteractiveShellState,
	text: string,
	agentState: ShellAgentState = "idle",
): InteractiveShellState {
	return persistShellChat(
		withLiveBtw(
			clampScrollState(
				appendWorking(
					{
						...state,
						agentState,
						chatScroll: followPreservedChatScroll(state),
					},
					{ role: "assistant", text, at: Date.now() },
				),
			),
		),
	);
}

export function appendProduct(
	state: InteractiveShellState,
	text: string,
): InteractiveShellState {
	return persistShellChat(
		withLiveBtw(
			clampScrollState(
				appendWorking(
					{
						...state,
						chatScroll: followPreservedChatScroll(state),
					},
					{ role: "product", text, at: Date.now() },
				),
			),
		),
	);
}

/**
 * Replace the trailing assistant message (streaming turns grow it in place).
 * Appends when the last message is not an assistant message.
 */
export function replaceLastAssistant(
	state: InteractiveShellState,
	text: string,
	agentState: ShellAgentState = "working",
): InteractiveShellState {
	const last = state.messages[state.messages.length - 1];
	if (last?.role !== "assistant") {
		const appended = appendAssistant(state, text, agentState);
		return appended;
	}
	const replaced = { role: "assistant" as const, text, at: last.at };
	const journal = state.journal;
	let nextJournal = journal;
	if (journal && journal.length > 0) {
		const lastJournal = journal[journal.length - 1];
		nextJournal =
			lastJournal?.role === "assistant"
				? [...journal.slice(0, -1), replaced]
				: [...journal, replaced];
	}
	return persistShellChat(
		withLiveBtw(
			clampScrollState({
				...state,
				agentState,
				chatScroll: followPreservedChatScroll(state),
				messages: [...state.messages.slice(0, -1), replaced],
				journal: nextJournal,
			}),
		),
	);
}

// ── TTY driver ───────────────────────────────────────────────────────────

export interface ShellHost {
	/** Run a product CLI surface; return human text. */
	readonly runVerb: (argv: readonly string[]) => Promise<string>;
	/** Handle a user chat prompt; return assistant text. */
	readonly complete: (prompt: string) => Promise<string>;
	/** Send a coding prompt into the focused in-session agent CLI pane. */
	readonly sendToAgent?: (agent: string, text: string) => Promise<string>;
	/**
	 * Deterministic create / run / debug turns. When this returns text, the
	 * shell must not send the prompt to the completion engine.
	 */
	readonly tryWorkspaceAction?: (prompt: string) => Promise<string | null>;
	/**
	 * Streaming turn (Slice 2, engine wired): events render live; the promise
	 * resolves with the final turn result. When absent, `complete` is used.
	 */
	readonly streamTurn?: (
		prompt: string,
		onEvent: (event: EngineTurnEvent) => void,
	) => Promise<EngineTurnResult>;
	/** Cancel the in-flight streaming turn (Esc). */
	readonly cancelTurn?: () => Promise<void>;
	/** Footer label for the wired engine, e.g. "pi · anthropic/claude-…". */
	readonly engineLabel?: string;
	/**
	 * Raise the promotion approval gate after an editing turn. Returning null
	 * means nothing changed in the sandbox, so no gate is shown.
	 */
	readonly pendingApprovalFor?: (
		result: EngineTurnResult,
	) => Promise<PendingApproval | null>;
	/** Run the audited, squash-only promote for an approved run. */
	readonly promote?: (approval: PendingApproval) => Promise<string>;
	/** Live session usage label for the footer / `/cost`. */
	readonly usageLabel?: () => string;
	/** Extra `/about` lines describing the live engine + sandbox. */
	readonly aboutLines?: readonly string[];
	/** Release long-lived local dev sessions owned by this shell. */
	readonly dispose?: () => Promise<void>;
}

export interface RunInteractiveShellOptions {
	readonly stdin?: Readable;
	readonly stdout?: Writable;
	readonly stderr?: Writable;
	readonly host: ShellHost;
	readonly dense?: boolean;
	readonly reducedMotion?: boolean;
	readonly cwd?: string;
	readonly hoboHome?: string;
	readonly env?: NodeJS.ProcessEnv;
	/** Test hook: stop after N ms */
	readonly maxMs?: number;
	/** Inject keys for tests (skips raw mode). */
	readonly scriptedKeys?: string;
	/** Test hook: receives the terminal for repaint-economy assertions. */
	readonly onTerminal?: (terminal: StreamTerminal) => void;
	/** Test hook: runs after TUI input listeners and the focused editor finish. */
	readonly onKeyHandled?: () => void;
	/** Test hook: runs after the terminal input listener is attached. */
	readonly onReady?: () => void;
	/** Test hook: runs after a turn settles and its final render is requested. */
	readonly onTurnSettled?: () => void;
	/**
	 * Start Station dashboard + Evidence sidecars. Default: on for a live TTY
	 * unless HOBO_CODE_SIDECARS=0. Tests pass false to stay off-network.
	 */
	readonly sidecars?: boolean;
	readonly sessionId?: string;
	readonly messages?: readonly ShellMessage[];
	readonly journal?: readonly ShellMessage[];
}

/**
 * Interactive driver: pi-tui differential renderer over StreamTerminal.
 *
 * Render economy contract (asserted by test/render-budget.test.ts):
 * - a repaint happens only when state changes (key, submit result, resize,
 *   or a Bo sprite frame that differs from the previous one);
 * - idle rest spans request no renders at all;
 * - unchanged lines are never rewritten (pi-tui line diff);
 * - live TTY uses the alternate screen so quit does not leave the frame
 *   in scrollback (Claude/Codex/Grok Build).
 */
export async function runInteractiveShell(
	options: RunInteractiveShellOptions,
): Promise<number> {
	const stdin = options.stdin ?? process.stdin;
	const stdout = options.stdout ?? process.stdout;
	const isTty =
		"isTTY" in stdin &&
		// SAFETY: parsed or fixture value is the named domain type after this assertion.
		(stdin as NodeJS.ReadStream).isTTY === true &&
		"isTTY" in stdout &&
		// SAFETY: parsed or fixture value is the named domain type after this assertion.
		(stdout as NodeJS.WriteStream).isTTY === true;

	const shellEnv = options.env ?? process.env;
	const shellHome = options.hoboHome ?? resolveHoboHome(shellEnv);
	describeAuthedStationSession({
		hoboHome: shellHome,
		env: shellEnv,
		ensureLocalLogin: true,
	});
	const wantSidecars =
		options.sidecars === true ||
		(options.sidecars !== false && sidecarsEnabled(shellEnv) && isTty);
	let sidecars: StationSidecars | undefined;
	if (wantSidecars) {
		try {
			sidecars = await startStationSidecars({
				hoboHome: shellHome,
				projectRoot: options.cwd ?? process.cwd(),
				env: shellEnv,
				persistEvidence: true,
			});
		} catch {
			sidecars = undefined;
		}
	}
	const stdoutColumns =
		"columns" in stdout && Number.isFinite(stdout.columns)
			? stdout.columns
			: undefined;
	const stdoutRows =
		"rows" in stdout && Number.isFinite(stdout.rows) ? stdout.rows : undefined;
	let state = createInitialShellState({
		width: stdoutColumns ?? 80,
		height: stdoutRows ?? 24,
		...(options.dense !== undefined ? { dense: options.dense } : undefined),
		...(options.reducedMotion !== undefined
			? { reducedMotion: options.reducedMotion }
			: undefined),
		...(options.cwd !== undefined ? { cwd: options.cwd } : undefined),
		hoboHome: shellHome,
		env: shellEnv,
		...(options.sessionId !== undefined
			? { sessionId: options.sessionId }
			: undefined),
		...(options.messages !== undefined
			? { messages: options.messages }
			: undefined),
		...(options.journal !== undefined
			? { journal: options.journal }
			: undefined),
	});
	if (options.host.engineLabel) {
		state = { ...state, modelLabel: options.host.engineLabel };
	}
	const sessionId = state.sessionId ?? newChatSessionId();
	if (state.sessionId !== sessionId) {
		state = { ...state, sessionId };
	}
	writeCurrentSessionContext(state.hoboHome, {
		sessionId,
		cwd: state.projectDir,
		...(state.stationLabel ? { stationLabel: state.stationLabel } : undefined),
		...(state.envLabel ? { envLabel: state.envLabel } : undefined),
		...(state.modelLabel ? { modelLabel: state.modelLabel } : undefined),
	});
	if (sidecars) {
		state = {
			...state,
			sidecarChips: [...formatSidecarStrap(sidecars)],
			welcomeTable: buildWelcomeTable({
				dashboardUrl: sidecars.dashboardUrl,
				evidenceUrl: sidecars.evidenceUrl,
			}),
		};
	}
	if (isTty) {
		try {
			const seated = await ensureInSessionPanes({
				cwd: options.cwd ?? process.cwd(),
				hoboHome: shellHome,
				env: shellEnv,
			});
			state = withHarnessFromLivePanes(state, seated);
			state = await hydrateHarnessSessions(state);
			state = {
				...state,
				focus: "chat",
				footerHints:
					seated.windows.length > 0
						? "chat first · /mux for agent terminals · /agents configure · Tab when work exists"
						: state.footerHints,
			};
		} catch {
			state = {
				...state,
				livePanes: emptyInSessionPanes("could not seat agent panes"),
			};
		}
	}

	const liveTty = isTty && options.scriptedKeys === undefined;
	const terminal = new StreamTerminal({
		stdin,
		stdout,
		columns: state.width,
		rows: state.height,
		rawMode: liveTty,
		alternateScreen: liveTty,
	});
	options.onTerminal?.(terminal);
	const startTerminal = terminal.start.bind(terminal);
	terminal.start = (onInput, onResize) => {
		startTerminal((data) => {
			try {
				onInput(data);
			} finally {
				options.onKeyHandled?.();
			}
		}, onResize);
	};
	const tui = new TUI(terminal, false);

	let quit = false;
	let resolveDone!: () => void;
	const done = new Promise<void>((resolve) => {
		resolveDone = resolve;
	});
	const requestQuit = () => {
		if (quit) return;
		quit = true;
		resolveDone();
	};

	let attachBusy = false;
	/** Set after the Editor exists — Enter / /mux attach call this. */
	let runFullscreenAttach: () => Promise<void> = async () => {};

	const applySlash = async (item: ShellSlashItem) => {
		if (item.action === "quit") {
			requestQuit();
			return;
		}
		if (item.action === "clear") {
			state = { ...state, messages: [], chatScroll: 0 };
			return;
		}
		if (item.action === "btw") {
			const asked = (item.argv ?? []).join(" ");
			state = applyBtwPrompt(state, asked);
			return;
		}
		if (item.action === "resume") {
			state = persistShellChat(state);
			state = appendProduct(
				state,
				state.sessionId
					? `This chat is ${state.sessionId}. Resume later: hobo-code resume ${state.sessionId}`
					: "No persisted chat yet. Send a prompt first, then hobo-code resume.",
			);
			return;
		}
		if (item.action === "compact") {
			state = applyCompact(state, (item.argv ?? []).join(" "));
			return;
		}
		if (item.action === "mux") {
			const unknown = (item.argv ?? []).join(" ");
			if (unknown) {
				state = appendProduct(
					state,
					`Unknown /mux ${unknown}.\n${MUX_SLASH_HELP}`,
				);
				return;
			}
			state = openAgentsSurface(state);
			input.clear();
			tui.requestRender();
			return;
		}
		if (item.action === "agents" && (item.argv?.length ?? 0) <= 1) {
			state = openAgentsCatalog(state);
			state = await refreshBoOllama(state);
			input.clear();
			tui.requestRender();
			return;
		}
		if (item.action === "pane-attach") {
			state = enterPaneInteract({
				...state,
				focus: "agents",
				agentWork: true,
				slashOpen: false,
				slashFilter: "",
				input: "",
			});
			tui.requestRender();
			return;
		}
		const sessionAction = harnessActionFromSlash(item.action);
		if (sessionAction) {
			state = {
				...state,
				focus: "agents",
				agentWork: true,
				slashOpen: false,
				slashFilter: "",
				input: "",
				footerHints: `agents · ${HARNESS_CHROME_KEY_HINT}`,
			};
			try {
				const outcome = await executeHarnessChromeAction(
					{
						hoboHome: state.hoboHome,
						harnessView: state.harnessView,
						livePanes: state.livePanes,
						runner: tmuxRunner(),
					},
					sessionAction,
				);
				state = {
					...state,
					harnessView: outcome.harnessView,
					livePanes: outcome.livePanes,
					focus: outcome.focus ?? state.focus,
					paneScroll: 0,
					footerHints: `agents · ${outcome.note}`,
				};
				state = appendProduct(state, outcome.note);
			} catch (err) {
				state = appendProduct(
					state,
					`${sessionAction.kind} failed: ${err instanceof Error ? err.message : String(err)}`,
				);
			}
			return;
		}
		if (state.btw) {
			state = { ...state, btw: null, focus: "chat" };
		}
		if (item.action === "help") {
			state = appendProduct(
				state,
				[
					"Commands: /dev /templates /hobo /ide /config /status /resources /agents /mux /quit",
					"  /agents = configure harnesses (model/effort) · /mux = connect to their terminals",
					"Aside: btw <question> borrows this moment without joining the main chat.",
					"Resume: /resume prints this chat id · later `hobo-code resume [id]`.",
					"Compact: /compact [focus] shrinks the working pane; the journal stays.",
					"Templates: /templates lists; /template <query> searches (zero LLM).",
					"Resident control: /sessions <args> (plain /sessions lists).",
					"HoBo control plane: /hobo <args> (for example /hobo yard status).",
					"Chat stays first. /mux (or Tab when work exists) opens live agent terminals.",
					"Harness CLIs are subagents on the mux TV, not a separate view.",
					"HoBo verbs stay on Bo: /dev /resources /history /alias.",
					"Keys: Tab chat · /mux · Enter attach · Ctrl+] leave · [ ]/{ }/, . · ↑/↓ · Ctrl+C quit",
				].join("\n"),
			);
			return;
		}
		if (item.action === "about") {
			const engineLines = options.host.aboutLines ?? [
				"Chat is first. /agents configures harnesses; /mux connects to their terminals.",
				"Tab into mux when a subagent has work — steer without losing this chat.",
				"HoBo verbs stay on Bo: /dev /resources /history /alias.",
				"Pi TUI remains an opt-in escape hatch via `hobo-code --pi`.",
			];
			state = appendProduct(
				state,
				[
					PRODUCT_NOT_PI,
					"This shell is HoBo product chrome over the hobo-code CLI.",
					...engineLines,
				].join("\n"),
			);
			return;
		}
		if (item.argv) {
			state = { ...state, agentState: "working" };
			tui.requestRender();
			try {
				const text = await options.host.runVerb(item.argv);
				// /cost must reflect what this session actually spent, not just
				// the configured budget — otherwise it is a brochure.
				const live =
					item.name === "cost" && state.usageLabel
						? `\n\nThis session (provider-reported): ${state.usageLabel}`
						: "";
				state = appendProduct(state, text.slice(0, 4000) + live);
			} catch (err) {
				state = appendProduct(
					state,
					`/${item.name} failed: ${err instanceof Error ? err.message : String(err)}`,
				);
			}
			state = { ...state, agentState: "idle" };
		}
	};

	let turnInFlight = false;
	let activeTurn: Promise<void> | undefined;

	const onSubmit = async (prompt: string) => {
		if (options.host.tryWorkspaceAction) {
			turnInFlight = true;
			try {
				const handled = await options.host.tryWorkspaceAction(prompt);
				if (handled !== null) {
					if (quit) return;
					state = appendAssistant(state, handled.slice(0, 8000), "idle");
					return;
				}
			} finally {
				turnInFlight = false;
			}
		}
		if (options.host.streamTurn) {
			turnInFlight = true;
			let view = EMPTY_TURN;
			const startedAt = Date.now();
			// Paint an assistant entry the instant the turn starts. A local
			// model can take many seconds to produce its first token, and an
			// empty screen for that long reads as a hang.
			state = appendAssistant(state, "…", "working");
			tui.requestRender();
			const paint = () => {
				const elapsed = Math.round((Date.now() - startedAt) / 1000);
				const body = renderTurnView(view);
				// Until the first token lands, keep a visibly ticking counter:
				// a local model can take many seconds, and silence reads as a hang.
				const waiting =
					view.text.length === 0 ? `${body || "…"} ${elapsed}s` : body;
				state = replaceLastAssistant(state, waiting, "working");
				tui.requestRender();
			};
			// Tick while waiting so the elapsed counter proves it is alive even
			// before a single token has arrived.
			const heartbeat = setInterval(() => {
				if (!quit && view.text.length === 0) paint();
			}, 1000);
			heartbeat.unref?.();
			try {
				const result = await options.host.streamTurn(prompt, (event) => {
					if (quit) return;
					view = reduceTurn(view, event);
					paint();
				});
				if (quit) return;
				const finalBody = renderTurnView(view) || result.text;
				const tail = result.aborted
					? "(cancelled)"
					: result.ok
						? ""
						: `(failed: ${result.error ?? "unknown"})`;
				state = replaceLastAssistant(
					state,
					`${finalBody || "(no reply)"}${tail ? `\n${tail}` : ""}`.slice(
						0,
						8000,
					),
					result.ok || result.aborted ? "idle" : "blocked",
				);
				refreshUsage();
				if (result.ok && !result.aborted && options.host.pendingApprovalFor) {
					const approval = await options.host.pendingApprovalFor(result);
					if (approval && !quit) {
						state = { ...state, pendingApproval: approval, chatScroll: 0 };
					}
				}
			} catch (err) {
				if (quit) return;
				state = replaceLastAssistant(
					state,
					`Could not complete: ${err instanceof Error ? err.message : String(err)}`,
					"blocked",
				);
			} finally {
				clearInterval(heartbeat);
				turnInFlight = false;
			}
			return;
		}
		// The non-streaming turn is in flight too. Without this the flag stays
		// false for the whole completion — only the `finally` below cleared it —
		// so a scripted quit drained nothing, Esc could not cancel the turn, and
		// every other `turnInFlight` guard read "idle" while a turn was running.
		turnInFlight = true;
		try {
			const text = await options.host.complete(prompt);
			if (quit) return;
			state = appendAssistant(state, text.slice(0, 8000), "idle");
		} catch (err) {
			if (quit) return;
			state = appendAssistant(
				state,
				`Could not complete: ${err instanceof Error ? err.message : String(err)}`,
				"blocked",
			);
		} finally {
			turnInFlight = false;
		}
	};

	const startTurn = (prompt: string) => {
		const turn = onSubmit(prompt).catch(() => {});
		activeTurn = turn;
		void turn.then(() => {
			if (activeTurn === turn) activeTurn = undefined;
			if (!quit) tui.requestRender();
			options.onTurnSettled?.();
		});
	};

	const refreshUsage = () => {
		const label = options.host.usageLabel?.();
		if (label !== undefined && label !== state.usageLabel) {
			state = { ...state, usageLabel: label };
		}
	};

	const resolveApproval = async (
		approval: PendingApproval,
		approved: boolean,
	) => {
		const impact = approval.changes
			.map((change) => `${change.status} ${change.path}`)
			.join("\n");
		if (state.sessionId) {
			recordSessionDecision(state.hoboHome, {
				sessionId: state.sessionId,
				title: approved ? "Promoted sandbox" : "Kept sandboxed",
				reason: approved
					? `Apply run ${approval.runId}.\n${impact || "No file changes listed."}`
					: `Refused run ${approval.runId}. Work stays in ${approval.sandboxRoot}.\n${impact}`,
			});
		}
		if (!approved) {
			state = appendProduct(
				state,
				[
					`Kept sandboxed — run ${approval.runId} was not promoted.`,
					`Sandbox: ${approval.sandboxRoot}`,
					`Promote later (audited): hobo-code promote --run ${approval.runId}`,
				].join("\n"),
			);
			return;
		}
		state = { ...state, agentState: "working" };
		tui.requestRender();
		try {
			const text = options.host.promote
				? await options.host.promote(approval)
				: `no promote handler wired for run ${approval.runId}`;
			state = appendProduct(state, text.slice(0, 4000));
		} catch (err) {
			state = appendProduct(
				state,
				`Promotion failed for ${approval.runId}: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
		state = { ...state, agentState: "idle" };
	};

	/** A completed line from the Editor: either a command or a prompt. */
	const handleSubmitText = (text: string) => {
		if (quit) return;
		const aside = matchBtwInput(text);
		if (aside !== undefined || (state.btw && !text.startsWith("/"))) {
			state = applyBtwPrompt(state, aside?.question ?? text);
			tui.requestRender();
			return;
		}
		if (text.startsWith("/")) {
			const item = slashItemForInput(text);
			if (item) {
				void applySlash(item)
					.then(() => {
						if (!quit) tui.requestRender();
					})
					.catch(() => {});
				return;
			}
			state = appendProduct(
				state,
				`Unknown command "${text}". Type / to see what exists.`,
			);
			tui.requestRender();
			return;
		}
		if (turnInFlight) {
			state = appendProduct(
				state,
				"Still working on the previous turn — Esc cancels it.",
			);
			tui.requestRender();
			return;
		}
		const seated =
			state.focus === "agents" && state.livePanes
				? pickSendWindow(state.livePanes)
				: undefined;
		if (
			seated &&
			!isProductPrompt(text) &&
			matchWorkspaceAction(text) === undefined &&
			options.host.sendToAgent
		) {
			state = persistShellChat(
				appendWorking(
					{
						...state,
						chatScroll: 0,
						focus: "agents",
						agentWork: true,
						agentState: "working",
					},
					{ role: "user", text: `→ ${seated.name}: ${text}`, at: Date.now() },
				),
			);
			tui.requestRender();
			void options.host
				.sendToAgent(seated.name, text)
				.then((reply) => {
					if (quit) return;
					state = appendProduct(state, reply);
					state = { ...state, agentState: "idle" };
				})
				.catch((err: Error) => {
					if (quit) return;
					state = appendProduct(
						state,
						`pane ${seated.name} refused: ${err instanceof Error ? err.message : String(err)}`,
					);
					state = { ...state, agentState: "blocked" };
				})
				.then(() => {
					if (!quit) tui.requestRender();
				});
			return;
		}
		state = persistShellChat(
			appendWorking(
				{ ...state, chatScroll: 0, agentState: "working" },
				{ role: "user", text, at: Date.now() },
			),
		);
		tui.requestRender();
		startTurn(text);
	};

	const handleKey = (sequence: string) => {
		if (quit) return;
		// Esc cancels an in-flight streaming turn before normal key reduction.
		if (
			sequence === "\u001b" &&
			turnInFlight &&
			options.host.cancelTurn &&
			!state.slashOpen
		) {
			void options.host.cancelTurn().catch(() => {
				// A failed cancel is not worth crashing a session over — the
				// turn simply keeps running and Ctrl+C still exits cleanly.
			});
			return;
		}
		const result = reduceShellKey(state, sequence);
		// SAFETY: reduceShellKey always returns InteractiveShellState in .state.
		state = result.state as InteractiveShellState;
		if (result.quit) {
			requestQuit();
			return;
		}
		if ("fullscreenAttach" in result && result.fullscreenAttach) {
			void runFullscreenAttach();
			return;
		}
		if (result.forwardPaneKey && state.livePanes) {
			const target = resolvePaneInteractTarget(state);
			if (target) {
				void sendKeysRawToInSessionPane(
					tmuxRunner(),
					target,
					result.forwardPaneKey,
				)
					.then(() =>
						refreshInSessionPanes(
							must(state.livePanes, "state.livePanes"),
							tmuxRunner(),
						),
					)
					.then((next) => {
						if (quit || !next) return;
						state = withHarnessFromLivePanes(state, next);
						tui.requestRender();
					})
					.catch((err: Error) => {
						if (quit) return;
						state = {
							...state,
							footerHints: `attach send failed: ${err instanceof Error ? err.message : String(err)}`,
						};
						tui.requestRender();
					});
			}
			tui.requestRender();
			return;
		}
		if (result.approve || result.decline) {
			const approval = must(
				result.approve ?? result.decline,
				"(result.approve ?? result.decline)",
			);
			void resolveApproval(approval, Boolean(result.approve))
				.then(() => {
					if (!quit) tui.requestRender();
				})
				.catch(() => {});
		} else if (result.slash) {
			void applySlash(result.slash)
				.then(() => {
					if (!quit) tui.requestRender();
				})
				.catch(() => {});
		} else if (result.toAgent && options.host.sendToAgent) {
			void options.host
				.sendToAgent(result.toAgent.agent, result.toAgent.text)
				.then((reply) => {
					if (quit) return;
					state = appendProduct(state, reply);
					state = { ...state, agentState: "idle" };
				})
				.catch((err: Error) => {
					if (quit) return;
					state = appendProduct(
						state,
						`pane ${result.toAgent?.agent} refused: ${err instanceof Error ? err.message : String(err)}`,
					);
					state = { ...state, agentState: "blocked" };
				})
				.then(() => {
					if (!quit) tui.requestRender();
				});
		} else if (result.sessionAction) {
			const action = result.sessionAction;
			void executeHarnessChromeAction(
				{
					hoboHome: state.hoboHome,
					harnessView: state.harnessView,
					livePanes: state.livePanes,
					runner: tmuxRunner(),
				},
				action,
			)
				.then((outcome) => {
					if (quit) return;
					state = {
						...state,
						harnessView: outcome.harnessView,
						livePanes: outcome.livePanes,
						focus: outcome.focus ?? state.focus,
						agentWork: true,
						paneScroll: 0,
						footerHints: `agents · ${outcome.note}`,
					};
					state = appendProduct(state, outcome.note);
				})
				.catch((err: Error) => {
					if (quit) return;
					state = appendProduct(
						state,
						`${action.kind} failed: ${err instanceof Error ? err.message : String(err)}`,
					);
				})
				.then(() => {
					if (!quit) tui.requestRender();
				});
		} else if (result.submit) {
			// One turn at a time: two overlapping streams would interleave into
			// the same transcript entry and leave cancel pointing at the wrong
			// request.
			if (turnInFlight) {
				state = appendProduct(
					state,
					"Still working on the previous turn — Esc cancels it.",
				);
			} else {
				startTurn(result.submit);
			}
		}
		tui.requestRender();
	};

	const input = createShellInput({
		tui,
		commands: DEFAULT_SLASH_ITEMS.map((i) => ({
			name: i.name,
			description: i.description,
		})),
		onSubmit: (text) => handleSubmitText(text),
	});

	/**
	 * Exact CLI parity: stop the product TUI, hand this TTY to tmux attach on
	 * the focused agent window, Ctrl+] detaches back here.
	 */
	runFullscreenAttach = async () => {
		if (quit || attachBusy) return;
		const ready = ensureHarnessView(state);
		if (!canEnterPaneInteract(ready) || !ready.livePanes) {
			state = appendProduct(
				ready,
				"no seated tmux pane to attach — install codex/pi and reopen hobo-code",
			);
			tui.requestRender();
			return;
		}
		const seated = pickSendWindow(ready.livePanes);
		if (!seated) {
			state = appendProduct(ready, "no steerable agent window focused");
			tui.requestRender();
			return;
		}
		attachBusy = true;
		state = {
			...ready,
			focus: "agents",
			agentWork: true,
			footerHints: AGENTS_ATTACH_HINT,
		};
		tui.requestRender();
		// Leave alt-screen + raw mode so tmux owns the real TTY.
		tui.stop();
		try {
			const outcome = await attachTmuxFullscreen({
				session: ready.livePanes.session,
				window: seated.name,
				pane: seated.target,
				runner: tmuxRunner(),
			});
			if (!quit) {
				state = appendProduct(
					{ ...state, paneInteract: false },
					outcome.detail,
				);
			}
		} catch (err) {
			if (!quit) {
				state = appendProduct(
					{ ...state, paneInteract: false },
					`attach failed: ${err instanceof Error ? err.message : String(err)}`,
				);
			}
		}
		if (quit) {
			attachBusy = false;
			return;
		}
		try {
			const next = await refreshInSessionPanes(
				state.livePanes ?? ready.livePanes,
				tmuxRunner(),
			);
			state = withHarnessFromLivePanes(state, next);
		} catch {
			// preview refresh is best-effort after detach
		}
		tui.start();
		tui.setFocus(input.editor);
		attachBusy = false;
		tui.requestRender();
	};

	const view: Component = {
		render(width: number): string[] {
			// Never invent a width wider than the TTY — clamp(40,…) used to paint
			// 40-cell lines into a 30-col terminal and leave wrapped garbage.
			const w = Math.max(16, width);
			const h = Math.max(8, terminal.rows);
			// The Editor grows with wrapped input; the transcript gives up rows
			// to match so the frame never overflows the screen.
			const rows = Math.max(1, input.height(w));
			if (w !== state.width || h !== state.height || rows !== state.inputRows) {
				state = clampScrollState({
					...state,
					width: w,
					height: h,
					inputRows: rows,
				});
				clearWrapCache();
			}
			return renderShellFrame(state).split("\n");
		},
		invalidate(): void {
			// TUI calls this when it needs a from-scratch re-render (theme or
			// size change). Cached wraps are keyed by (message, width), but an
			// explicit invalidate must not be able to serve stale lines.
			clearWrapCache();
		},
		handleInput(data: string): void {
			handleKey(data);
		},
	};

	tui.addChild(view);
	tui.addChild(input.editor);
	// The Editor owns editing keys (backspace, word kill, undo, cursor,
	// history). The shell claims only true globals, and only when the editor
	// would not otherwise need them.
	tui.addInputListener((data) => {
		if (quit) return undefined;
		// Attach: keys → focused leaf inside TV; Ctrl+]/Ctrl+\ leave; [ ] cycle panes.
		// PgUp/PgDn/Home/End scroll the TV capture (do not forward — otherwise
		// multi-turn conversations stay stuck off-screen with no way to peek).
		if (state.paneInteract && state.focus === "agents") {
			if (isPaneInteractDetach(data)) {
				state = leavePaneInteract(state);
				tui.requestRender();
				return { consume: true };
			}
			if (data === "[" || data === "]") {
				state = applyHarnessNav(state, "leaf", data === "]" ? 1 : -1);
				if (state.livePanes) {
					void focusInSessionLeaf(
						state.livePanes,
						tmuxRunner(),
						state.livePanes.focusedPane ?? 0,
					)
						.then((next) => {
							if (quit || !next) return;
							state = withHarnessFromLivePanes(
								{ ...state, paneInteract: true },
								next,
							);
							tui.requestRender();
						})
						.catch(() => {});
				}
				tui.requestRender();
				return { consume: true };
			}
			if (matchesKey(data, "pageUp") || matchesKey(data, "pageDown")) {
				state = syncAgentsBodyLines(state);
				state = scrollFocused(
					state,
					matchesKey(data, "pageUp") ? "up" : "down",
					pageStep(viewportRows(state)),
				);
				tui.requestRender();
				return { consume: true };
			}
			if (matchesKey(data, "home")) {
				state = syncAgentsBodyLines(state);
				state = scrollToHome(state);
				tui.requestRender();
				return { consume: true };
			}
			if (matchesKey(data, "end")) {
				state = syncAgentsBodyLines(state);
				state = scrollToLive(state);
				tui.requestRender();
				return { consume: true };
			}
			const target = resolvePaneInteractTarget(state);
			if (target) {
				void sendKeysRawToInSessionPane(tmuxRunner(), target, data)
					.then(() =>
						refreshInSessionPanes(
							must(state.livePanes, "state.livePanes"),
							tmuxRunner(),
						),
					)
					.then((next) => {
						if (quit || !next) return;
						state = withHarnessFromLivePanes(
							{ ...state, paneInteract: true },
							next,
						);
						tui.requestRender();
					})
					.catch((err: Error) => {
						if (quit) return;
						state = {
							...state,
							footerHints: `attach send failed: ${err instanceof Error ? err.message : String(err)}`,
						};
						tui.requestRender();
					});
			} else {
				state = {
					...state,
					footerHints: "attach · no tmux pane — leave with Ctrl+] or Ctrl+\\",
				};
				tui.requestRender();
			}
			return { consume: true };
		}
		if (data === "\u0003") {
			requestQuit();
			return { consume: true };
		}
		if (state.pendingApproval) {
			// Modal: the gate must see every key so a mutation cannot be
			// approved by something falling through to the editor.
			handleKey(data);
			return { consume: true };
		}
		if (shellModalOwnsInput(state)) {
			// Pin + consume every key while /agents modal is open — including Tab.
			// Requiring focus==="agents-catalog" previously let Tab hit cycleFocus
			// and wipe the catalog/configure stack (focus loss).
			if (agentsModalActive(state)) {
				state = pinAgentsModalFocus(state);
			}
			handleKey(data);
			if (agentsModalActive(state) && input.text().length > 0) {
				input.clear();
			}
			return { consume: true };
		}
		if (
			matchesKey(data, "enter") &&
			state.focus === "agents" &&
			input.text().length === 0 &&
			!state.slashOpen &&
			canEnterPaneInteract(state)
		) {
			state = enterPaneInteract(state);
			tui.requestRender();
			return { consume: true };
		}
		if (data === "\u001b") {
			if (turnInFlight && options.host.cancelTurn) {
				void options.host.cancelTurn().catch(() => {});
				return { consume: true };
			}
			// Esc clears a half-typed line instead of doing nothing at all.
			if (input.text().length > 0) {
				input.clear();
				tui.requestRender();
				return { consume: true };
			}
			return { consume: true };
		}
		if (data === "\t") {
			if (agentsModalActive(state)) {
				state = pinAgentsModalFocus(state);
				handleKey(data);
				if (input.text().length > 0) input.clear();
				tui.requestRender();
				return { consume: true };
			}
			state = cycleFocus(state);
			tui.requestRender();
			return { consume: true };
		}
		if (
			(data === "[" || data === "]") &&
			state.focus === "agents" &&
			input.text().length === 0 &&
			hasAgentWork(state) &&
			state.harnessView.sessions.length > 0
		) {
			state = applyHarnessNav(state, "leaf", data === "]" ? 1 : -1);
			if (state.livePanes) {
				void focusInSessionLeaf(
					state.livePanes,
					tmuxRunner(),
					state.livePanes.focusedPane ?? 0,
				)
					.then((next) => {
						if (quit || !next) return;
						state = withHarnessFromLivePanes(state, next);
						tui.requestRender();
					})
					.catch(() => {});
			}
			tui.requestRender();
			return { consume: true };
		}
		if (
			(data === "{" || data === "}") &&
			state.focus === "agents" &&
			input.text().length === 0 &&
			hasAgentWork(state) &&
			state.harnessView.sessions.length > 0
		) {
			state = applyHarnessNav(state, "tab", data === "}" ? 1 : -1);
			tui.requestRender();
			return { consume: true };
		}
		if (
			(data === "," || data === ".") &&
			state.focus === "agents" &&
			input.text().length === 0 &&
			hasAgentWork(state) &&
			state.harnessView.sessions.length > 1
		) {
			state = applyHarnessNav(state, "session", data === "." ? 1 : -1);
			tui.requestRender();
			return { consume: true };
		}
		if (matchesKey(data, "pageUp") || matchesKey(data, "pageDown")) {
			if (state.focus === "agents") state = syncAgentsBodyLines(state);
			state = scrollFocused(
				state,
				matchesKey(data, "pageUp") ? "up" : "down",
				pageStep(viewportRows(state)),
			);
			tui.requestRender();
			return { consume: true };
		}
		if (matchesKey(data, "home")) {
			if (state.focus === "agents") state = syncAgentsBodyLines(state);
			state = scrollToHome(state);
			tui.requestRender();
			return { consume: true };
		}
		if (matchesKey(data, "end")) {
			if (state.focus === "agents") state = syncAgentsBodyLines(state);
			state = scrollToLive(state);
			tui.requestRender();
			return { consume: true };
		}
		if (matchesKey(data, "ctrl+u")) {
			if (state.focus === "agents") state = syncAgentsBodyLines(state);
			state = scrollFocused(state, "up", halfPageStep(viewportRows(state)));
			tui.requestRender();
			return { consume: true };
		}
		if (matchesKey(data, "ctrl+d")) {
			if (state.focus === "agents") state = syncAgentsBodyLines(state);
			state = scrollFocused(state, "down", halfPageStep(viewportRows(state)));
			tui.requestRender();
			return { consume: true };
		}
		if (matchesKey(data, "ctrl+o")) {
			state = state.transcriptMode
				? exitTranscriptLess(state)
				: enterTranscriptLess(state);
			tui.requestRender();
			return { consume: true };
		}
		if (state.transcriptMode) {
			handleKey(data);
			return { consume: true };
		}
		// ↑/↓ always scroll when composer empty — Agents focus stays on [ ] / { }
		// Agents catalog owns ↑↓ via shellModalOwnsInput (consumed above).
		if (
			input.text().length === 0 &&
			!shellModalOwnsInput(state) &&
			(matchesKey(data, "up") || matchesKey(data, "down"))
		) {
			state = scrollFocused(state, matchesKey(data, "up") ? "up" : "down", 1);
			tui.requestRender();
			return { consume: true };
		}
		return undefined;
	});
	tui.setFocus(input.editor);
	tui.start();
	options.onReady?.();

	// pi-tui's resize hook only requestRender()s. Force a full clear + invalidate
	// so width/height changes never leave differential leftovers (WSL/WT especially).
	const onTerminalResize = () => {
		if (quit) return;
		const nextW = Math.max(16, terminal.columns);
		const nextH = Math.max(8, terminal.rows);
		state = clampScrollState({
			...state,
			width: nextW,
			height: nextH,
			inputRows: Math.max(1, input.height(nextW)),
		});
		tui.invalidate();
		tui.requestRender(true);
		if (state.focus === "agents" && state.livePanes?.tmux) {
			void refreshInSessionPanes(state.livePanes, tmuxRunner())
				.then((next) => {
					if (quit) return;
					state = withHarnessFromLivePanes(state, next);
					tui.requestRender();
				})
				.catch(() => {});
		}
	};
	// SAFETY: parsed or fixture value is the named domain type after this assertion.
	const resizeStream = stdout as NodeJS.WriteStream & {
		on?: (event: string, listener: () => void) => void;
		off?: (event: string, listener: () => void) => void;
		removeListener?: (event: string, listener: () => void) => void;
	};
	resizeStream.on?.("resize", onTerminalResize);

	// Idle animation: request a repaint only when the sprite frame actually
	// changes. Rest spans (15 of 26 ticks) request nothing.
	const started = Date.now();
	let lastBoFrame = selectBoIdleFrame({
		tickMs: 0,
		reducedMotion: state.reducedMotion,
	});
	const tick = setInterval(() => {
		if (quit || state.reducedMotion) return;
		const tickMs = Date.now() - started;
		const frame = selectBoIdleFrame({ tickMs, reducedMotion: false });
		if (frame === lastBoFrame) return;
		lastBoFrame = frame;
		state = { ...state, tickMs };
		tui.requestRender();
	}, BO_IDLE_TICK_MS);
	tick.unref?.();
	const paneTick = setInterval(() => {
		if (quit || state.focus !== "agents" || !state.livePanes?.tmux) return;
		void refreshInSessionPanes(state.livePanes, tmuxRunner())
			.then((next) => {
				if (quit) return;
				if (next.capture === state.livePanes?.capture) return;
				state = withHarnessFromLivePanes(state, next);
				tui.requestRender();
			})
			.catch(() => {});
	}, 200);
	paneTick.unref?.();

	let maxMsTimer: NodeJS.Timeout | undefined;
	let maxMsExpired: Promise<void> | undefined;
	const maxMs =
		options.maxMs ?? (options.scriptedKeys === undefined ? undefined : 12_000);
	if (maxMs !== undefined) {
		maxMsExpired = new Promise<void>((resolve) => {
			maxMsTimer = setTimeout(() => {
				resolve();
				requestQuit();
			}, maxMs);
			maxMsTimer.unref?.();
		});
	}

	if (options.scriptedKeys !== undefined) {
		try {
			for (const sequence of splitKeySequences(options.scriptedKeys)) {
				if (quit) break;
				handleKey(sequence);
				// Yield the event loop so immediate hosts settle while slow turns stay
				// interruptible by the next Ctrl-C or Escape key.
				await new Promise<void>((resolve) => setImmediate(resolve));
			}
			if (activeTurn) {
				if (maxMsExpired) await Promise.race([activeTurn, maxMsExpired]);
				else await activeTurn;
			}
			tui.requestRender(true);
			await new Promise<void>((resolve) => process.nextTick(resolve));
		} finally {
			requestQuit();
		}
	}

	// Signals must restore the terminal too: closing the emulator or `kill`
	// otherwise leaves raw mode, a hidden cursor and bracketed paste enabled.
	// hobo-code's launcher passes SIGINT and SIGQUIT on as well, and in raw
	// mode neither comes from the keyboard: each asks the shell to quit.
	const quitSignals = ["SIGTERM", "SIGHUP", "SIGINT", "SIGQUIT"] as const;
	const onSignal = () => requestQuit();
	for (const signal of quitSignals) process.once(signal, onSignal);

	try {
		await done;
	} finally {
		clearInterval(tick);
		clearInterval(paneTick);
		if (maxMsTimer) clearTimeout(maxMsTimer);
		for (const signal of quitSignals) process.removeListener(signal, onSignal);
		resizeStream.off?.("resize", onTerminalResize);
		resizeStream.removeListener?.("resize", onTerminalResize);
		// Leave the alternate screen (and raw mode) even if the driver threw —
		// a CLI that can strand a terminal in raw mode is not shippable.
		tui.stop();
		state = persistShellChat(state, true);
		if (state.sessionId) {
			stdout.write(`${formatShellCloseout(state.sessionId)}\n`);
		}
		await sidecars?.close().catch(() => {});
	}
	return 0;
}
