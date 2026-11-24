// Load the existing test-only OpenAPI mock outside Jest; this never enters the app bundle.
const Module = require('node:module');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const { repo } = require('./common.cjs');
const root = path.join(repo, 'apps/mobile/src');
const resolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...args) {
  const target = request.startsWith('@/')
    ? path.join(root, request.slice(2))
    : request;
  try {
    return resolve.call(this, target, parent, ...args);
  } catch (error) {
    if (fs.existsSync(`${target}.ts`))
      return resolve.call(this, `${target}.ts`, parent, ...args);
    throw error;
  }
};
require.extensions['.ts'] = (module, file) => {
  const source = fs.readFileSync(file, 'utf8');
  module._compile(
    ts.transpileModule(source, {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
        esModuleInterop: true,
      },
    }).outputText,
    file,
  );
};
module.exports = require(path.join(root, 'test/mock/fetch.ts')).createMockFetch(
  { latencyMs: [0, 0] },
);
