#!/usr/bin/env python3
# شواهد شکست آزمون مرورگر (پایدار؛ فقط هنگام شکست اجرا می‌شود). زمینه: webkit-dark-375 در PR #106.
# شواهدی را که در artifact هست ولی از بیرون خوانده نمی‌شود در لاگ Job چاپ می‌کند:
# خلاصهٔ results.json، آزمون‌های هم‌زمان و قبلیِ همان worker، diagnostics.log،
# error-context.md و خط زمانی اقدام‌های trace. داده‌ها همه مصنوعی‌اند؛ هدر، کوکی
# و بدنهٔ درخواست چاپ نمی‌شود.
#
# LM-106-L03: هر خروجی از out() و redact() می‌گذرد؛ Query و Fragment هیچ نشانی‌ای چاپ
# نمی‌شود و نشانی نامعتبر خام برنمی‌گردد. قواعد همان apps/web/e2e/redact.ts است و
# apps/web/test/e2e-redact.test.ts هر دو را با یک مجموعه ورودی می‌سنجد.
import datetime as dt
import glob
import json
import os
import re
import sys
import zipfile
from urllib.parse import urlsplit

LIMIT = 6000


REDACTED = "[redacted]"
UNPARSEABLE = "[unparseable-url]"
WEB_SCHEMES = {"http", "https", "ws", "wss"}
DEFAULT_PORTS = {"http": 80, "https": 443, "ws": 80, "wss": 443}
# پس از ? یا # یا یک طرح مات، تا فاصلهٔ بعدی همه‌چیز حذف می‌شود (مثل redact.ts).
ABSOLUTE = re.compile(r"[A-Za-z][A-Za-z0-9+.-]*://[^\s\"'<>`?#]+(?:[?#]\S*)?")
OPAQUE = re.compile(r"\b(?:data|blob|javascript|about):\S+", re.IGNORECASE)
FRAGMENT = re.compile(r"(/[^\s\"'<>`?#]*)#\S+")
QUERY = re.compile(r"\?(?![.?\s])\S+")


def _absolute(match):
    raw = match.group(0)
    try:
        parts = urlsplit(raw)
        host, port = parts.hostname, parts.port
    except ValueError:
        return UNPARSEABLE
    scheme = parts.scheme.lower()
    if scheme not in WEB_SCHEMES:
        return f"{scheme}:[omitted]"
    if not host:
        return UNPARSEABLE
    netloc = f"[{host}]" if ":" in host else host
    if port is not None and port != DEFAULT_PORTS[scheme]:
        netloc += f":{port}"
    dropped = "?" in raw or "#" in raw
    return f"{scheme}://{netloc}{parts.path or '/'}" + (f"?{REDACTED}" if dropped else "")


def redact(text):
    text = ABSOLUTE.sub(_absolute, str(text))
    text = OPAQUE.sub(lambda m: m.group(0)[: m.group(0).index(":") + 1] + "[omitted]", text)
    text = FRAGMENT.sub(lambda m: f"{m.group(1)}#{REDACTED}", text)
    return QUERY.sub(f"?{REDACTED}", text)


def out(text=""):
    print(redact(text))


def parse_time(value):
    return dt.datetime.fromisoformat(value.replace("Z", "+00:00"))


def flatten(suite, path=()):
    for child in suite.get("suites", []):
        yield from flatten(child, path + (child.get("title", ""),))
    for spec in suite.get("specs", []):
        for test in spec.get("tests", []):
            for result in test.get("results", []):
                start = parse_time(result["startTime"])
                yield {
                    "title": spec["title"],
                    "where": f'{spec.get("file")}:{spec.get("line")}',
                    "project": test.get("projectName"),
                    "status": result.get("status"),
                    "worker": result.get("workerIndex"),
                    "parallel": result.get("parallelIndex"),
                    "start": start,
                    "end": start + dt.timedelta(milliseconds=result.get("duration", 0)),
                    "errors": [e.get("message", "") for e in result.get("errors", [])],
                    "attachments": [a.get("path") for a in result.get("attachments", []) if a.get("path")],
                }


def short(text, limit=LIMIT):
    return text if len(text) <= limit else text[:limit] + f"\n… [{len(text) - limit} chars truncated]"


