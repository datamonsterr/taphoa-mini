/**
 * Synthesize the voice clips from their sidecars.
 *
 *   node scripts/voice-synth.ts [--dir golden/voice] [--out DIR] [--only a,b] [--force] [--list]
 *
 * For every `<id>.json` in --dir (default golden/voice) that has no `<id>.m4a` yet:
 *   1. speaks `segments` (default: the `transcript`) with OpenRouter TTS
 *      (POST /api/v1/audio/speech, model microsoft/mai-voice-2.1-flash). Voices
 *      vi-VN-Harper and vi-VN-Grant alternate between segments, and between clips for
 *      single-segment clips, so the set has two voices;
 *   2. for `"noise": true`, mixes light shop noise (pink noise from ffmpeg anoisesrc);
 *   3. an empty transcript becomes 3 s of silence (ffmpeg anullsrc), or noise only;
 *   4. encodes AAC m4a, 16 kHz mono 32 kbps.
 * Needs ffmpeg on PATH and OPENROUTER_EVAL_API_KEY (env, else
 * ~/.config/taphoa-mini/secrets.env). The key is never printed.
 * Owner recordings need none of this: drop `<id>.m4a` and its sidecar
 * (`"source": "recorded"`) into the directory.
 */
import { execFileSync } from 'node:child_process';
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
  existsSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

export const TTS_URL = 'https://openrouter.ai/api/v1/audio/speech';
export const TTS_MODEL = 'microsoft/mai-voice-2.1-flash';
export const VOICES = [
  'vi-VN-Harper:MAI-Voice-2.1-Flash',
  'vi-VN-Grant:MAI-Voice-2.1-Flash',
];
const SECRETS = join(homedir(), '.config', 'taphoa-mini', 'secrets.env');
const SILENCE_SECONDS = 3;
const NOISE_AMPLITUDE = 0.03;

type Sidecar = {
  /** Defaults to the file name without `.json`. */
  id: string;
  transcript: string;
  segments?: string[];
  noise?: boolean;
};

export function loadKey(
  env: Record<string, string | undefined> = process.env,
): string {
  const fromEnv = env.OPENROUTER_EVAL_API_KEY?.trim();
  if (fromEnv) return fromEnv;
  if (existsSync(SECRETS)) {
    for (const line of readFileSync(SECRETS, 'utf8').split('\n')) {
      const m = /^\s*OPENROUTER_EVAL_API_KEY\s*=\s*(.*)$/.exec(line);
      if (m) return m[1]!.trim().replace(/^['"]|['"]$/g, '');
    }
  }
  throw new Error(
    'OPENROUTER_EVAL_API_KEY is not set (env or ~/.config/taphoa-mini/secrets.env)',
  );
}

function ffmpeg(args: string[]) {
  execFileSync(
    'ffmpeg',
    ['-hide_banner', '-loglevel', 'error', '-y', ...args],
    {
      stdio: ['ignore', 'ignore', 'inherit'],
    },
  );
}

async function speak(
  text: string,
  voice: string,
  key: string,
  out: string,
): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(TTS_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: TTS_MODEL,
        input: text,
        voice,
        response_format: 'mp3',
      }),
      signal: AbortSignal.timeout(60_000),
    });
    if (res.ok) {
      writeFileSync(out, Buffer.from(await res.arrayBuffer()));
      return;
    }
    if (attempt < 4 && (res.status === 429 || res.status >= 500)) {
      await new Promise((r) => setTimeout(r, 1500 * attempt));
      continue;
    }
    throw new Error(
      `TTS failed for ${JSON.stringify(text)}: HTTP ${res.status}`,
    );
  }
}

const ENCODE = [
  '-ar',
  '16000',
  '-ac',
  '1',
  '-c:a',
  'aac',
  '-b:a',
  '32k',
  '-movflags',
  '+faststart',
];

function noiseSource(seconds: number, amplitude: number) {
  return [
    '-f',
    'lavfi',
    '-i',
    `anoisesrc=color=pink:amplitude=${amplitude}:duration=${seconds}:sample_rate=16000`,
  ];
}

