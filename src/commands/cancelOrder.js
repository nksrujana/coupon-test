import pool from '../db.js';

/**
 * Cancel an order and release every coupon used by that order.
 *
 * @param {string} orderId
 * @returns {Promise<string>}
 */
export async function cancelOrder(orderId) {
  if (!orderId || typeof orderId !== 'string' || !orderId.trim()) {
    throw new Error('Order ID is required');
  }

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    /*
     * Lock the order so two terminals cannot cancel
     * the same order simultaneously.
     */
    const orderResult = await client.query(
      `
      SELECT id, status
      FROM orders
      WHERE id = $1
      FOR UPDATE
      `,
      [orderId.trim()]
    );

    if (orderResult.rowCount === 0) {
      throw new Error(`Order '${orderId}' not found`);
    }

    const order = orderResult.rows[0];

    if (order.status === 'cancelled') {
      throw new Error(`Order '${orderId}' is already cancelled`);
    }

    /*
     * Get all coupons used by this order.
     *
     * order_coupons supports both:
     * - normal single-coupon orders
     * - stacked orders
     */
    const couponsResult = await client.query(
      `
      SELECT code
      FROM order_coupons
      WHERE order_id = $1
      ORDER BY code
      `,
      [order.id]
    );

    /*
     * Backward-compatible fallback:
     * If an old/base order doesn't have an order_coupons row,
     * use orders.coupon_code.
     */
    let couponCodes = couponsResult.rows.map(
      (row) => row.code
    );

    if (couponCodes.length === 0) {
      const fallbackResult = await client.query(
        `
        SELECT coupon_code
        FROM orders
        WHERE id = $1
          AND coupon_code IS NOT NULL
        `,
        [order.id]
      );

      couponCodes = fallbackResult.rows
        .map((row) => row.coupon_code)
        .filter(Boolean);
    }

    /*
     * Always lock coupons in deterministic order.
     * This avoids deadlocks if multiple cancellation
     * operations involve multiple coupons.
     */
    couponCodes = [...new Set(couponCodes)].sort();

    for (const code of couponCodes) {
      const couponResult = await client.query(
        `
        SELECT code, times_used
        FROM coupons
        WHERE code = $1
        FOR UPDATE
        `,
        [code]
      );

      if (couponResult.rowCount === 0) {
        throw new Error(
          `Coupon '${code}' associated with order was not found`
        );
      }

      const coupon = couponResult.rows[0];

      if (coupon.times_used <= 0) {
        throw new Error(
          `Coupon '${code}' usage count is already zero`
        );
      }

      await client.query(
        `
        UPDATE coupons
        SET times_used = times_used - 1
        WHERE code = $1
        `,
        [code]
      );
    }

    /*
     * Finally mark the order cancelled.
     */
    await client.query(
      `
      UPDATE orders
      SET status = 'cancelled'
      WHERE id = $1
      `,
      [order.id]
    );

    await client.query('COMMIT');

    return `Order '${order.id}' cancelled successfully`;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
