/**
 * walletService.js
 * Student internal coin wallet — completely separate from the XP gamification ledger.
 * Supports atomic credit/debit with idempotent transaction records.
 */

/**
 * Gets or creates a student's wallet, returns the wallet record.
 */
async function getOrCreateWallet(studentId, prisma) {
  let wallet = await prisma.studentWallet.findUnique({ where: { studentId } });
  if (!wallet) {
    wallet = await prisma.studentWallet.create({ data: { studentId, balance: 0 } });
  }
  return wallet;
}

/**
 * Credits coins to a student's wallet.
 * @param {object} opts
 * @param {number} opts.studentId
 * @param {number} opts.amount - Positive integer
 * @param {string} opts.type - e.g. 'TRIVIA_WIN'
 * @param {number|null} opts.referenceId
 * @param {string|null} opts.note
 * @param {any} opts.prisma
 */
async function credit({ studentId, amount, type, referenceId = null, note = null, prisma }) {
  if (amount <= 0) throw new Error('Credit amount must be positive.');

  return prisma.$transaction(async (tx) => {
    const wallet = await getOrCreateWallet(studentId, tx);

    const updatedWallet = await tx.studentWallet.update({
      where: { id: wallet.id },
      data: { balance: { increment: amount } }
    });

    await tx.walletTransaction.create({
      data: {
        walletId: wallet.id,
        amount,
        type,
        referenceId,
        note
      }
    });

    return { balance: updatedWallet.balance, credited: amount };
  });
}

/**
 * Debits coins from a student's wallet. Fails if insufficient balance.
 */
async function debit({ studentId, amount, type, referenceId = null, note = null, prisma }) {
  if (amount <= 0) throw new Error('Debit amount must be positive.');

  return prisma.$transaction(async (tx) => {
    const wallet = await getOrCreateWallet(studentId, tx);

    if (wallet.balance < amount) {
      throw new Error(`Insufficient wallet balance. Current: ${wallet.balance}, Required: ${amount}`);
    }

    const updatedWallet = await tx.studentWallet.update({
      where: { id: wallet.id },
      data: { balance: { decrement: amount } }
    });

    await tx.walletTransaction.create({
      data: {
        walletId: wallet.id,
        amount: -amount,
        type,
        referenceId,
        note
      }
    });

    return { balance: updatedWallet.balance, debited: amount };
  });
}

/**
 * Returns the student's current wallet balance and last 10 transactions.
 */
async function getWalletSummary(studentId, prisma) {
  const wallet = await prisma.studentWallet.findUnique({
    where: { studentId },
    include: {
      transactions: {
        orderBy: { createdAt: 'desc' },
        take: 10
      }
    }
  });

  if (!wallet) {
    return { balance: 0, transactions: [] };
  }

  return {
    balance: wallet.balance,
    transactions: wallet.transactions
  };
}

module.exports = { credit, debit, getWalletSummary, getOrCreateWallet };