NOISE = {"Continue request", "Fulfill request", "Abort request", "Fallback request", "continue", "fulfill", "abort", "fallback"}


def trace_timeline(path):
    """برای هر پروندهٔ trace جداگانه، بی فراخوان‌های Route ساختگی (فقط نویز)."""
    out = {}
    try:
        with zipfile.ZipFile(path) as zf:
            for name in sorted(n for n in zf.namelist() if n.endswith(".trace")):
                lines, noisy = out.setdefault(name, []), set()
                for line in zf.read(name).decode("utf-8", "replace").splitlines():
                    try:
                        event = json.loads(line)
                    except ValueError:
                        continue
                    kind = event.get("type")
                    call, stamp = event.get("callId"), event.get("startTime") or event.get("endTime") or event.get("time") or ""
                    if kind == "before":
                        title = event.get("apiName") or event.get("title") or event.get("method")
                        if title in NOISE:
                            noisy.add(call)
                            continue
                        lines.append(f'{stamp} before {call} {title}')
                    elif kind == "after" and call not in noisy:
                        error = event.get("error")
                        lines.append(f'{stamp} after  {call}' + (f' ERROR {str(error)[:300]}' if error else ""))
                    elif kind == "log" and call not in noisy:
                        lines.append(f'{stamp} log    {call} {str(event.get("message"))[:200]}')
                    elif kind == "console":
                        lines.append(f'{stamp} console.{event.get("messageType")} {str(event.get("text"))[:200]}')
                    elif kind == "event":
                        lines.append(f'{stamp} event  {event.get("method")} {event.get("class", "")}')
    except (OSError, zipfile.BadZipFile) as err:
        out.setdefault("error", []).append(f"cannot read trace: {err}")
    return out


def main():
    root = sys.argv[1] if len(sys.argv) > 1 else "apps/web/test-results"
    results_path = os.path.join(root, "results.json")
    if not os.path.exists(results_path):
        out(f"no {results_path}")
        return
    rows = [r for s in json.load(open(results_path)).get("suites", []) for r in flatten(s)]
    failed = [r for r in rows if r["status"] not in ("passed", "skipped")]
    out(f"== {len(rows)} results, {len(failed)} not passed")
    for f in failed:
        out("\n" + "=" * 100)
        out(f'FAILED [{f["project"]}] {f["where"]} :: {f["title"]}')
        out(f'status={f["status"]} worker={f["worker"]} parallel={f["parallel"]} start={f["start"].isoformat()} end={f["end"].isoformat()} dur={(f["end"] - f["start"]).total_seconds():.1f}s')
        for message in f["errors"]:
            out(short(message, 1500))
        same_worker = [r for r in rows if r["worker"] == f["worker"] and r["end"] <= f["start"]]
        out("-- previous tests in the same worker process (same browser instance):")
        for r in sorted(same_worker, key=lambda r: r["start"])[-4:]:
            out(f'   {r["start"].strftime("%H:%M:%S")} {(r["end"] - r["start"]).total_seconds():5.1f}s {r["status"]:8} [{r["project"]}] {r["where"]} {r["title"][:60]}')
        out("-- tests overlapping in time (other workers):")
        for r in sorted(rows, key=lambda r: r["start"]):
            if r is not f and r["start"] < f["end"] and r["end"] > f["start"]:
                out(f'   {r["start"].strftime("%H:%M:%S")}-{r["end"].strftime("%H:%M:%S")} w{r["worker"]}/p{r["parallel"]} {r["status"]:8} [{r["project"]}] {r["where"]} {r["title"][:60]}')
        folders = {os.path.dirname(p) for p in f["attachments"]}
        for folder in sorted(folders):
            for name in ("diagnostics.log", "error-context.md"):
                path = os.path.join(folder, name)
                if os.path.exists(path):
                    out(f"-- {name} ({path})")
                    out(short(open(path, encoding="utf-8", errors="replace").read()))
            for trace in glob.glob(os.path.join(folder, "trace.zip")):
                for name, lines in trace_timeline(trace).items():
                    out(f"-- trace {name}: last 40 of {len(lines)} entries ({trace})")
                    out("\n".join(lines[-40:]))


if __name__ == "__main__":
    main()
