function safeUrl(
  value: string | undefined,
  origin: string,
): string | undefined {
  if (
    !value ||
    (!/^https?:\/\//i.test(value) &&
      (!value.startsWith("/") || value.startsWith("//")))
  )
    return;
  try {
    const url = new URL(value, origin);
    if (
      (url.protocol !== "https:" && url.protocol !== "http:") ||
      url.username ||
      url.password
    )
      return;
    return url.href;
  } catch {
    return;
  }
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

export function legalLinks(
  privacyUrl: string | undefined,
  termsUrl: string | undefined,
  origin: string,
): string {
  return [
    ["Privacy Policy", privacyUrl],
    ["Terms and Conditions", termsUrl],
  ]
    .flatMap(([label, value]) => {
      const url = safeUrl(value, origin);
      return url
        ? [
            `<a href="${escapeHtml(
              url,
            )}" target="_blank" rel="noopener noreferrer">${label}</a>`,
          ]
        : [];
    })
    .join("\n");
}
