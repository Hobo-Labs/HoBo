// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  canSubmitSettings,
  clearPhotoFileInput,
  handlePhotoFileChange,
  invalidatePhotoRead,
  invalidPhotoMessage,
  type PhotoReadCallbacks,
  type PhotoReadControl,
} from "../src/admin/elements/settings/settingsPhotoRead";

const savedPhoto =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/a6kAAAAASUVORK5CYII=";

const pendingReaders: MockFileReader[] = [];

class MockFileReader {
  result: string | ArrayBuffer | null = null;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  abort = vi.fn(() => {
    const index = pendingReaders.indexOf(this);
    if (index >= 0) pendingReaders.splice(index, 1);
  });
  readAsDataURL = vi.fn(() => {
    pendingReaders.push(this);
  });

  completeAs(dataUrl: string) {
    this.result = dataUrl;
    this.onload?.();
  }
}

function createCallbacks(): PhotoReadCallbacks & {
  draftPhoto: string | null;
  error: string;
  reading: boolean;
} {
  const state: { draftPhoto: string | null; error: string; reading: boolean } = {
    draftPhoto: null,
    error: "",
    reading: false,
  };
  return {
    get draftPhoto() {
      return state.draftPhoto;
    },
    get error() {
      return state.error;
    },
    get reading() {
      return state.reading;
    },
    setReading: (reading) => {
      state.reading = reading;
    },
    setDraftPhoto: (dataUrl) => {
      state.draftPhoto = dataUrl;
    },
    setError: (message) => {
      state.error = message;
    },
    clearError: () => {
      state.error = "";
    },
    clearNotice: () => {},
  };
}

beforeEach(() => {
  pendingReaders.length = 0;
  vi.stubGlobal("FileReader", MockFileReader);
});

describe("settings photo read", () => {
  it("aborts a superseded reader when an invalid file is chosen next", () => {
    const control: PhotoReadControl = { generation: 0, activeReader: null };
    const callbacks = createCallbacks();
    const valid = new File(["png"], "ok.png", { type: "image/png" });
    const invalid = new File(["txt"], "bad.txt", { type: "text/plain" });

    handlePhotoFileChange(
      control,
      callbacks,
      valid,
      256 * 1024,
      (value) => (typeof value === "string" ? value : null),
    );
    const superseded = pendingReaders[0];
    expect(superseded.abort).not.toHaveBeenCalled();

    handlePhotoFileChange(
      control,
      callbacks,
      invalid,
      256 * 1024,
      (value) => (typeof value === "string" ? value : null),
    );
    expect(superseded.abort).toHaveBeenCalled();
    expect(callbacks.error).toBe(invalidPhotoMessage);

    superseded.completeAs(savedPhoto);
    expect(callbacks.draftPhoto).toBeNull();
    expect(callbacks.error).toBe(invalidPhotoMessage);
  });

  it("does not allow submit while a photo read is in flight", () => {
    expect(canSubmitSettings(true, false)).toBe(false);
    expect(canSubmitSettings(false, true)).toBe(false);
    expect(canSubmitSettings(true, true)).toBe(false);
    expect(canSubmitSettings(false, false)).toBe(true);
  });

  it("clears a file input value", () => {
    const input = { value: "C:\\fakepath\\keep.png" };
    // SAFETY: clearPhotoFileInput only reads and writes `value`.
    clearPhotoFileInput(input as HTMLInputElement);
    expect(input.value).toBe("");
  });

  it("invalidates an in-flight read when canceling via invalidatePhotoRead", () => {
    const control: PhotoReadControl = { generation: 0, activeReader: null };
    const callbacks = createCallbacks();
    const file = new File(["png"], "ok.png", { type: "image/png" });
    handlePhotoFileChange(
      control,
      callbacks,
      file,
      256 * 1024,
      (value) => (typeof value === "string" ? value : null),
    );
    expect(control.activeReader).not.toBeNull();
    invalidatePhotoRead(control, callbacks);
    expect(control.activeReader).toBeNull();
    expect(callbacks.reading).toBe(false);
  });
});