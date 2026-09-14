import { getPaymentGatewayConfig } from './platformRuntime';

export function publicPaymentConfig() {
  const cfg = getPaymentGatewayConfig();
  return {
    enabled: cfg.enabled,
    provider: cfg.provider,
    paystackPublicKey: cfg.paystackPublicKey,
    flutterwavePublicKey: cfg.flutterwavePublicKey,
  };
}

function frontendBase() {
  return (process.env.FRONTEND_URL || 'http://localhost:3001').replace(/\/$/, '');
}

export async function initializeOnlinePayment(opts: {
  email: string;
  amount: number;
  invoiceId: number;
  studentId: number;
  branchId: number;
}) {
  const cfg = getPaymentGatewayConfig();
  if (!cfg.enabled) {
    throw new Error('Online payments are disabled. Configure a gateway in Super Admin → Global Settings.');
  }

  const reference = `UGK-${opts.invoiceId}-${Date.now()}`;
  const amount = Number(opts.amount);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error('Invalid payment amount.');
  }

  if (cfg.provider === 'paystack') {
    const response = await fetch('https://api.paystack.co/transaction/initialize', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${cfg.paystackSecretKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        email: opts.email,
        amount: Math.round(amount * 100),
        reference,
        currency: 'NGN',
        callback_url: `${frontendBase()}/dashboard?pay_ref=${encodeURIComponent(reference)}`,
        metadata: {
          invoiceId: opts.invoiceId,
          studentId: opts.studentId,
          branchId: opts.branchId,
        },
      }),
    });
    const json: any = await response.json();
    if (!response.ok || !json?.status) {
      throw new Error(json?.message || 'Paystack could not start this payment.');
    }
    return {
      provider: 'paystack' as const,
      reference,
      authorizationUrl: json.data.authorization_url as string,
      accessCode: json.data.access_code as string,
      publicKey: cfg.paystackPublicKey,
    };
  }

  const response = await fetch('https://api.flutterwave.com/v3/payments', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${cfg.flutterwaveSecretKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      tx_ref: reference,
      amount,
      currency: 'NGN',
      redirect_url: `${frontendBase()}/dashboard?pay_ref=${encodeURIComponent(reference)}`,
      customer: { email: opts.email },
      meta: {
        invoiceId: opts.invoiceId,
        studentId: opts.studentId,
        branchId: opts.branchId,
      },
    }),
  });
  const json: any = await response.json();
  if (!response.ok || json?.status !== 'success') {
    throw new Error(json?.message || 'Flutterwave could not start this payment.');
  }
  return {
    provider: 'flutterwave' as const,
    reference,
    authorizationUrl: json.data.link as string,
    accessCode: '',
    publicKey: cfg.flutterwavePublicKey,
  };
}

export async function verifyOnlinePayment(reference: string) {
  const cfg = getPaymentGatewayConfig();
  if (!cfg.enabled) {
    throw new Error('Online payments are disabled.');
  }

  if (cfg.provider === 'paystack') {
    const response = await fetch(`https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`, {
      headers: { Authorization: `Bearer ${cfg.paystackSecretKey}` },
    });
    const json: any = await response.json();
    if (!response.ok || !json?.status) {
      throw new Error(json?.message || 'Paystack verification failed.');
    }
    const data = json.data || {};
    if (String(data.status).toLowerCase() !== 'success') {
      throw new Error(`Payment is ${data.status || 'incomplete'}.`);
    }
    return {
      provider: 'paystack' as const,
      reference: String(data.reference || reference),
      amount: Number(data.amount || 0) / 100,
      metadata: data.metadata || {},
    };
  }

  const response = await fetch(`https://api.flutterwave.com/v3/transactions/verify_by_reference?tx_ref=${encodeURIComponent(reference)}`, {
    headers: { Authorization: `Bearer ${cfg.flutterwaveSecretKey}` },
  });
  const json: any = await response.json();
  if (!response.ok || json?.status !== 'success') {
    throw new Error(json?.message || 'Flutterwave verification failed.');
  }
  const data = json.data || {};
  if (String(data.status).toLowerCase() !== 'successful') {
    throw new Error(`Payment is ${data.status || 'incomplete'}.`);
  }
  return {
    provider: 'flutterwave' as const,
    reference: String(data.tx_ref || reference),
    amount: Number(data.amount || 0),
    metadata: data.meta || {},
  };
}
