export interface Parsed {
  positionals: string[];
  flags: Record<string, string[]>;
  bools: Set<string>;
}

const BOOLEAN = new Set(["json", "takeover", "dry-run", "no-open", "version", "help", "wait"]);

/** Minimal parser: `--name value` (repeatable) and boolean `--json`, `--takeover`, `--dry-run`, `--no-open`, `--version`, `--wait`, `--help` (also `-h`). */
export function parseArgs(argv: string[]): Parsed {
  const out: Parsed = { positionals: [], flags: {}, bools: new Set() };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-h") out.bools.add("help");
    else if (a.startsWith("--")) {
      const [name, inline] = a.slice(2).split("=", 2);
      if (BOOLEAN.has(name)) {
        out.bools.add(name);
        continue;
      }
      const value = inline ?? argv[++i];
      if (value === undefined) continue;
      out.flags[name] ??= [];
      out.flags[name].push(value);
    } else out.positionals.push(a);
  }
  return out;
}

/** Whether the command runs outside a git checkout: doctor reports it as its git check, --version and --help need none. */
export function runsOutsideCheckout(argv: string[]): boolean {
  const { positionals, bools } = parseArgs(argv);
  return positionals[0] === "doctor" || bools.has("version") || bools.has("help");
}
