import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SettingsPage } from "../src/admin/elements/settings/SettingsPage";
import * as waspOperations from "wasp/client/operations";

const saveAdminProfile = vi.mocked(waspOperations.saveAdminProfile);
const refetchAuth = vi.fn();

vi.mock("wasp/client/operations", () => ({
  saveAdminProfile: vi.fn(),
}));

vi.mock("wasp/client/auth", () => ({
  useAuth: () => ({ refetch: refetchAuth }),
}));

vi.mock("../src/admin/layout/DefaultLayout", () => ({
  DefaultLayout: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
}));

vi.mock("../src/admin/layout/Breadcrumb", () => ({
  Breadcrumb: () => null,
}));

const pendingReaders: MockFileReader[] = [];

class MockFileReader {
  result: string | ArrayBuffer | null = null;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  abort = vi.fn(() => {
    pendingReaders.splice(pendingReaders.indexOf(this), 1);
  });
  readAsDataURL = vi.fn(() => {
    pendingReaders.push(this);
  });

  completeAs(dataUrl: string) {
    this.result = dataUrl;
    this.onload?.();
  }
}

const adminUser = {
  id: "admin",
  isAdmin: true,
  email: "admin@example.test",
  username: "admin",
  fullName: "Ada",
  phoneNumber: null,
  bio: null,
  profilePhoto: null,
};

const savedPhoto =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/a6kAAAAASUVORK5CYII=";

function pickFile(input: HTMLInputElement, file: File) {
  Object.defineProperty(input, "files", {
    configurable: true,
    value: [file],
  });
  fireEvent.change(input);
}

afterEach(cleanup);

beforeEach(() => {
  saveAdminProfile.mockReset();
  refetchAuth.mockReset();
  pendingReaders.length = 0;
  vi.stubGlobal("FileReader", MockFileReader);
});

describe("SettingsPage photo reads", () => {
  it("ignores a superseded reader after an invalid follow-up pick", async () => {
    render(<SettingsPage user={adminUser} />);
    const input = screen.getByLabelText(
      "Choose a photo",
    ) as HTMLInputElement;
    const valid = new File(["png"], "ok.png", { type: "image/png" });
    const invalid = new File(["txt"], "bad.txt", { type: "text/plain" });

    pickFile(input, valid);
    expect(pendingReaders).toHaveLength(1);
    const superseded = pendingReaders[0];
    expect(superseded.abort).not.toHaveBeenCalled();

    pickFile(input, invalid);
    expect(superseded.abort).toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toContain(
      "Choose a PNG, JPEG, or WebP",
    );

    superseded.completeAs(savedPhoto);
    await waitFor(() => {
      expect(screen.queryByRole("img", { name: "Profile preview" })).toBeNull();
    });
    expect(screen.getByRole("alert").textContent).toContain(
      "Choose a PNG, JPEG, or WebP",
    );
  });

  it("does not save while a photo read is still in flight", async () => {
    saveAdminProfile.mockResolvedValue({
      fullName: "Ada",
      phoneNumber: null,
      bio: null,
      profilePhoto: null,
    });
    render(<SettingsPage user={adminUser} />);
    const input = screen.getByLabelText(
      "Choose a photo",
    ) as HTMLInputElement;
    const valid = new File(["png"], "ok.png", { type: "image/png" });
    pickFile(input, valid);
    expect(pendingReaders).toHaveLength(1);

    const form = screen.getByRole("button", { name: "Save settings" })
      .closest("form");
    expect(form).not.toBeNull();
    fireEvent.submit(form!);

    await waitFor(() => {
      expect(saveAdminProfile).not.toHaveBeenCalled();
    });
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("clears the file input when Remove photo is clicked", async () => {
    render(
      <SettingsPage
        user={{ ...adminUser, profilePhoto: savedPhoto }}
      />,
    );
    const input = screen.getByLabelText(
      "Choose a photo",
    ) as HTMLInputElement;
    const file = new File(["png"], "keep.png", { type: "image/png" });
    pickFile(input, file);
    pendingReaders[0].completeAs(savedPhoto);
    await waitFor(() => {
      expect(screen.getByRole("img", { name: "Profile preview" })).toBeTruthy();
    });

    fireEvent.click(screen.getByRole("button", { name: "Remove photo" }));

    expect(input.value).toBe("");
    await waitFor(() => {
      expect(screen.queryByRole("img", { name: "Profile preview" })).toBeNull();
    });
  });

  it("clears the file input when Cancel is clicked", () => {
    render(
      <SettingsPage
        user={{ ...adminUser, profilePhoto: savedPhoto }}
      />,
    );
    const input = screen.getByLabelText(
      "Choose a photo",
    ) as HTMLInputElement;
    const file = new File(["png"], "keep.png", { type: "image/png" });
    pickFile(input, file);
    pendingReaders[0].completeAs(savedPhoto);

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(input.value).toBe("");
  });
});