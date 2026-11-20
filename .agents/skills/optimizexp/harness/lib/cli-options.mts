export function normalizeCliOptions(
	argv: readonly string[],
	options: {
		values: readonly string[];
		flags: readonly string[];
		inlineValues?: readonly string[];
		allowEmptyValues?: readonly string[];
	},
): { argv: string[]; positionals: string[]; error?: string } {
	const result: string[] = [];
	const positionals: string[] = [];
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i]!;
		if (!arg.startsWith("-")) {
			result.push(arg);
			positionals.push(arg);
			continue;
		}
		const equals = arg.indexOf("=");
		const name = equals > 0 ? arg.slice(0, equals) : arg;
		const value = equals > 0 ? arg.slice(equals + 1) : undefined;
		if (options.inlineValues?.includes(name)) {
			if (!value?.trim()) return { argv: result, positionals, error: `${name} requires a value after =` };
			result.push(arg);
		} else if (options.values.includes(name)) {
			const next = value ?? argv[++i];
			if (next === undefined || (!next.trim() && !options.allowEmptyValues?.includes(name)) || (value === undefined && next.startsWith("-"))) {
				return { argv: result, positionals, error: `${name} requires a value` };
			}
			result.push(name, next);
		} else if (equals < 0 && options.flags.includes(name)) {
			result.push(arg);
		} else {
			return { argv: result, positionals, error: `Unknown option: ${arg}` };
		}
	}
	return { argv: result, positionals };
}
