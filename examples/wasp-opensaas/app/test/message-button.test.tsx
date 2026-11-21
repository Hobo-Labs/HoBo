import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { MessageIndicator } from "../src/admin/dashboards/messages/MessageIndicator";

afterEach(cleanup);

describe("message indicator", () => {
  it("shows an animated indicator only when messages are unread", () => {
    const { container, rerender } = render(
      <MessageIndicator unreadCount={2} />,
    );
    expect(container.querySelector(".animate-ping")).not.toBeNull();
    rerender(<MessageIndicator unreadCount={0} />);
    expect(container.querySelector(".animate-ping")).toBeNull();
    rerender(<MessageIndicator unreadCount={undefined} />);
    expect(container.querySelector(".animate-ping")).toBeNull();
  });
});
