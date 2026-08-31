import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Field, Input } from '@storm/ui';

/**
 * Field binds a label to its control. This was broken once — the label had no
 * `htmlFor` and the input no `id` — which made every form in the panel
 * announce as unlabelled and made half the browser tests unable to find a
 * field at all. These assertions are the ones that would have caught it.
 */
describe('Field', () => {
  it('binds the label to the control it wraps', () => {
    render(
      <Field label="Email or username">
        <Input />
      </Field>,
    );

    const input = screen.getByLabelText('Email or username');
    expect(input).toBeInTheDocument();
    expect(input.id).not.toBe('');
  });

  it('keeps the required marker out of the accessible name', () => {
    // Otherwise the field announces as "Password star" and getByLabel('Password')
    // no longer matches it.
    render(
      <Field label="Password" required>
        <Input type="password" />
      </Field>,
    );

    expect(screen.getByLabelText('Password')).toBeInTheDocument();
    expect(screen.getByText('*')).toHaveAttribute('aria-hidden');
  });

  it('describes the control with its hint', () => {
    render(
      <Field label="Username" hint="Letters, numbers, dots, dashes and underscores.">
        <Input />
      </Field>,
    );

    const input = screen.getByLabelText('Username');
    const describedBy = input.getAttribute('aria-describedby');
    expect(describedBy).toBeTruthy();
    expect(document.getElementById(describedBy!)).toHaveTextContent(/Letters, numbers/);
  });

  it('replaces the hint with the error, so the failure is what gets announced', () => {
    render(
      <Field label="Email" hint="We never share this." error="Invalid email">
        <Input />
      </Field>,
    );

    const input = screen.getByLabelText('Email');
    const describedBy = input.getAttribute('aria-describedby');
    expect(document.getElementById(describedBy!)).toHaveTextContent('Invalid email');
    expect(screen.queryByText('We never share this.')).not.toBeInTheDocument();
  });

  it('shows the first message when the API returns several for one field', () => {
    render(
      <Field label="Password" error={['Password must be at least 10 characters', 'Too common']}>
        <Input />
      </Field>,
    );

    expect(screen.getByText('Password must be at least 10 characters')).toBeInTheDocument();
  });

  it('adopts the first control even when siblings follow it', () => {
    // The registration form puts a strength meter next to the input; the label
    // must still bind to the input rather than to nothing.
    render(
      <Field label="Password">
        <Input type="password" />
        <div>strength meter</div>
      </Field>,
    );

    expect(screen.getByLabelText('Password').tagName).toBe('INPUT');
  });

  it('leaves an id the caller set alone', () => {
    render(
      <Field label="Authenticator code" htmlFor="totp-code">
        <div>
          <Input id="totp-code" />
        </div>
      </Field>,
    );

    expect(screen.getByLabelText('Authenticator code').id).toBe('totp-code');
  });

  it('gives two fields on one page different ids', () => {
    render(
      <>
        <Field label="First name">
          <Input />
        </Field>
        <Field label="Last name">
          <Input />
        </Field>
      </>,
    );

    const first = screen.getByLabelText('First name');
    const last = screen.getByLabelText('Last name');
    expect(first.id).not.toBe(last.id);
  });
});
