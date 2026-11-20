/**
 * Bombadil spec: the HoBo secret-capture page the MCP server serves on
 * 127.0.0.1 (`packages/mcp/src/secret-capture/html.ts`, loopback mode).
 *
 * Bombadil types, clicks, presses keys, reloads and goes back and forward,
 * and also pastes a value of the right shape and submits it; at every state:
 *
 * - the one-time token stays in the fragment (never a query a server or a
 *   proxy log sees);
 * - the value is never shown: the field stays a password field and no text
 *   on the page contains what was typed;
 * - once stored, the form is gone and its fields are empty;
 * - a submit always ends: the button comes back, or the page says stored;
 * - a hand-over's page never claims a secret store;
 * - nothing throws, and no CSP violation or console error.
 */
import {
	actions,
	always,
	eventually,
	extract,
	weighted,
} from "@antithesishq/bombadil";
import { registerCustomAction } from "@antithesishq/bombadil/browser";
import {
	clicks,
	inputs,
	navigation,
	reload,
	waitOnce,
} from "@antithesishq/bombadil/browser/defaults/actions";

export {
	noConsoleErrors,
	noUncaughtExceptions,
	noUnhandledPromiseRejections,
} from "@antithesishq/bombadil/browser/defaults/properties";

/** What the owner pastes: synthetic, the shape the capture expects. */
// Base64, as Infisical's Copy to clipboard gives it: the capture accepts
// this shape, so exploration reaches the stored state too.
const PASTED = "aG9iby1ib21iYWRpbC1zeW50aGV0aWMtc2Vzc2lvbg==";

const pasteAndSubmit = registerCustomAction(
	"pasteAndSubmit",
	async (document: Document) => {
		const field = document.getElementById("capture-line");
		const form = document.getElementById("capture-form");
		if (!(field instanceof HTMLInputElement) || form === null || form.hidden)
			return;
		field.value = PASTED;
		form.dispatchEvent(new Event("submit", { cancelable: true }));
	},
);

export const owner = weighted([
	[3, clicks],
	[3, inputs],
	[2, actions(() => [pasteAndSubmit()])],
	[1, navigation],
	[1, reload],
	[1, waitOnce],
]);

const page = extract((state: { document: Document; window: Window }) => {
	const document = state.document;
	const line = document.getElementById("capture-line");
	const multi = document.getElementById("capture-multi");
	const typed = [line, multi]
		.map((field) =>
			field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement
				? field.value
				: "",
		)
		.filter((value) => value !== "");
	const done = document.getElementById("capture-done");
	const submit = document.getElementById("capture-submit");
	return {
		// The capture page is loaded (the browser starts on about:blank).
		onPage: document.getElementById("capture-form") !== null,
		search: state.window.location.search,
		lineType: line?.getAttribute("type") ?? "",
		text: document.body?.innerText ?? "",
		typed,
		done: done !== null && !done.hidden,
		formShown: document.getElementById("capture-form")?.hidden === false,
		caption: document.getElementById("capture-caption")?.textContent ?? "",
		busy: submit instanceof HTMLButtonElement && submit.disabled,
	};
});

export const token_stays_in_the_fragment = always(
	() => !page.current.onPage || page.current.search === "",
);

export const the_value_is_never_shown = always(
	() =>
		!page.current.onPage ||
		(page.current.lineType === "password" &&
			!page.current.text.includes(PASTED) &&
			page.current.typed.every((value) => !page.current.text.includes(value))),
);

export const stored_closes_the_form = always(
	() =>
		!page.current.done ||
		(!page.current.formShown && page.current.typed.length === 0),
);

export const a_submit_always_ends = always(() =>
	page.current.busy
		? eventually(() => !page.current.busy).within(5, "seconds")
		: true,
);

/** A hand-over goes only to the waiting run: its page never claims a store. */
export const a_hand_over_never_claims_a_store = always(
	() =>
		!page.current.onPage ||
		!page.current.caption.includes("hand-over") ||
		!/secret store|Store it/u.test(page.current.text),
);
