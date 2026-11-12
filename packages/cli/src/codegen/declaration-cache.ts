import { resolve } from "node:path";
import ts from "typescript";
import { digest } from "./text.js";

/**
 * Parsed declarations shared by every program codegen builds, so the lib
 * files and installed packages' `.d.ts` are parsed once rather than once per
 * program (each pass builds two). An entry is keyed by path, the settings
 * that change how a file parses and its module format; its text digest is the
 * version, so an edited file is parsed again in place. At most `limit` entries
 * are held: past it the least recently used one is released to the registry,
 * and a long-lived process that reads many projects stays bounded.
 */
export interface DeclarationCache {
	acquire(
		file: string,
		options: ts.CompilerOptions,
		text: string,
		languageVersion: ts.ScriptTarget | ts.CreateSourceFileOptions,
	): ts.SourceFile;
	readonly size: number;
}

export const DECLARATION_CACHE_LIMIT = 2048;

interface Held {
	readonly file: string;
	readonly options: ts.CompilerOptions;
	readonly scriptKind: ts.ScriptKind;
	readonly format: ts.ResolutionMode;
}

export function createDeclarationCache(
	limit = DECLARATION_CACHE_LIMIT,
): DeclarationCache {
	const registry = ts.createDocumentRegistry(
		ts.sys.useCaseSensitiveFileNames,
		ts.sys.getCurrentDirectory(),
	);
	// Insertion order is recency: a hit is moved to the end.
	const held = new Map<string, Held>();
	const release = (entry: Held) =>
		registry.releaseDocument(
			entry.file,
			entry.options,
			entry.scriptKind,
			entry.format,
		);
	return {
		get size() {
			return held.size;
		},
		acquire(file, options, text, languageVersion) {
			const source = registry.acquireDocument(
				file,
				options,
				ts.ScriptSnapshot.fromString(text),
				digest(text),
				ts.ScriptKind.TS,
				languageVersion,
			);
			// The registry files the document under the module format it was parsed for.
			const format = source.impliedNodeFormat;
			const key = `${registry.getKeyForCompilationSettings(options)}\0${format ?? ""}\0${resolve(file)}`;
			const previous = held.get(key);
			held.delete(key);
			// One registry reference per held entry: drop the one taken before.
			if (previous) release(previous);
			held.set(key, {
				file,
				options,
				// Every declaration (.d.ts, .d.mts, .d.cts, lib.*.d.ts) is a TS script.
				scriptKind: ts.ScriptKind.TS,
				format,
			});
			for (const [oldest, entry] of held) {
				if (held.size <= limit) break;
				held.delete(oldest);
				release(entry);
			}
			return source;
		},
	};
}
