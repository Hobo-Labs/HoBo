import { MessageCircleMore } from "lucide-react";

export function MessageIndicator({
  unreadCount,
}: {
  unreadCount: number | undefined;
}) {
  return (
    <>
      {unreadCount ? (
        <span
          className="bg-meta-1 z-1 absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full"
          aria-hidden="true"
        >
          <span className="bg-meta-1 -z-1 absolute inline-flex h-full w-full animate-ping rounded-full opacity-75 motion-reduce:animate-none" />
        </span>
      ) : null}
      <MessageCircleMore className="size-5" aria-hidden="true" />
    </>
  );
}
