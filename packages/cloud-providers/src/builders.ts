/**
 * The one-import authoring surface: `station`, `yard`, `camp`.
 *
 * These are `@hobo/yards`' `buildStation` / `buildYard` / `buildCamp` under the
 * names an author actually wants to type. They live here rather than in
 * `@hobo/yards` for a boring reason: that package already spends `yard` and
 * `camp` on the parse boundaries these builders compile *into*, and renaming
 * those would break every caller for a cosmetic win. This package has neither
 * name, and is already the place a provider namespace comes from — so one
 * import line gets you the noun and the offerings that fill it:
 *
 * ```ts
 * import { station, yard, camp, azure, cloudflare } from "@hobo/cloud-providers";
 *
 * export default station("acme", (s) => {
 *   s.tenant("acme").residency("eu").trustDomain("acme.hobo.internal");
 *
 *   s.yard(azure, "prod-eu", (y) => {
 *     y.region("westeurope").residency("eu").label("tier", "public");
 *     y.web(azure.containerApps({ ingress: "external" }), azure.appService({ sku: "P1v3" }));
 *     y.data(azure.postgresFlexible({ tier: "GeneralPurpose" }));
 *     y.camp("api", (c) => c.production().label("exposure", "public"));
 *   });
 *
 *   s.yard(cloudflare.Yard());
 * });
 * ```
 *
 * One verb per noun (`station`, `yard`, `camp`, and `bindle` in
 * `@hobo/bindles`), callbacks for containers, chaining for scalars, variadic
 * slot methods that accumulate. Nesting is what replaces `attachCampToYard`:
 * a Camp declared inside `y.camp(…)` is handed the Yard's id and provider by
 * the Yard, so the author never re-types identifiers the Yard already owns.
 *
 * **Bindle stays in `@hobo/bindles`.** App authoring and ops configuration are
 * different lifecycles with different owners and different review paths;
 * folding `bindle()` into this import would make one surface out of two
 * unrelated jobs, which is a worse surface than a second import.
 *
 * **Additive, not a migration.** `defineYard`, `defineStation`, `yard` and
 * `camp` in `@hobo/yards` / `@hobo/camps` keep working exactly as they do now.
 * These builders terminate in those functions, so every refusal they make still
 * fires here with its existing code.
 *
 * `station()` returns the `StationManifest` `defineStation` returns — the
 * registration record a composition root hands to `station()` in
 * `@hobo/stations`. A Station registers Yards; it never parents them (ADR-0131).
 */
export {
	BuilderError,
	type BuilderErrorCode,
	buildCamp as camp,
	buildStation as station,
	buildYard as yard,
	type CampBuilder,
	type ProviderNamespaceRef,
	type ProviderRef,
	providerIdOf,
	type StationBuilder,
	type StationManifest,
	type YardBuilder,
	type YardSlotMethods,
} from "@hobo/yards";
