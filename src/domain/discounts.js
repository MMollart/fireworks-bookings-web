import crypto from 'node:crypto';

export function listDiscounts(db) {
  return db.prepare(`
    SELECT 
      d.*,
      COALESCE(COUNT(b.id), 0) AS actual_bookings_count,
      COALESCE(SUM(b.discount_amount), 0) AS total_discount_given,
      COALESCE(SUM(b.total_price), 0) AS associated_revenue
    FROM discount_codes d
    LEFT JOIN bookings b ON d.id = b.discount_code_id AND b.status = 'confirmed'
    GROUP BY d.id
    ORDER BY d.created_at DESC
  `).all();
}

export function getDiscountByCode(db, rawCode) {
  if (!rawCode) return null;
  const code = String(rawCode).trim().toUpperCase();
  const row = db.prepare('SELECT * FROM discount_codes WHERE UPPER(code) = ?').get(code);
  if (!row) return null;
  return {
    ...row,
    times_used: row.times_used ?? row.usage_count,
    total_savings_generated: row.total_savings_generated ?? row.total_discount_amount,
    total_revenue_associated: row.total_revenue_associated ?? 0,
  };
}

export function getDiscountById(db, id) {
  const row = db.prepare('SELECT * FROM discount_codes WHERE id = ?').get(id);
  if (!row) return null;
  return {
    ...row,
    times_used: row.times_used ?? row.usage_count,
    total_savings_generated: row.total_savings_generated ?? row.total_discount_amount,
    total_revenue_associated: row.total_revenue_associated ?? 0,
  };
}

export function getDiscountCode(db, codeOrId) {
  return getDiscountByCode(db, codeOrId) || getDiscountById(db, codeOrId);
}

export function createDiscount(db, data) {
  const code = String(data.code).trim().toUpperCase();
  const existing = getDiscountByCode(db, code);
  if (existing) {
    throw new Error(`Discount code '${code}' already exists`);
  }

  const id = data.id || `dsc_${crypto.randomBytes(6).toString('hex')}`;
  const now = new Date().toISOString();

  const stmt = db.prepare(`
    INSERT INTO discount_codes (
      id, code, description, discount_type, discount_value,
      usage_count, times_used, total_discount_amount, total_savings_generated, total_revenue_associated,
      is_active, created_at
    )
    VALUES (?, ?, ?, ?, ?, 0, 0, 0, 0, 0, ?, ?)
  `);

  stmt.run(
    id,
    code,
    data.description || null,
    data.discount_type || 'fixed',
    parseFloat(data.discount_value || 0),
    data.is_active !== undefined ? (data.is_active ? 1 : 0) : 1,
    now
  );

  return getDiscountById(db, id);
}

export function calculateDiscount(discount, subtotal) {
  if (!discount || !discount.is_active) {
    return { discountAmount: 0, total: subtotal };
  }
  let discountAmount = 0;
  if (discount.discount_type === 'percent') {
    const percent = Math.min(100, Math.max(0, discount.discount_value));
    discountAmount = parseFloat(((subtotal * percent) / 100).toFixed(2));
  } else {
    discountAmount = Math.min(subtotal, parseFloat(discount.discount_value.toFixed(2)));
  }
  const total = Math.max(0, parseFloat((subtotal - discountAmount).toFixed(2)));
  return {
    discountAmount,
    total,
  };
}

export function recordDiscountUsage(db, codeOrId, savingsAmount = 0, revenueAssociated = 0) {
  if (!codeOrId) return;
  const savings = parseFloat(savingsAmount || 0);
  const revenue = parseFloat(revenueAssociated || 0);

  const stmt = db.prepare(`
    UPDATE discount_codes
    SET usage_count = usage_count + 1,
        times_used = times_used + 1,
        total_discount_amount = total_discount_amount + ?,
        total_savings_generated = total_savings_generated + ?,
        total_revenue_associated = total_revenue_associated + ?
    WHERE id = ? OR UPPER(code) = UPPER(?)
  `);
  stmt.run(savings, savings, revenue, codeOrId, codeOrId);
}

export const createDiscountCode = createDiscount;
export const listDiscountCodes = listDiscounts;

export default {
  listDiscounts,
  listDiscountCodes,
  getDiscountByCode,
  getDiscountById,
  getDiscountCode,
  createDiscount,
  createDiscountCode,
  calculateDiscount,
  recordDiscountUsage,
};
