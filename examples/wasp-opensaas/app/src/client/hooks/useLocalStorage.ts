import { useEffect, useState } from "react";
import type { ZodType } from "zod";

type SetValue<T> = T | ((val: T) => T);

export function useLocalStorage<T>(
  key: string,
  initialValue: T,
  schema: ZodType<T>,
): [T, (value: SetValue<T>) => void] {
  const [storedValue, setStoredValue] = useState<T>(() => {
    if (!globalThis.window) {
      return initialValue;
    }

    try {
      const item = window.localStorage.getItem(key);
      return item === null ? initialValue : schema.parse(JSON.parse(item));
    } catch {
      return initialValue;
    }
  });

  useEffect(() => {
    try {
      const value = JSON.stringify(storedValue);
      if (value !== undefined) window.localStorage.setItem(key, value);
    } catch (error) {
      console.warn("Unable to save preference", error);
    }
  }, [key, storedValue]);

  const setValue = (value: SetValue<T>) => {
    setStoredValue((previous) => {
      if (value instanceof Function) return value(previous);
      return value;
    });
  };

  return [storedValue, setValue];
}
