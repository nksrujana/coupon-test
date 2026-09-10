import pool from '../db.js';

function roundCurrency(value) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

/**
 * BONUS 3
 *
 * Apply one or two coupons to a single order.
 *
 * STACKING RULE:
 * - At most one percent coupon and one flat coupon.
 * - Percentage coupon is applied first.
 * - Flat coupon is applied second.
 * - If either coupon is invalid, the entire transaction is rolled back.
 *
 * @param {number} cartTotal
 * @param {string[]} codes
 * @param {string|null} [userId]
 * @returns {Promise<{
 *   orderId: string,
 *   discountAmount: number,
 *   finalTotal: number,
 *   appliedCodes: string[]
 * }>}
 */
export async function applyCoupons(cartTotal, codes, userId = null) {
  if (
    typeof cartTotal !== 'number' ||
    !Number.isFinite(cartTotal) ||
    cartTotal < 0
  ) {
    throw new Error('cartTotal must be a non-negative number');
  }

  if (!Array.isArray(codes)) {
    throw new Error('codes must be an array');
  }

  if (codes.length < 1 || codes.length > 2) {
    throw new Error('You can apply one or two coupons only');
  }

  const normalizedCodes = codes.map((code) => {
    if (!code || typeof code !== 'string' || !code.trim()) {
      throw new Error('Coupon code cannot be empty');
    }

    return code.trim();
  });

  if (new Set(normalizedCodes).size !== normalizedCodes.length) {
    throw new Error('The same coupon cannot be applied twice');
  }

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    /*
     * Sort codes before locking them.
     *
     * This prevents deadlocks when two concurrent requests
     * try to stack the same two coupons in opposite order:
     *
     * Request A: A -> B
     * Request B: B -> A
     *
     * Both lock alphabetically, so there is no lock cycle.
     */
    const codesToLock = [...normalizedCodes].sort();

    const coupons = [];

    for (const code of codesToLock) {
      const result = await client.query(
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
        [code]
      );

      if (result.rowCount === 0) {
        throw new Error(`Coupon '${code}' not found`);
      }

      coupons.push(result.rows[0]);
    }

    /*
     * Reject two coupons of the same discount type.
     */
    const types = coupons.map((coupon) => coupon.discount_type);

    if (types.length === 2 && types[0] === types[1]) {
      throw new Error(
        'Cannot stack two coupons of the same discount type'
      );
    }

    /*
     * Validate every coupon BEFORE changing anything.
     */
    for (const coupon of coupons) {
      if (cartTotal < Number(coupon.min_spend)) {
        throw new Error(
          `Cart total must be at least ${Number(coupon.min_spend).toFixed(2)} to use coupon '${coupon.code}'`
        );
      }

      if (new Date() > new Date(coupon.expires_at)) {
        throw new Error(`Coupon '${coupon.code}' has expired`);
      }

      if (coupon.times_used >= coupon.usage_limit) {
        throw new Error(
          `Coupon '${coupon.code}' has reached its usage limit`
        );
      }

      /*
       * Bonus 2: per-user usage limit.
       */
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
    }

    /*
     * We calculate in this order:
     *
     * 1. Percent coupon
     * 2. Flat coupon
     *
     * The current total changes after every coupon.
     */
    let currentTotal = roundCurrency(cartTotal);
    let totalDiscount = 0;

    const appliedResults = [];

    const orderedCoupons = [...coupons].sort((a, b) => {
      if (a.discount_type === 'percent') return -1;
      if (b.discount_type === 'percent') return 1;
      return 0;
    });

    for (const coupon of orderedCoupons) {
      let discount;

      if (coupon.discount_type === 'percent') {
        discount =
          currentTotal *
          (Number(coupon.discount_value) / 100);

        /*
         * Bonus 1: percentage discount cap.
         */
        if (coupon.max_discount_amount !== null) {
          discount = Math.min(
            discount,
            Number(coupon.max_discount_amount)
          );
        }
      } else {
        discount = Number(coupon.discount_value);
      }

      /*
       * Never allow an individual coupon to push
       * the running total below zero.
       */
      discount = Math.min(discount, currentTotal);

      discount = roundCurrency(discount);

      currentTotal = roundCurrency(
        Math.max(0, currentTotal - discount)
      );

      totalDiscount = roundCurrency(
        totalDiscount + discount
      );

      appliedResults.push({
        code: coupon.code,
        discountAmount: discount,
      });
    }

    const finalTotal = roundCurrency(
      Math.max(0, currentTotal)
    );

    /*
     * orders.coupon_code can store the first coupon.
     * order_coupons stores every coupon.
     */
    const primaryCoupon = orderedCoupons[0];

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
        primaryCoupon.code,
        totalDiscount,
        finalTotal,
        userId,
      ]
    );

    const orderId = orderResult.rows[0].id;

    /*
     * Record each coupon separately.
     */
    for (const applied of appliedResults) {
      await client.query(
        `
        INSERT INTO order_coupons (
          order_id,
          code,
          discount_amount
        )
        VALUES ($1, $2, $3)
        `,
        [
          orderId,
          applied.code,
          applied.discountAmount,
        ]
      );
    }

    /*
     * Consume each coupon.
     */
    for (const coupon of coupons) {
      await client.query(
        `
        UPDATE coupons
        SET times_used = times_used + 1
        WHERE code = $1
        `,
        [coupon.code]
      );
    }

    await client.query('COMMIT');

    return {
      orderId,
      discountAmount: totalDiscount,
      finalTotal,
      appliedCodes: orderedCoupons.map(
        (coupon) => coupon.code
      ),
    };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
