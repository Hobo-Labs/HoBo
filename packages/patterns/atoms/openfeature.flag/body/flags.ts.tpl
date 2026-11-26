export const PRIMARY_FLAG = "{{flagKey}}";

export function flagEnabled(
	evaluate: (key: string) => boolean,
	key = PRIMARY_FLAG,
): boolean {
	return evaluate(key);
}
