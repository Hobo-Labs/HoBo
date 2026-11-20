import { useEffect } from "react";
import * as z from "zod";
import { useLocalStorage } from "./useLocalStorage";

const colorModeSchema = z.enum(["light", "dark"]);

export function useColorMode() {
  const [colorMode, setColorMode] = useLocalStorage(
    "color-theme",
    "light",
    colorModeSchema,
  );

  useEffect(() => {
    const className = "dark";
    const bodyClass = window.document.body.classList;

    if (colorMode === "dark") {
      bodyClass.add(className);
    } else {
      bodyClass.remove(className);
    }
  }, [colorMode]);

  return [colorMode, setColorMode] as const;
}
