import { describe, expect, it } from 'vitest';
import { isValidEmail, validateRequest } from './validate';

describe('validateRequest', () => {
  it('accepts a valid request and trims fields', () => {
    const { data, errors } = validateRequest({ name: '  ישראל   ישראלי ', email: ' a@b.co ', company: ' ', message: '' });
    expect(errors).toEqual({});
    expect(data.name).toBe('ישראל ישראלי');
    expect(data.email).toBe('a@b.co');
    expect(data.company).toBe('');
  });
  it('rejects short/long names and missing fields', () => {
    expect(validateRequest({ name: 'a', email: 'a@b.co' }).errors.name).toBeTruthy();
    expect(validateRequest({ name: 'x'.repeat(81), email: 'a@b.co' }).errors.name).toBeTruthy();
    expect(validateRequest({ name: '', email: '' }).errors).toMatchObject({ name: expect.any(String), email: expect.any(String) });
  });
  it('validates email format', () => {
    expect(isValidEmail('user@example.com')).toBe(true);
    expect(isValidEmail('user@example')).toBe(false);
    expect(isValidEmail('user example@x.com')).toBe(false);
    expect(isValidEmail('@x.com')).toBe(false);
  });
});
