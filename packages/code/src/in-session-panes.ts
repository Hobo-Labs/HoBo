/**
 * Herdr-style in-session panes: tmux windows owned by the hobo-code TTY.
 * Watch + interact paint ANSI captures inside the product TV bezel; keys
 * forward to the focused leaf pane. Multi-pane tabs = tmux splits in one window.
 */
import { join } from "node:path";
import { first } from "@hobo/core/total-access";
import { loadHarnessCatalog, seatingOrder } from "./agent-harness-catalog.js";
import { defaultProbes, detectAgents } from "./agent-registry.js";
import { isStaleSeatCapture, seatShellCommand } from "./agent-seat.js";
import { workspaceForAgent } from "./agent-work.js";
import {
	applySettingsToSeatCommand,
	loadHarnessSettings,
} from "./harness-settings.js";
import {
	applyMux,
	type MuxRunner,
	type MuxTarget,
	planMux,
	safeWindowName,
	sessionTarget,
	targetCommand,
	tmuxRunner,
} from "./mux.js";
import { sendKeysToPane } from "./pane-interact.js";

// public-contract: default in-session mux name
export const IN_SESSION_MUX = "hobo" as const;

/** One tmux pane leaf inside a harness window/tab (herdr pane). */
export interface InSessionPaneLeaf {
	readonly id: string;
	readonly index: number;
	readonly active: boolean;
	readonly width: number;
	readonly height: number;
	readonly capture: string;
}

export interface InSessionWindow {
	readonly name: string;
	readonly target: string;
	readonly kind: "harness" | "coding-agent" | "inference" | "unknown";
	/** tmux panes in this window when listed (1 = unsplit). */
	readonly panes?: readonly InSessionPaneLeaf[];
}

export interface InSessionPanes {
	readonly session: string;
	readonly windows: readonly InSessionWindow[];
	readonly focused: number;
	/** Capture of the focused leaf (compat with older callers). */
	readonly capture: string;
	readonly note: string;
	readonly tmux: boolean;
	/** Focused leaf index inside the focused window (default 0). */
	readonly focusedPane?: number;
}

function codingOrder(): readonly string[] {
	return seatingOrder(loadHarnessCatalog());
}

export function pickCodingWindow(
	windows: readonly InSessionWindow[],
): InSessionWindow | undefined {
	for (const id of codingOrder()) {
		const hit = windows.find((row) => row.name === id);
		if (hit) return hit;
	}
	return windows.find((row) => row.kind === "coding-agent");
}

function isSteerable(row: InSessionWindow): boolean {
	return row.kind === "coding-agent" || row.kind === "harness";
}

/** Focused subagent (coding CLI or harness), else the preferred coding window. */
export function pickSendWindow(
	panes: InSessionPanes,
): InSessionWindow | undefined {
	const focused = panes.windows[panes.focused];
	if (focused && isSteerable(focused)) return focused;
	return (
		pickCodingWindow(panes.windows) ??
		panes.windows.find((row) => row.kind === "harness")
	);
}

export function isProductPrompt(text: string): boolean {
	const t = text.trim();
	if (t.startsWith("/")) return true;
	if (/^(btw)\b/iu.test(t)) return true;
	return false;
}

export function emptyInSessionPanes(note: string): InSessionPanes {
	return {
		session: IN_SESSION_MUX,
		windows: [],
		focused: 0,
		focusedPane: 0,
		capture: "",
		note,
		tmux: false,
	};
}

export function classifyWindowName(name: string): InSessionWindow["kind"] {
	const spec = loadHarnessCatalog().find((row) => row.id === name);
	if (!spec) return "unknown";
	if (spec.host === true || spec.kind === "harness") return "harness";
	if (spec.kind === "inference") return "inference";
	if (spec.kind === "coding-agent") return "coding-agent";
	return "unknown";
}

export async function listInSessionWindows(
	runner: MuxRunner,
	session: string = IN_SESSION_MUX,
): Promise<readonly InSessionWindow[]> {
	const listed = await runner.run([
		"list-windows",
		"-t",
		sessionTarget(session),
		"-F",
		"#{window_name}\t#{pane_id}",
	]);
	if (listed.code !== 0) return [];
	const rows: InSessionWindow[] = [];
	for (const line of listed.stdout.split("\n")) {
		const [nameRaw, paneId] = line.split("\t");
		const name = nameRaw?.trim() ?? "";
		if (name.length === 0) continue;
		rows.push({
			name,
			target: paneId?.trim() || `${session}:${name}`,
			kind: classifyWindowName(name),
		});
	}
	return rows;
}

