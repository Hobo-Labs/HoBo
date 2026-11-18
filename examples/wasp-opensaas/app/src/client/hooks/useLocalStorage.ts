import { useEffect, useRef, useState } from "react";
import type { ZodType } from "zod";

type SetValue<T> = T | ((val: T) => T);

export function useLocalStorage<T>(
  key: string,
  initialValue: T,
  schema: ZodType<T>,
): [T, (value: SetValue<T>) => void] {
  const storageRead = useRef(false);
  const [storedValue, setStoredValue] = useState<T>(() => {
    if (!globalThis.window) {
      return initialValue;
    }
    storageRead.current = true;
    try {
      const item = window.localStorage.getItem(key);
      return item === null ? initialValue : schema.parse(JSON.parse(item));
    } catch {
      return initialValue;
    }
  });

  useEffect(() => {
    if (!globalThis.window) {
      return;
    }

    if (!storageRead.current) {
      storageRead.current = true;
      try {
        const item = window.localStorage.getItem(key);
        if (item !== null) {
          setStoredValue(schema.parse(JSON.parse(item)));
        }
      } catch {
        return;
      }
      return;
    }

    try {
      const value = JSON.stringify(storedValue);
      if (value !== undefined) {
        window.localStorage.setItem(key, value);
      }
    } catch (error) {
      console.warn("Unable to save preference", error);
    }
  }, [key, storedValue, schema]);

  return [storedValue, setStoredValue];
}