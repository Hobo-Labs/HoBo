import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type WorkspaceBuild = (
	root: string,
	args: readonly string[],
	signal: AbortSignal,
) => Promise<number>;

export const SOURCE_WORKSPACE_BUILD_ARGS = Object.freeze([
	"run",
	"build",
	"--filter=@hobo/hobo^...",
	"--output-logs=errors-only",
]);

function turboAt(root: string): string {
	return path.join(root, "node_modules", ".bin", "turbo");
}

export function sourceWorkspaceRoot(entryUrl: string): string | undefined {
	const entry = fileURLToPath(entryUrl);
	if (path.extname(entry) !== ".ts") return undefined;
	const root = path.resolve(path.dirname(entry), "..", "..", "..", "..");
	return existsSync(path.join(root, "turbo.json")) && existsSync(turboAt(root))
		? root
		: undefined;
}

export const turboBuild: WorkspaceBuild = (root, args, signal) =>
	new Promise((resolve) => {
		const child = spawn(turboAt(root), [...args], {
			cwd: root,
			env: { ...process.env, TURBO_TELEMETRY_DISABLED: "1" },
			stdio: ["ignore", process.stderr, process.stderr],
			signal,
		});
		const stop = () => child.kill();
		process.once("exit", stop);
		const settle = (code: number) => {
			process.off("exit", stop);
			resolve(code);
		};
		child.once("error", () => settle(1));
		child.once("exit", (code) => settle(code ?? 1));
	});

export async function prepareSourceWorkspace(
	entryUrl: string,
	signal: AbortSignal,
	build: WorkspaceBuild = turboBuild,
): Promise<void> {
	const root = sourceWorkspaceRoot(entryUrl);
	if (root === undefined) return;
	const code = await build(root, SOURCE_WORKSPACE_BUILD_ARGS, signal);
	if (signal.aborted)
		throw new Error(
			"the host closed the connection while the workspace was building",
		);
	if (code !== 0)
		throw new Error(
			`building the workspace packages @hobo/hobo imports failed (turbo exit ${code}); run pnpm install, then pnpm exec turbo ${SOURCE_WORKSPACE_BUILD_ARGS.join(" ")} in ${root}`,
		);
}
