import pool from '../db.js';

/**
 * Create a new coupon.
 *
 * @param {string} code
 * @param {'percent'|'flat'} discountType
 * @param {number} discountValue
 * @param {number} minSpend
 * @param {string} expiresAt
 * @param {number} usageLimit
 * @param {number|null} [maxDiscountAmount]
 * @param {number|null} [usageLimitPerUser]
 * @returns {Promise<string>}
 */
export async function createCoupon(
  code,
  discountType,
  discountValue,
  minSpend,
  expiresAt,
  usageLimit,
  maxDiscountAmount = null,
  usageLimitPerUser = null
) {
  // Basic validation
  if (!code || typeof code !== 'string' || !code.trim()) {
    throw new Error('Coupon code is required');
  }

  code = code.trim();

  if (!['percent', 'flat'].includes(discountType)) {
    throw new Error('discountType must be either percent or flat');
  }

  if (
    typeof discountValue !== 'number' ||
    !Number.isFinite(discountValue) ||
    discountValue <= 0
  ) {
    throw new Error('discountValue must be greater than 0');
  }

  if (
    typeof minSpend !== 'number' ||
    !Number.isFinite(minSpend) ||
    minSpend < 0
  ) {
    throw new Error('minSpend must be 0 or greater');
  }

  if (!expiresAt || Number.isNaN(Date.parse(expiresAt))) {
    throw new Error('expiresAt must be a valid ISO date');
  }

  if (
    !Number.isInteger(usageLimit) ||
    usageLimit <= 0
  ) {
    throw new Error('usageLimit must be a positive integer');
  }

  if (maxDiscountAmount !== null) {
    if (
      typeof maxDiscountAmount !== 'number' ||
      !Number.isFinite(maxDiscountAmount) ||
      maxDiscountAmount <= 0
    ) {
      throw new Error('maxDiscountAmount must be greater than 0');
    }
  }

  if (usageLimitPerUser !== null) {
    if (
      !Number.isInteger(usageLimitPerUser) ||
      usageLimitPerUser <= 0
    ) {
      throw new Error('usageLimitPerUser must be a positive integer');
    }
  }

  // A percentage must be between 0 and 100.
  if (discountType === 'percent' && discountValue > 100) {
    throw new Error('Percentage discount cannot exceed 100');
  }

  try {
    await pool.query(
      `
      INSERT INTO coupons (
        code,
        discount_type,
        discount_value,
        min_spend,
        expires_at,
        usage_limit,
        times_used,
        max_discount_amount,
        usage_limit_per_user
      )
      VALUES ($1, $2, $3, $4, $5, $6, 0, $7, $8)
      `,
      [
        code,
        discountType,
        discountValue,
        minSpend,
        new Date(expiresAt),
        usageLimit,
        maxDiscountAmount,
        usageLimitPerUser,
      ]
    );
  } catch (err) {
    if (err.code === '23505') {
      throw new Error(`Coupon '${code}' already exists`);
    }

    throw err;
  }

  return `Coupon '${code}' created successfully`;
}
