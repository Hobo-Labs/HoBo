export const REMOTE_INFEASIBLE =
	/\b(on|at) your own (machine|terminal|computer)\b|\bin a terminal\b|\byour terminal\b|\bon this machine\b|\bbrowser on this machine\b|\brun it yourself\b|\byourself in a\b|https?:\/\/(127\.0\.0\.1|localhost|\[::1\])\b/iu;

export function remoteInfeasible(lines: readonly string[]): string[] {
	return lines.filter((line) => REMOTE_INFEASIBLE.test(line));
}

export function isRemoteBox(
	env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
	return [
		"CLAUDE_CODE_REMOTE",
		"CODESPACES",
		"GITPOD_WORKSPACE_ID",
		"CODER",
		"REMOTE_CONTAINERS",
		"DEVCONTAINER",
		"CLOUD_SHELL",
		"SSH_CONNECTION",
	].some((name) => {
		const value = env[name];
		return value !== undefined && value !== "" && value !== "false";
	});
}
