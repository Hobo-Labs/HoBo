const domainPattern =
  /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/i;

export function installPlausibleAnalytics(
  target: Document,
  domain: string | undefined,
  production: boolean,
) {
  if (
    !domain ||
    !domainPattern.test(domain) ||
    target.getElementById("plausible-analytics")
  )
    return;
  const script = target.createElement("script");
  script.id = "plausible-analytics";
  script.async = true;
  script.dataset.domain = domain;
  script.src = production
    ? "https://plausible.io/js/script.js"
    : "https://plausible.io/js/script.local.js";
  target.head.appendChild(script);
}
