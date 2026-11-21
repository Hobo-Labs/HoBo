import { getUnreadContactMessageCount, useQuery } from "wasp/client/operations";
import { Link as WaspRouterLink, routes } from "wasp/client/router";
import { MessageIndicator } from "./MessageIndicator";

export function MessageButton() {
  const { data: unreadCount } = useQuery(
    getUnreadContactMessageCount,
    undefined,
    { refetchInterval: 30_000 },
  );
  return (
    <li className="relative">
      <WaspRouterLink
        aria-label={
          unreadCount ? `Messages, ${unreadCount} unread` : "Messages"
        }
        className="border-stroke bg-gray hover:text-primary dark:border-strokedark dark:bg-meta-4 h-8.5 w-8.5 relative flex items-center justify-center rounded-full border-[0.5px] dark:text-white"
        to={routes.AdminMessagesRoute.to}
      >
        <MessageIndicator unreadCount={unreadCount} />
      </WaspRouterLink>
    </li>
  );
}
