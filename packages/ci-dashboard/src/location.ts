import { DASHBOARD_VIEWS, type DashboardView } from "./views.js";

declare const parsedLocation: unique symbol;

export type DashboardLocation = Readonly<{
	view: DashboardView;
	repository: string | undefined;
	run:
		| Readonly<{ repository: string; id: number; attempt: number }>
		| undefined;
	readonly [parsedLocation]: true;
}>;

const REPOSITORY = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/u;
const HISTORY_RUN =
	/^#\/history\/([A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100})\/(\d{1,16})\/(\d{1,6})$/u;

function seal(
	location: Omit<DashboardLocation, typeof parsedLocation>,
): asserts location is DashboardLocation {
	if (location.run) Object.freeze(location.run);
	Object.freeze(location);
}

function frozen(
	location: Omit<DashboardLocation, typeof parsedLocation>,
): DashboardLocation {
	seal(location);
	return location;
}

export function parseRepository(text: string | undefined): string | undefined {
	const trimmed = text?.trim() ?? "";
	return REPOSITORY.test(trimmed) ? trimmed : undefined;
}

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
