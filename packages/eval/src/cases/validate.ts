import { TOOL_NAMES } from './tools.ts';

const ID = /^(U([1-9]|1[0-9]|2[0-3])|OT)-\d{2}$/;
const USE_CASE = /^(U([1-9]|1[0-9]|2[0-3])|OT)$/;
const TAGS = new Set([
  'smoke',
  'permission',
  'injection',
  'ambiguity',
  'offtopic',
  'multi_turn',
  'voice',
]);
const FACT_MATCHES = new Set([
  'all_mentioned',
  'any_mentioned',
  'number',
  'none_mentioned',
]);
const CASE_KEYS = new Set([
  'id',
  'use_case',
  'role',
  'language',
  'kind',
  'context',
  'messages',
  'expect_tools',
  'expect_facts',
  'expect_action',
  'expect_refusal',
  'denied_facts',
  'injection',
  'rubric_vi',
  'tags',
  'pending',
]);
const TOOLS = new Set(TOOL_NAMES);

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const isText = (v: unknown): v is string =>
  typeof v === 'string' && v.trim() !== '';
const isNum = (v: unknown): v is number =>
  typeof v === 'number' && Number.isFinite(v);
const isTextArray = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((x) => typeof x === 'string');
const isArgs = (v: unknown): boolean =>
  isObj(v) && Object.values(v).every((x) => typeof x === 'string' || isNum(x));

/**
 * Check one parsed case against the shape in x7-plan.md and the tag rules.
 * Returns one message per problem, each starting with `where` (for example
 * `golden/U3.jsonl:4`). An empty list means the case is valid.
 */
export function validateCase(obj: unknown, where: string): string[] {
  const errors: string[] = [];
  const err = (msg: string) => errors.push(`${where}: ${msg}`);

  if (!isObj(obj)) {
    err('a case must be a JSON object');
    return errors;
  }
  for (const key of Object.keys(obj)) {
    if (!CASE_KEYS.has(key)) err(`unknown field '${key}'`);
  }

  const { id, use_case, role, kind } = obj;
  if (typeof id !== 'string' || !ID.test(id)) {
    err(`id ${JSON.stringify(id)} must look like U1-03, U23-06 or OT-02`);
  }
  if (typeof use_case !== 'string' || !USE_CASE.test(use_case)) {
    err(`use_case ${JSON.stringify(use_case)} must be U1..U23 or OT`);
  } else if (
    typeof id === 'string' &&
    ID.test(id) &&
    id.split('-')[0] !== use_case
  ) {
    err(`id ${id} does not start with its use_case ${use_case}`);
  }
  if (role !== 'lead' && role !== 'seller')
    err(`role must be 'lead' or 'seller'`);
  if (
    obj.language !== undefined &&
    obj.language !== 'vi' &&
    obj.language !== 'en'
  ) {
    err(`language must be 'vi' or 'en'`);
  }
  if (kind !== undefined && kind !== 'chat' && kind !== 'digest') {
    err(`kind must be 'chat' or 'digest'`);
  }
  if (obj.context !== undefined) {
    const ctx = obj.context;
    if (
      !isObj(ctx) ||
      Object.keys(ctx).some((k) => k !== 'screen' && k !== 'receipt') ||
      Object.values(ctx).some((v) => typeof v !== 'string')
    ) {
      err('context must be {screen?: string, receipt?: string}');
    }
  }

  const messages = obj.messages;
  if (!Array.isArray(messages)) {
    err('messages must be an array');
  } else {
    if (messages.length === 0 && kind !== 'digest')
      err('messages must not be empty');
    messages.forEach((m, i) => {
      if (!isObj(m) || m.role !== 'user' || !isText(m.content)) {
        err(`messages[${i}] must be {role: 'user', content: non-empty string}`);
      }
    });
  }

  checkTools(obj.expect_tools, err);
  checkFacts(obj.expect_facts, 'expect_facts', err);
  if (obj.denied_facts !== undefined) {
    checkFacts(obj.denied_facts, 'denied_facts', err);
  }
  checkAction(obj.expect_action, err);
  if (
    obj.expect_refusal !== undefined &&
    typeof obj.expect_refusal !== 'boolean'
  ) {
    err('expect_refusal must be a boolean');
  }
  checkInjection(obj.injection, err);
  if (!isText(obj.rubric_vi)) err('rubric_vi must be a non-empty string');

  const tags = obj.tags;
  if (!isTextArray(tags)) {
    err('tags must be an array of strings');
  } else {
    for (const tag of tags) {
      if (!TAGS.has(tag)) err(`tags: unknown tag '${tag}'`);
    }
  }

  checkPending(obj.pending, err);
  if (isTextArray(tags)) {
    checkTagRules(obj, tags, err);
  }
  return errors;
}

type Report = (msg: string) => void;

function checkToolList(list: unknown, path: string, err: Report) {
  if (!isTextArray(list)) {
    err(`${path} must be an array of tool names`);
    return;
  }
  for (const tool of list) {
    if (!TOOLS.has(tool)) err(`${path}: unknown tool '${tool}'`);
  }
}

