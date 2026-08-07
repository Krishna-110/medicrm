import type { Tx } from '../db/prisma.js';
import { ApiError } from '../lib/errors.js';

/**
 * Per-location stock, in one place so conversion, renewal and the stock endpoint can never
 * drift on how they read or write it.
 *
 * The per-location rows are the source of truth; Product.stockQuantity is a cached sum that
 * refreshTotal keeps current on every change, so the catalogue's headline total stays honest
 * without every read having to aggregate.
 */

/** Units of a product at a location. A missing row is zero. */
export async function stockAt(tx: Tx, productId: string, locationId: string): Promise<number> {
  const row = await tx.productLocationStock.findUnique({
    where: { productId_locationId: { productId, locationId } },
    select: { quantity: true },
  });
  return row?.quantity ?? 0;
}

/** Recompute a product's cached total from its live location rows. */
async function refreshTotal(tx: Tx, productId: string): Promise<void> {
  const agg = await tx.productLocationStock.aggregate({
    where: { productId, location: { deletedAt: null } },
    _sum: { quantity: true },
  });
  await tx.product.update({ where: { id: productId }, data: { stockQuantity: agg._sum.quantity ?? 0 } });
}

/** Adds `delta` (may be negative) to a location's stock, flooring at zero, then refreshes the
 *  cached total. Creates the row if the product has never been stocked there. */
export async function changeStock(tx: Tx, productId: string, locationId: string, delta: number): Promise<void> {
  const next = Math.max((await stockAt(tx, productId, locationId)) + delta, 0);
  await tx.productLocationStock.upsert({
    where: { productId_locationId: { productId, locationId } },
    create: { productId, locationId, quantity: next },
    update: { quantity: next },
  });
  await refreshTotal(tx, productId);
}

/** Sets a location's stock to an absolute value, then refreshes the cached total. */
export async function setStock(tx: Tx, productId: string, locationId: string, quantity: number): Promise<void> {
  await tx.productLocationStock.upsert({
    where: { productId_locationId: { productId, locationId } },
    create: { productId, locationId, quantity },
    update: { quantity },
  });
  await refreshTotal(tx, productId);
}

/**
 * The location a sale draws from: the lead's or renewal's assigned caller sells from theirs,
 * and theirs only. Whoever clicks convert, the stock leaves the caller's location — an admin
 * converting on their behalf included.
 *
 * Throws when there is no caller or the caller has no location, because then there is no
 * defined place for the stock to come from and the sale must not guess.
 */
export async function resolveSellerLocation(
  tx: Tx,
  assignedCallerId: string | null,
): Promise<string> {
  if (!assignedCallerId) {
    throw ApiError.badRequest('Assign this lead to a caller with a location before converting.');
  }
  const caller = await tx.user.findUnique({
    where: { id: assignedCallerId },
    select: { locationId: true },
  });
  if (!caller?.locationId) {
    throw ApiError.badRequest('The assigned caller has no location — an admin must set one before selling.');
  }
  return caller.locationId;
}
