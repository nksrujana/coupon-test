import pool from '../db.js';

/**
 * Get the current state of a coupon.
 *
 * @param {string} code
 * @returns {Promise<{
 *   code: string,
 *   timesUsed: number,
 *   usageLimit: number,
 *   expiresAt: string
 * }>}
 */
export async function getCoupon(code) {
  if (!code || typeof code !== 'string' || !code.trim()) {
    throw new Error('Coupon code is required');
  }

  const result = await pool.query(
    `
    SELECT
      code,
      times_used,
      usage_limit,
      expires_at
    FROM coupons
    WHERE code = $1
    `,
    [code.trim()]
  );

  if (result.rowCount === 0) {
    throw new Error(`Coupon '${code}' not found`);
  }

  const coupon = result.rows[0];

  return {
    code: coupon.code,
    timesUsed: Number(coupon.times_used),
    usageLimit: Number(coupon.usage_limit),
    expiresAt: new Date(coupon.expires_at).toISOString(),
  };
}
