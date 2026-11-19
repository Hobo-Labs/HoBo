import { relative, resolve, sep } from "node:path";
import { watch } from "chokidar";
import { runCodegen } from "../codegen/run-codegen.js";

const IGNORED_DIRECTORIES = new Set([
	".git",
	".cache",
	"node_modules",
	"coverage",
	"dist",
]);
const SOURCE_EXTENSION = /\.(?:[cm]?[jt]sx?|json|wit)$/i;
const DEBOUNCE_MS = 150;

function ignoredPath(projectDir: string, path: string): boolean {
	const parts = relative(projectDir, path).split(sep);
	if (parts.some((part) => IGNORED_DIRECTORIES.has(part))) return true;
	if (parts[0]?.startsWith(".hobo-codegen")) return true;
	if (parts[0] === ".hobo" && parts.length > 1 && parts[1] !== "sources")
		return true;
	return parts[0] === "src" && parts[1] === "_generated";
}

export async function watchCodegen(options: {
	readonly projectDir: string;
	readonly emitProgress: (message: string) => void;
	readonly generate?: (
		projectDir: string,
	) => Promise<{ readonly written: readonly string[] }>;
}): Promise<{ close(): Promise<void> }> {
	const projectDir = resolve(options.projectDir);
	const emit = options.emitProgress;
	const pending = new Set<string>();
	let timer: ReturnType<typeof setTimeout> | undefined;
	let running: Promise<void> | undefined;
	let closed = false;
	const watcher = watch(projectDir, {
		ignored: (path) => ignoredPath(projectDir, path),
		ignoreInitial: true,
		followSymlinks: false,
	});

	const schedule = () => {
		if (timer !== undefined) clearTimeout(timer);
		timer = setTimeout(() => {
			timer = undefined;
			void flush();
		}, DEBOUNCE_MS);
	};
	const flush = async () => {
		if (closed || running !== undefined || pending.size === 0) return;
		const changed = [...pending].sort();
		pending.clear();
		running = (async () => {
			try {
				const result = await (
					options.generate ??
					((projectRoot) => runCodegen({ projectRoot, check: false }))
				)(projectDir);
				emit(
					`hobo dev: codegen wrote ${result.written.length} files after changes to ${changed.join(", ")}`,
				);
			} catch (error) {
				emit(
					`hobo dev: codegen failed: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		})();
		await running;
		running = undefined;
		if (!closed && pending.size > 0 && timer === undefined) schedule();
	};

	watcher.on("all", (event, path) => {
		if (closed || !["add", "change", "unlink"].includes(event)) return;
		if (!SOURCE_EXTENSION.test(path) || ignoredPath(projectDir, path)) return;
		pending.add(relative(projectDir, path));
		schedule();
	});

	try {
		await new Promise<void>((resolveReady, reject) => {
			watcher.once("error", reject);
			watcher.once("ready", () => {
				watcher.off("error", reject);
				resolveReady();
			});
		});
	} catch (error) {
		await watcher.close();
		emit(
			`hobo dev: codegen watch unavailable: ${error instanceof Error ? error.message : String(error)}`,
		);
		return { close: async () => {} };
	}
	watcher.on("error", (error) => {
		emit(
			`hobo dev: codegen watch error: ${error instanceof Error ? error.message : String(error)}`,
		);
	});

	return {
		async close() {
			closed = true;
			if (timer !== undefined) clearTimeout(timer);
			await watcher.close();
			await running;
		},
	};
}
