import * as React from 'react';
import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ConfirmProvider, ToastProvider } from '@storm/ui';
import { INSTALL_BUSY_STATUSES, type ServerStatus } from '@storm/types';
import { ServerProvider, useServer } from '@/components/panel/server-context';
import { ServerHeaderPowerControls } from '@/components/panel/power-controls';
import { ServerStatusBadge } from '@/components/panel/stats';

/**
 * The badge and the power buttons have to be reading the same status.
 *
 * They were not. The badge took the account socket's value, which arrives on
 * every page for every transition; the buttons took a context value that only
 * the console page ever refreshed, so on any other page they were frozen at
 * whatever the page load had fetched. A server put into REINSTALLING from
 * somewhere else showed the new badge beside a lit Start button — and pressing
 * it got "This server is still installing", an error for an action the panel
 * should never have offered.
 *
 * `PowerControls` already refuses every install-busy status. The bug was never
 * in the rule; it was that the rule was being asked about the wrong server
 * state. So this asserts on the two together, from one source, rather than on
 * either alone.
 */

const server = {
  id: 'srv_1',
  shortId: 'abc123',
  uuid: 'u',
  name: 'Storm SMP Test',
  status: 'OFFLINE' as ServerStatus,
  permissions: ['servers.start', 'servers.stop', 'servers.restart', 'servers.kill'],
  suspended: false,
} as never;

/** Renders the header pair exactly as the server layout does. */
function Header({ socketStatus }: { socketStatus?: ServerStatus }) {
  return (
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <ToastProvider>
        <ConfirmProvider>
          <ServerProvider server={server} socketStatus={socketStatus}>
            <ServerStatusBadge status={socketStatus ?? 'OFFLINE'} />
            <ServerHeaderPowerControls />
            <Readout />
          </ServerProvider>
        </ConfirmProvider>
      </ToastProvider>
    </QueryClientProvider>
  );
}

/** What the context hands to anything that asks. */
function Readout() {
  const { status } = useServer();
  // Prefixed so it cannot be mistaken for the badge when querying by text.
  return <span data-testid="context-status">context:{status}</span>;
}

// Exact, because "Restart" also matches a loose /start/ pattern.
const startButton = () => screen.getByRole('button', { name: 'Start' });

describe('the status the header reads', () => {
  it('offers Start on a server that is merely off', () => {
    render(<Header socketStatus="OFFLINE" />);
    expect(startButton()).toBeEnabled();
  });

  for (const status of INSTALL_BUSY_STATUSES) {
    it(`refuses Start while the server is ${status}`, () => {
      // The fetched row still says OFFLINE — this is the case that broke: the
      // transition happened after the page loaded, so only the socket knows.
      render(<Header socketStatus={status} />);
      expect(startButton()).toBeDisabled();
    });
  }

  it('refuses Start on a suspended server', () => {
    render(<Header socketStatus="SUSPENDED" />);
    expect(startButton()).toBeDisabled();
  });

  it('hands the socket status on rather than the stale fetched one', () => {
    render(<Header socketStatus="REINSTALLING" />);
    // The badge and the buttons can only agree if this is what they both see.
    expect(screen.getByTestId('context-status')).toHaveTextContent('REINSTALLING');
    expect(screen.getByText(/^reinstalling$/i)).toBeInTheDocument();
  });

  it('falls back to the fetched row before the socket has said anything', () => {
    render(<Header />);
    expect(screen.getByTestId('context-status')).toHaveTextContent('OFFLINE');
    expect(startButton()).toBeEnabled();
  });
});

/**
 * Pressing a power button paints the expected state before the socket
 * confirms it, so the badge does not sit on the old one for a second. That
 * guess must not outlive the truth: a server that goes into REINSTALLING
 * from somewhere else has to take the buttons with it, even if this tab
 * pressed Start a moment earlier.
 */
describe('the optimistic status a button press paints', () => {
  function Guessing({ socketStatus }: { socketStatus: ServerStatus }) {
    return (
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <ToastProvider>
          <ConfirmProvider>
            <ServerProvider server={server} socketStatus={socketStatus}>
              <GuessButton />
              <ServerHeaderPowerControls />
              <Readout />
            </ServerProvider>
          </ConfirmProvider>
        </ToastProvider>
      </QueryClientProvider>
    );
  }

  /**
   * Stands in for the press. It has to be a real click rather than a mount
   * effect: the provider clears the guess whenever the reported status
   * changes, and on mount that includes the first report — so a guess set
   * during mounting is wiped before anything can see it, which is true of the
   * harness and never true of a button.
   */
  function GuessButton() {
    const { setLiveStatus } = useServer();
    return (
      <button type="button" onClick={() => setLiveStatus('STARTING')}>
        guess
      </button>
    );
  }

  const press = () => fireEvent.click(screen.getByRole('button', { name: 'guess' }));

  it('shows the guess while the socket still reports the old state', () => {
    render(<Guessing socketStatus="OFFLINE" />);
    press();
    expect(screen.getByTestId('context-status')).toHaveTextContent('STARTING');
  });

  it('gives way the moment the socket reports something real', () => {
    const { rerender } = render(<Guessing socketStatus="OFFLINE" />);
    press();
    expect(screen.getByTestId('context-status')).toHaveTextContent('STARTING');

    rerender(<Guessing socketStatus="REINSTALLING" />);

    expect(screen.getByTestId('context-status')).toHaveTextContent('REINSTALLING');
    expect(startButton()).toBeDisabled();
  });
});
