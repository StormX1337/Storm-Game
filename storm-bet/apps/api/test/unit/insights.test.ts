import { describe, expect, it } from 'vitest';
import { matchTeam } from '../../src/services/insights';

describe('league table team matching', () => {
  const rows = [
    { team: 'Man United', alt: 'Manchester United FC' },
    { team: 'Man City', alt: 'Manchester City FC' },
    { team: 'Bayern', alt: 'FC Bayern München' },
    { team: 'Leverkusen', alt: 'Bayer 04 Leverkusen' },
  ];
  it('finds the club under the feed’s name', () => {
    expect(matchTeam('Manchester United', rows)).toBe(0);
    expect(matchTeam('Manchester City', rows)).toBe(1);
    expect(matchTeam('Bayern Munich', rows)).toBe(2);
    expect(matchTeam('Bayer Leverkusen', rows)).toBe(3);
  });
  it('marks nothing when unsure', () => {
    expect(matchTeam('Manchester', rows)).toBe(-1);
    expect(matchTeam('Real Madrid', rows)).toBe(-1);
  });
});
