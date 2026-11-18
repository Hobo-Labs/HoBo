import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as z from "zod";
import { useLocalStorage } from "../src/client/hooks/useLocalStorage";

const schema = z.enum(["alpha", "beta"]);

beforeEach(() => {
  localStorage.clear();
});

afterEach(cleanup);

describe("useLocalStorage", () => {
  it("reads a new key and resets when the new key is missing", () => {
    localStorage.setItem("first", JSON.stringify("alpha"));
    const { result, rerender } = renderHook(
      ({ key }: { key: string }) => useLocalStorage(key, "beta", schema),
      { initialProps: { key: "first" } },
    );
    act(() => undefined);
    expect(result.current[0]).toBe("alpha");
    rerender({ key: "second" });
    act(() => undefined);
    expect(result.current[0]).toBe("beta");
    expect(localStorage.getItem("second")).toBe('"beta"');
  });

  it("rejects invalid stored data for the active key", () => {
    localStorage.setItem("pref", JSON.stringify("gamma"));
    const { result } = renderHook(() =>
      useLocalStorage("pref", "beta", schema),
    );
    act(() => undefined);
    expect(result.current[0]).toBe("beta");
    expect(localStorage.getItem("pref")).toBe('"beta"');
  });
});