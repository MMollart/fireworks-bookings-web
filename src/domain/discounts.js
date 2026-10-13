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
  return db.prepare('SELECT * FROM discount_codes WHERE UPPER(code) = ?').get(code);
}

export function getDiscountById(db, id) {
  return db.prepare('SELECT * FROM discount_codes WHERE id = ?').get(id);
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
    INSERT INTO discount_codes (id, code, description, discount_type, discount_value, usage_count, total_discount_amount, is_active, created_at)
    VALUES (?, ?, ?, ?, ?, 0, 0, ?, ?)
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
    return 0;
  }
  if (discount.discount_type === 'percent') {
    const percent = Math.min(100, Math.max(0, discount.discount_value));
    return parseFloat(((subtotal * percent) / 100).toFixed(2));
  }
  return Math.min(subtotal, parseFloat(discount.discount_value.toFixed(2)));
}

export function recordDiscountUsage(db, discountId, discountAmount) {
  if (!discountId) return;
  const stmt = db.prepare(`
    UPDATE discount_codes
    SET usage_count = usage_count + 1,
        total_discount_amount = total_discount_amount + ?
    WHERE id = ?
  `);
  stmt.run(parseFloat(discountAmount || 0), discountId);
}

export const createDiscountCode = createDiscount;
export const listDiscountCodes = listDiscounts;

export default {
  listDiscounts,
  listDiscountCodes,
  getDiscountByCode,
  getDiscountById,
  createDiscount,
  createDiscountCode,
  calculateDiscount,
  recordDiscountUsage,
};
