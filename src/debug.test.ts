import { describe, it, expect } from 'vitest';
import { fmt } from './debug';

describe('fmt', () => {
  it('returns strings as-is', () => {
    expect(fmt("hello world")).toBe("hello world");
  });

  it('formats Error objects extracting the stack', () => {
    const error = new Error("test error");
    error.stack = "Error: test error\n    at someFunction (file.ts:1:1)";
    expect(fmt(error)).toBe(error.stack);
  });

  it('formats Error objects falling back to message if stack is missing', () => {
    const error = new Error("test error");
    delete error.stack;
    expect(fmt(error)).toBe("test error");
  });

  it('JSON stringifies normal objects', () => {
    const obj = { key: "value", num: 42 };
    expect(fmt(obj)).toBe('{"key":"value","num":42}');
  });

  it('falls back to String(a) if JSON.stringify throws (e.g. BigInt)', () => {
    // JSON.stringify throws on BigInt
    const val = 10n;
    expect(fmt(val)).toBe("10");
  });

  it('falls back to String(a) if JSON.stringify throws (e.g. circular reference)', () => {
    const circular: any = {};
    circular.self = circular;
    expect(fmt(circular)).toBe("[object Object]");
  });
});
