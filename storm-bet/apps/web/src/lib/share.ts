'use client';

/** Link that opens the given selections as a bet slip (stakes are never shared). */
export function slipLink(selectionIds: string[]): string {
  return `${window.location.origin}/share?ids=${selectionIds.join(',')}`;
}

/**
 * Shares a link via the system share sheet, or copies it. The clipboard and
 * share APIs exist only on HTTPS/localhost; plain HTTP falls back to the
 * legacy copy command.
 */
export async function shareLink(
  url: string,
  title: string,
): Promise<'shared' | 'copied' | 'failed'> {
  try {
    if (typeof navigator.share === 'function') {
      await navigator.share({ title, url });
      return 'shared';
    }
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') return 'failed';
  }
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(url);
      return 'copied';
    }
  } catch {
    // fall through to the legacy copy
  }
  const area = document.createElement('textarea');
  area.value = url;
  area.setAttribute('readonly', '');
  area.style.position = 'fixed';
  area.style.opacity = '0';
  document.body.appendChild(area);
  area.select();
  const ok = document.execCommand('copy');
  area.remove();
  return ok ? 'copied' : 'failed';
}