function duration(file: string): number {
  const out = execFileSync(
    'ffprobe',
    ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file],
    { encoding: 'utf8' },
  );
  return Number(out.trim());
}

export async function synthesize(
  c: Sidecar,
  index: number,
  key: string,
  outFile: string,
): Promise<void> {
  const work = mkdtempSync(join(tmpdir(), 'voice-synth-'));
  try {
    if (c.transcript === '') {
      if (c.noise) {
        ffmpeg([
          ...noiseSource(SILENCE_SECONDS, 0.05),
          '-af',
          'highpass=f=150,lowpass=f=4000',
          ...ENCODE,
          outFile,
        ]);
      } else {
        ffmpeg([
          '-f',
          'lavfi',
          '-i',
          `anullsrc=r=16000:cl=mono`,
          '-t',
          String(SILENCE_SECONDS),
          ...ENCODE,
          outFile,
        ]);
      }
      return;
    }
    const segments = c.segments ?? [c.transcript];
    const parts: string[] = [];
    for (const [i, text] of segments.entries()) {
      const mp3 = join(work, `seg${i}.mp3`);
      // Segments alternate speakers; single-segment clips alternate by clip index.
      await speak(text, VOICES[(index + i) % VOICES.length]!, key, mp3);
      parts.push(mp3);
    }
    const joined = join(work, 'speech.wav');
    const inputs = parts.flatMap((p) => ['-i', p]);
    const concat =
      parts
        .map(
          (_, i) =>
            `[${i}:a]aresample=16000,aformat=channel_layouts=mono[a${i}]`,
        )
        .join(';') +
      ';' +
      parts.map((_, i) => `[a${i}]`).join('') +
      `concat=n=${parts.length}:v=0:a=1,adelay=300:all=1,apad=pad_dur=0.4[out]`;
    ffmpeg([...inputs, '-filter_complex', concat, '-map', '[out]', joined]);
    if (!c.noise) {
      ffmpeg(['-i', joined, ...ENCODE, outFile]);
      return;
    }
    const seconds = Math.ceil(duration(joined)) + 1;
    ffmpeg([
      '-i',
      joined,
      ...noiseSource(seconds, NOISE_AMPLITUDE),
      '-filter_complex',
      '[1:a]highpass=f=150,lowpass=f=4000[n];[0:a][n]amix=inputs=2:duration=first:normalize=0[out]',
      '-map',
      '[out]',
      ...ENCODE,
      outFile,
    ]);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

export async function main(argv: string[]): Promise<number> {
  const opts = new Map<string, string>();
  const flags = new Set<string>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--force' || a === '--list') flags.add(a);
    else if (a === '--dir' || a === '--out' || a === '--only') {
      const v = argv[++i];
      if (!v) throw new Error(`${a} needs a value`);
      opts.set(a, v);
    } else throw new Error(`unknown option ${a}`);
  }
  const dir = resolve(
    opts.get('--dir') ?? join(import.meta.dirname, '..', 'golden', 'voice'),
  );
  const out = resolve(opts.get('--out') ?? dir);
  const only = opts.get('--only')?.split(',');
  const sidecars = readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => {
      const raw = JSON.parse(readFileSync(join(dir, f), 'utf8')) as Sidecar;
      // The e2e sidecars have no id: the file name is the clip name.
      return { ...raw, id: raw.id ?? f.slice(0, -'.json'.length) };
    })
    .filter((c) => !only || only.includes(c.id));
  const todo = sidecars
    .map((c, index) => ({ c, index }))
    .filter(
      ({ c }) => flags.has('--force') || !existsSync(join(out, `${c.id}.m4a`)),
    );
  console.log(
    `${todo.length} of ${sidecars.length} clips to synthesize into ${out}`,
  );
  if (flags.has('--list') || todo.length === 0) return 0;
  execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
  const key = loadKey();
  for (const { c, index } of todo) {
    const file = join(out, `${c.id}.m4a`);
    await synthesize(c, index, key, file);
    console.log(`${c.id}  ${(statSync(file).size / 1024).toFixed(0)} KB`);
  }
  return 0;
}

if (import.meta.main) {
  process.exit(await main(process.argv.slice(2)));
}
