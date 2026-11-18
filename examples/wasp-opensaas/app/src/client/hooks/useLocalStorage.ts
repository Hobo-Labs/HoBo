import { useEffect, useRef, useState } from "react";
import type { ZodType } from "zod";

type SetValue<T> = T | ((val: T) => T);

export function useLocalStorage<T>(
  key: string,
  initialValue: T,
  schema: ZodType<T>,
): [T, (value: SetValue<T>) => void] {
  const storageRead = useRef(false);
  const [storedValue, setStoredValue] = useState<T>(initialValue);

  useEffect(() => {
    storageRead.current = false;
  }, [key]);

  useEffect(() => {
    if (!globalThis.window) {
      return;
    }

    if (!storageRead.current) {
      storageRead.current = true;
      try {
        const item = window.localStorage.getItem(key);
        if (item === null) {
          setStoredValue(initialValue);
          return;
        }
        setStoredValue(schema.parse(JSON.parse(item)));
      } catch {
        setStoredValue(initialValue);
        try {
          window.localStorage.setItem(key, JSON.stringify(initialValue));
        } catch {
          return;
        }
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
  }, [key, storedValue, schema, initialValue]);

  return [storedValue, setStoredValue];
}