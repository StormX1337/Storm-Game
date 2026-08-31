import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ServerStatus, NodeStatus } from '@storm/types';
import { ServerStatusBadge, NodeStatusBadge } from '@/components/panel/stats';

describe('ServerStatusBadge', () => {
  it('renders a readable label for every status, never a raw enum', () => {
    for (const status of Object.values(ServerStatus)) {
      const { unmount } = render(<ServerStatusBadge status={status} />);
      // INSTALL_FAILED must reach the customer as "Install failed".
      expect(screen.queryByText(status)).not.toBeInTheDocument();
      unmount();
    }
  });

  it('names the states a customer acts on', () => {
    const { rerender } = render(<ServerStatusBadge status={ServerStatus.ONLINE} />);
    expect(screen.getByText('Online')).toBeInTheDocument();

    rerender(<ServerStatusBadge status={ServerStatus.CRASHED} />);
    expect(screen.getByText('Crashed')).toBeInTheDocument();

    rerender(<ServerStatusBadge status={ServerStatus.INSTALL_FAILED} />);
    expect(screen.getByText('Install failed')).toBeInTheDocument();
  });

  it('falls back to the raw value rather than rendering nothing', () => {
    // An API that grows a status the panel has not shipped yet should degrade
    // to something visible, not to an empty badge.
    render(<ServerStatusBadge status={'MIGRATING' as ServerStatus} />);
    expect(screen.getByText('MIGRATING')).toBeInTheDocument();
  });
});

describe('NodeStatusBadge', () => {
  it('covers every node status', () => {
    for (const status of Object.values(NodeStatus)) {
      const { unmount } = render(<NodeStatusBadge status={status} />);
      expect(screen.queryByText(status)).not.toBeInTheDocument();
      unmount();
    }
  });
});
