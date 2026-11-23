import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ESLint } from 'eslint';

const eslint = new ESLint({ cwd: new URL('..', import.meta.url).pathname });

const lint = async (code, filePath) => {
  const [result] = await eslint.lintText(code, { filePath });
  return result.messages.filter((m) => m.ruleId === 'no-restricted-syntax');
};

const literal = 'export const s = { fontSize: 17, lineHeight: 22 };\n';

test('numeric fontSize literal outside the theme fails lint', async () => {
  const messages = await lint(literal, 'src/components/ui/Fixture.ts');
  assert.equal(messages.length, 1);
  assert.match(messages[0].message, /fontSize/);
});

test('theme module and tests may use literals', async () => {
  assert.deepEqual(await lint(literal, 'src/theme/typography.ts'), []);
  assert.deepEqual(
    await lint(literal, 'src/components/ui/Fixture.test.ts'),
    [],
  );
});

test('token lookups pass', async () => {
  const code =
    "import { fontSize } from '@/theme';\nexport const s = { fontSize: fontSize[17] };\n";
  assert.deepEqual(await lint(code, 'src/components/ui/Fixture.ts'), []);
});
