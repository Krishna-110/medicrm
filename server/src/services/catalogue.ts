import type { Prisma } from '@prisma/client';

/**
 * The catalogue product a medicine name refers to, if any.
 *
 * Best-effort and exact, case-insensitive, against both the brand and generic name. A
 * free-text medicine simply has no product behind it, which is a normal state rather than an
 * error — it just cannot be priced.
 *
 * Shared by lead creation (which stores the link) and by pricing (which falls back to it when
 * the stored link is missing), so the two can never disagree about what counts as a match.
 */
export async function findCatalogueProductByName<T extends Pick<Prisma.TransactionClient, 'product'>>(
  db: T,
  name: string,
) {
  return db.product.findFirst({
    where: {
      isActive: true,
      deletedAt: null,
      OR: [
        { brandName: { equals: name, mode: 'insensitive' } },
        { genericName: { equals: name, mode: 'insensitive' } },
      ],
    },
  });
}
