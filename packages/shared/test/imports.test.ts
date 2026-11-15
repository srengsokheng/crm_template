import { describe, expect, it } from 'vitest';
import {
  CsvError, detectDelimiter, mappingErrors, normalizeNumberCell, parseBoolCell, parseCsv, parseDateCell, splitFullName,
  splitListCell, suggestMapping, toCsv,
} from '../src/index.ts';

describe('parseCsv', () => {
  it('reads quoted cells, escaped quotes, embedded delimiters and line breaks', () => {
    const r = parseCsv('Name,Note\r\n"Lovelace, Ada","She said ""hi""\nthen left"\r\nBob,plain\r\n');
    expect(r.headers).toEqual(['Name', 'Note']);
    expect(r.rows).toEqual([['Lovelace, Ada', 'She said "hi"\nthen left'], ['Bob', 'plain']]);
    // Spreadsheet row numbers: the multi-line cell is still one spreadsheet row.
    expect(r.rowNumbers).toEqual([2, 3]);
  });

  it('strips a BOM, honours Excel "sep=" and detects ; / tab delimiters', () => {
    expect(parseCsv('﻿a;b\n1;2').rows).toEqual([['1', '2']]);
    expect(parseCsv('sep=|\na|b\n1|2').rows).toEqual([['1', '2']]);
    expect(detectDelimiter('a\tb\tc\n1\t2\t3')).toBe('\t');
    expect(detectDelimiter('"x;y",b,c')).toBe(','); // delimiters inside quotes don't count
  });

  it('drops blank rows, pads short rows, trims cells and names empty headers', () => {
    const r = parseCsv('first, ,third\n\n  x  \n,,\n1,2,3,4\n');
    expect(r.headers).toEqual(['first', 'Column 2', 'third']);
    expect(r.rows).toEqual([['x', '', ''], ['1', '2', '3']]);
    expect(r.rowNumbers).toEqual([3, 5]);
  });

  it('handles CR-only line endings and a file without a trailing newline', () => {
    expect(parseCsv('a,b\r1,2\r3,4').rows).toEqual([['1', '2'], ['3', '4']]);
  });

  it('reports an unterminated quote with its line', () => {
    expect(() => parseCsv('a,b\n1,"oops\n2,3')).toThrow(CsvError);
    try { parseCsv('a,b\n1,"oops\n2,3'); } catch (e) { expect((e as CsvError).line).toBe(2); }
  });

  it('returns nothing for an empty file', () => {
    expect(parseCsv('\n \n')).toMatchObject({ headers: [], rows: [] });
  });
});

describe('toCsv', () => {
  it('quotes when needed and neutralises formulas; parseCsv reverses the formula guard', () => {
    const out = toCsv([['Name', 'Phone', 'Note'], ['Ada, L', '+1 555 0100', '=HYPERLINK("x")'], [null, 7, 'a"b']]);
    expect(out).toBe('Name,Phone,Note\r\n"Ada, L",\'+1 555 0100,"\'=HYPERLINK(""x"")"\r\n,7,"a""b"\r\n');
    expect(parseCsv(out).rows).toEqual([['Ada, L', '+1 555 0100', '=HYPERLINK("x")'], ['', '7', 'a"b']]);
  });
});

describe('suggestMapping', () => {
  it('maps common headers by key, label and alias; custom fields by label', () => {
    const m = suggestMapping('contact',
      ['First Name', 'Surname', 'E-mail', 'Work phone', 'Mobile', 'Organisation', 'Title', 'ZIP', 'Segment', 'Mystery'],
      [{ key: 'segment', label: 'Segment' }]);
    expect(m).toEqual(['firstName', 'lastName', 'email', 'phone', 'phone', 'company', 'jobTitle', 'postalCode', 'custom.segment', null]);
  });

  it('uses a single-value target once, and maps "Title" to the lead title for leads', () => {
    expect(suggestMapping('company', ['Name', 'Company'])).toEqual(['name', null]);
    expect(suggestMapping('lead', ['Title', 'Status', 'Value'])).toEqual(['title', 'stage', 'amount']);
  });
});

