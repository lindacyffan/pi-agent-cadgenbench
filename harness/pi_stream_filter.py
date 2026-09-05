#!/usr/bin/env python3
"""Turn a Pi JSON stream into a concise live trajectory log."""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from pathlib import Path
from typing import Callable, List, Optional, Tuple


OutputEntry = Tuple[str, bool]


HIGH_SIGNAL_WORDS = (
    "pass",
    "fail",
    "validity gate",
    "gate fail",
    "exported",
    "error",
    "warning",
    "worker was not running",
    "worker crashed",
    "failed to start",
    "non-manifold",
    "open edge",
)


def compact(value: object, limit: int = 220) -> str:
    text = " ".join(str(value).split())
    return text[:limit]


def text_from_content(content: object) -> str:
    if content is None:
        return ""
    if isinstance(content, str):
        return content
    if isinstance(content, dict):
        content = content.get("content", content.get("result", ""))
        return text_from_content(content)
    if isinstance(content, list):
        parts = []
        for item in content:
            if not isinstance(item, dict):
                continue
            if item.get("type") == "text" and item.get("text"):
                parts.append(str(item["text"]))
        return "\n".join(parts)
    return str(content)


class PiStreamFilter:
    def __init__(self) -> None:
        self.started_at = time.monotonic()
        self.execute_count = 0
        self.completed = False
        self.tool_names = {}
        self.result_seen = set()

    def stamp(self) -> str:
        return "[{:4d}s]".format(int(time.monotonic() - self.started_at))

    def process(self, event: dict) -> List[OutputEntry]:
        event_type = event.get("type")
        if event_type == "message_update":
            return []
        if event_type == "tool_execution_start":
            return self.process_tool_start(event)
        if event_type == "tool_execution_end":
            return self.process_tool_end(event)
        if event_type == "message_end":
            return self.process_message_end(event)
        if event_type == "agent_settled":
            self.completed = True
            return [(f"{self.stamp()} AGENT SETTLED", True)]
        if event_type in {"error", "fatal"}:
            message = compact(event.get("message") or event.get("error") or event)
            return [(f"{self.stamp()} ERROR: {message}", True)]
        if event_type == "result":
            message = compact(event.get("result", ""))
            return [(f"{self.stamp()} RESULT: {message}", True)]
        return []

    def process_tool_start(self, event: dict) -> List[OutputEntry]:
        tool_call_id = event.get("toolCallId")
        name = event.get("toolName") or "tool"
        if tool_call_id is not None:
            self.tool_names[tool_call_id] = name
        args = event.get("args") or event.get("arguments") or {}

        if name == "execute":
            self.execute_count += 1
            preview = compact(args.get("code", ""), limit=180)
            return [(f"{self.stamp()} execute #{self.execute_count}: {preview}", True)]
        if name in {"validate", "export"}:
            argument = args.get("filename") or args.get("object_name") or ""
            suffix = f"({argument})" if argument else "()"
            return [(f"{self.stamp()} >> {name}{suffix}", True)]
        return [(f"{self.stamp()} . {name}", False)]

    def process_tool_end(self, event: dict) -> List[OutputEntry]:
        tool_call_id = event.get("toolCallId")
        if tool_call_id is None or tool_call_id in self.result_seen:
            return []
        result = event.get("result", {})
        if isinstance(result, str):
            result = {"content": result}
        entries = self.format_tool_result(
            tool_call_id=tool_call_id,
            result=result,
            fallback_name=event.get("toolName"),
        )
        self.result_seen.add(tool_call_id)
        return entries

    def process_message_end(self, event: dict) -> List[OutputEntry]:
        message = event.get("message") or {}
        role = message.get("role")
        if role == "toolResult":
            tool_call_id = message.get("toolCallId")
            if tool_call_id in self.result_seen:
                return []
            entries = self.format_tool_result(
                tool_call_id=tool_call_id,
                result=message,
                fallback_name=message.get("toolName"),
            )
            if tool_call_id is not None:
                self.result_seen.add(tool_call_id)
            return entries
        if role != "assistant":
            return []

        entries = []
        content = message.get("content") or []
        if not isinstance(content, list):
            content = []
        for item in content:
            if not isinstance(item, dict):
                continue
            if item.get("type") == "thinking" and item.get("thinking"):
                entries.append((f"{self.stamp()} thinking: {compact(item['thinking'], 180)}", True))
            elif item.get("type") == "text" and item.get("text"):
                entries.append((f"{self.stamp()} chat: {compact(item['text'], 180)}", True))
        return entries

    def format_tool_result(
        self,
        tool_call_id: Optional[str],
        result: dict,
        fallback_name: Optional[str],
    ) -> List[OutputEntry]:
        name = fallback_name or self.tool_names.get(tool_call_id or "", "tool")
        text = text_from_content(result.get("content"))
        if not text and isinstance(result.get("details"), dict):
            text = text_from_content(result["details"].get("result"))
        if not text:
            text = text_from_content(result)
        message = compact(text)
        is_error = bool(result.get("isError") or result.get("error"))
        lower = message.lower()
        important = is_error or name in {"validate", "export"} or any(
            word in lower for word in HIGH_SIGNAL_WORDS
        )
        return [(f"{self.stamp()}   <- {name}: {message}", important)]


