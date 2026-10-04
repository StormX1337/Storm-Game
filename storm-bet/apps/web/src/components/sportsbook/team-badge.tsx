import { cn } from '@storm-bet/ui';

/** A stable hue per team name, so a team always carries the same colours. */
export function teamHue(name: string): number {
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) % 360;
  return h;
}

function initials(name: string, short?: string): string {
  // Three letters fit the large badge only; the small one takes two.
  if (short && short.length <= 3) return short.toUpperCase();
  const words = name
    .replace(/[^\p{L}\p{N} ]/gu, '')
    .split(/\s+/)
    .filter(Boolean);
  const letters =
    words.length > 1 ? words[0]![0]! + words[words.length - 1]![0]! : name.slice(0, 2);
  return letters.toUpperCase();
}

/** Our own neutral team mark (initials on a colour): no club logos are used. */
export function TeamBadge({
  name,
  short,
  className,
}: {
  name: string;
  /** Short name for large badges; small ones use two initials. */
  short?: string;
  className?: string;
}) {
  const h = teamHue(name);
  return (
    <span
      aria-hidden="true"
      className={cn(
        'grid size-5 shrink-0 place-items-center rounded-full text-[8px] font-bold tracking-wide ring-1 ring-inset ring-white/10',
        className,
      )}
      style={{ background: `hsl(${h} 42% 24%)`, color: `hsl(${h} 80% 82%)` }}
    >
      {initials(name, short)}
    </span>
  );
}
