"""Mirror a native terminal's output into the run's ordinary output collector.

This is raw terminal evidence, not structured tool telemetry or input auditing.
The file lives inside the disposable container, never the mounted project.
"""
import os
import pty
import sys

with open("/tmp/periscope-terminal.log", "ab", buffering=0) as transcript:
    def record(fd):
        data = os.read(fd, 4096)
        transcript.write(data)
        return data

    status = pty.spawn(sys.argv[1:], master_read=record)
sys.exit(os.waitstatus_to_exitcode(status))
