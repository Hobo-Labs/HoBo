---
name: impeccable
description: Use when the user wants to design, redesign, shape, critique, audit, polish, clarify, distill, harden, optimize, adapt, animate, colorize, extract, or otherwise improve a frontend interface. Covers websites, landing pages, dashboards, product UI, app shells, components, forms, settings, onboarding, and empty states. Handles UX review, visual hierarchy, information architecture, cognitive load, accessibility, performance, responsive behavior, theming, anti-patterns, typography, fonts, spacing, layout, alignment, color, motion, micro-interactions, UX copy, error states, edge cases, i18n, and reusable design systems or tokens. Also use for bland designs that need to become bolder or more delightful, loud designs that should become quieter, live browser iteration on UI elements, or ambitious visual effects that should feel technically extraordinary. Not for backend-only or non-UI tasks.
version: 4.0.4
---

# Impeccable

Follow the repository rules in `AGENTS.md`. They override every reference and
helper in this skill. Do not create planning documents, design documents,
surface briefs, critique files, or unfinished artifacts. Do not wait for a
separate design approval when the request already authorizes implementation.

Inspect the target, its existing components, styles, tokens, and assets. Apply
the requested visual work directly, preserve product truth, and use the
relevant visual guidance where it is consistent with the repository rules.
Use `reference/craft-floor.md` for the visual quality floor.

Verify the finished surface with the appropriate rendered-state tests, visual
review, and `pnpm run design:lint`. Describe findings and tradeoffs in the
response or pull request. For `init`, `document`, and `doctor`, inspect the
implemented source and report useful findings inline; do not generate files.
