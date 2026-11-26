/**
 * What to say when git failed because it could not ask the user something.
 *
 * Every network git the pins run is in its own session, so that its deadline
 * can end it with everything it started; it therefore has no controlling
 * terminal. ssh cannot ask for a passphrase, a password or whether to trust
 * a host key, and git cannot ask for a username or a password
 * (GIT_TERMINAL_PROMPT=0).
 *
 * Erasable TypeScript with node builtins only.
 */

/**
 * Only the forms ssh and git print for a missing key, password, host key or
 * credential: a bare "Permission denied" is also a local file error. ssh
 * lists the methods it tried, `(publickey,password)` or
 * `(keyboard-interactive)`; git asks for a username first and a password
 * when the URL already names the user.
 */
const NEEDED_A_TERMINAL =
	/Permission denied \((publickey|password)|keyboard-interactive|Host key verification failed|could not read (Username|Password)|Authentication failed/u;

/** A hint line to append to a GIT_FAILED message, or "" when git's error is something else. */
export function terminalHint(stderr: string): string {
	if (!NEEDED_A_TERMINAL.test(stderr)) return "";
	return (
		"\nhint: pins run git without a terminal, so ssh cannot ask for a passphrase, a password or a host key, and git cannot ask for a username or password." +
		" Load the key into ssh-agent (ssh-add), add the host to ~/.ssh/known_hosts (connect once with ssh), or set up a git credential helper." +
		" The repositories in tools/pins/siblings.json are https; ssh is used only when your git config rewrites them (url.<base>.insteadOf)."
	);
}