def terminal_safe(line: str) -> str:
    encoding = getattr(sys.stdout, "encoding", None) or "utf-8"
    return line.encode(encoding, errors="replace").decode(encoding, errors="replace")


def print_line(line: str) -> None:
    print(terminal_safe(line), flush=True)


def process_stream(
    stream_path: Path,
    log_path: Path,
    follow: bool = False,
    poll_interval: float = 0.25,
    sleeper: Callable[[float], None] = time.sleep,
    printer: Callable[[str], None] = print_line,
) -> int:
    stream_filter = PiStreamFilter()
    position = 0
    pending = b""
    processed = 0

    with log_path.open("a", encoding="utf-8", buffering=1) as log:
        while True:
            if stream_path.exists():
                size = stream_path.stat().st_size
                if size < position:
                    position = 0
                    pending = b""
                    stream_filter = PiStreamFilter()
                with stream_path.open("rb") as stream:
                    stream.seek(position)
                    while True:
                        chunk = stream.read(65536)
                        if not chunk:
                            break
                        pending += chunk
                        while True:
                            newline = pending.find(b"\n")
                            if newline < 0:
                                break
                            raw, pending = pending[:newline], pending[newline + 1 :]
                            processed += handle_raw_line(
                                raw, stream_filter, log, printer
                            )
                    position = stream.tell()

                if stream_filter.completed:
                    return processed
                if not follow:
                    if pending:
                        processed += handle_raw_line(pending, stream_filter, log, printer)
                    return processed
            elif not follow:
                raise FileNotFoundError(stream_path)
            sleeper(poll_interval)


def handle_raw_line(
    raw: bytes,
    stream_filter: PiStreamFilter,
    log,
    printer: Callable[[str], None],
) -> int:
    line = raw.decode("utf-8", errors="replace").strip()
    if not line:
        return 0
    try:
        event = json.loads(line)
    except json.JSONDecodeError:
        return 0
    if not isinstance(event, dict):
        return 0
    entries = stream_filter.process(event)
    for line, important in entries:
        log.write(line + "\n")
        if important:
            printer(line)
    return len(entries)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("run_dir", type=Path, help="Pi experiment run directory")
    parser.add_argument(
        "--follow",
        action="store_true",
        help="Wait for new events and stop after agent_settled",
    )
    args = parser.parse_args()
    stream_path = args.run_dir / "stream.jsonl"
    log_path = args.run_dir / "filtered.log"
    try:
        process_stream(stream_path, log_path, follow=args.follow)
    except KeyboardInterrupt:
        return 130
    except FileNotFoundError:
        print(f"Stream not found: {stream_path}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
