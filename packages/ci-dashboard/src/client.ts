/**
 * The dashboard's browser client, bundled to `dist/client/app.js`.
 *
 * It keeps the account token in this tab's session storage (a `#token=`
 * fragment is moved there and wiped from the address bar), reads the view the
 * address names from the relay's read API, and puts the markup in `<main>`.
 * The what-if panel walks the order again in the page and reads nothing.
 * Every request is a `GET` to this page's own origin.
 */

import { RUNNER_STEP_KEYS, type RunnerStepKey } from "@hobo/ci/runner-order";
import { loadView, type RouterState, routerWithAnswer } from "./load.js";
import {
	type DashboardLocation,
	parseDashboardLocation,
	parseRepository,
} from "./location.js";
import { DashboardApiError, DashboardReadApi } from "./read-api.js";
import { type DashboardView, VIEW_TITLES } from "./views.js";
import type { WhatIfQuestion } from "./what-if.js";

const TOKEN_KEY = "hobo-ci-dashboard-token";
const REPOSITORY_KEY = "hobo-ci-dashboard-repository";

function element<T extends HTMLElement>(id: string, kind: new () => T): T {
	const found = document.getElementById(id);
	if (!(found instanceof kind)) throw new Error(`the page has no #${id}`);
	return found;
}

function stored(key: string): string | undefined {
	try {
		return sessionStorage.getItem(key) ?? undefined;
	} catch {
		return undefined;
	}
}

function store(key: string, value: string | undefined): void {
	try {
		if (value === undefined || value === "") sessionStorage.removeItem(key);
		else sessionStorage.setItem(key, value);
	} catch {
		// Storage is blocked: the token lasts until the page is left.
	}
}

let token: string | undefined;
let router: RouterState | undefined;

/**
 * Take a `#token=` fragment into session storage and out of the address bar
 * and history. Returns a sentence to show when the fragment is not readable.
 */
function takeTokenFromFragment(): string {
	const match = /^#token=([^&]+)/u.exec(location.hash);
	if (!match?.[1]) return "";
	let problem = "";
	try {
		token = decodeURIComponent(match[1]);
		store(TOKEN_KEY, token);
	} catch {
		problem =
			"The token in the link is not readable (a broken % escape). Paste the token below instead.";
	}
	history.replaceState(
		null,
		"",
		`${location.pathname}${location.search}#/runners`,
	);
	return problem;
}

function currentLocation(): DashboardLocation {
	return parseDashboardLocation(location.hash, stored(REPOSITORY_KEY));
}

function setStatus(text: string, error = false): void {
	const status = element("status", HTMLParagraphElement);
	status.textContent = text;
	if (error) status.dataset.state = "error";
	else delete status.dataset.state;
}

function showSignIn(message: string): void {
	element("signin", HTMLFormElement).hidden = false;
	element("view", HTMLElement).replaceChildren();
	setStatus(message, message !== "");
	element("token", HTMLInputElement).focus();
}

function markNavigation(view: DashboardView): void {
	for (const link of document.querySelectorAll<HTMLAnchorElement>(
		"nav a[data-view]",
	)) {
		if (link.dataset.view === view) link.setAttribute("aria-current", "page");
		else link.removeAttribute("aria-current");
	}
	document.title = `${VIEW_TITLES.get(view) ?? view} · HoBo CI dashboard`;
}

function offerRepositories(names: readonly string[]): void {
	if (names.length === 0) return;
	const list = element("repositories", HTMLDataListElement);
	const known = new Set([...list.options].map((option) => option.value));
	for (const name of names)
		if (!known.has(name)) {
			const option = document.createElement("option");
			option.value = name;
			list.append(option);
		}
}

let generation = 0;

async function show(moveFocus = false): Promise<void> {
	if (token === undefined) {
		showSignIn("");
		return;
	}
	element("signin", HTMLFormElement).hidden = true;
	const where = currentLocation();
	markNavigation(where.view);
	const main = element("view", HTMLElement);
	const mine = ++generation;
	main.setAttribute("aria-busy", "true");
	setStatus(`Reading ${VIEW_TITLES.get(where.view) ?? where.view}…`);
	try {
		const api = new DashboardReadApi(location.origin, token, (url, init) =>
			fetch(url, { ...init, credentials: "omit", cache: "no-store" }),
		);
		const loaded = await loadView(api, where, Date.now());
		if (mine !== generation) return;
		router = loaded.router;
		main.innerHTML = loaded.html;
		offerRepositories(loaded.repositories);
		setStatus(
			`${VIEW_TITLES.get(where.view) ?? where.view}${where.repository ? ` · ${where.repository}` : ""}`,
		);
		if (moveFocus) main.focus({ preventScroll: true });
	} catch (error) {
		if (mine !== generation) return;
		if (
			error instanceof DashboardApiError &&
			(error.status === 401 || error.status === 403)
		) {
			token = undefined;
			store(TOKEN_KEY, undefined);
			showSignIn(
				`${error.message}. Sign in with a token that holds policy:read.`,
			);
			return;
		}
		main.replaceChildren();
		setStatus(
			error instanceof DashboardApiError && error.command
				? `${error.message}`
				: `Could not read the view: ${error instanceof Error ? error.message : String(error)}`,
			true,
		);
	} finally {
		if (mine === generation) main.removeAttribute("aria-busy");
	}
}

