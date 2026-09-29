/**
 * Cashier integration point. Deposits and withdrawals of real funds require a
 * gambling licence, KYC, AML monitoring and a regulated payment provider. None
 * of that exists in this build, so the only gateway rejects every request.
 * Demo credit is issued by the wallet service as DEPOSIT_DEMO, never here.
 */
export interface PaymentRequest {
  userId: string;
  amountMinor: number;
  currency: string;
}

export interface PaymentGateway {
  readonly enabled: boolean;
  deposit(request: PaymentRequest): Promise<never>;
  withdraw(request: PaymentRequest): Promise<never>;
}

export class RealMoneyDisabledError extends Error {
  constructor() {
    super(
      'Echtgeld-Zahlungen sind deaktiviert. Diese Plattform nutzt ausschließlich Demo-Guthaben.',
    );
    this.name = 'RealMoneyDisabledError';
  }
}

export class DisabledPaymentGateway implements PaymentGateway {
  readonly enabled = false;

  async deposit(): Promise<never> {
    throw new RealMoneyDisabledError();
  }

  async withdraw(): Promise<never> {
    throw new RealMoneyDisabledError();
  }
}
