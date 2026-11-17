/**
 * Where the person is, parsed from the address: the view in the fragment
 * (`#/router`, `#/history/<owner>/<name>/<run>/<attempt>`) and the repository
 * the picker holds. `DashboardLocation` in `data-models/ci_dashboard.proto` is
 * the record; `parseDashboardLocation` is its one parser (parse, don't
 * validate): what it returns is checked and frozen, so the loaders never
 * look at a raw fragment.
 */
import { DASHBOARD_VIEWS, type DashboardView } from "./views.js";

declare const parsedLocation: unique symbol;

/** A location that passed `parseDashboardLocation`. */
export type DashboardLocation = Readonly<{
	view: DashboardView;
	/** `owner/name`, or undefined for every connected repository. */
	repository: string | undefined;
	/** History only: the run attempt opened. */
	run:
		| Readonly<{ repository: string; id: number; attempt: number }>
		| undefined;
	readonly [parsedLocation]: true;
}>;

const REPOSITORY = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/u;
const HISTORY_RUN =
	/^#\/history\/([A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100})\/(\d{1,16})\/(\d{1,6})$/u;

function frozen(
	location: Omit<DashboardLocation, typeof parsedLocation>,
): DashboardLocation {
	if (location.run) Object.freeze(location.run);
	// SAFETY: every field was read through the rules above, which is what the brand states.
	return Object.freeze(location) as DashboardLocation;
}

/** A repository the picker holds, or undefined for a blank or malformed one. */
export function parseRepository(text: string | undefined): string | undefined {
	const trimmed = text?.trim() ?? "";
	return REPOSITORY.test(trimmed) ? trimmed : undefined;
}

/**
 * The location a fragment and a picked repository name. An unknown or
 * malformed fragment is the Runners view, the dashboard's front page.
 */
export function parseDashboardLocation(
	hash: string,
	repository: string | undefined,
): DashboardLocation {
	const picked = parseRepository(repository);
	const run = HISTORY_RUN.exec(hash);
	const id = Number(run?.[2]);
	const attempt = Number(run?.[3]);
	if (
		run?.[1] &&
		Number.isSafeInteger(id) &&
		id > 0 &&
		attempt >= 1 &&
		attempt <= 1000
	)
		return frozen({
			view: "history",
			repository: picked,
			run: { repository: run[1], id, attempt },
		});
	const view =
		DASHBOARD_VIEWS.find((name) => hash === `#/${name}`) ?? "runners";
	return frozen({ view, repository: picked, run: undefined });
}
