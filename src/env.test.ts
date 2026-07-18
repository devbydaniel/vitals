import { afterEach, describe, expect, it } from 'vitest';

import { optionalEnv, requireEnv } from './env.js';

describe('env', () => {
  afterEach(() => {
    delete process.env.VITALS_TEST_VAR;
  });

  it('requireEnv returns the value when set', () => {
    process.env.VITALS_TEST_VAR = 'hello';
    expect(requireEnv('VITALS_TEST_VAR')).toBe('hello');
  });

  it('requireEnv throws when missing or empty', () => {
    expect(() => requireEnv('VITALS_TEST_VAR')).toThrow(/VITALS_TEST_VAR/);
    process.env.VITALS_TEST_VAR = '';
    expect(() => requireEnv('VITALS_TEST_VAR')).toThrow(/VITALS_TEST_VAR/);
  });

  it('optionalEnv returns undefined when missing or empty', () => {
    expect(optionalEnv('VITALS_TEST_VAR')).toBeUndefined();
    process.env.VITALS_TEST_VAR = '';
    expect(optionalEnv('VITALS_TEST_VAR')).toBeUndefined();
    process.env.VITALS_TEST_VAR = 'x';
    expect(optionalEnv('VITALS_TEST_VAR')).toBe('x');
  });
});
