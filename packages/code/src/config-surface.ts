/**
 * Unified configuration / setup inventory for persona stack critique.
 * Discovers env + flags that matter to CLI-native, cost, hermetic, auth,
 * editor, harness, and remote stacks — never prints secret values.
 */

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// public-contract: config inventory schema
export const CODE_CONFIG_SCHEMA = "hobo.code.config/v1" as const;

export type ConfigStackId =
	| "core"
	| "auth"
	| "models-byok"
	| "cost-budget"
	| "hermetic-nix"
	| "isolation"
	| "remote-attach"
	| "editor-vim"
	| "harness-pi-flue"
	| "chrome-dense"
	| "monetization"
	| "agent-native";

export type ConfigKnob = {
	readonly name: string;
	readonly kind: "env" | "flag" | "file" | "feature-flag";
	readonly stacks: readonly ConfigStackId[];
	readonly purpose: string;
	readonly example?: string;
	readonly secret: boolean;
	readonly present: boolean;
	readonly valueHint: string | null;
};

export type ConfigSurfaceStatus = {
	readonly schema: typeof CODE_CONFIG_SCHEMA;
	readonly knobs: readonly ConfigKnob[];
	readonly byStack: Readonly<Record<ConfigStackId, readonly ConfigKnob[]>>;
	readonly setupChecklist: readonly string[];
	readonly missingCritical: readonly string[];
	readonly legend: string;
	readonly notes: readonly string[];
};

type DetectResult = { present: boolean; valueHint: string | null };

type KnobDef = {
	readonly name: string;
	readonly kind: ConfigKnob["kind"];
	readonly stacks: readonly ConfigStackId[];
	readonly purpose: string;
	readonly example?: string;
	readonly secret: boolean;
	readonly detect?: (env: NodeJS.ProcessEnv, cwd: string) => DetectResult;
};

function envPresent(env: NodeJS.ProcessEnv, name: string): DetectResult {
	const v = env[name];
	const present = Boolean(v && String(v).length > 0);
	return { present, valueHint: present ? "set" : null };
}

function secretPresent(env: NodeJS.ProcessEnv, name: string): DetectResult {
	const v = env[name];
	const present = Boolean(v && String(v).length > 0);
	return { present, valueHint: present ? "present (secret)" : null };
}

function whichOnPath(env: NodeJS.ProcessEnv, bin: string): boolean {
	const pathEnv = env.PATH ?? "";
	for (const dir of pathEnv.split(":")) {
		if (dir && existsSync(join(dir, bin))) return true;
	}
	return false;
}

