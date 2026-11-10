// ==========================================================================
// The stops along the trail: one per section of the landing page.
//
// The trail band is docked to the bottom of the viewport and the page scrolls
// over it, so the band can only be *about* the page if it knows where the
// reader is. A stop is that link: a section declares `data-trail-stop="<key>"`,
// and everything standing beside the trail for that stop (see
// ./trail-landmarks.ts) arrives alongside Bo as the section's heading reaches
// the reading line.
//
// Plain data on purpose — this file is imported by the page at build time and
// by the client controller, so it must not touch the filesystem.
// ==========================================================================

export const TRAIL_STOPS = [
	{ key: "trailhead", label: "The trailhead" },
	{ key: "crossroads", label: "The crossroads" },
	{ key: "rails", label: "The main line" },
	{ key: "depot", label: "The depot" },
	{ key: "crew", label: "The crew camp" },
	{ key: "airfield", label: "The airfield" },
	{ key: "river", label: "The river" },
	{ key: "home", label: "The home stretch" },
] as const;

export type TrailStop = (typeof TRAIL_STOPS)[number]["key"];

export const stopLabel = (key: string): string =>
	TRAIL_STOPS.find((s) => s.key === key)?.label ?? "";
