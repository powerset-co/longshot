// A small startup display, not a terminal UI: redraw only the current stage and
// three recent lines. Pipes and --json keep the original, complete stderr stream.
import { once } from "node:events";
import { stripVTControlCharacters } from "node:util";

export function startupProgress(json: boolean) {
  const interactive = !!process.stderr.isTTY && !json && process.env.TERM !== "dumb";
  let label = "";
  let started = 0;
  let frame = 0;
  let drawn = 0;
  let timer: ReturnType<typeof setInterval> | undefined;
  let lines: string[] = [];
  const partial = { stdout: "", stderr: "" };

  // Remote output must not move our cursor or wrap into untracked terminal rows.
  function fit(text: string) {
    const clean = stripVTControlCharacters(text).replace(/[\x00-\x1f\x7f-\x9f]/g, " ");
    const width = Math.max(0, (process.stderr.columns || 80) - 1);
    let result = "";
    let used = 0;
    for (const character of clean) {
      used += Bun.stringWidth(character);
      if (used > width) break;
      result += character;
    }
    return result;
  }

  function draw(marker: string, showLogs: boolean) {
    const recent = [...lines, partial.stdout, partial.stderr].filter(Boolean).slice(-3);
    const elapsed = Math.floor((Date.now() - started) / 1000);
    const rows = [
      `${marker} ${label} (${elapsed}s)`,
      ...(showLogs ? recent.map((s) => `  ${s}`) : []),
    ];
    // The cursor stays on the blank line below our display. Never hide it, so
    // Ctrl+C needs no terminal restoration or custom signal handling.
    const clear = drawn ? `\x1b[${drawn}A\r\x1b[J` : "";
    process.stderr.write(clear + rows.map(fit).join("\n") + "\n");
    drawn = rows.length;
  }

  function finish(success = true) {
    clearInterval(timer);
    timer = undefined;
    if (interactive && label) draw(success ? "✓" : "✗", !success);
    drawn = 0;
    label = "";
  }

  return {
    stage(next: string) {
      finish();
      label = next;
      started = Date.now();
      lines = [];
      partial.stdout = partial.stderr = "";
      if (!interactive) {
        process.stderr.write(`${label}...\n`);
        return;
      }
      const tick = () => draw("|/-\\"[frame++ % 4]!, true);
      tick();
      timer = setInterval(tick, 100);
      timer.unref();
    },
    async write(chunk: string, source: "stdout" | "stderr") {
      if (!interactive) {
        if (!process.stderr.write(chunk)) await once(process.stderr, "drain");
        return;
      }
      // Each pipe has its own partial line: chunks can split lines, and stdout
      // and stderr can interleave. Bound even output with no newline.
      const pieces = (partial[source] + chunk).split(/\r\n|[\r\n]/);
      partial[source] = pieces.pop()!.slice(0, 4096);
      lines = [...lines, ...pieces.filter(Boolean).map((s) => s.slice(0, 4096))].slice(-3);
      // The timer paints at most ten times a second, even for noisy installers.
    },
    finish,
  };
}