describe('mappingErrors', () => {
  it('requires a name for contacts and companies, and something for leads', () => {
    expect(mappingErrors('contact', ['email', null], [])).toEqual(['Map a column to First name, Last name or Full name']);
    expect(mappingErrors('company', ['email'], [])).toEqual(['Map a column to Company name']);
    expect(mappingErrors('lead', ['phone'], [])).toEqual([]);
  });

  it('rejects unknown targets and duplicate single-value targets, allows repeated multi-value ones', () => {
    expect(mappingErrors('contact', ['firstName', 'firstName', 'email', 'email'], [])).toEqual(['"First name" is mapped to 2 columns; choose one']);
    expect(mappingErrors('contact', ['lastName', 'bogus', 'custom.nope'], ['segment'])).toEqual(['Unknown field "bogus"', 'Unknown custom field "nope"']);
  });
});

describe('cell parsers', () => {
  it('splits full names', () => {
    expect(splitFullName('Ada  King Lovelace')).toEqual(['Ada King', 'Lovelace']);
    expect(splitFullName('Lovelace, Ada')).toEqual(['Ada', 'Lovelace']);
    expect(splitFullName('Cher')).toEqual(['Cher', null]);
  });

  it('parses dates in the chosen format and rejects impossible dates', () => {
    expect(parseDateCell('2026-3-7')).toBe('2026-03-07');
    expect(parseDateCell('2026-03-07T10:00:00Z')).toBe('2026-03-07');
    expect(parseDateCell('2026-03-07 9:30 pm')).toBe('2026-03-07');
    expect(parseDateCell('07/03/2026', 'dmy')).toBe('2026-03-07');
    expect(parseDateCell('03/07/2026', 'mdy')).toBe('2026-03-07');
    expect(parseDateCell('7.3.26', 'dmy')).toBe('2026-03-07');
    expect(parseDateCell('2026-03-07', 'dmy')).toBe('2026-03-07'); // year-first is unambiguous
    expect(parseDateCell('07/03/2026')).toBeNull(); // ambiguous in the default Y-M-D format
    expect(parseDateCell('2026-02-30')).toBeNull();
    expect(parseDateCell('soon')).toBeNull();
  });

  it('normalises numbers with thousands separators, decimal commas and currency symbols', () => {
    expect(normalizeNumberCell('1,500.50')).toBe('1500.50');
    expect(normalizeNumberCell('1.500,50')).toBe('1500.50');
    expect(normalizeNumberCell('1,5')).toBe('1.5');
    expect(normalizeNumberCell('12,000')).toBe('12000');
    expect(normalizeNumberCell('1.000.000')).toBe('1000000');
    expect(normalizeNumberCell('$ 2 500')).toBe('2500');
    expect(normalizeNumberCell('USD 99.9')).toBe('99.9');
    expect(normalizeNumberCell('-3')).toBe('-3');
    expect(normalizeNumberCell('abc')).toBeNull();
    expect(normalizeNumberCell('1.2.3')).toBeNull();
  });

  it('parses yes/no and splits lists', () => {
    expect([parseBoolCell('Yes'), parseBoolCell('0'), parseBoolCell('maybe')]).toEqual([true, false, null]);
    expect(splitListCell('A; B, C|D')).toEqual(['A', 'B', 'C', 'D']);
  });
});

describe('template headers', () => {
  it('every field label maps back to its field, so the downloadable template needs no manual mapping', async () => {
    const { IMPORT_TARGETS } = await import('../src/index.ts');
    for (const entity of ['contact', 'company', 'lead'] as const) {
      const targets = IMPORT_TARGETS[entity].filter((t) => t.key !== 'fullName');
      expect(suggestMapping(entity, targets.map((t) => t.label))).toEqual(targets.map((t) => t.key));
    }
  });
  it('ignores non-breaking spaces in numbers', () => {
    expect(normalizeNumberCell('1\u00a0250,75')).toBe('1250.75');
  });
});
