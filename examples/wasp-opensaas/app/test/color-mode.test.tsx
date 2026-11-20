import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useColorMode } from "../src/client/hooks/useColorMode";

beforeEach(() => {
  localStorage.clear();
  document.body.classList.remove("dark");
});

afterEach(cleanup);

describe("color mode", () => {
  it("restores a valid preference and updates the document", () => {
    localStorage.setItem("color-theme", JSON.stringify("dark"));
    const { result } = renderHook(() => useColorMode());
    expect(result.current[0]).toBe("dark");
    expect(document.body.classList.contains("dark")).toBe(true);
  });

  it("falls back to light for invalid stored data", () => {
    localStorage.setItem("color-theme", JSON.stringify("unexpected"));
    const { result } = renderHook(() => useColorMode());
    expect(result.current[0]).toBe("light");
    expect(localStorage.getItem("color-theme")).toBe('"light"');
  });

  it("persists changes and functional updates", () => {
    const { result } = renderHook(() => useColorMode());
    act(() => result.current[1]("dark"));
    expect(localStorage.getItem("color-theme")).toBe('"dark"');
    expect(document.body.classList.contains("dark")).toBe(true);
    act(() =>
      result.current[1]((value) => (value === "dark" ? "light" : "dark")),
    );
    expect(localStorage.getItem("color-theme")).toBe('"light"');
    expect(document.body.classList.contains("dark")).toBe(false);
  });
});
