/**
 * Bombadil spec: the GitHub App hand-off page (`site/public/github-app/`).
 *
 * The page is opened three ways: bare, with a manifest to post to GitHub
 * (`#manifest=…&action=…`), and as GitHub's redirect with a single-use code
 * (`?code=…&state=…`). Bombadil explores it (clicks, keys, back, forward,
 * reload) and checks, at every state it reaches:
 *
 * - exactly one section shows: the owner always knows what to do;
 * - the code and the manifest leave the address bar at once (history,
 *   screenshots and shared links never carry them);
 * - the form posts only to GitHub;
 * - its one script runs under its own CSP (a stale hash is a console error)
 *   and nothing throws.
 */
import { actions, always, extract, weighted } from "@antithesishq/bombadil";
import {
	clicks,
	navigation,
	reload,
} from "@antithesishq/bombadil/browser/defaults/actions";

export {
	noConsoleErrors,
	noUncaughtExceptions,
	noUnhandledPromiseRejections,
} from "@antithesishq/bombadil/browser/defaults/properties";

/** The hand-off page is loaded (the browser starts on about:blank). */
const onPage = extract(
	(state: { document: Document }) =>
		state.document.getElementById("empty") !== null,
);
const shown = extract((state: { document: Document }) =>
	["create", "code", "empty"].filter(
		(id) =>
			state.document.getElementById(id)?.classList.contains("hidden") === false,
	),
);
const address = extract((state: { window: Window }) => ({
	search: state.window.location.search,
	hash: state.window.location.hash,
}));
const action = extract(
	(state: { document: Document }) =>
		state.document.getElementById("form")?.getAttribute("action") ?? "",
);

export const one_section_shows = always(
	() => !onPage.current || shown.current.length === 1,
);

export const nothing_left_in_the_address_bar = always(
	() =>
		!onPage.current ||
		(address.current.search === "" && address.current.hash === ""),
);

export const the_form_posts_only_to_github = always(
	() =>
		!shown.current.includes("create") ||
		action.current.startsWith("https://github.com/"),
);

/** What the owner does here: click, go back and forward, reload, wait. */
export const owner = weighted([
	[4, clicks],
	[2, navigation],
	[1, reload],
	[1, actions(() => ["Wait"])],
]);
