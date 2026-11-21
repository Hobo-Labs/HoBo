// public-contract: the title types allowed unless the caller passes its own.
export const DEFAULT_PULL_REQUEST_TITLE_TYPES: readonly string[] = [
	"feat",
	"fix",
	"docs",
	"style",
	"refactor",
	"perf",
	"test",
	"build",
	"ci",
	"chore",
	"revert",
];

export type PullRequestTitleOptions = Readonly<{
	types?: readonly string[];
}>;

export type PullRequestTitleCheck =
	| Readonly<{ ok: true; type: string; scope?: string; breaking: boolean }>
	| Readonly<{ ok: false; reason: string }>;

const EXAMPLE = '"feat: add retry" or "fix(api): handle empty body"';

const LEADING_LETTERS = /^[A-Za-z]+/;

function rejected(reason: string): PullRequestTitleCheck {
	return { ok: false, reason };
}

export function checkPullRequestTitle(
	title: string,
	options: PullRequestTitleOptions = {},
): PullRequestTitleCheck {
	const types =
		options.types === undefined || options.types.length === 0
			? DEFAULT_PULL_REQUEST_TITLE_TYPES
			: options.types;

	const type = LEADING_LETTERS.exec(title)?.[0];
	if (type === undefined) {
		return rejected(
			`The title must start with a type made of letters, like ${EXAMPLE}.`,
		);
	}

	let rest = title.slice(type.length);
	let scope: string | undefined;
	if (rest.startsWith("(")) {
		const close = rest.indexOf(")");
		if (close === -1) {
			return rejected(
				`The scope after "${type}" is missing its closing parenthesis; write it as "${type}(scope): subject".`,
			);
		}
		scope = rest.slice(1, close);
		if (scope.trim().length === 0) {
			return rejected(
				`The scope after "${type}" is empty; name a scope or drop the parentheses.`,
			);
		}
		if (/[(\r\n]/.test(scope)) {
			return rejected(
				`The scope "${scope}" must not contain parentheses or line breaks.`,
			);
		}
		rest = rest.slice(close + 1);
	}

	const breaking = rest.startsWith("!");
	if (breaking) rest = rest.slice(1);

	if (!rest.startsWith(":")) {
		return rejected(
			`The type must be followed by a colon and a space, like ${EXAMPLE}.`,
		);
	}
	const subject = rest.slice(1);
	if (subject.trim().length === 0) {
		return rejected("The subject after the colon is empty; say what changed.");
	}
	if (!subject.startsWith(" ")) {
		return rejected(
			`Put a space after the colon: "${title.slice(0, title.length - subject.length)} ${subject}".`,
		);
	}
	if (/^\s/.test(subject.slice(1))) {
		return rejected("Put exactly one space between the colon and the subject.");
	}

	if (!types.includes(type)) {
		const sameLetters = types.find(
			(allowed) => allowed.toLowerCase() === type.toLowerCase(),
		);
		const hint =
			sameLetters === undefined
				? ""
				: ` Types are matched exactly: write "${sameLetters}".`;
		return rejected(
			`Unknown type "${type}". Use one of: ${types.join(", ")}.${hint}`,
		);
	}

	if (scope === undefined) return { ok: true, type, breaking };
	return { ok: true, type, scope, breaking };
}

export function parseTitleTypes(text: string): readonly string[] {
	const types = text
		.split(/[,\r\n]/)
		.map((entry) => entry.trim())
		.filter((entry) => entry.length > 0);
	return [...new Set(types)];
}