function walkHas(cwd: string, rels: readonly string[]): DetectResult {
	let dir = cwd;
	for (let i = 0; i < 8; i++) {
		for (const rel of rels) {
			const p = join(dir, rel);
			if (existsSync(p)) return { present: true, valueHint: p };
		}
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return { present: false, valueHint: null };
}

const KNOB_DEFS: readonly KnobDef[] = [
	{
		name: "HOBO_HOME",
		kind: "env",
		stacks: ["core", "hermetic-nix", "isolation", "auth", "agent-native"],
		purpose: "Durable home (auth, sandboxes, handbacks, worlds)",
		example: "$HOME/.hobo or $XDG_STATE_HOME/hobo",
		secret: false,
	},
	{
		name: "HOBO_CODE_AGENT",
		kind: "env",
		stacks: ["agent-native", "auth", "core"],
		purpose:
			"Unattended agent contract (no elicitation; prefer human-free auth)",
		example: "1",
		secret: false,
	},
	{
		name: "HOBO_CODE_NO_ELICITATION",
		kind: "env",
		stacks: ["agent-native"],
		purpose: "Alias for agent no-prompt contract",
		example: "1",
		secret: false,
	},
	{
		name: "HOBO_CODE_SESSION_REF",
		kind: "env",
		stacks: ["agent-native", "auth"],
		purpose: "Pre-bound session ref for human-free auth (value never shown)",
		secret: true,
	},
	{
		name: "HOBO_CODE_AGENT_TOKEN",
		kind: "env",
		stacks: ["agent-native", "auth"],
		purpose: "Optional agent workload token presence (value never shown)",
		secret: true,
	},
	{
		name: "HOBO_CODE_DENSE",
		kind: "env",
		stacks: ["chrome-dense", "core"],
		// SAFETY: parsed or fixture value is the named domain type after this assertion.
		purpose: "Force dense glyph chrome (same as --dense)",
		example: "1",
		secret: false,
	},
	{
		name: "HOBO_CODE_MODEL",
		kind: "env",
		stacks: ["models-byok", "cost-budget", "harness-pi-flue"],
		purpose: "Active provider/model for Pi/Flue harness",
		example: "ollama/qwen2.5-coder:7b or anthropic/claude-sonnet-4-6",
		secret: false,
	},
	{
		name: "OPENAI_API_KEY",
		kind: "env",
		stacks: ["models-byok", "cost-budget"],
		purpose: "BYOK OpenAI-compatible (value never shown)",
		secret: true,
	},
	{
		name: "ANTHROPIC_API_KEY",
		kind: "env",
		stacks: ["models-byok", "cost-budget"],
		purpose: "BYOK Anthropic (value never shown)",
		secret: true,
	},
	{
		name: "OPENAI_BASE_URL",
		kind: "env",
		stacks: ["models-byok", "cost-budget"],
		purpose:
			"Local OpenAI-compatible endpoint (Ollama/LM Studio/OrnithAI-class)",
		example: "http://127.0.0.1:11434/v1",
		secret: false,
	},
	{
		name: "OLLAMA_HOST",
		kind: "env",
		stacks: ["models-byok", "cost-budget"],
		purpose: "Ollama host for free-local models",
		example: "http://127.0.0.1:11434",
		secret: false,
	},
	{
		name: "HOBO_CODE_LOCAL_BASE_URL",
		kind: "env",
		stacks: ["models-byok", "cost-budget"],
		purpose: "Edge/local base URL for free-local routing",
		secret: false,
	},
	{
		name: "HOBO_CODE_BUDGET_USD",
		kind: "env",
		stacks: ["cost-budget"],
		purpose: "Inference spend cap (shown by hobo-code cost)",
		example: "0 or 5",
		secret: false,
	},
	{
		name: "HOBO_CODE_ROUTING",
		kind: "env",
		stacks: ["cost-budget", "models-byok"],
		purpose: "Model routing policy",
		example: "cheapest-capable | pinned | fallback-chain",
		secret: false,
	},
	{
		name: "HOBO_CODE_MONETIZATION",
		kind: "env",
		stacks: ["cost-budget", "monetization"],
		purpose: "Sponsored wait / monetization surface (0 = off)",
		example: "0",
		secret: false,
	},
	{
		name: "HOBO_CODE_SECURE_SANDBOX",
		kind: "env",
		stacks: ["isolation", "harness-pi-flue"],
		purpose: "Secure sandbox stack (0 disables for local debug)",
		example: "0",
		secret: false,
	},
	{
		name: "HOBO_CODE_SEAT_AGENTS",
		kind: "env",
		stacks: ["harness-pi-flue", "agent-native"],
		purpose:
			"Seat the agent CLIs found on PATH in tmux, from the shell's panes and mux (0, false, no or off: no seats, no tmux session)",
		example: "0",
		secret: false,
	},
	{
		name: "HOBO_RIFT",
		kind: "env",
		stacks: ["isolation"],
		purpose: "Prefer CoW rift isolation when platform supports",
		example: "1",
		secret: false,
	},
	{
		name: "HOBO_RIFT_COW",
		kind: "env",
		stacks: ["isolation"],
		purpose: "Confirm CoW capability for rift",
		example: "1",
		secret: false,
	},
	{
		name: "EDITOR",
		kind: "env",
		stacks: ["editor-vim", "core"],
		purpose: "Fallback editor for hobo-code edit ($EDITOR)",
		example: "nvim",
		secret: false,
		detect: (env) => {
			const v = env.EDITOR || env.VISUAL;
			return {
				present: Boolean(v && String(v).length > 0),
				valueHint: v ? String(v).slice(0, 40) : null,
			};
		},
	},
	{
		name: "nvim|vim|tmux PATH",
		kind: "env",
		stacks: ["editor-vim", "remote-attach"],
		purpose: "CLI-native tools for edit bridge + attach workflows",
		secret: false,
		detect: (env) => {
			const found = ["nvim", "vim", "tmux"].filter((b) => whichOnPath(env, b));
			return {
				present: found.length > 0,
				valueHint: found.length ? found.join("+") : "missing nvim/vim/tmux",
			};
		},
	},
	{
		name: "HOBO_TENANT",
		kind: "env",
		stacks: ["auth", "remote-attach", "core"],
		purpose: "Soft multi-tenant context for named endpoints / Station",
		secret: false,
	},
	{
		name: "HOBO_PROJECT",
		kind: "env",
		stacks: ["auth", "remote-attach", "core"],
		purpose: "Project id for named endpoints",
		secret: false,
	},
	{
		name: "IN_NIX_SHELL",
		kind: "env",
		stacks: ["hermetic-nix"],
		purpose: "Hermetic shell marker (nix-shell / nix develop)",
		secret: false,
	},
	{
		name: "DEVENV_ROOT",
		kind: "env",
		stacks: ["hermetic-nix"],
		purpose: "devenv active root",
		secret: false,
	},
	{
		name: "DIRENV_DIR",
		kind: "env",
		stacks: ["hermetic-nix"],
		purpose: "direnv active directory",
		secret: false,
	},
	{
		name: "devenv.nix|flake.nix",
		kind: "file",
		stacks: ["hermetic-nix"],
		purpose: "Optional hermetic project markers (never required monorepo IaC)",
		secret: false,
		detect: (_env, cwd) => {
			const present =
				existsSync(join(cwd, "devenv.nix")) ||
				existsSync(join(cwd, "flake.nix"));
			return {
				present,
				valueHint: present ? "hermetic markers in cwd" : null,
			};
		},
	},
	{
		name: ".mcp.json",
		kind: "file",
		stacks: ["harness-pi-flue", "core", "agent-native"],
		purpose: "MCP servers (Serena, headroom, gbrain) for agent tooling",
		secret: false,
		detect: (_env, cwd) => walkHas(cwd, [".mcp.json", ".cursor/mcp.json"]),
	},
	{
		name: "AGENTS.md|.agents/skills",
		kind: "file",
		stacks: ["harness-pi-flue", "core"],
		purpose: "Repo agent conventions + skills roots",
		secret: false,
		detect: (_env, cwd) => walkHas(cwd, ["AGENTS.md", ".agents/skills"]),
	},
	{
		name: "editor/hobo-code.nvim",
		kind: "file",
		stacks: ["editor-vim"],
		purpose: "Neovim managed-pane bridge extension",
		secret: false,
		detect: () => {
			try {
				const here = dirname(fileURLToPath(import.meta.url));
				const p = join(
					here,
					"..",
					"editor/hobo-code.nvim/lua/hobo-code/init.lua",
				);
				return {
					present: existsSync(p),
					valueHint: existsSync(p)
						? "packages/code/editor/hobo-code.nvim"
						: null,
				};
			} catch {
				return { present: false, valueHint: null };
			}
		},
	},
	{
		name: "code.harness.enabled",
		kind: "feature-flag",
		stacks: ["harness-pi-flue", "isolation"],
		purpose: "OpenFeature master switch for harness (session/dispatch)",
		secret: false,
		detect: () => ({ present: true, valueHint: "default ON" }),
	},
	{
		name: "code.distributed",
		kind: "feature-flag",
		stacks: ["core", "isolation"],
		purpose: "Multi-node compute dispatch (internal)",
		secret: false,
		detect: () => ({ present: true, valueHint: "default ON" }),
	},
	{
		name: "--home|--cwd|--dense|--json",
		kind: "flag",
		stacks: ["core", "chrome-dense", "hermetic-nix"],
		purpose:
			"Universal CLI flags for home, project root, dense, machine output",
		example: "hobo-code env --cwd . --home /tmp/h --json",
		secret: false,
		detect: () => ({ present: true, valueHint: "always available" }),
	},
];

const STACK_ORDER: ConfigStackId[] = [
	"core",
	"auth",
	"agent-native",
	"models-byok",
	"cost-budget",
	"hermetic-nix",
	"isolation",
	"remote-attach",
	"editor-vim",
	"harness-pi-flue",
	"chrome-dense",
	"monetization",
];

export function inspectConfigSurface(
	env: NodeJS.ProcessEnv = process.env,
	cwd: string = process.cwd(),
): ConfigSurfaceStatus {
	const knobs: ConfigKnob[] = KNOB_DEFS.map((d) => {
		const det = d.detect
			? d.detect(env, cwd)
			: d.secret
				? secretPresent(env, d.name)
				: envPresent(env, d.name);
		return {
			name: d.name,
			kind: d.kind,
			stacks: d.stacks,
			purpose: d.purpose,
			...(d.example !== undefined ? { example: d.example } : undefined),
			secret: d.secret,
			present: det.present,
			valueHint: det.valueHint,
		};
	});

	// SAFETY: parsed or fixture value is the named domain type after this assertion.
	const byStack = {} as Record<ConfigStackId, ConfigKnob[]>;
	for (const s of STACK_ORDER) byStack[s] = [];
	for (const k of knobs) {
		for (const s of k.stacks) {
			const bucket = byStack[s] ?? [];
			byStack[s] = bucket;
			bucket.push(k);
		}
	}

	const setupChecklist = [
		"export HOBO_HOME=$HOME/.hobo   # durable outside Nix store if hermetic",
		"hobo-code auth login           # Station identity",
		"export HOBO_CODE_MODEL=…       # or free-local ollama/… + mon=0",
		"hobo-code config               # this inventory",
		"hobo-code env --json           # hermetic markers",
		"hobo-code cost                 # budget + $0 path",
		"hobo-code harness              # Pi/Flue + skills",
		"hobo-code agent --json         # MCP/ACP + human-free auth",
		"hobo-code edit --help          # nvim bridge",
	];

	// Recommended (not hard-required) setup gaps personas score as friction.
	const missingCritical: string[] = [];
	const byName = new Map(knobs.map((k) => [k.name, k]));
	const tip = (name: string, msg: string) => {
		const k = byName.get(name);
		if (k && !k.present) missingCritical.push(msg);
	};
	const hasModelPath =
		Boolean(byName.get("HOBO_CODE_MODEL")?.present) ||
		Boolean(byName.get("OPENAI_BASE_URL")?.present) ||
		Boolean(byName.get("OLLAMA_HOST")?.present) ||
		Boolean(byName.get("HOBO_CODE_LOCAL_BASE_URL")?.present) ||
		Boolean(byName.get("OPENAI_API_KEY")?.present) ||
		Boolean(byName.get("ANTHROPIC_API_KEY")?.present);
	if (!hasModelPath) {
		missingCritical.push(
			"no model path yet — HOBO_CODE_MODEL, free-local OLLAMA_HOST/OPENAI_BASE_URL, or BYOK key (values never printed)",
		);
	}
	tip(
		"HOBO_CODE_MONETIZATION",
		"set HOBO_CODE_MONETIZATION=0 to disable sponsored wait",
	);
	tip(
		"nvim|vim|tmux PATH",
		"install nvim (or vim) + tmux on PATH for edit/attach stacks",
	);
	tip("EDITOR", "export EDITOR=nvim (or VISUAL) for edit fallback");
	tip(
		"AGENTS.md|.agents/skills",
		"repo AGENTS.md / .agents/skills for harness skills",
	);

	return {
		schema: CODE_CONFIG_SCHEMA,
		knobs,
		// SAFETY: parsed or fixture value is the named domain type after this assertion.
		byStack: byStack as ConfigSurfaceStatus["byStack"],
		setupChecklist,
		missingCritical,
		legend: "config · env · stacks · setup",
		notes: [
			"Never prints secret values — only presence for API keys.",
			"Stack tags map to personas: cost-budget, editor-vim, hermetic-nix, harness-pi-flue, …",
			"Feature flags resolve via OpenFeature memory port defaults (ON).",
			"Use --stack <id> to filter; --json for full inventory.",
			"missingCritical = recommended setup gaps (soft), not hard failures.",
		],
	};
}

export function configHumanSummary(
	status: ConfigSurfaceStatus,
	stackFilter?: ConfigStackId | null,
): string {
	const stacks: ConfigStackId[] = stackFilter
		? [stackFilter]
		: [
				"core",
				"agent-native",
				"models-byok",
				"cost-budget",
				"editor-vim",
				"harness-pi-flue",
				"hermetic-nix",
			];

	const lines: string[] = [
		`setup · ${status.setupChecklist.length} tips · ${status.legend}`,
	];
	for (const s of stacks) {
		const ks = status.byStack[s] ?? [];
		if (ks.length === 0) continue;
		const bits = ks
			.slice(0, 6)
			.map((k) => `${k.present ? "●" : "○"}${shortName(k.name)}`)
			.join(" ");
		lines.push(`${s} · ${bits}`);
	}
	if (status.missingCritical.length > 0) {
		lines.push(`gaps · ${status.missingCritical.slice(0, 3).join(" · ")}`);
	} else {
		lines.push("gaps · none (recommended knobs look set)");
	}
	lines.push("filter · hobo-code config --stack cost-budget|editor-vim|…");
	lines.push("full · hobo-code config --json");
	return lines.join("\n");
}

function shortName(name: string): string {
	if (name.length <= 18) return name;
	if (name.includes("API_KEY")) return name.replace(/_API_KEY$/, "_KEY");
	return `${name.slice(0, 16)}…`;
}

export const CONFIG_STACK_IDS: readonly ConfigStackId[] = STACK_ORDER;

export function isConfigStackId(s: string): s is ConfigStackId {
	// SAFETY: parsed or fixture value is the named domain type after this assertion.
	return (STACK_ORDER as readonly string[]).includes(s);
}
