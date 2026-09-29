import { $Enums } from '@prisma/client';
import * as shared from '@storm-bet/types';
import { describe, expect, it } from 'vitest';

// The browser never loads the Prisma client, so @storm-bet/types keeps its own
// copy of every enum. This test is what keeps the two from drifting.
const pairs: [string, Record<string, string>, readonly string[]][] = [
  ['UserRole', $Enums.UserRole, shared.USER_ROLES],
  ['UserStatus', $Enums.UserStatus, shared.USER_STATUSES],
  ['EventStatus', $Enums.EventStatus, shared.EVENT_STATUSES],
  ['MarketStatus', $Enums.MarketStatus, shared.MARKET_STATUSES],
  ['SelectionStatus', $Enums.SelectionStatus, shared.SELECTION_STATUSES],
  ['SelectionResult', $Enums.SelectionResult, shared.SELECTION_RESULTS],
  ['BetStatus', $Enums.BetStatus, shared.BET_STATUSES],
  ['BetType', $Enums.BetType, shared.BET_TYPES],
  ['SlipMode', $Enums.SlipMode, shared.SLIP_MODES],
  ['OddsChangePolicy', $Enums.OddsChangePolicy, shared.ODDS_CHANGE_POLICIES],
  ['TransactionType', $Enums.TransactionType, shared.TRANSACTION_TYPES],
  ['LimitType', $Enums.LimitType, shared.LIMIT_TYPES],
  ['KycStatus', $Enums.KycStatus, shared.KYC_STATUSES],
  ['MarketType', $Enums.MarketType, shared.MARKET_TYPES],
  ['Outcome', $Enums.Outcome, shared.OUTCOMES],
];

describe('shared enums mirror the database', () => {
  it.each(pairs)('%s', (_name, prismaEnum, sharedValues) => {
    expect([...sharedValues].sort()).toEqual(Object.values(prismaEnum).sort());
  });
});
