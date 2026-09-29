'use client';

import type { TransactionDto } from '@storm-bet/types';
import { cn, Table, Td, Th } from '@storm-bet/ui';
import { formatDateTime, formatMoney } from '@/lib/format';
import { TRANSACTION_LABELS } from '@/lib/labels';
import { LoadMore } from './load-more';

function Row({ tx }: { tx: TransactionDto }) {
  // What the player feels: the change of the available amount.
  const available = tx.amount - tx.reservedDelta;
  return (
    <tr>
      <Td className="whitespace-nowrap text-xs text-fg-muted">{formatDateTime(tx.createdAt)}</Td>
      <Td>
        <p className="font-medium">{TRANSACTION_LABELS[tx.type]}</p>
        <p className="text-xs text-fg-subtle">{tx.description}</p>
      </Td>
      <Td
        className={cn(
          'tabular whitespace-nowrap text-right font-semibold',
          available > 0 && 'text-up',
          available < 0 && 'text-fg',
        )}
      >
        {available === 0 ? '±0,00' : formatMoney(available, { sign: true, unit: false })}
      </Td>
      <Td className="tabular whitespace-nowrap text-right text-xs text-fg-muted">
        {formatMoney(tx.balanceAfter, { unit: false })}
        {tx.reservedAfter ? (
          <span className="block text-fg-subtle">
            davon reserviert {formatMoney(tx.reservedAfter, { unit: false })}
          </span>
        ) : null}
      </Td>
    </tr>
  );
}

export function TransactionsTable({
  items,
  nextCursor,
  path,
}: {
  items: TransactionDto[];
  nextCursor: string | null;
  path: string;
}) {
  return (
    <>
      <Table>
        <thead>
          <tr>
            <Th>Datum</Th>
            <Th>Buchung</Th>
            <Th className="text-right">Verfügbar Δ</Th>
            <Th className="text-right">Kontostand</Th>
          </tr>
        </thead>
        <tbody>
          {items.map((tx) => (
            <Row key={tx.id} tx={tx} />
          ))}
          <LoadMore<TransactionDto>
            asRow
            path={path}
            initialCursor={nextCursor}
            render={(more) => more.map((tx) => <Row key={tx.id} tx={tx} />)}
          />
        </tbody>
      </Table>
    </>
  );
}
