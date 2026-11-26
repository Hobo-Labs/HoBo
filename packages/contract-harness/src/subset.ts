/** Recursive subset: every field in `expected` must exist with equal value in `actual`. */
export function isRecursiveSubset(
	expected: unknown,
	actual: unknown,
	path = "$",
): boolean {
	if (expected === actual) {
		return true;
	}

	if (expected === null || expected === undefined) {
		return expected === actual;
	}

	if (typeof expected !== typeof actual) {
		return false;
	}

	if (Array.isArray(expected)) {
		if (!Array.isArray(actual) || expected.length > actual.length) {
			return false;
		}
		return expected.every((item, index) =>
			isRecursiveSubset(item, actual[index], `${path}[${index}]`),
		);
	}

	if (typeof expected === "object" && expected !== null) {
		if (
			typeof actual !== "object" ||
			actual === null ||
			Array.isArray(actual)
		) {
			return false;
		}
		const expectedRecord = expected as Record<string, unknown>;
		const actualRecord = actual as Record<string, unknown>;
		return Object.keys(expectedRecord).every((key) =>
			isRecursiveSubset(
				expectedRecord[key],
				actualRecord[key],
				`${path}.${key}`,
			),
		);
	}

	return false;
}

/** Find first path where expected is not a subset of actual. */
export function subsetMismatchPath(
	expected: unknown,
	actual: unknown,
	path = "$",
): string | undefined {
	if (isRecursiveSubset(expected, actual, path)) {
		return undefined;
	}

	if (
		expected === null ||
		expected === undefined ||
		typeof expected !== "object" ||
		Array.isArray(expected)
	) {
		return path;
	}

	if (typeof actual !== "object" || actual === null || Array.isArray(actual)) {
		return path;
	}

	const expectedRecord = expected as Record<string, unknown>;
	const actualRecord = actual as Record<string, unknown>;

	for (const key of Object.keys(expectedRecord)) {
		const childPath = `${path}.${key}`;
		if (!(key in actualRecord)) {
			return childPath;
		}
		const nested = subsetMismatchPath(
			expectedRecord[key],
			actualRecord[key],
			childPath,
		);
		if (nested) {
			return nested;
		}
	}

	return path;
}
