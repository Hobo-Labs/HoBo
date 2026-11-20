import type { ReactNode } from "react";

export const routes = {
  LandingPageRoute: { to: "/" },
  AdminMessagesRoute: { to: "/admin/messages" },
  AdminSettingsRoute: { to: "/admin/settings" },
};

export function Link({
  to,
  children,
  ...props
}: {
  to: string;
  children: ReactNode;
  replace?: boolean;
}) {
  return (
    <a href={to} {...props}>
      {children}
    </a>
  );
}