import { describe, expect, it } from 'vitest';
import { EN } from '../../src/i18n/en';
import { translate } from '../../src/i18n/translate';

describe('translation', () => {
  it('keeps German, translates English, fills placeholders', () => {
    expect(translate('de', 'Wette platziert · {0}', ['SB-1'])).toBe('Wette platziert · SB-1');
    expect(translate('en', 'Wette platziert · {0}', ['SB-1'])).toBe('Bet placed · SB-1');
    expect(translate('en', 'Wettschein')).toBe('Bet slip');
    expect(translate('en', null)).toBe('');
  });

  it('handles dates, market lines and selection names from the book', () => {
    expect(translate('en', 'Heute 18:30')).toBe('Today 18:30');
    expect(translate('en', 'Do., 02.10. 20:45')).toBe('Thu 02/10 20:45');
    expect(translate('en', 'vor 5 Minuten')).toBe('5 minutes ago');
    expect(translate('en', 'Tore Über/Unter 2.5')).toBe('Goals Over/Under 2.5');
    expect(translate('en', 'Über 2.5')).toBe('Over 2.5');
    expect(translate('en', 'FC Nordhafen oder Unentschieden')).toBe('FC Nordhafen or draw');
    expect(translate('en', 'L. Varga – Punkte Über 21.5')).toBe('L. Varga – points over 21.5');
  });

  it('falls back to German for anything unknown and has no empty entries', () => {
    expect(translate('en', 'Blau-Weiß Kronach')).toBe('Blau-Weiß Kronach');
    expect(Object.values(EN).every((v) => v.trim().length > 0)).toBe(true);
  });
});
