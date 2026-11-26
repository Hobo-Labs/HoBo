import { useState } from "react";
import type { AuthUser } from "wasp/auth";
import {
  getContactMessages,
  getUnreadContactMessageCount,
  markContactMessageRead,
  useQuery,
} from "wasp/client/operations";
import { Button } from "../../../client/components/ui/button";
import { Breadcrumb } from "../../layout/Breadcrumb";
import { DefaultLayout } from "../../layout/DefaultLayout";

export function MessagesPage({ user }: { user: AuthUser }) {
  const [page, setPage] = useState(0);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [saveError, setSaveError] = useState(false);
  const contactMessagesQuery = useQuery(getContactMessages, { page });
  const unreadCountQuery = useQuery(getUnreadContactMessageCount);
  const { data, isLoading, error } = contactMessagesQuery;

  async function markRead(id: string) {
    setSavingId(id);
    setSaveError(false);
    try {
      await markContactMessageRead({ id });
      await Promise.all([
        contactMessagesQuery.refetch(),
        unreadCountQuery.refetch(),
      ]);
    } catch {
      setSaveError(true);
    } finally {
      setSavingId(null);
    }
  }

  return (
    <DefaultLayout user={user}>
      <Breadcrumb pageName="Messages" />
      {isLoading && <p role="status">Loading messages…</p>}
      {error && (
        <p role="alert">Messages could not be loaded. Please try again.</p>
      )}
      {saveError && (
        <p role="alert">The message could not be updated. Please try again.</p>
      )}
      {data && data.messages.length === 0 && <p>No messages on this page.</p>}
      {data && data.messages.length > 0 && (
        <ul className="space-y-4">
          {data.messages.map((message) => (
            <li
              key={message.id}
              className="border-border bg-card rounded-sm border p-5 shadow-sm"
            >
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <p className="font-semibold">
                    {message.user.username ||
                      message.user.email ||
                      "Unknown sender"}
                  </p>
                  {message.user.username && message.user.email && (
                    <p className="text-muted-foreground text-sm">
                      {message.user.email}
                    </p>
                  )}
                  <time
                    className="text-muted-foreground text-sm"
                    dateTime={new Date(message.createdAt).toISOString()}
                  >
                    {new Date(message.createdAt).toLocaleString()}
                  </time>
                </div>
                <span className="text-sm font-medium">
                  {message.isRead ? "Read" : "Unread"}
                </span>
              </div>
              <p className="mt-4 whitespace-pre-wrap break-words">
                {message.content}
              </p>
              {!message.isRead && (
                <Button
                  className="mt-4"
                  disabled={savingId !== null}
                  onClick={() => void markRead(message.id)}
                >
                  {savingId === message.id ? "Saving…" : "Mark as read"}
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      {data && (page > 0 || data.hasNext) && (
        <nav
          aria-label="Message pages"
          className="mt-6 flex items-center gap-3"
        >
          <Button
            variant="outline"
            disabled={page === 0}
            onClick={() => setPage((current) => current - 1)}
          >
            Previous
          </Button>
          <span>Page {page + 1}</span>
          <Button
            variant="outline"
            disabled={!data.hasNext}
            onClick={() => setPage((current) => current + 1)}
          >
            Next
          </Button>
        </nav>
      )}
    </DefaultLayout>
  );
}
