import { action, page, query, route, type Spec } from "@wasp.sh/spec";

import { AnalyticsDashboardPage } from "./dashboards/analytics/AnalyticsDashboardPage" with { type: "ref" };
import { MessagesPage } from "./dashboards/messages/MessagesPage" with { type: "ref" };
import {
  getContactMessages,
  getUnreadContactMessageCount,
  markContactMessageRead,
} from "./dashboards/messages/operations" with { type: "ref" };
import { UsersDashboardPage } from "./dashboards/users/UsersDashboardPage" with { type: "ref" };
import { CalendarPage } from "./elements/calendar/CalendarPage" with { type: "ref" };
import { SettingsPage } from "./elements/settings/SettingsPage" with { type: "ref" };
import { saveAdminProfile } from "./elements/settings/operations" with { type: "ref" };
import { ButtonsPage } from "./elements/ui-elements/ButtonsPage" with { type: "ref" };

export const adminSpec: Spec = [
  query(getContactMessages, { entities: ["ContactFormMessage"] }),
  query(getUnreadContactMessageCount, { entities: ["ContactFormMessage"] }),
  action(markContactMessageRead, { entities: ["ContactFormMessage"] }),
  action(saveAdminProfile, { entities: ["User"] }),
  route(
    "AdminRoute",
    "/admin",
    page(AnalyticsDashboardPage, { authRequired: true }),
  ),
  route(
    "AdminUsersRoute",
    "/admin/users",
    page(UsersDashboardPage, { authRequired: true }),
  ),
  route(
    "AdminSettingsRoute",
    "/admin/settings",
    page(SettingsPage, { authRequired: true }),
  ),
  route(
    "AdminCalendarRoute",
    "/admin/calendar",
    page(CalendarPage, { authRequired: true }),
  ),
  route(
    "AdminUIButtonsRoute",
    "/admin/ui/buttons",
    page(ButtonsPage, { authRequired: true }),
  ),
  route(
    "AdminMessagesRoute",
    "/admin/messages",
    page(MessagesPage, { authRequired: true }),
  ),
];
