import { createHash, randomUUID } from "node:crypto";
import {
	chmod,
	mkdir,
	readdir,
	readFile,
	realpath,
	rename,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";

const IGNORED_DIRECTORIES = new Set([".git", "node_modules", ".cache"]);

function temporary(name: string): boolean {
	return (
		/\.(?:tmp|temp|swp|swo|log|bak)$/iu.test(name) ||
		name.endsWith("~") ||
		name.startsWith(".#")
	);
}

type LocalDeploymentFingerprint = `sha256:${string}`;

export function isLocalDeploymentFingerprint(
	value: string,
): value is LocalDeploymentFingerprint {
	return /^sha256:[a-f0-9]{64}$/u.test(value);
}

async function walkLocalDeploymentInputs(
	projectDir: string,
	hoboHome: string,
	visitor: {
		readonly directory?: (path: string) => Promise<void>;
		readonly file: (
			path: string,
			bytes: Buffer,
			mode: number,
		) => Promise<void> | void;
	},
): Promise<LocalDeploymentFingerprint> {
	const project = resolve(projectDir);
	const home = resolve(hoboHome);
	if (project === home)
		throw new Error(
			"HOBO_HOME must be separate from the application project directory",
		);
	const hash = createHash("sha256");
	const ancestors = new Set<string>();
	async function visit(directory: string): Promise<void> {
		const actual = await realpath(directory);
		if (ancestors.has(actual))
			throw new Error(`Circular deployment input directory: ${directory}`);
		ancestors.add(actual);
		try {
			const entries = await readdir(directory, { withFileTypes: true });
			entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
			for (const entry of entries) {
				const file = join(directory, entry.name);
				const path = relative(project, file).split(sep).join("/");
				const generated = /^\.hobo\/(?:build|generated)(?:\/|$)/u.test(path);
				if (
					!generated &&
					(IGNORED_DIRECTORIES.has(entry.name) ||
						temporary(entry.name) ||
						entry.name === ".hobo-codegen.lock" ||
						entry.name.startsWith(".hobo-codegen-"))
				)
					continue;
				if (resolve(file) === home) continue;
				if (path.startsWith(".hobo/") && !generated) continue;
				const info = await stat(file);
				if (info.isDirectory()) {
					await visitor.directory?.(path);
					await visit(file);
				} else if (info.isFile()) {
					const bytes = await readFile(file);
					hash.update(JSON.stringify([path, bytes.length, info.mode & 0o555]));
					hash.update(bytes);
					await visitor.file(path, bytes, info.mode & 0o777);
				} else throw new Error(`Unsupported deployment input: ${path}`);
			}
		} finally {
			ancestors.delete(actual);
		}
	}
	await visit(project);
	return `sha256:${hash.digest("hex")}`;
}

export async function fingerprintLocalDeployment(
	projectDir: string,
	hoboHome: string,
): Promise<`sha256:${string}`> {
	return walkLocalDeploymentInputs(projectDir, hoboHome, {
		file: () => {},
	});
}

export function localDeploymentSnapshotDirectory(
	projectDir: string,
	fingerprint: LocalDeploymentFingerprint,
): string {
	if (!isLocalDeploymentFingerprint(fingerprint))
		throw new Error("Invalid local deployment fingerprint");
	return join(
		resolve(projectDir),
		".hobo",
		"local-deployment-work",
		fingerprint.slice("sha256:".length),
	);
}

export async function materializeLocalDeploymentSnapshot(
	projectDir: string,
	hoboHome: string,
	expectedFingerprint: LocalDeploymentFingerprint,
): Promise<string> {
	const destination = localDeploymentSnapshotDirectory(
		projectDir,
		expectedFingerprint,
	);
	try {
		const existing = await fingerprintLocalDeployment(destination, hoboHome);
		if (existing !== expectedFingerprint)
			throw new Error("Approved local deployment snapshot is corrupted");
		return destination;
	} catch (error) {
		if (!(error instanceof Error && "code" in error && error.code === "ENOENT"))
			throw error;
	}

	const parent = join(resolve(projectDir), ".hobo", "local-deployment-work");
	await mkdir(parent, { recursive: true });
	const temporaryDirectory = `${destination}.${randomUUID()}.tmp`;
	await mkdir(temporaryDirectory);
	try {
		const actualFingerprint = await walkLocalDeploymentInputs(
			projectDir,
			hoboHome,
			{
				directory: async (path) => {
					const directory = join(temporaryDirectory, path);
					await mkdir(directory);
				},
				file: async (path, bytes, mode) => {
					const file = join(temporaryDirectory, path);
					await writeFile(file, bytes, { mode });
					await chmod(file, mode & 0o555);
				},
			},
		);
		if (actualFingerprint !== expectedFingerprint)
			throw new Error(
				"Local project inputs changed while creating the approved execution snapshot",
			);
		try {
			await rename(temporaryDirectory, destination);
		} catch (error) {
			if (
				!(
					error instanceof Error &&
					"code" in error &&
					(error.code === "EEXIST" || error.code === "ENOTEMPTY")
				)
			)
				throw error;
			const existing = await fingerprintLocalDeployment(destination, hoboHome);
			if (existing !== expectedFingerprint)
				throw new Error("Approved local deployment snapshot is corrupted");
		}
		if (
			(await fingerprintLocalDeployment(destination, hoboHome)) !==
			expectedFingerprint
		)
			throw new Error("Approved local deployment snapshot is corrupted");
		return destination;
	} finally {
		await rm(temporaryDirectory, { recursive: true, force: true });
	}
}
