import { api } from "../lib/api.ts";
import { useEffect, useState } from "react";
import { FEATURES, normalizeSearch } from "../lib/navigation.ts";
import { navigate } from "../lib/use-url-state.ts";

export function FeatureSearch() {
  const [query, setQuery] = useState("");
  const [allowed, setAllowed] = useState<Set<string>>(new Set());
  const [checking, setChecking] = useState(false);
  const active = query.trim().length > 0;
  useEffect(() => {
    if (!active) return;
    const controller = new AbortController(); setChecking(true); setAllowed(new Set());
    const operations = [...new Set(FEATURES.flatMap(f => f.anyOf))];
    void Promise.allSettled(operations.map(async operation => {
      const verdict = await api.get<{verdict: string}>(`/auth/can?operation=${encodeURIComponent(operation)}`, {signal: controller.signal});
      return verdict.verdict === "allow" ? operation : null;
    })).then(results => { if (!controller.signal.aborted) {
      setAllowed(new Set(results.flatMap(r => r.status === "fulfilled" && r.value ? [r.value] : []))); setChecking(false);
    }});
    return () => controller.abort();
  }, [active]);
  const needle = normalizeSearch(query).toLocaleLowerCase();
  const results = needle ? FEATURES.filter(f => (f.anyOf.length === 0 || f.anyOf.some(p => allowed.has(p))) && normalizeSearch(`${f.label} ${f.words}`).toLocaleLowerCase().includes(needle)) : [];
  return <div className="feature-search">
    <label><span className="sr-only">پیداکردن بخش یا ابزار</span><input type="search" value={query}
      placeholder="پیداکردن بخش یا ابزار…" maxLength={80} onChange={e => setQuery(e.target.value)}
      onKeyDown={e => { if (e.key === "Escape") setQuery(""); }} /></label>
    {needle && <div className="feature-results solid" aria-label="نتایج جست‌وجوی بخش‌ها">
      {results.map(f => <a href={f.href} key={f.label} onClick={e => {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
        e.preventDefault(); navigate(f.href); setQuery("");
      }}>{f.label}</a>)}
      {checking && <p role="status">بررسی دسترسی‌ها…</p>}
      {!checking && !results.length && <p role="status">بخشی با این نام پیدا نشد.</p>}
    </div>}
  </div>;
}