/** List every tmux pane leaf in a window (herdr multi-pane tab). */
export async function listWindowPaneLeaves(
	runner: MuxRunner,
	session: string,
	windowName: string,
	options: { readonly captureLines?: number } = {},
): Promise<readonly InSessionPaneLeaf[]> {
	const listed = await runner.run([
		"list-panes",
		"-t",
		`${session}:${windowName}`,
		"-F",
		"#{pane_id}\t#{pane_index}\t#{pane_active}\t#{pane_width}\t#{pane_height}",
	]);
	if (listed.code !== 0 || listed.stdout.trim().length === 0) return [];
	const lines = options.captureLines ?? 120;
	const leaves: InSessionPaneLeaf[] = [];
	for (const line of listed.stdout.split("\n")) {
		const [idRaw, indexRaw, activeRaw, widthRaw, heightRaw] = line.split("\t");
		const id = idRaw?.trim() ?? "";
		if (!id) continue;
		const capture = await captureInSessionPane(runner, id, lines);
		leaves.push({
			id,
			index: Number.parseInt(indexRaw ?? "0", 10) || 0,
			active: activeRaw === "1",
			width: Number.parseInt(widthRaw ?? "0", 10) || 0,
			height: Number.parseInt(heightRaw ?? "0", 10) || 0,
			capture,
		});
	}
	leaves.sort((a, b) => a.index - b.index);
	return leaves;
}

export async function captureInSessionPane(
	runner: MuxRunner,
	target: string,
	lines = 80,
): Promise<string> {
	const captured = await runner.run([
		"capture-pane",
		"-p",
		"-e",
		"-S",
		`-${lines}`,
		"-t",
		target,
	]);
	return captured.stdout.replace(/\s+$/u, "");
}

/** Send literal text + Enter (steer / prompt). */
export async function sendToInSessionPane(
	runner: MuxRunner,
	target: string,
	text: string,
): Promise<void> {
	await runner.run(["send-keys", "-t", target, "-l", "--", text]);
	await runner.run(["send-keys", "-t", target, "Enter"]);
}

/** Forward raw keystrokes without forcing Enter (interactive menus). */
export async function sendKeysRawToInSessionPane(
	runner: MuxRunner,
	target: string,
	data: string,
): Promise<void> {
	await sendKeysToPane(runner, target, data);
}

/**
 * Whether the shell seats the agent CLIs it finds on PATH in tmux panes.
 * HOBO_CODE_SEAT_AGENTS set to 0, false, no or off (any case, spaces aside)
 * turns seating off, as 0, false and off turn off HOBO_CODE_SIDECARS;
 * anything else, or nothing, leaves it on.
 */
export function agentSeatingEnabled(
	env: NodeJS.ProcessEnv = process.env,
): boolean {
	const raw = env.HOBO_CODE_SEAT_AGENTS?.trim().toLowerCase();
	return !(raw === "0" || raw === "false" || raw === "no" || raw === "off");
}

export async function ensureInSessionPanes(options: {
	readonly cwd?: string;
	readonly hoboHome?: string;
	readonly env?: NodeJS.ProcessEnv;
	readonly runner?: MuxRunner;
	readonly session?: string;
}): Promise<InSessionPanes> {
	// Off for a shell that must not start the agent CLIs it finds on PATH: a
	// test run, or anyone who wants the shell without agent seats.
	const env = options.env ?? process.env;
	if (!agentSeatingEnabled(env)) {
		return emptyInSessionPanes(
			`agent seating is off (HOBO_CODE_SEAT_AGENTS=${env.HOBO_CODE_SEAT_AGENTS?.trim()})`,
		);
	}
	const runner = options.runner ?? tmuxRunner();
	const session = safeWindowName(options.session ?? IN_SESSION_MUX);
	const hasTmux = await runner.run(["-V"]);
	if (hasTmux.code !== 0) {
		return emptyInSessionPanes(
			"tmux is not available — install tmux to seat agent CLIs in-session",
		);
	}
	const agents = detectAgents(defaultProbes(options.env ?? process.env));
	const placeable = agents.filter(
		(agent) =>
			agent.binary !== null &&
			agent.kind !== "harness" &&
			agent.kind !== "inference",
	);
	if (placeable.length === 0) {
		return emptyInSessionPanes(
			"no agent CLI on PATH — install codex, claude, or cursor-agent",
		);
	}
	const cwd = options.cwd ?? process.cwd();
	const homeValue = (options.env ?? process.env).HOME;
	const userHome =
		homeValue && homeValue.length > 0 ? homeValue : (process.env.HOME ?? "");
	const hoboHome =
		options.hoboHome && options.hoboHome.length > 0
			? options.hoboHome
			: joinHoboHome(userHome);
	const targets: MuxTarget[] = placeable.map((agent) => {
		const seated = seatShellCommand({
			agentId: agent.id,
			command: agent.command,
			hoboHome,
			userHome,
		});
		const settings = loadHarnessSettings(hoboHome, agent.id, "harness");
		return {
			name: agent.id,
			kind: "local" as const,
			command: applySettingsToSeatCommand(agent.id, seated, settings),
			cwd: workspaceForAgent(hoboHome, agent.id) ?? cwd,
		};
	});
	const applied = await applyMux(planMux(session, targets), runner);
	if (!applied.ok) {
		return {
			...emptyInSessionPanes(applied.detail),
			tmux: true,
		};
	}
	await respawnStaleSeats(session, targets, runner);
	const baseWindows = await listInSessionWindows(runner, session);
	const coding = pickCodingWindow(baseWindows);
	const focused = coding
		? Math.max(
				0,
				baseWindows.findIndex((row) => row.name === coding.name),
			)
		: 0;
	const windows = await attachLeavesToWindows(
		runner,
		session,
		baseWindows,
		focused,
	);
	const focusedWindow = windows[focused];
	const focusedPane = pickFocusedLeafIndex(focusedWindow);
	const capture =
		focusedWindow?.panes?.[focusedPane]?.capture ??
		focusedWindow?.panes?.[0]?.capture ??
		"";
	return {
		session,
		windows,
		focused,
		focusedPane,
		capture,
		note:
			coding !== undefined
				? `in-session · ${coding.name} · Enter attach in TV · [ ] panes`
				: applied.detail,
		tmux: true,
	};
}

