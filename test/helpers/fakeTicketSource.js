/** In-memory stand-in for api.ticketsource.io (shapes follow the published OpenAPI spec). */
export function createFakeTicketSource({ filterSupported = true } = {}) {
  const day = 86_400_000;
  const iso = (ms) => new Date(ms).toISOString();

  const state = {
    calls: [],
    methods: [],
    rateLimitAfter: Infinity, // respond 429 once this many calls were made
    events: [],
    settledFlags: {}, // settled is a filterable property, not an attribute of the event resource
    dates: {}, // eventId -> [date]
    bookings: {}, // dateId -> [booking]
    customers: {},
    seats: {}, // bookingId -> [seat]
  };

  state.addEvent = (id, name, { archived = false, settled = false, dates = [] } = {}) => {
    state.settledFlags[id] = settled;
    state.events.push({ id, type: 'event', attributes: { name, archived, activated: true, public: true, created_at: iso(0), updated_at: iso(0) } });
    state.dates[id] = dates.map((d) => ({ id: d.id, type: 'date', attributes: { start: d.start, end: d.end ?? d.start, cancelled: false, updated_at: iso(0) } }));
    for (const d of dates) state.bookings[d.id] = [];
  };

  state.addBooking = (dateId, n, { updated = '2026-10-01T10:00:00+00:00', created = '2026-09-30T10:00:00+00:00', lines: customLines, customer = `cst-${n}`, seats = 2, gross = 20, refund = 0 } = {}) => {
    const id = `bkg-${n}`;
    const lines = [{ line_type: 'TICKETS', payment_method: 'TS', is_refund: false, amount: { gross, fee: 1, fee_vat: 0.2, net: gross - 1.2, discounts: { automatic: 0, code: { description: 'EARLY', amount: 2 } } }, created_at: updated }];
    if (refund) lines.push({ line_type: 'TICKETS', payment_method: 'TS', is_refund: true, amount: { gross: refund, fee: 0, fee_vat: 0, net: refund, discounts: {} }, created_at: updated });
    state.bookings[dateId].push({
      id,
      type: 'booking',
      attributes: { ref: `REF${String(n).padStart(3, '0')}`, ...(created === null ? {} : { created_at: created }), updated_at: updated, lines: customLines ?? lines },
      links: { customer: `https://api.ticketsource.io/customers/${customer}`, date: `https://api.ticketsource.io/dates/${dateId}` },
    });
    state.customers[customer] ??= { id: customer, attributes: { first_name: 'Ann', last_name: `Lee${n}`, email: `ann${n}@example.com`, telephone: `0700${n}`, address: { line_1: '1 High St', postcode: `AB${n} 2CD` } } };
    state.seats[id] = Array.from({ length: seats }, (_, i) => ({
      id: `set-${n}-${i}`,
      attributes: { price_category: i === 0 ? 'Adult' : 'Child', is_cancelled: false, attendee: i === 0 ? { first_name: 'Ann', last_name: `Lee${n}`, email: `ann${n}@example.com` } : {} },
    }));
    return id;
  };

  const page = (items, url, base) => {
    const per = Number(url.searchParams.get('per_page')) || 10;
    const p = Number(url.searchParams.get('page')) || 1;
    const slice = items.slice((p - 1) * per, p * per);
    let next = null;
    if (p * per < items.length) {
      const n = new URL(url);
      n.searchParams.set('page', String(p + 1));
      next = n.toString();
    }
    return { data: slice, links: { next }, meta: { current_page: p } };
  };

  state.fetch = async (input, init = {}) => {
    const url = new URL(input);
    state.calls.push(url.pathname + url.search);
    state.methods.push((init.method || 'GET').toUpperCase());
    const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

    if (init.headers?.Authorization !== 'Bearer test-key') return json({ errors: [{ detail: 'Unauthenticated' }] }, 401);
    if (state.calls.length > state.rateLimitAfter) return json({ errors: [{ code: 'rate_limit' }] }, 429, { 'retry-after': '30' });

    const p = url.pathname;
    let m;
    if (p === '/events') {
      // Like the real API: settled events are hidden unless the request asks for them (default filter[settled]=false)
      const q = (name) => ({ op: url.searchParams.get(`filter[${name}][operator]`), value: url.searchParams.get(`filter[${name}][value]`) });
      const settled = q('settled').op ? q('settled') : { op: 'eq', value: 'false' };
      const archived = q('archived');
      if (state.rejectAnyOperator && (settled.op === 'any' || archived.op === 'any')) return json({ errors: [{ detail: 'bad operator' }] }, 422);
      let items = state.events;
      if (settled.op === 'eq') items = items.filter((e) => String(state.settledFlags[e.id]) === settled.value);
      if (archived.op === 'eq') items = items.filter((e) => String(Boolean(e.attributes.archived)) === archived.value);
      return json(page(items, url));
    }
    if ((m = p.match(/^\/events\/([^/]+)\/dates$/))) return json(page(state.dates[m[1]] || [], url));
    if ((m = p.match(/^\/dates\/([^/]+)\/bookings$/))) {
      let items = state.bookings[m[1]] || [];
      const op = url.searchParams.get('filter[updated_at][operator]');
      if (op) {
        if (!filterSupported || op !== 'after') return json({ errors: [{ detail: 'bad filter' }] }, 422);
        const since = Date.parse(url.searchParams.get('filter[updated_at][value]'));
        items = items.filter((b) => Date.parse(b.attributes.updated_at) > since);
      }
      return json(page(items, url));
    }
    if ((m = p.match(/^\/customers\/([^/]+)$/))) return state.customers[m[1]] ? json({ data: state.customers[m[1]] }) : json({ errors: [] }, 404);
    if ((m = p.match(/^\/bookings\/([^/]+)\/seats$/))) return json(page(state.seats[m[1]] || [], url));
    return json({ errors: [{ detail: 'not found' }] }, 404);
  };

  return state;
}
