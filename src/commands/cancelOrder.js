import pool from '../db.js';

/**
 * Cancel an order.
 *
 * If the order used a coupon, its usage count is released.
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
     * Lock the order.
     *
     * This prevents two terminal sessions from cancelling
     * the same order simultaneously.
     */
    const orderResult = await client.query(
      `
      SELECT
        id,
        coupon_code,
        status
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
     * If the order used a coupon, lock the coupon row
     * before modifying its usage count.
     */
    if (order.coupon_code) {
      const couponResult = await client.query(
        `
        SELECT code, times_used
        FROM coupons
        WHERE code = $1
        FOR UPDATE
        `,
        [order.coupon_code]
      );

      /*
       * The foreign key means the coupon should normally
       * exist. This check makes the failure explicit.
       */
      if (couponResult.rowCount === 0) {
        throw new Error(
          `Coupon '${order.coupon_code}' associated with order was not found`
        );
      }

      const coupon = couponResult.rows[0];

      if (coupon.times_used <= 0) {
        throw new Error(
          `Coupon '${coupon.code}' usage count is already zero`
        );
      }

      await client.query(
        `
        UPDATE coupons
        SET times_used = times_used - 1
        WHERE code = $1
        `,
        [coupon.code]
      );
    }

    /*
     * Mark order cancelled.
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
