import ts from "typescript";

/**
 * The syntactic and semantic diagnostics codegen reports: those of the files
 * `isSource` selects, plus any that belong to no file.
 *
 * `program.getSemanticDiagnostics()` with no file type-checks every file in
 * the program, the lib and `@types` declarations included, and codegen threw
 * all of those away. Asking per source file checks only what the sources
 * reach. The checker still surfaces a file-less (global) diagnostic with the
 * first file whose check produced it, so those are kept as before.
 */
export function sourceDiagnostics(
	program: ts.Program,
	isSource: (fileName: string) => boolean,
): ts.Diagnostic[] {
	const sources = program
		.getSourceFiles()
		.filter((source) => isSource(source.fileName));
	const keep = (diagnostic: ts.Diagnostic) =>
		!diagnostic.file || isSource(diagnostic.file.fileName);
	return [
		...ts.sortAndDeduplicateDiagnostics(
			sources.flatMap((source) => program.getSyntacticDiagnostics(source)),
		),
		...ts.sortAndDeduplicateDiagnostics(
			sources.flatMap((source) => program.getSemanticDiagnostics(source)),
		),
	].filter(keep);
}
