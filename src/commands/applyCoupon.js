import pool from '../db.js';

function roundCurrency(value) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

/**
 * Create a new order and apply a single coupon.
 *
 * @param {number} cartTotal
 * @param {string} code
 * @param {string|null} [userId]
 * @returns {Promise<{
 *   orderId: string,
 *   discountAmount: number,
 *   finalTotal: number
 * }>}
 */
export async function applyCoupon(cartTotal, code, userId = null) {
  if (
    typeof cartTotal !== 'number' ||
    !Number.isFinite(cartTotal) ||
    cartTotal < 0
  ) {
    throw new Error('cartTotal must be a non-negative number');
  }

  if (!code || typeof code !== 'string' || !code.trim()) {
    throw new Error('Coupon code is required');
  }

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    /*
     * IMPORTANT:
     * Lock the coupon row before checking times_used.
     *
     * This prevents:
     *
     * Request A -> sees 4/5
     * Request B -> sees 4/5
     * A -> 5
     * B -> 6
     *
     * FOR UPDATE serializes these operations.
     */
    const couponResult = await client.query(
      `
      SELECT
        code,
        discount_type,
        discount_value,
        min_spend,
        expires_at,
        usage_limit,
        times_used,
        max_discount_amount,
        usage_limit_per_user
      FROM coupons
      WHERE code = $1
      FOR UPDATE
      `,
      [code.trim()]
    );

    if (couponResult.rowCount === 0) {
      throw new Error(`Coupon '${code}' not found`);
    }

    const coupon = couponResult.rows[0];

    // Minimum spend check
    if (cartTotal < Number(coupon.min_spend)) {
      throw new Error(
        `Cart total must be at least ${Number(coupon.min_spend).toFixed(2)} to use coupon '${coupon.code}'`
      );
    }

    // Expiry check
    if (new Date() > new Date(coupon.expires_at)) {
      throw new Error(`Coupon '${coupon.code}' has expired`);
    }

    // Global usage limit
    if (coupon.times_used >= coupon.usage_limit) {
      throw new Error(`Coupon '${coupon.code}' has reached its usage limit`);
    }

    // Bonus 2: per-user usage limit
    if (coupon.usage_limit_per_user !== null) {
      if (!userId) {
        throw new Error(
          `User ID is required to use coupon '${coupon.code}'`
        );
      }

      const userUsageResult = await client.query(
        `
        SELECT COUNT(*)::int AS count
        FROM orders
        WHERE coupon_code = $1
          AND user_id = $2
          AND status <> 'cancelled'
        `,
        [coupon.code, userId]
      );

      const userTimesUsed = userUsageResult.rows[0].count;

      if (userTimesUsed >= coupon.usage_limit_per_user) {
        throw new Error(
          `User '${userId}' has reached the usage limit for coupon '${coupon.code}'`
        );
      }
    }

    /*
     * Calculate discount.
     */
    let discountAmount;

    if (coupon.discount_type === 'percent') {
      discountAmount =
        cartTotal * (Number(coupon.discount_value) / 100);

      // Bonus 1: maximum discount cap
      if (coupon.max_discount_amount !== null) {
        discountAmount = Math.min(
          discountAmount,
          Number(coupon.max_discount_amount)
        );
      }
    } else {
      // flat coupon
      discountAmount = Number(coupon.discount_value);
    }

    // Coupon can never make total negative.
    discountAmount = Math.min(discountAmount, cartTotal);

    discountAmount = roundCurrency(discountAmount);

    const finalTotal = roundCurrency(
      Math.max(0, cartTotal - discountAmount)
    );

    /*
     * Create order.
     */
    const orderResult = await client.query(
      `
      INSERT INTO orders (
        cart_total,
        coupon_code,
        discount_amount,
        final_total,
        status,
        user_id
      )
      VALUES ($1, $2, $3, $4, 'pending', $5)
      RETURNING id
      `,
      [
        roundCurrency(cartTotal),
        coupon.code,
        discountAmount,
        finalTotal,
        userId,
      ]
    );

    const orderId = orderResult.rows[0].id;

    /*
     * Record coupon on order_coupons.
     * This is useful for cancellation and bonus stacking.
     */
    await client.query(
      `
      INSERT INTO order_coupons (
        order_id,
        code,
        discount_amount
      )
      VALUES ($1, $2, $3)
      `,
      [orderId, coupon.code, discountAmount]
    );

    /*
     * Increase coupon usage.
     */
    await client.query(
      `
      UPDATE coupons
      SET times_used = times_used + 1
      WHERE code = $1
      `,
      [coupon.code]
    );

    await client.query('COMMIT');

    return {
      orderId,
      discountAmount,
      finalTotal,
    };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
