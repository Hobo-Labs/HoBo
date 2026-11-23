import ts from "typescript";

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
