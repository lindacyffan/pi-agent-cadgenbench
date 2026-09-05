import json
import tempfile
import unittest
from pathlib import Path

from pi_stream_filter import PiStreamFilter, process_stream


class PiStreamFilterTest(unittest.TestCase):
    def test_formats_tool_calls_results_and_completion(self):
        stream_filter = PiStreamFilter()

        events = [
            {"type": "message_update", "delta": "partial token"},
            {
                "type": "tool_execution_start",
                "toolCallId": "call-1",
                "toolName": "execute",
                "args": {"code": "from build123d import *\nbody = Box(1, 2, 3)"},
            },
            {
                "type": "message_end",
                "message": {
                    "role": "toolResult",
                    "toolCallId": "call-1",
                    "toolName": "execute",
                    "content": [{"type": "text", "text": "registered shape\nvolume: 6"}],
                },
            },
            {
                "type": "tool_execution_start",
                "toolCallId": "call-2",
                "toolName": "validate",
                "args": {},
            },
            {
                "type": "message_end",
                "message": {
                    "role": "toolResult",
                    "toolCallId": "call-2",
                    "toolName": "validate",
                    "content": [{"type": "text", "text": "PASS: geometry is valid"}],
                },
            },
            {"type": "agent_settled"},
        ]

        output = [entry for event in events for entry in stream_filter.process(event)]

        joined = "\n".join(line for line, _ in output)
        self.assertIn("execute #1: from build123d import * body = Box(1, 2, 3)", joined)
        self.assertIn("<- execute: registered shape volume: 6", joined)
        self.assertIn(">> validate()", joined)
        self.assertIn("<- validate: PASS: geometry is valid", joined)
        self.assertIn("AGENT SETTLED", joined)
        self.assertNotIn("partial token", joined)

    def test_highlights_errors_warnings_and_completion(self):
        stream_filter = PiStreamFilter()

        events = [
            {
                "type": "message_end",
                "message": {
                    "role": "assistant",
                    "content": [{"type": "thinking", "thinking": "Check the bore diameter."}],
                },
            },
            {
                "type": "message_end",
                "message": {
                    "role": "toolResult",
                    "toolCallId": "call-error",
                    "toolName": "execute",
                    "content": [{"type": "text", "text": "Worker was not running"}],
                    "isError": True,
                },
            },
            {
                "type": "message_end",
                "message": {
                    "role": "toolResult",
                    "toolCallId": "call-warning",
                    "toolName": "validate",
                    "content": [{"type": "text", "text": "warning: open edge detected"}],
                },
            },
        ]

        output = [entry for event in events for entry in stream_filter.process(event)]
        highlighted = [line for line, important in output if important]
        hidden = [line for line, important in output if not important]

        self.assertTrue(any("thinking: Check the bore diameter." in line for line in highlighted))
        self.assertTrue(any("Worker was not running" in line for line in highlighted))
        self.assertTrue(any("warning: open edge detected" in line for line in highlighted))
        self.assertFalse(highlighted == [])
        self.assertTrue(all("message_update" not in line for line in hidden))

    def test_processes_existing_stream_and_writes_full_log(self):
        with tempfile.TemporaryDirectory() as directory:
            run_dir = Path(directory)
            stream_path = run_dir / "stream.jsonl"
            log_path = run_dir / "filtered.log"
            events = [
                {"type": "message_update", "delta": "ignored"},
                {
                    "type": "tool_execution_start",
                    "toolCallId": "call-export",
                    "toolName": "export",
                    "args": {"filename": "output.step"},
                },
                {
                    "type": "message_end",
                    "message": {
                        "role": "toolResult",
                        "toolCallId": "call-export",
                        "toolName": "export",
                        "content": [{"type": "text", "text": "exported output.step"}],
                    },
                },
                {"type": "agent_settled"},
            ]
            stream_path.write_text(
                "".join(json.dumps(event) + "\n" for event in events), encoding="utf-8"
            )
            printed = []

            processed = process_stream(
                stream_path,
                log_path,
                follow=False,
                printer=printed.append,
            )

            log_text = log_path.read_text(encoding="utf-8")
            self.assertGreaterEqual(processed, 3)
            self.assertIn(">> export(output.step)", log_text)
            self.assertIn("<- export: exported output.step", log_text)
            self.assertIn("AGENT SETTLED", log_text)
            self.assertTrue(any(">> export(output.step)" in line for line in printed))
            self.assertTrue(any("AGENT SETTLED" in line for line in printed))
            self.assertFalse(any("ignored" in line for line in printed))

    def test_prefers_tool_execution_result_over_duplicate_message_result(self):
        stream_filter = PiStreamFilter()
        tool_call_id = "call-result"
        events = [
            {
                "type": "tool_execution_start",
                "toolCallId": tool_call_id,
                "toolName": "execute",
                "args": {"code": "show(Box(1, 1, 1))"},
            },
            {
                "type": "tool_execution_end",
                "toolCallId": tool_call_id,
                "toolName": "execute",
                "result": {
                    "content": [{"type": "text", "text": "volume: 1"}],
                    "isError": False,
                },
            },
            {
                "type": "message_end",
                "message": {
                    "role": "toolResult",
                    "toolCallId": tool_call_id,
                    "toolName": "execute",
                    "content": [{"type": "text", "text": "volume: 1"}],
                },
            },
        ]

        output = [entry for event in events for entry in stream_filter.process(event)]
        result_lines = [line for line, _ in output if "volume: 1" in line]

        self.assertEqual(len(result_lines), 1)
        self.assertEqual(stream_filter.execute_count, 1)

    def test_follow_exits_when_existing_stream_is_already_complete(self):
        with tempfile.TemporaryDirectory() as directory:
            run_dir = Path(directory)
            stream_path = run_dir / "stream.jsonl"
            log_path = run_dir / "filtered.log"
            stream_path.write_text(
                json.dumps({"type": "agent_settled"}) + "\n",
                encoding="utf-8",
            )

            def fail_if_polled(interval):
                self.fail("follow mode should stop without polling a complete stream")

            processed = process_stream(
                stream_path,
                log_path,
                follow=True,
                sleeper=fail_if_polled,
                printer=lambda line: None,
            )

            self.assertEqual(processed, 1)
            self.assertIn("AGENT SETTLED", log_path.read_text(encoding="utf-8"))


if __name__ == "__main__":
    unittest.main()
