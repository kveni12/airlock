import type { SandboxOutput } from "../runtime/sandboxProvider.js";

export class LineDecoder {
  private pending = "";

  constructor(
    private readonly stream: SandboxOutput["stream"],
    private readonly emit: (output: SandboxOutput) => void,
    private readonly maxLineBytes = 64 * 1024
  ) {}

  write(chunk: Buffer | string): void {
    this.pending += chunk.toString();
    const lines = this.pending.split(/\r?\n/);
    this.pending = lines.pop() ?? "";
    for (const line of lines) this.emitLine(line);

    if (Buffer.byteLength(this.pending) > this.maxLineBytes) {
      this.emitLine(this.pending, true);
      this.pending = "";
    }
  }

  flush(): void {
    if (this.pending) this.emitLine(this.pending);
    this.pending = "";
  }

  private emitLine(line: string, truncated = false): void {
    if (!line) return;
    this.emit({
      stream: this.stream,
      line: truncated ? truncateWithMarker(line, this.maxLineBytes) : truncateUtf8(line, this.maxLineBytes)
    });
  }
}

function truncateUtf8(value: string, maxBytes: number): string {
  const bytes = Buffer.from(value);
  if (bytes.length <= maxBytes) return value;
  return bytes.subarray(0, maxBytes).toString("utf8");
}

function truncateWithMarker(value: string, maxBytes: number): string {
  const marker = " [truncated]";
  const markerBytes = Buffer.byteLength(marker);
  if (maxBytes <= markerBytes) return truncateUtf8(marker.trim(), maxBytes);
  return `${truncateUtf8(value, maxBytes - markerBytes)}${marker}`;
}
