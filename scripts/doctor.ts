import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";

let failed = false;
function ok(message: string) {
	console.log(`ok  ${message}`);
}
function warn(message: string) {
	// stdout so agents/transcripts that only capture stdout still see remediation
	console.log(`warn ${message}`);
}
function fail(message: string) {
	console.error(`fail ${message}`);
	failed = true;
}
function version(command: string, args = ["--version"]) {
	const result = spawnSync(command, args, { encoding: "utf8", shell: false });
	return result.status === 0 ? result.stdout.trim() : undefined;
}
function have(command: string): boolean {
	const result = spawnSync("bash", ["-lc", `command -v ${command}`], {
		encoding: "utf8",
		shell: false,
	});
	return result.status === 0 && Boolean(result.stdout?.trim());
}

const nodeMajor = Number(process.versions.node.split(".")[0]);
if (nodeMajor >= 20) ok(`Node ${process.versions.node}`);
else fail(`Node ${process.versions.node}; expected >=20`);
const pnpm = version("pnpm");
if (pnpm) ok(`pnpm ${pnpm}`);
else if (process.env.npm_config_user_agent?.startsWith("pnpm/"))
	ok(`pnpm available (${process.env.npm_config_user_agent.split(" ")[0]})`);
else
	fail(
		"pnpm not available; run bash scripts/bootstrap-dev.sh --project-only && pnpm run install:check",
	);
if (existsSync("mise.toml")) ok("mise.toml present");
else fail("mise.toml missing; run bash scripts/bootstrap-dev.sh");
if (existsSync("mise.lock")) ok("mise.lock present");
else warn("mise.lock missing; run mise lock");
if (version("mise")) ok(`mise ${version("mise")}`);
else warn("mise not on PATH; run bash scripts/bootstrap-dev.sh");
if (version("corepack"))
	ok("Corepack available (optional when using mise pnpm)");
else ok("Corepack not required when pnpm is provisioned via mise");
if (existsSync("pnpm-lock.yaml")) ok("pnpm-lock.yaml present");
else fail("pnpm-lock.yaml missing");
if (existsSync("pnpm-workspace.yaml")) ok("pnpm-workspace.yaml present");
else fail("pnpm-workspace.yaml missing");
if (existsSync("turbo.json")) ok("turbo.json present");
else fail("turbo.json missing");
if (existsSync("contracts/data-models"))
	fail(
		"central contracts/data-models is forbidden; move CUE-backed data models into the owning project/package",
	);
else ok("no central data-model catalog present");
if (existsSync("AGENTS.md")) ok("root AGENTS.md present");
else fail("root AGENTS.md missing");
if (existsSync("node_modules")) {
	ok("node_modules present");
	try {
		const require = createRequire(import.meta.url);
		require.resolve("tsx");
		ok("tsx resolvable");
	} catch {
		fail("tsx not resolvable; run: pnpm install");
	}
} else {
	fail("node_modules missing");
	console.error(
		"next  bash scripts/bootstrap-dev.sh --project-only && pnpm run install:check",
	);
	console.error(
		"hint  Install once so agent:check and other tsx scripts can run.",
	);
}

// Agent experience (AX): zero-key setup surface + fail-closed MCP wiring.
// Missing optional binaries are warnings (common on cold clones before setup).
if (existsSync("AUTH.md"))
	ok("AUTH.md present (WorkOS auth.md protocol + residual local tooling keys)");
else
	fail(
		"AUTH.md missing — WorkOS auth.md standing auth surface for agents (https://workos.com/auth-md)",
	);
if (existsSync("scripts/setup-agent-tools.sh")) {
	const help = spawnSync("bash", ["scripts/setup-agent-tools.sh", "--help"], {
		encoding: "utf8",
		shell: false,
	});
	if (help.status === 0 && /--no-gbrain|AUTH\.md/i.test(help.stdout ?? "")) {
		ok("setup-agent-tools.sh --help (zero-key flags)");
	} else {
		fail("setup-agent-tools.sh --help failed or omitted zero-key flags");
	}
} else fail("scripts/setup-agent-tools.sh missing");
if (existsSync(".mcp.json")) ok(".mcp.json present (Claude Code MCP)");
else fail(".mcp.json missing");
if (existsSync(".cursor/mcp.json")) ok(".cursor/mcp.json present (Cursor MCP)");
else warn(".cursor/mcp.json missing");
if (existsSync(".codex/config.toml"))
	ok(".codex/config.toml present (Codex MCP template)");
else warn(".codex/config.toml missing");
for (const launcher of [
	"scripts/agent-mcp-serena.sh",
	"scripts/agent-mcp-headroom.sh",
	"scripts/agent-mcp-gbrain.sh",
] as const) {
	if (existsSync(launcher)) ok(`${launcher} present`);
	else fail(`${launcher} missing (fail-closed MCP launcher)`);
}
// Optional PATH tools: warn only — install via setup --common-only --no-gbrain
for (const bin of ["serena", "headroom", "rtk", "tgrep"] as const) {
	if (have(bin)) ok(`${bin} on PATH`);
	else
		warn(
			`${bin} not on PATH — bash scripts/setup-agent-tools.sh --common-only --no-gbrain`,
		);
}
if (have("gbrain"))
	ok(
		"gbrain on PATH (opt-in; needs an initialized embedding provider — AUTH.md)",
	);
else
	warn(
		"gbrain not on PATH (ok for zero-key) — decline gbrain MCP, or stay zero-key: bash scripts/setup-agent-tools.sh --common-only --no-gbrain  (see AUTH.md; enable later: Bun + setup without --no-gbrain, then gbrain init)",
	);

process.exit(failed ? 1 : 0);
