import { useEffect, useRef, useState } from "react";
import type { ZodType } from "zod";

type SetValue<T> = T | ((val: T) => T);

function readStoredValue<T>(
  key: string,
  initialValue: T,
  schema: ZodType<T>,
): T {
  if (!globalThis.window) {
    return initialValue;
  }
  try {
    const item = window.localStorage.getItem(key);
    if (item === null) {
      return initialValue;
    }
    return schema.parse(JSON.parse(item));
  } catch {
    return initialValue;
  }
}

export function useLocalStorage<T>(
  key: string,
  initialValue: T,
  schema: ZodType<T>,
): [T, (value: SetValue<T>) => void] {
  const [storedValue, setStoredValue] = useState<T>(() =>
    readStoredValue(key, initialValue, schema),
  );
  const skipPersist = useRef(true);

  useEffect(() => {
    if (!globalThis.window) {
      return;
    }
    skipPersist.current = true;
    try {
      const item = window.localStorage.getItem(key);
      if (item === null) {
        setStoredValue(initialValue);
        window.localStorage.setItem(key, JSON.stringify(initialValue));
        return;
      }
      setStoredValue(schema.parse(JSON.parse(item)));
    } catch {
      setStoredValue(initialValue);
      window.localStorage.setItem(key, JSON.stringify(initialValue));
    }
  }, [key, initialValue, schema]);

  useEffect(() => {
    if (!globalThis.window) {
      return;
    }
    if (skipPersist.current) {
      skipPersist.current = false;
      return;
    }
    try {
      const item = window.localStorage.getItem(key);
      const serialized = JSON.stringify(storedValue);
      if (item !== serialized) {
        window.localStorage.setItem(key, serialized);
      }
    } catch (error) {
      console.warn("Unable to save preference", error);
    }
  }, [key, storedValue]);

  return [storedValue, setStoredValue];
}