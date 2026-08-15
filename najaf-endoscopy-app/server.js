const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

// --- Database connection ---
// Railway injects DATABASE_URL automatically when you attach a Postgres
// plugin and reference it in this service's variables.
if (!process.env.DATABASE_URL) {
  console.warn('WARNING: DATABASE_URL is not set. Set it in Railway → Variables.');
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Most Railway internal Postgres connections do not require SSL.
  // If you connect to a public/external Postgres that requires SSL,
  // set PGSSL=true in your environment variables.
  ssl: process.env.PGSSL === 'true' ? { rejectUnauthorized: false } : false
});

// --- Capacity rules (mirrors the frontend) ---
const LIMITS = {
  gastro_original: 8,
  gastro_reserve: 4,
  colon_original: 4,
  colon_reserve: 4,
  ward_general: 3
};
const TOTAL_LIMIT = 20;

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS bookings (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      age INTEGER NOT NULL,
      governorate TEXT NOT NULL,
      phone TEXT NOT NULL,
      booking_date DATE NOT NULL,
      booking_time TIME NOT NULL,
      procedure TEXT NOT NULL CHECK (procedure IN ('gastro','colon')),
      status TEXT NOT NULL CHECK (status IN ('original','reserve')),
      polyp BOOLEAN NOT NULL DEFAULT false,
      ward TEXT NOT NULL CHECK (ward IN ('general','private')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_bookings_date ON bookings(booking_date);`);
}

function rowToPatient(r) {
  return {
    id: r.id,
    name: r.name,
    age: r.age,
    gov: r.governorate,
    phone: r.phone,
    date: r.booking_date.toISOString().slice(0, 10),
    time: r.booking_time.slice(0, 5),
    procedure: r.procedure,
    status: r.status,
    polyp: r.polyp,
    ward: r.ward
  };
}

function computeCounts(list, excludeId) {
  const c = {
    gastro_original: 0, gastro_reserve: 0,
    colon_original: 0, colon_reserve: 0,
    colon_polyp: 0, ward_general: 0, ward_private: 0, total: 0
  };
  list.forEach(p => {
    if (excludeId && p.id === excludeId) return;
    c.total++;
    if (p.procedure === 'gastro') {
      c[p.status === 'original' ? 'gastro_original' : 'gastro_reserve']++;
    } else {
      c[p.status === 'original' ? 'colon_original' : 'colon_reserve']++;
      if (p.polyp) c.colon_polyp++;
    }
    if (p.ward === 'general') c.ward_general++; else c.ward_private++;
  });
  return c;
}

// --- API routes ---

// Get all bookings for one date
app.get('/api/bookings', async (req, res) => {
  const { date } = req.query;
  if (!date) return res.status(400).json({ error: 'التاريخ مطلوب' });
  try {
    const { rows } = await pool.query(
      'SELECT * FROM bookings WHERE booking_date = $1 ORDER BY booking_time ASC',
      [date]
    );
    res.json(rows.map(rowToPatient));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

// Get counts for multiple dates (for the day-tab badges)
app.get('/api/bookings/counts', async (req, res) => {
  const dates = (req.query.dates || '').split(',').filter(Boolean);
  if (dates.length === 0) return res.json({});
  try {
    const { rows } = await pool.query(
      `SELECT booking_date, COUNT(*) AS cnt FROM bookings
       WHERE booking_date = ANY($1::date[]) GROUP BY booking_date`,
      [dates]
    );
    const result = {};
    dates.forEach(d => { result[d] = 0; });
    rows.forEach(r => { result[r.booking_date.toISOString().slice(0, 10)] = Number(r.cnt); });
    res.json(result);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

// Create a booking
app.post('/api/bookings', async (req, res) => {
  const { id, name, age, gov, phone, date, time, procedure, status, polyp, ward } = req.body;
  if (!name || !age || !gov || !phone || !date || !time || !procedure || !status || !ward) {
    return res.status(400).json({ error: 'الرجاء تعبئة جميع الحقول المطلوبة' });
  }
  try {
    const { rows } = await pool.query(
      'SELECT id, procedure, status, polyp, ward FROM bookings WHERE booking_date = $1',
      [date]
    );
    const existing = rows.map(r => ({ id: r.id, procedure: r.procedure, status: r.status, polyp: r.polyp, ward: r.ward }));
    const counts = computeCounts(existing);
    const key = `${procedure}_${status}`;

    if (counts.total >= TOTAL_LIMIT) {
      return res.status(409).json({ error: 'اكتمل العدد الكلي لهذا اليوم (٢٠ مريضاً)' });
    }
    if (counts[key] >= LIMITS[key]) {
      return res.status(409).json({ error: 'اكتملت هذه الفئة من الحجوزات لهذا اليوم' });
    }
    if (ward === 'general' && counts.ward_general >= LIMITS.ward_general) {
      return res.status(409).json({ error: 'الجناح العام مكتمل (٣/٣)، الرجاء اختيار الجناح الخاص' });
    }

    const newId = id || ('p_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8));
    await pool.query(
      `INSERT INTO bookings (id, name, age, governorate, phone, booking_date, booking_time, procedure, status, polyp, ward)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [newId, name, age, gov, phone, date, time, procedure, status, !!polyp, ward]
    );
    res.status(201).json({ ok: true, id: newId });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

// Update a booking (including moving its date/time)
app.put('/api/bookings/:id', async (req, res) => {
  const { id } = req.params;
  const { name, age, gov, phone, date, time, procedure, status, polyp, ward } = req.body;
  if (!name || !age || !gov || !phone || !date || !time || !procedure || !status || !ward) {
    return res.status(400).json({ error: 'الرجاء تعبئة جميع الحقول المطلوبة' });
  }
  try {
    const { rows } = await pool.query(
      'SELECT id, procedure, status, polyp, ward FROM bookings WHERE booking_date = $1',
      [date]
    );
    const existing = rows.map(r => ({ id: r.id, procedure: r.procedure, status: r.status, polyp: r.polyp, ward: r.ward }));
    const counts = computeCounts(existing, id);
    const key = `${procedure}_${status}`;

    if (counts.total >= TOTAL_LIMIT) {
      return res.status(409).json({ error: 'اكتمل العدد الكلي لهذا اليوم (٢٠ مريضاً)' });
    }
    if (counts[key] >= LIMITS[key]) {
      return res.status(409).json({ error: 'اكتملت هذه الفئة من الحجوزات لهذا اليوم' });
    }
    if (ward === 'general' && counts.ward_general >= LIMITS.ward_general) {
      return res.status(409).json({ error: 'الجناح العام مكتمل (٣/٣)، الرجاء اختيار الجناح الخاص' });
    }

    const result = await pool.query(
      `UPDATE bookings SET name=$1, age=$2, governorate=$3, phone=$4, booking_date=$5,
       booking_time=$6, procedure=$7, status=$8, polyp=$9, ward=$10 WHERE id=$11`,
      [name, age, gov, phone, date, time, procedure, status, !!polyp, ward, id]
    );
    if (result.rowCount === 0) return res.status(404).json({ error: 'الحجز غير موجود' });
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

// Delete a booking
app.delete('/api/bookings/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM bookings WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

app.get('/api/health', (req, res) => res.json({ ok: true }));

// --- Serve frontend ---
app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

initDb()
  .then(() => {
    app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
  })
  .catch(err => {
    console.error('Failed to initialize database:', err);
    process.exit(1);
  });
