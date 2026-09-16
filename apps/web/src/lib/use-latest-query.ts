import { useEffect, useRef, useState } from "react";
import { RequestSequence } from "./request-sequence.ts";

export function useLatestQuery<T>({ key, version = 0, load, delay = 0, enabled = true }: {
  key: string; version?: number; load: (signal: AbortSignal) => Promise<T>; delay?: number; enabled?: boolean;
}) {
  const sequence = useRef(new RequestSequence());
  const [result, setResult] = useState<{ key: string; version: number; data: T | null; error: unknown; loading: boolean }>({ key, version, data: null, error: null, loading: true });
  useEffect(() => {
    const requests = sequence.current;
    if (!enabled) { requests.cancel(); return; }
    const request = requests.begin();
    setResult({ key, version, data: null, error: null, loading: true });
    const timer = setTimeout(() => {
      void load(request.signal).then(data => {
        if (request.current()) setResult({ key, version, data, error: null, loading: false });
      }, error => {
        if (request.current()) setResult({ key, version, data: null, error, loading: false });
      });
    }, delay);
    return () => { clearTimeout(timer); requests.cancel(); };
  }, [key, version, load, delay, enabled]);
  const current = result.key === key && result.version === version;
  return { data: current ? result.data : null, error: current ? result.error : null, loading: enabled && (!current || result.loading) };
}
