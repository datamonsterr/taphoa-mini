import { relative, resolve } from 'node:path';
import { checkCoverage } from './cases/coverage.ts';
import { loadGolden } from './cases/load.ts';

const USAGE =
  'usage: node src/cli.ts <validate|smoke|full|compare|calibrate>\n' +
  '  validate [--dir golden]   check the golden cases and their coverage';

/** The golden directory next to this package's src, whatever the cwd is. */
const DEFAULT_DIR = resolve(import.meta.dirname, '..', 'golden');

function parseDir(args: string[]): string | null {
  let dir = DEFAULT_DIR;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--dir' && args[i + 1] !== undefined) {
      dir = resolve(args[++i]!);
    } else if (arg.startsWith('--dir=') && arg.length > '--dir='.length) {
      dir = resolve(arg.slice('--dir='.length));
    } else {
      return null;
    }
  }
  return dir;
}

function validate(args: string[]): number {
  const dir = parseDir(args);
  if (dir === null) {
    console.error(USAGE);
    return 2;
  }
  // Show paths relative to where the command ran, so editors can open them.
  const { cases, errors } = loadGolden(relative(process.cwd(), dir) || '.');
  // The oracle-name check arrives with the oracle catalog.
  const problems = [...errors, ...checkCoverage(cases)];
  if (problems.length === 0) {
    console.log(`ok: ${cases.length} golden cases`);
    return 0;
  }
  for (const problem of problems) console.log(problem);
  console.log(`${problems.length} problem(s) in ${cases.length} valid cases`);
  return 1;
}

const [command, ...rest] = process.argv.slice(2);
if (command === 'validate') {
  process.exit(validate(rest));
}

// Placeholder: smoke, full, compare and calibrate arrive in later X7 tasks.
console.error(USAGE);
process.exit(2);
