import { execFile } from "node:child_process";

/** One herdr CLI call: its JSON `result` (or the plain text a read prints), or herdr's error code. */
export type HerdrAnswer = { ok: true; result: unknown } | { ok: false; code: string; message: string };

/** Runs one herdr CLI command, e.g. ["agent", "get", "w1:p2"]. */
export type Herdr = (args: string[]) => Promise<HerdrAnswer>;

/** The real herdr CLI, reaching the herdr session through HERDR_SOCKET_PATH in `env`. */
export function herdrCli(env: Record<string, string | undefined>): Herdr {
  const bin = env.HERDR_BIN_PATH || "herdr";
  return (args) =>
    new Promise((resolve) => {
      execFile(bin, args, { env, maxBuffer: 16 * 1024 * 1024, timeout: 60_000 }, (err, stdout, stderr) => {
        // herdr answers JSON on stdout, except reads, which print plain text; an error is JSON on stderr with exit 1.
        const text = stdout.trim() || stderr.trim();
        let json: { result?: unknown; error?: { code?: string; message?: string } } | null = null;
        try {
          json = text ? JSON.parse(text) : null;
        } catch {}
        if (json?.error) resolve({ ok: false, code: json.error.code ?? "error", message: json.error.message ?? text });
        else if (err) resolve({ ok: false, code: "failed", message: text || err.message });
        else resolve({ ok: true, result: json ? json.result : stdout });
      });
    });
}

/** A field deep in a herdr answer, e.g. dig(result, "root_pane", "pane_id"). */
export const dig = (v: unknown, ...path: string[]): unknown =>
  path.reduce<unknown>((o, k) => (o && typeof o === "object" ? (o as Record<string, unknown>)[k] : undefined), v);

/** Whether norn runs inside a herdr session, which norn run and norn deliver need. */
export const underHerdr = (env: Record<string, string | undefined>) => env.HERDR_ENV === "1";
