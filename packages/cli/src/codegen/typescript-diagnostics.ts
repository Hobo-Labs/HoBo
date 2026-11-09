import ts from "typescript";

/**
 * The syntactic and semantic diagnostics codegen reports: those of the files
 * `isSource` selects, plus any that belong to no file.
 *
 * `program.getSemanticDiagnostics()` with no file type-checks every file in
 * the program, the lib and `@types` declarations included, and codegen threw
 * the declarations' diagnostics away. Only non-declaration files are checked
 * here. They must all be checked, tests and other non-source files included:
 * the checker reports a missing global type (TS2318, e.g. AsyncIterableIterator
 * for an async generator, Disposable for `using` under an older lib) as a
 * file-less diagnostic with the first file whose check needs it, and codegen
 * has always reported those. Declarations have no bodies, so they raise none.
 * `program.getGlobalDiagnostics()` is not added: it also holds the ones the
 * checker raises while it initialises (for example under `noLib`), which the
 * whole-program check never reported.
 */
export function sourceDiagnostics(
	program: ts.Program,
	isSource: (fileName: string) => boolean,
): ts.Diagnostic[] {
	const files = program.getSourceFiles();
	const keep = (diagnostic: ts.Diagnostic) =>
		!diagnostic.file || isSource(diagnostic.file.fileName);
	return [
		...ts.sortAndDeduplicateDiagnostics(
			files
				.filter((source) => isSource(source.fileName))
				.flatMap((source) => program.getSyntacticDiagnostics(source)),
		),
		...ts.sortAndDeduplicateDiagnostics(
			files
				.filter((source) => !source.isDeclarationFile)
				.flatMap((source) => program.getSemanticDiagnostics(source)),
		),
	].filter(keep);
}
