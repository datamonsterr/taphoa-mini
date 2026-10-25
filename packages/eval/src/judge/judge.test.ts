import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_JUDGE_MODELS,
  fakeJudge,
  judgeAnswer,
  judgeModelsFromEnv,
  makeJudge,
} from './judge.ts';

const MODELS = ['judge/a:free', 'judge/b:free'];
const INPUT = {
  rubric_vi: 'Liệt kê đúng 3 sản phẩm cần nhập.',
  answer: 'Cần nhập Coca, Pepsi và Sting.',
};

function completion(content: string): Response {
  return new Response(
    JSON.stringify({
      id: 'gen-1',
      model: 'judge/a:free',
      choices: [{ message: { role: 'assistant', content } }],
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

function fakeFetch(...contents: (string | Response)[]) {
  let i = 0;
  return vi.fn<typeof fetch>(async () => {
    const next = contents[Math.min(i++, contents.length - 1)]!;
    return typeof next === 'string' ? completion(next) : next;
  });
}

function bodyOf(fetchFn: ReturnType<typeof fakeFetch>, call = 0) {
  const init = fetchFn.mock.calls[call]![1]!;
  return JSON.parse(String(init.body)) as {
    model: string;
    temperature: number;
    response_format: { type: string };
    messages: { role: string; content: string }[];
  };
}

describe('judgeAnswer', () => {
  it('returns score, reason and the model that judged', async () => {
    const fetchFn = fakeFetch('{"score": 4, "reason": "Đúng, thiếu đơn giá."}');
    const result = await judgeAnswer(INPUT, {
      apiKey: 'sk-secret',
      models: MODELS,
      fetch: fetchFn,
    });
    expect(result).toEqual({
      score: 4,
      reason: 'Đúng, thiếu đơn giá.',
      model: 'judge/a:free',
    });
  });

  it('posts to OpenRouter chat completions with a bearer key', async () => {
    const fetchFn = fakeFetch('{"score": 5, "reason": "ok"}');
    await judgeAnswer(INPUT, {
      apiKey: 'sk-secret',
      models: MODELS,
      fetch: fetchFn,
    });
    const [url, init] = fetchFn.mock.calls[0]!;
    expect(String(url)).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect(init?.method).toBe('POST');
    const headers = new Headers(init?.headers);
    expect(headers.get('authorization')).toBe('Bearer sk-secret');
    expect(headers.get('content-type')).toBe('application/json');
  });

  it('asks for temperature 0 and a JSON object', async () => {
    const fetchFn = fakeFetch('{"score": 5, "reason": "ok"}');
    await judgeAnswer(INPUT, { apiKey: 'k', models: MODELS, fetch: fetchFn });
    const body = bodyOf(fetchFn);
    expect(body.temperature).toBe(0);
    expect(body.response_format).toEqual({ type: 'json_object' });
  });

  it('sends the rubric and the answer, and nothing else', async () => {
    const fetchFn = fakeFetch('{"score": 5, "reason": "ok"}');
    await judgeAnswer(INPUT, { apiKey: 'k', models: MODELS, fetch: fetchFn });
    const body = bodyOf(fetchFn);
    expect(body.messages.map((m) => m.role)).toEqual(['system', 'user']);
    expect(body.messages[1]!.content).toContain(INPUT.rubric_vi);
    expect(body.messages[1]!.content).toContain(INPUT.answer);
    expect(body.messages[0]!.content).not.toContain(INPUT.answer);
  });

  it('uses the first model when nothing is excluded', async () => {
    const fetchFn = fakeFetch('{"score": 5, "reason": "ok"}');
    await judgeAnswer(INPUT, { apiKey: 'k', models: MODELS, fetch: fetchFn });
    expect(bodyOf(fetchFn).model).toBe('judge/a:free');
  });

  it('skips the model under test', async () => {
    const fetchFn = fakeFetch('{"score": 5, "reason": "ok"}');
    const result = await judgeAnswer(INPUT, {
      apiKey: 'k',
      models: MODELS,
      excludeModel: 'judge/a:free',
      fetch: fetchFn,
    });
    expect(bodyOf(fetchFn).model).toBe('judge/b:free');
    expect(result?.model).toBe('judge/b:free');
  });

  it('ignores an exclusion that is not in the list', async () => {
    const fetchFn = fakeFetch('{"score": 5, "reason": "ok"}');
    await judgeAnswer(INPUT, {
      apiKey: 'k',
      models: MODELS,
      excludeModel: 'other/model',
      fetch: fetchFn,
    });
    expect(bodyOf(fetchFn).model).toBe('judge/a:free');
  });

  it('fails when every judge model is excluded', async () => {
    await expect(
      judgeAnswer(INPUT, {
        apiKey: 'k',
        models: ['judge/a:free'],
        excludeModel: 'judge/a:free',
        fetch: fakeFetch('{}'),
      }),
    ).rejects.toThrow('EVAL_JUDGE_MODELS');
  });

  it('retries once on invalid JSON', async () => {
    const fetchFn = fakeFetch('Tôi nghĩ là 4', '{"score": 3, "reason": "tạm"}');
    const result = await judgeAnswer(INPUT, {
      apiKey: 'k',
      models: MODELS,
      fetch: fetchFn,
    });
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(result?.score).toBe(3);
  });

  it('returns null after a second invalid reply', async () => {
    const fetchFn = fakeFetch('not json', '{"score": 9, "reason": "x"}');
    const result = await judgeAnswer(INPUT, {
      apiKey: 'k',
      models: MODELS,
      fetch: fetchFn,
    });
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(result).toBeNull();
  });

  it('treats a missing or out-of-range score as invalid', async () => {
    for (const bad of [
      '{"reason": "x"}',
      '{"score": 0, "reason": "x"}',
      '{"score": "high"}',
    ]) {
      const fetchFn = fakeFetch(bad);
      expect(
        await judgeAnswer(INPUT, {
          apiKey: 'k',
          models: MODELS,
          fetch: fetchFn,
        }),
      ).toBeNull();
      expect(fetchFn).toHaveBeenCalledTimes(2);
    }
  });

  it('accepts JSON inside a code fence and a numeric string score', async () => {
    const fetchFn = fakeFetch('```json\n{"score": "5", "reason": "tốt"}\n```');
    const result = await judgeAnswer(INPUT, {
      apiKey: 'k',
      models: MODELS,
      fetch: fetchFn,
    });
    expect(result).toMatchObject({ score: 5, reason: 'tốt' });
  });

  it('throws on an HTTP error without leaking the key', async () => {
    const fetchFn = fakeFetch(new Response('rate limited', { status: 429 }));
    const err = (await judgeAnswer(INPUT, {
      apiKey: 'sk-secret',
      models: MODELS,
      fetch: fetchFn,
    }).catch((e: unknown) => e)) as Error;
    expect(err.message).toContain('429');
    expect(err.message).not.toContain('sk-secret');
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
});

describe('judgeModelsFromEnv', () => {
  it('defaults to the two free judges', () => {
    expect(judgeModelsFromEnv({})).toEqual(DEFAULT_JUDGE_MODELS);
    expect(DEFAULT_JUDGE_MODELS).toEqual([
      'google/gemma-4-31b-it:free',
      'nvidia/nemotron-3-super-120b-a12b:free',
    ]);
  });

  it('parses a comma-separated EVAL_JUDGE_MODELS', () => {
    expect(
      judgeModelsFromEnv({ EVAL_JUDGE_MODELS: ' a/x:free , b/y:free,, ' }),
    ).toEqual(['a/x:free', 'b/y:free']);
  });

  it('falls back to the default for a blank value', () => {
    expect(judgeModelsFromEnv({ EVAL_JUDGE_MODELS: '  ' })).toEqual(
      DEFAULT_JUDGE_MODELS,
    );
  });
});

describe('makeJudge and fakeJudge', () => {
  it('makeJudge excludes the model under test', async () => {
    const fetchFn = fakeFetch('{"score": 4, "reason": "ok"}');
    const judge = makeJudge({ apiKey: 'k', models: MODELS, fetch: fetchFn });
    await judge(INPUT, 'judge/a:free');
    expect(bodyOf(fetchFn).model).toBe('judge/b:free');
  });

  it('fakeJudge returns a fixed score without a network call', async () => {
    expect(await fakeJudge(5)(INPUT, null)).toEqual({
      score: 5,
      reason: 'stub judge',
      model: 'stub/judge',
    });
    expect((await fakeJudge(1)(INPUT, null))?.score).toBe(1);
  });
});
