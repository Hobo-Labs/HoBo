/**
 * How a ceremony reaches the owner when they are not at the machine (a
 * remote dev box run by an agent): a link they open in their own browser,
 * and a secret they hand over through a channel whose value goes only to
 * this process, never to the agent's context, chat, a file or a log (the
 * HoBo MCP App's secret capture, for one).
 */
export interface OwnerChannel {
	/** Show the owner a link to open on their own device, and why. */
	openUrl(url: string, message: string): Promise<void>;
	/** Ask for a secret; `undefined` when the owner declined or did not answer. */
	captureSecret(request: {
		readonly name: string;
		readonly title: string;
		readonly instructions: string;
	}): Promise<string | undefined>;
}
