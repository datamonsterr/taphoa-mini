import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ExpectedLine, VoiceCase } from './types.ts';

export const GOLDEN_VOICE_DIR = join(
  import.meta.dirname,
  '..',
  '..',
  'golden',
  'voice',
);

const INTENTS = ['sale', 'chat', 'none'];
const PAYMENTS = ['cash', 'transfer', 'credit'];
const STATUSES = ['matched', 'ambiguous', 'unknown'];

export class VoiceCaseError extends Error {}

function checkLine(l: unknown, where: string): ExpectedLine {
  const o = l as Partial<ExpectedLine>;
  const bad = (m: string) => new VoiceCaseError(`${where}: ${m}`);
  if (typeof o?.spoken !== 'string' || o.spoken === '')
    throw bad('line.spoken must be text');
  if (o.product !== null && typeof o.product !== 'string')
    throw bad('line.product must be a name or null');
  if (o.status !== undefined && !STATUSES.includes(o.status))
    throw bad(`line.status ${o.status} is not matched, ambiguous or unknown`);
  if (o.status === 'matched' && o.product === null)
    throw bad('a matched line needs a product');
  if (!Number.isInteger(o.quantity) || o.quantity! < 1 || o.quantity! > 999)
    throw bad('line.quantity must be a whole number 1..999');
  if (o.unit_price !== null && !Number.isInteger(o.unit_price))
    throw bad('line.unit_price must be whole dong or null');
  return o as ExpectedLine;
}

/** Validate one sidecar object; throws `VoiceCaseError` naming the problem. */
export function parseVoiceCase(raw: unknown, file: string): VoiceCase {
  const o = raw as Partial<VoiceCase>;
  const bad = (m: string) => new VoiceCaseError(`${file}: ${m}`);
  if (typeof o?.id !== 'string' || o.id === '') throw bad('id must be text');
  if (o.source !== 'synthetic' && o.source !== 'recorded')
    throw bad('source must be synthetic or recorded');
  if (typeof o.transcript !== 'string') throw bad('transcript must be text');
  if (o.language !== 'vi' && o.language !== 'en')
    throw bad('language must be vi or en');
  if (!INTENTS.includes(o.intent as string))
    throw bad('intent must be sale, chat or none');
  if (o.payment_method !== undefined && !PAYMENTS.includes(o.payment_method))
    throw bad('payment_method must be cash, transfer or credit');
  if (!Array.isArray(o.lines)) throw bad('lines must be a list');
  if (!Array.isArray(o.tags) || o.tags.some((t) => typeof t !== 'string'))
    throw bad('tags must be a list of text');
  const lines = o.lines.map((l) => checkLine(l, file));
  if (o.intent === 'sale' && lines.length === 0)
    throw bad('a sale case needs at least one line');
  if (o.intent !== 'sale' && lines.length > 0)
    throw bad('only a sale case has lines');
  if (o.intent === 'none' && o.transcript !== '')
    throw bad('a none case has an empty transcript');
  if (o.intent !== 'none' && o.transcript === '')
    throw bad('transcript is empty');
  if (o.payment_method === 'credit' && !o.customer_name)
    throw bad('a credit case needs customer_name');
  return o as VoiceCase;
}

export type LoadedVoiceCase = VoiceCase & {
  /** Absolute path of the clip. */
  audio_path: string;
};

/** Read `<dir>/*.json` with a `<id>.m4a` beside each; sorted by id. */
export function loadVoiceCases(
  dir: string = GOLDEN_VOICE_DIR,
): LoadedVoiceCase[] {
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort();
  const seen = new Set<string>();
  return files.map((f) => {
    const c = parseVoiceCase(JSON.parse(readFileSync(join(dir, f), 'utf8')), f);
    const stem = f.slice(0, -'.json'.length);
    if (c.id !== stem)
      throw new VoiceCaseError(`${f}: id ${c.id} must equal the file name`);
    if (seen.has(c.id)) throw new VoiceCaseError(`${f}: duplicate id ${c.id}`);
    seen.add(c.id);
    const audio_path = join(dir, `${stem}.m4a`);
    if (!existsSync(audio_path))
      throw new VoiceCaseError(
        `${f}: clip ${stem}.m4a is missing (run voice-synth or drop a recording)`,
      );
    return { ...c, audio_path };
  });
}

/** Ten smoke clips: the ones tagged `smoke`. */
export function smokeSubset<T extends VoiceCase>(cases: T[]): T[] {
  return cases.filter((c) => c.tags.includes('smoke'));
}
