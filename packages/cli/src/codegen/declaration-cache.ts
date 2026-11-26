import { resolve } from "node:path";
import ts from "typescript";
import { digest } from "./text.js";

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
			const format = source.impliedNodeFormat;
			const key = `${registry.getKeyForCompilationSettings(options)}\0${format ?? ""}\0${resolve(file)}`;
			const previous = held.get(key);
			held.delete(key);
			if (previous) release(previous);
			held.set(key, {
				file,
				options,
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
