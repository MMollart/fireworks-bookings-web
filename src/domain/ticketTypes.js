/**
 * Ticket type dictionary: maps each distinct TicketSource ticket type (price category) to a reporting category,
 * e.g. "Adult Ticket - 15yrs and older" and "Early Bird Adult Ticket - 15yrs and older" are both "Adult".
 * Types are matched case-insensitively with whitespace collapsed (TicketSource has both "Infant  Ticket" and "Infant Ticket").
 */

export const typeKey = (t) => String(t ?? '').replace(/\s+/g, ' ').trim().toLowerCase();

/** A best guess for a type that has not been mapped yet; only ever a suggestion. */
export function suggestCategory(type) {
  const t = typeKey(type);
  if (!t) return null;
  if (t === 'standard') return 'Family (included seats)';
  if (t.includes('blue badge')) return 'Blue Badge Parking';
  if (t.includes('vip')) return 'VIP';
  if (t.includes('family')) return 'Family';
  if (t.includes('infant') || /under 5yrs old/.test(t)) return 'Infant';
  if (t.includes('child') || /5\s?yrs? - 14|5 to 14|under 5yrs - 14/.test(t)) return 'Child';
  if (t.includes('adult') || t.includes('15yrs')) return 'Adult';
  return null;
}

export async function loadCategoryMap(db) {
  const rows = await db.prepare('SELECT type_key, category FROM ticket_type_map').all();
  return new Map(rows.map((r) => [r.type_key, r.category]));
}

/** Every distinct ticket type found on tickets (merged by key) plus mapped types with no tickets, with counts. */
export async function listTicketTypes(db) {
  const used = await db.prepare('SELECT ticket_type, COUNT(*) AS tickets FROM tickets GROUP BY ticket_type').all();
  const mapped = await db.prepare('SELECT type_key, ticket_type, category FROM ticket_type_map').all();
  const map = new Map(mapped.map((m) => [m.type_key, m]));

  const merged = new Map();
  for (const u of used) {
    const key = typeKey(u.ticket_type);
    const cur = merged.get(key) || { key, ticket_type: u.ticket_type, tickets: 0, best: 0 };
    cur.tickets += u.tickets;
    if (u.tickets > cur.best) { cur.best = u.tickets; cur.ticket_type = String(u.ticket_type).replace(/\s+/g, ' ').trim(); }
    merged.set(key, cur);
  }
  for (const m of mapped) if (!merged.has(m.type_key)) merged.set(m.type_key, { key: m.type_key, ticket_type: m.ticket_type, tickets: 0, best: 0 });

  const types = [...merged.values()]
    .map((t) => ({
      key: t.key,
      ticket_type: t.ticket_type,
      tickets: t.tickets,
      category: map.get(t.key)?.category ?? null,
      suggested: map.has(t.key) ? null : suggestCategory(t.ticket_type),
    }))
    .sort((a, b) => (a.category === null) - (b.category === null) || (a.category || '').localeCompare(b.category || '') || b.tickets - a.tickets);
  const categories = [...new Set(mapped.map((m) => m.category))].sort((a, b) => a.localeCompare(b));
  return { types, categories };
}

export async function saveTicketType(db, ticketType, category) {
  const type = String(ticketType ?? '').replace(/\s+/g, ' ').trim();
  const cat = String(category ?? '').replace(/\s+/g, ' ').trim();
  if (!type) throw new Error('Ticket type is required');
  if (!cat) throw new Error('Category is required');
  if (type.length > 200 || cat.length > 80) throw new Error('Ticket type or category is too long');
  await db
    .prepare(
      `INSERT INTO ticket_type_map (type_key, ticket_type, category, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(type_key) DO UPDATE SET ticket_type = excluded.ticket_type, category = excluded.category, updated_at = excluded.updated_at`
    )
    .run(typeKey(type), type, cat, new Date().toISOString());
  return { key: typeKey(type), ticket_type: type, category: cat };
}

export async function deleteTicketType(db, ticketType) {
  const res = await db.prepare('DELETE FROM ticket_type_map WHERE type_key = ?').run(typeKey(ticketType));
  return res.changes > 0;
}
