import ts from "typescript";

const renderers = [
	"drawRailTrack",
	"drawConnectionBays",
	"drawCostMeter",
	"drawErrorBunker",
	"drawBootstrap",
	"drawParticles",
] as const;

const primitives = new Set([
	"arc",
	"bezierCurveTo",
	"ellipse",
	"fill",
	"fillRect",
	"lineTo",
	"moveTo",
	"quadraticCurveTo",
	"rect",
	"roundRect",
	"stroke",
	"strokeRect",
]);

export function controlYardPropViolations(sourceText: string): string[] {
	const source = ts.createSourceFile(
		"yard-game.js",
		sourceText,
		ts.ScriptTarget.Latest,
		true,
		ts.ScriptKind.JS,
	);
	const functions = new Map<string, ts.FunctionDeclaration>();
	for (const statement of source.statements) {
		if (ts.isFunctionDeclaration(statement) && statement.name) {
			functions.set(statement.name.text, statement);
		}
	}

	return renderers.flatMap((renderer) => {
		const root = functions.get(renderer);
		if (!root?.body) return [`${renderer}: renderer is missing`];
		const visited = new Set<string>();
		const violations = new Set<string>();
		let imageRendered = false;

		const inspect = (name: string, body: ts.Block): void => {
			if (visited.has(name)) return;
			visited.add(name);
			const visit = (node: ts.Node): void => {
				if (ts.isCallExpression(node)) {
					const expression = node.expression;
					if (
						ts.isPropertyAccessExpression(expression) &&
						ts.isIdentifier(expression.expression) &&
						expression.expression.text === "ctx"
					) {
						const method = expression.name.text;
						if (method === "drawImage") imageRendered = true;
						if (primitives.has(method)) {
							const location = source.getLineAndCharacterOfPosition(
								expression.getStart(source),
							);
							violations.add(
								`${renderer} -> ${name}:${location.line + 1}:${location.character + 1} uses ctx.${method}`,
							);
						}
					}
					if (ts.isIdentifier(expression)) {
						const dependency = functions.get(expression.text);
						if (dependency?.body) inspect(expression.text, dependency.body);
					}
				}
				ts.forEachChild(node, visit);
			};
			visit(body);
		};

		inspect(renderer, root.body);
		if (!imageRendered)
			violations.add(`${renderer}: image renderer is missing`);
		return [...violations];
	});
}