function checkTools(tools: unknown, err: Report) {
  if (!isObj(tools)) {
    err('expect_tools must be {must, must_not, any_of?}');
    return;
  }
  checkToolList(tools.must, 'expect_tools.must', err);
  checkToolList(tools.must_not, 'expect_tools.must_not', err);
  if (tools.any_of !== undefined) {
    if (!Array.isArray(tools.any_of)) {
      err('expect_tools.any_of must be an array of tool-name arrays');
    } else {
      tools.any_of.forEach((group: unknown, i) =>
        checkToolList(group, `expect_tools.any_of[${i}]`, err),
      );
    }
  }
}

function checkFacts(facts: unknown, path: string, err: Report) {
  if (!Array.isArray(facts)) {
    err(`${path} must be an array`);
    return;
  }
  facts.forEach((f: unknown, i) => {
    const at = `${path}[${i}]`;
    if (!isObj(f)) {
      err(`${at} must be an object`);
      return;
    }
    for (const key of Object.keys(f)) {
      if (!['oracle', 'args', 'match', 'tolerance_pct'].includes(key)) {
        err(`${at}: unknown field '${key}'`);
      }
    }
    if (!isText(f.oracle)) err(`${at}.oracle must be a non-empty string`);
    if (typeof f.match !== 'string' || !FACT_MATCHES.has(f.match)) {
      err(`${at}.match must be one of ${[...FACT_MATCHES].join(', ')}`);
    }
    if (f.args !== undefined && !isArgs(f.args)) {
      err(`${at}.args must map names to strings or numbers`);
    }
    if (
      f.tolerance_pct !== undefined &&
      !(isNum(f.tolerance_pct) && f.tolerance_pct >= 0)
    ) {
      err(`${at}.tolerance_pct must be a number of 0 or more`);
    }
  });
}

function fieldExpectOk(v: unknown): boolean {
  if (!isObj(v)) return false;
  const keys = Object.keys(v);
  if ('ref' in v) return keys.length === 1 && isText(v.ref);
  if ('eq' in v) {
    return (
      keys.length === 1 &&
      (typeof v.eq === 'string' || isNum(v.eq) || typeof v.eq === 'boolean')
    );
  }
  if ('oracle' in v) {
    return (
      keys.every((k) => k === 'oracle' || k === 'args') &&
      isText(v.oracle) &&
      (v.args === undefined || isArgs(v.args))
    );
  }
  return (
    keys.every((k) => k === 'min' || k === 'max') &&
    (v.min === undefined || isNum(v.min)) &&
    (v.max === undefined || isNum(v.max))
  );
}

function checkAction(action: unknown, err: Report) {
  if (action === null) return;
  if (!isObj(action)) {
    err('expect_action must be null or {kind, fields}');
    return;
  }
  if (!isText(action.kind))
    err('expect_action.kind must be a non-empty string');
  if (!isObj(action.fields)) {
    err('expect_action.fields must be an object');
    return;
  }
  for (const [path, expected] of Object.entries(action.fields)) {
    if (!fieldExpectOk(expected)) {
      err(
        `expect_action.fields.${path} must be {ref}, {eq}, {min?, max?} or {oracle, args?}`,
      );
    }
  }
}

function checkInjection(injection: unknown, err: Report) {
  if (injection === undefined) return;
  if (!isObj(injection)) {
    err('injection must be {canaries, must_not_tools}');
    return;
  }
  const { canaries } = injection;
  if (
    !isTextArray(canaries) ||
    canaries.length === 0 ||
    !canaries.every(isText)
  ) {
    err('injection.canaries must be a non-empty array of non-empty strings');
  }
  checkToolList(injection.must_not_tools, 'injection.must_not_tools', err);
}

function checkPending(pending: unknown, err: Report) {
  if (pending === undefined) return;
  if (!isObj(pending)) {
    err('pending must be {on, reason}');
    return;
  }
  if (pending.on !== 'X5' && pending.on !== 'X8')
    err(`pending.on must be 'X5' or 'X8'`);
  if (!isText(pending.reason)) err('pending.reason must be a non-empty string');
}

function checkTagRules(obj: Obj, tags: string[], err: Report) {
  const messages = Array.isArray(obj.messages) ? obj.messages : [];
  const pending = isObj(obj.pending) ? obj.pending : undefined;

  if (tags.includes('permission')) {
    if (obj.role !== 'seller') err(`a permission case must have role 'seller'`);
    const denied =
      Array.isArray(obj.denied_facts) && obj.denied_facts.length > 0;
    if (!denied && obj.expect_refusal !== true) {
      err('a permission case needs denied_facts or expect_refusal: true');
    }
  }
  if (tags.includes('injection') && obj.injection === undefined) {
    err('an injection case needs an injection block');
  }
  if (tags.includes('multi_turn') && messages.length < 2) {
    err('a multi_turn case needs 2 or more messages');
  }
  if (pending && tags.includes('smoke')) {
    err('a pending case must not carry the smoke tag');
  }
  if (obj.kind === 'digest' && messages.length > 0 && pending?.on !== 'X8') {
    err(`a digest case needs pending.on = 'X8' or no messages`);
  }
}
