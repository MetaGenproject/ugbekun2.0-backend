/**
 * Student internal coin wallet — completely separate from the XP gamification ledger.
 * Supports atomic credit/debit with idempotent transaction records.
 */

/**
 * Gets or creates a student's wallet, returns the wallet record.
 */
export async function getOrCreateWallet(studentId: number, prisma: any) {
  let wallet = await prisma.studentWallet.findUnique({ where: { studentId } });
  if (!wallet) {
    wallet = await prisma.studentWallet.create({ data: { studentId, balance: 0 } });
  }
  return wallet;
}

export interface CreditDebitOptions {
  studentId: number;
  amount: number;
  type: string;
  referenceId?: number | null;
  note?: string | null;
  prisma: any;
}

/**
 * Credits coins to a student's wallet.
 */
export async function credit({
  studentId,
  amount,
  type,
  referenceId = null,
  note = null,
  prisma,
}: CreditDebitOptions) {
  if (amount <= 0) throw new Error('Credit amount must be positive.');

  return prisma.$transaction(async (tx: any) => {
    const wallet = await getOrCreateWallet(studentId, tx);

    const updatedWallet = await tx.studentWallet.update({
      where: { id: wallet.id },
      data: { balance: { increment: amount } },
    });

    await tx.walletTransaction.create({
      data: {
        walletId: wallet.id,
        amount,
        type,
        referenceId,
        note,
      },
    });

    return { balance: updatedWallet.balance, credited: amount };
  });
}

/**
 * Debits coins from a student's wallet. Fails if insufficient balance.
 */
export async function debit({
  studentId,
  amount,
  type,
  referenceId = null,
  note = null,
  prisma,
}: CreditDebitOptions) {
  if (amount <= 0) throw new Error('Debit amount must be positive.');

  return prisma.$transaction(async (tx: any) => {
    const wallet = await getOrCreateWallet(studentId, tx);

    if (wallet.balance < amount) {
      throw new Error(`Insufficient wallet balance. Current: ${wallet.balance}, Required: ${amount}`);
    }

    const updatedWallet = await tx.studentWallet.update({
      where: { id: wallet.id },
      data: { balance: { decrement: amount } },
    });

    await tx.walletTransaction.create({
      data: {
        walletId: wallet.id,
        amount: -amount,
        type,
        referenceId,
        note,
      },
    });

    return { balance: updatedWallet.balance, debited: amount };
  });
}

/**
 * Returns the student's current wallet balance and last 10 transactions.
 */
export async function getWalletSummary(studentId: number, prisma: any) {
  const wallet = await prisma.studentWallet.findUnique({
    where: { studentId },
    include: {
      transactions: {
        orderBy: { createdAt: 'desc' },
        take: 10,
      },
    },
  });

  if (!wallet) {
    return { balance: 0, transactions: [] };
  }

  return {
    balance: wallet.balance,
    transactions: wallet.transactions,
  };
}

export default { credit, debit, getWalletSummary, getOrCreateWallet };
