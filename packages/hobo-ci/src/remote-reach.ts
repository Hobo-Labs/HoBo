/**
 * What an owner outside a remote dev box can act on. A handed-off run (an
 * agent on a remote box: Claude Code on the web, Codespaces, Coder, Gitpod,
 * a dev container, SSH) must never ask the owner for something only someone
 * at the box could do: open a loopback page, use a terminal, or "run it on
 * your own machine". Every line it shows names something the owner can do
 * from their own device (a link, a form the agent shows, an approval in an
 * app), or something the agent itself does.
 */

/** Words that ask for presence at the box (or a machine the run cannot reach). */
export const REMOTE_INFEASIBLE =
	/\b(on|at) your own (machine|terminal|computer)\b|\bin a terminal\b|\byour terminal\b|\bon this machine\b|\bbrowser on this machine\b|\brun it yourself\b|\byourself in a\b|https?:\/\/(127\.0\.0\.1|localhost|\[::1\])\b/iu;

/** The lines of `lines` an owner outside the box could not act on. */
export function remoteInfeasible(lines: readonly string[]): string[] {
	return lines.filter((line) => REMOTE_INFEASIBLE.test(line));
}

/** Whether this process runs on a remote dev box the owner is not at. */
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
