"""Lightweight sandbox runner for user code execution.

This module is intentionally kept free of heavy dependencies (no httpx,
BeautifulSoup, pydantic-ai, MongoDB drivers, etc.) to keep it fast to import.
"""

import datetime
import json
import math
import queue
import re
import sys
import threading
import time
from typing import Any


_SAFE_BUILTINS = {
    "json": json,
    "re": re,
    "math": math,
    "datetime": datetime,
    "str": str,
    "int": int,
    "float": float,
    "bool": bool,
    "list": list,
    "dict": dict,
    "len": len,
    "range": range,
    "enumerate": enumerate,
    "sorted": sorted,
    "min": min,
    "max": max,
    "sum": sum,
    "round": round,
    "abs": abs,
    "isinstance": isinstance,
    "print": print,
    "True": True,
    "False": False,
    "None": None,
}


class _SandboxTimeout(BaseException):
    """Raised inside the sandbox thread to unwind it once the deadline passes.

    Derives from BaseException so sandboxed ``except Exception`` handlers can't
    swallow it and keep the thread alive.
    """


def execute_sandboxed_code(code: str, input_data: Any, timeout: int = 10) -> dict[str, Any]:
    """Execute sandboxed code in a daemon thread with a timeout.

    Returns a dict with one of:
    - ``{"result": <value>}`` on success
    - ``{"error": <message>}`` on runtime error
    - ``{"timed_out": True}`` when the code exceeds the timeout

    The thread is *stopped* on timeout, not abandoned. Python has no way to kill
    a thread from outside, so we install a per-thread trace function that raises
    once the deadline passes; because tracing fires per line, any pure-Python
    loop unwinds promptly.

    Abandoning it is not a survivable option: a runaway like ``while True: pass``
    would keep spinning for the life of the process, holding the GIL between
    switch intervals and degrading everything else in it. In a Celery worker
    that is permanent, and it accumulates one pegged core per timeout.

    Two costs, both measured and both judged acceptable:

    - Tracing makes sandboxed code ~5.4x slower (a 200k-iteration loop goes from
      8.1ms to 43.3ms). Realistic Code-node and validation-expression payloads
      are orders of magnitude smaller than that, and sit alongside LLM calls
      taking seconds, so the absolute cost is negligible. Sampling the clock
      rather than checking it every line only recovered ~5%, so it isn't worth
      the extra state.
    - A runaway *inside a single C call* (e.g. ``sum(range(10**18))`` — both
      names are in ``_SAFE_BUILTINS``) executes no Python lines, so the trace
      function never fires and that call still cannot be interrupted. Only a
      killable subprocess closes that gap, at the cost of process startup and
      requiring picklable input. Worth revisiting if it shows up in practice.
    """
    result_holder: dict = {}
    local_vars = {"data": input_data, "result": None}
    deadline = time.monotonic() + timeout

    def _tracer(frame, event, arg):  # type: ignore[no-untyped-def]
        if time.monotonic() >= deadline:
            raise _SandboxTimeout
        return _tracer

    def _run() -> None:
        sys.settrace(_tracer)
        try:
            exec(code, {"__builtins__": _SAFE_BUILTINS}, local_vars)  # noqa: S102  # nosec B102
        except _SandboxTimeout:
            result_holder["timed_out"] = True
            return
        except Exception as exc:
            result_holder["error"] = str(exc)
            return
        finally:
            sys.settrace(None)
        result_holder["result"] = local_vars.get("result")

    thread = threading.Thread(target=_run, daemon=True)
    thread.start()
    # Allow a little slack past the deadline for the tracer to unwind the stack.
    thread.join(timeout=timeout + 1.0)

    if thread.is_alive() or result_holder.get("timed_out"):
        return {"timed_out": True}

    return result_holder if result_holder else {"result": local_vars.get("result")}


def run_sandboxed_code(code: str, input_data: Any, result_queue: queue.Queue[dict[str, Any]]) -> None:
    """Legacy entry point for multiprocessing-based execution."""
    local_vars = {"data": input_data, "result": None}

    try:
        exec(code, {"__builtins__": _SAFE_BUILTINS}, local_vars)  # noqa: S102  # nosec B102
    except Exception as exc:
        result_queue.put({"error": str(exc)})
        return

    try:
        result_queue.put({"result": local_vars.get("result", "")})
    except Exception:
        result_queue.put({"result": str(local_vars.get("result", ""))})
