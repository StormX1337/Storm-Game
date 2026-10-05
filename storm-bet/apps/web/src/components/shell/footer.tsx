import Link from 'next/link';
import { getPlatformMeta } from '@/lib/server-api';
import { Brand } from './brand';
import { LanguageSwitch } from './language-switch';
import { getT } from '@/i18n/server';

const LINKS = [
  { href: '/sports', label: 'Sportarten' },
  { href: '/live', label: 'Live' },
  { href: '/responsible-gaming', label: 'Verantwortungsvolles Spielen' },
  { href: '/terms', label: 'Nutzungsbedingungen' },
  { href: '/privacy', label: 'Datenschutz' },
  { href: '/contact', label: 'Kontakt' },
];

export async function Footer() {
  const t = await getT();
  const { odds } = await getPlatformMeta();
  return (
    <footer className="mt-16 border-t border-border bg-surface/60">
      <div className="mx-auto grid max-w-[1440px] gap-8 px-4 py-10 md:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)] lg:px-6">
        <div className="space-y-4">
          <div className="flex items-center justify-between gap-3">
            <Brand alwaysShowName />
            <LanguageSwitch />
          </div>
          <p className="max-w-md text-sm leading-relaxed text-fg-muted">
            {t('STORM BET ist eine Demonstrationsplattform.')}{' '}
            {odds.isSimulated
              ? t('Alle Spiele, Teams und Quoten sind simuliert.')
              : t('Spiele, Quoten und Ergebnisse stammen von {0}; Angaben ohne Gewähr.', [
                  odds.name,
                ])}{' '}
            {t(
              'Gewettet wird ausschließlich mit Demo-Guthaben ohne Geldwert. Es gibt keine Einzahlungen, keine Auszahlungen und keine Gewinnversprechen.',
            )}
          </p>
          <div className="flex items-center gap-3 text-xs text-fg-subtle">
            <span className="grid size-8 place-items-center rounded-full border border-border-strong text-[11px] font-bold text-fg-muted">
              18+
            </span>
            <span>
              {t('Glücksspiel kann süchtig machen. Hilfe unter')}{' '}
              <a
                href="https://www.check-dein-spiel.de"
                className="underline underline-offset-2 hover:text-fg"
                rel="noopener noreferrer"
                target="_blank"
              >
                check-dein-spiel.de
              </a>{' '}
              {t('· BZgA-Hotline 0800 1 37 27 00 (kostenlos)')}
            </span>
          </div>
        </div>
        <nav
          aria-label={t('Fußzeile')}
          className="grid min-w-0 grid-cols-2 gap-x-6 gap-y-2 text-sm sm:grid-cols-3 md:grid-cols-2 md:justify-self-end lg:grid-cols-3"
        >
          {LINKS.map((l) => (
            <Link
              key={l.href}
              href={l.href}
              className="text-fg-muted transition-colors hover:text-fg"
            >
              {t(l.label)}
            </Link>
          ))}
        </nav>
      </div>
      <div className="border-t border-border">
        <p className="mx-auto max-w-[1440px] px-4 py-4 text-xs text-fg-subtle lg:px-6">
          © {new Date().getFullYear()}{' '}
          {t('STORM BET · Demo-Software ohne Glücksspiellizenz · Kein Echtgeldbetrieb')}
        </p>
      </div>
    </footer>
  );
}