async function attachLeavesToWindows(
	runner: MuxRunner,
	session: string,
	windows: readonly InSessionWindow[],
	focusedIndex: number,
): Promise<readonly InSessionWindow[]> {
	const out: InSessionWindow[] = [];
	for (const [index, window] of windows.entries()) {
		if (index !== focusedIndex) {
			out.push(window);
			continue;
		}
		const panes = await listWindowPaneLeaves(runner, session, window.name);
		if (panes.length === 0) {
			out.push(window);
			continue;
		}
		const active = panes.find((row) => row.active) ?? first(panes);
		out.push({
			...window,
			target: active.id,
			panes,
		});
	}
	return out;
}

function pickFocusedLeafIndex(window: InSessionWindow | undefined): number {
	if (!window?.panes || window.panes.length === 0) return 0;
	const active = window.panes.findIndex((row) => row.active);
	return active >= 0 ? active : 0;
}

function joinHoboHome(userHome: string): string {
	return userHome.length > 0 ? join(userHome, ".hobo") : ".hobo";
}

/**
 * applyMux is idempotent and will not restart a window that already exists
 * but whose CLI crashed (Codex app-server conflict). Kill + recreate those.
 */
async function respawnStaleSeats(
	session: string,
	targets: readonly MuxTarget[],
	runner: MuxRunner,
): Promise<void> {
	for (const target of targets) {
		const name = safeWindowName(target.name);
		const win = `${session}:${name}`;
		const capture = await captureInSessionPane(runner, win, 40);
		if (!isStaleSeatCapture(capture)) continue;
		await runner.run(["kill-window", "-t", win]);
		await runner.run([
			"new-window",
			"-d",
			"-t",
			sessionTarget(session),
			"-n",
			name,
			targetCommand(target),
		]);
	}
}

export async function refreshInSessionPanes(
	current: InSessionPanes,
	runner: MuxRunner,
): Promise<InSessionPanes> {
	if (!current.tmux || current.windows.length === 0) return current;
	const windows = await attachLeavesToWindows(
		runner,
		current.session,
		current.windows.map((row) => ({
			name: row.name,
			target: row.target,
			kind: row.kind,
		})),
		current.focused,
	);
	const window = windows[current.focused] ?? windows[0];
	if (!window) return current;
	let focusedPane = current.focusedPane ?? 0;
	if (window.panes && window.panes.length > 0) {
		focusedPane = Math.max(0, Math.min(focusedPane, window.panes.length - 1));
	} else {
		focusedPane = 0;
	}
	const capture =
		window.panes?.[focusedPane]?.capture ??
		window.panes?.[0]?.capture ??
		(await captureInSessionPane(runner, window.target));
	return { ...current, windows, focusedPane, capture };
}

/** Select a leaf pane inside the focused window (herdr focus). */
export async function focusInSessionLeaf(
	current: InSessionPanes,
	runner: MuxRunner,
	paneIndex: number,
): Promise<InSessionPanes> {
	const window = current.windows[current.focused];
	if (!window?.panes || window.panes.length === 0) return current;
	const next = Math.max(0, Math.min(paneIndex, window.panes.length - 1));
	const leaf = window.panes[next];
	if (!leaf) return current;
	await runner.run(["select-pane", "-t", leaf.id]);
	return refreshInSessionPanes(
		{ ...current, focusedPane: next, capture: "" },
		runner,
	);
}

export function cycleInSessionWindow(
	current: InSessionPanes,
	delta: 1 | -1,
): InSessionPanes {
	if (current.windows.length === 0) return current;
	const next =
		(current.focused + delta + current.windows.length) % current.windows.length;
	return { ...current, focused: next, focusedPane: 0, capture: "" };
}

/** Cycle leaf panes inside the focused window when it is split. */
export function cycleInSessionLeaf(
	current: InSessionPanes,
	delta: 1 | -1,
): InSessionPanes {
	const window = current.windows[current.focused];
	const panes = window?.panes;
	if (!panes || panes.length <= 1) return cycleInSessionWindow(current, delta);
	const focusedPane = current.focusedPane ?? 0;
	const next = (focusedPane + delta + panes.length) % panes.length;
	return {
		...current,
		focusedPane: next,
		capture: panes[next]?.capture ?? "",
	};
}
