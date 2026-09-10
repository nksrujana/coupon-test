import pool from '../db.js';

/**
 * Create a new order for `cartTotal` and apply a single coupon to it:
 * validate the coupon, compute the discount, record the redemption
 * (counts against the coupon's usage_limit, and its usage_limit_per_user
 * if `userId` is given — bonus 2), and store the result on the order.
 * @param {number} cartTotal
 * @param {string} code
 * @param {string|null} [userId] - bonus 2: required if the coupon has a usage_limit_per_user
 * @returns {Promise<{orderId: string, discountAmount: number, finalTotal: number}>}
 * @throws {Error} if the coupon is invalid, expired, below min spend, or
 *   at its usage limit (global or per-user)
 */
export async function applyCoupon(cartTotal, code, userId = null) {
  // TODO: implement.
  throw new Error('not implemented');
}
