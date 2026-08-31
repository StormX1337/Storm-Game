import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render as rtlRender, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ToastProvider } from '@storm/ui';
import { ApiError } from '@/lib/api';

const mocks = vi.hoisted(() => ({
  post: vi.fn(),
  replace: vi.fn(),
  refresh: vi.fn(),
  toastSuccess: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: mocks.replace, push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('@/lib/auth-context', () => ({ useAuth: () => ({ refresh: mocks.refresh }) }));
vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  api: { post: mocks.post },
}));

const LoginPage = (await import('@/app/(auth)/login/page')).default;

/** The page raises toasts, so it needs the real provider around it. */
const render = (ui: React.ReactElement) => rtlRender(<ToastProvider>{ui}</ToastProvider>);

beforeEach(() => {
  vi.clearAllMocks();
});

async function fillCredentials(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText('Email or username'), 'ada@example.com');
  await user.type(screen.getByLabelText('Password', { exact: true }), 'CorrectHorse123!');
}

describe('sign-in form', () => {
  it('signs in and goes where the user was headed', async () => {
    const user = userEvent.setup();
    mocks.post.mockResolvedValue({});
    render(<LoginPage />);

    await fillCredentials(user);
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    await waitFor(() => expect(mocks.post).toHaveBeenCalledOnce());
    expect(mocks.post).toHaveBeenCalledWith(
      '/auth/login',
      expect.objectContaining({ identifier: 'ada@example.com', password: 'CorrectHorse123!' }),
    );
    // The session has to be re-read before navigating, or the panel renders
    // signed-out for a beat.
    await waitFor(() => expect(mocks.refresh).toHaveBeenCalled());
    expect(mocks.replace).toHaveBeenCalledWith('/dashboard');
  });

  it('shows the reason a sign-in failed and stays put', async () => {
    const user = userEvent.setup();
    mocks.post.mockRejectedValue(
      new ApiError(401, 'INVALID_CREDENTIALS', 'Those credentials do not match our records'),
    );
    render(<LoginPage />);

    await fillCredentials(user);
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/do not match/i);
    expect(mocks.replace).not.toHaveBeenCalled();
  });

  it('asks for the second factor without discarding what was typed', async () => {
    const user = userEvent.setup();
    mocks.post.mockRejectedValueOnce(
      new ApiError(401, 'TWO_FACTOR_REQUIRED', 'Enter your authenticator code'),
    );
    render(<LoginPage />);

    await fillCredentials(user);
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    const code = await screen.findByLabelText(/Authenticator code|Two-factor|code/i);
    expect(code).toBeInTheDocument();
    // Retyping the password because 2FA kicked in would be a small cruelty.
    expect(screen.getByLabelText('Email or username')).toHaveValue('ada@example.com');
    expect(screen.getByLabelText('Password', { exact: true })).toHaveValue('CorrectHorse123!');
    // And no error banner: needing a code is not a failure.
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();

    mocks.post.mockResolvedValueOnce({});
    await user.type(code, '123456');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    await waitFor(() => expect(mocks.post).toHaveBeenCalledTimes(2));
    expect(mocks.post).toHaveBeenLastCalledWith('/auth/login', expect.objectContaining({ totp: '123456' }));
  });

  it('says something useful when the panel cannot be reached at all', async () => {
    const user = userEvent.setup();
    mocks.post.mockRejectedValue(new TypeError('Failed to fetch'));
    render(<LoginPage />);

    await fillCredentials(user);
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/connection/i);
  });

  it('marks the individual fields the API rejected', async () => {
    const user = userEvent.setup();
    mocks.post.mockRejectedValue(
      new ApiError(422, 'VALIDATION_ERROR', 'The submitted data is invalid', {
        identifier: ['Enter an email address or username'],
      }),
    );
    render(<LoginPage />);

    await fillCredentials(user);
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(await screen.findByText('Enter an email address or username')).toBeInTheDocument();
  });
});