function stepKeyOf(name: string): RunnerStepKey | undefined {
	return RUNNER_STEP_KEYS.find((key) => key === name);
}

/** The what-if form's values as a question; labels the form does not show are left out. */
function questionFrom(
	form: HTMLFormElement,
	base: WhatIfQuestion,
): WhatIfQuestion {
	const data = new FormData(form);
	const labels = new Map(base.labels);
	const unhealthy = new Set<RunnerStepKey>();
	for (const [name, value] of data) {
		const text = String(value);
		if (name.startsWith("label:")) {
			const key = stepKeyOf(name.slice("label:".length));
			if (key) labels.set(key, text);
		}
		if (name === "unhealthy") {
			const key = stepKeyOf(text);
			if (key) unhealthy.add(key);
		}
	}
	const used = String(data.get("minutesUsedPercent") ?? "").trim();
	const percent =
		used === "" ? undefined : Math.min(100, Math.max(0, Number(used)));
	return {
		repository: base.repository,
		labels,
		public: data.has("public"),
		fork: data.has("fork"),
		startedBy: String(data.get("startedBy") ?? "").trim(),
		fleetTaking: data.has("fleetTaking"),
		unhealthy,
		minutesUsedPercent:
			percent === undefined || Number.isNaN(percent) ? undefined : percent,
	};
}

function onSubmit(event: SubmitEvent): void {
	const form = event.target;
	if (!(form instanceof HTMLFormElement)) return;
	event.preventDefault();
	if (form.id === "signin") {
		const value = element("token", HTMLInputElement).value.trim();
		if (value === "") return;
		token = value;
		store(TOKEN_KEY, value);
		element("token", HTMLInputElement).value = "";
		void show();
		return;
	}
	if (form.id === "picker") {
		store(
			REPOSITORY_KEY,
			parseRepository(element("repository", HTMLInputElement).value),
		);
		void show();
		return;
	}
	if (form.id === "what-if" && router !== undefined) {
		const question = questionFrom(form, router.question);
		let html: string;
		try {
			html = routerWithAnswer(router, question, Date.now());
		} catch (error) {
			// `answerWhatIf` turns every refusal it knows into a sentence; this
			// keeps anything else from failing silently.
			const answer = document.getElementById("what-if-answer");
			if (answer) {
				answer.textContent = `The walk could not run: ${error instanceof Error ? error.message : String(error)}`;
				answer.focus();
			}
			return;
		}
		element("view", HTMLElement).innerHTML = html;
		router = { ...router, question };
		document.getElementById("what-if-answer")?.focus();
	}
}

function syncThemeButton(): void {
	const button = element("theme-toggle", HTMLButtonElement);
	const night = document.documentElement.getAttribute("data-theme") === "dark";
	button.setAttribute("aria-pressed", String(night));
	button.textContent = night ? "Day" : "Night";
}

function start(): void {
	const fragmentProblem = takeTokenFromFragment();
	token ??= stored(TOKEN_KEY);
	element("repository", HTMLInputElement).value = stored(REPOSITORY_KEY) ?? "";
	document.addEventListener("submit", onSubmit);
	window.addEventListener("hashchange", () => void show(true));
	element("theme-toggle", HTMLButtonElement).addEventListener("click", () => {
		const next =
			document.documentElement.getAttribute("data-theme") === "dark"
				? "light"
				: "dark";
		document.documentElement.setAttribute("data-theme", next);
		try {
			localStorage.setItem("hobo-theme", next);
		} catch {
			// The choice lasts until the page is left.
		}
		syncThemeButton();
	});
	syncThemeButton();
	if (fragmentProblem !== "" && token === undefined)
		showSignIn(fragmentProblem);
	else void show();
}

start();
