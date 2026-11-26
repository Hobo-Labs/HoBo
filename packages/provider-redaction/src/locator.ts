import { anyCase } from "./any-case.js";

/**
 * The locators the redactor keeps, as the code that issues them writes them
 * (`parseSecretRef` in `@hobo/bindings`, the providers' `credentialRef`
 * examples): a scheme, an authority and at least one path segment of
 * unreserved URI characters, and an optional `#field`
 * (`hobo-token://vercel/deploy`, `secret://camp/aws-deploy`,
 * `hobo-secret://tenant-1/conformance/claimable-1-v2#key`), or `env://` and an
 * environment variable's name. Nothing else is a locator: not a single
 * segment (`secret://loc…`), not a character outside the set (a zero-width
 * or direction mark, a control character, a backslash).
 */
const SEGMENT = "[A-Za-z0-9._~-]+";

/** A locator's path after `scheme://`: authority, path segments, field. */
export const LOCATOR_PATH = String.raw`${SEGMENT}(?:\/${SEGMENT})+(?:#[A-Za-z0-9._-]+)?`;

/** A whole locator, any scheme. */
export const LOCATOR = String.raw`(?:${anyCase("hobo-token|hobo-secret|secret")}):\/\/${LOCATOR_PATH}|${anyCase("env")}:\/\/[A-Za-z_][A-Za-z0-9_]*`;

/**
 * Where a kept locator ends: at the end of its run, after any closing quotes
 * or brackets around it (`"secret://camp/db"}`), or at an escaped line break
 * (`secret://camp/db\nnext line` in a JSON string), which ends a line of the
 * text it was written in.
 */
export const LOCATOR_END = String.raw`(?:["'}\],)]*(?!\S)|\\[nr])`;
