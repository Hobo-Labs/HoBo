/**
 * The CI project's declaration: what `hobo ci up` (or `hobo up` here)
 * converges.
 *
 * HoBo's CI is the hosted relay plus the GitHub connection it runs on. The
 * relay's Bindle — an HTTP entry, three private queues, a repair schedule, a
 * cache it may lose and a read-only config service — is declared once, beside
 * the code that serves it (`packages/ci-vercel/src/bindle.ts`, whose tests tie
 * every name to `vercel.json`), and this project deploys it unchanged. The
 * GitHub App is not a Bindle resource: it is a provider *connection* the CI
 * lifecycle makes before it converges (`prepareGithubConnection`), and its
 * credentials live in the secret store the relay's config service reads.
 *
 * Like the relay's own declaration, this file names no provider; where it runs
 * is chosen where the deploy is run. It is loaded by the Bindle loader, not
 * compiled by this package's `tsc` (see `tsconfig.json`).
 */
export { default } from "../../ci-vercel/src/bindle.ts";
