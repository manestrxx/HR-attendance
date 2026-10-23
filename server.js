const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcrypt');
const cors = require('cors');
const path = require('path');

const app = express();
app.use(express.json());
app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

const db = new sqlite3.Database('./attendance.db', (err) => {
    if (err) console.error('Error opening database:', err.message);
    else console.log('Connected to SQLite database.');
});

db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS employees (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        employee_id TEXT UNIQUE,
        name TEXT,
        department TEXT,
        shift_start TEXT DEFAULT '08:00',
        shift_end TEXT DEFAULT '17:00',
        pin_hash TEXT,
        status TEXT DEFAULT 'Active'
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS attendance (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        employee_id TEXT,
        date TEXT,
        check_in TEXT,
        check_out TEXT,
        late_minutes INTEGER DEFAULT 0,
        status TEXT,
        sync_status TEXT DEFAULT 'Pending'
    )`);

    db.get(`SELECT * FROM employees WHERE employee_id = 'EMP001'`, async (err, row) => {
        if (!row) {
            const hash = await bcrypt.hash('1234', 10);
            db.run(`INSERT INTO employees (employee_id, name, department, pin_hash) VALUES ('EMP001', 'أحمد محمود', 'الموارد البشرية', '${hash}')`);
            console.log('Sample employee created (EMP001 / PIN: 1234)');
        }
    });
});

app.post('/api/attendance', (req, res) => {
    const { employee_id, pin, action } = req.body;
    const today = new Date().toISOString().split('T')[0];
    const currentTime = new Date().toTimeString().split(' ')[0];

    db.get(`SELECT * FROM employees WHERE employee_id = ? AND status = 'Active'`, [employee_id], async (err, employee) => {
        if (err || !employee) {
            return res.status(401).json({ error: 'الرقم الوظيفي غير موجود أو الحساب معطل / Invalid Employee ID' });
        }

        const match = await bcrypt.compare(pin, employee.pin_hash);
        if (!match) {
            return res.status(401).json({ error: 'رمز الدخول (PIN) غير صحيح / Incorrect PIN' });
        }

        db.get(`SELECT * FROM attendance WHERE employee_id = ? AND date = ?`, [employee_id, today], (err, record) => {
            if (action === 'check-in') {
                if (record && record.check_in) {
                    return res.status(400).json({ error: 'تم تسجيل الحضور مسبقاً لهذا اليوم / Already checked in' });
                }

                const [sh, sm] = employee.shift_start.split(':').map(Number);
                const [ch, cm] = currentTime.split(':').map(Number);
                const lateMinutes = Math.max(0, (ch * 60 + cm) - (sh * 60 + sm));
                const status = lateMinutes > 15 ? 'Late' : 'Present';

                if (record) {
                    db.run(`UPDATE attendance SET check_in = ?, late_minutes = ?, status = ? WHERE id = ?`,
                        [currentTime, lateMinutes, status, record.id], (uErr) => {
                            if (uErr) return res.status(500).json({ error: 'Database error' });
                            res.json({ message: 'تم تسجيل الحضور بنجاح / Check-in successful', employee_name: employee.name });
                        });
                } else {
                    db.run(`INSERT INTO attendance (employee_id, date, check_in, late_minutes, status) VALUES (?, ?, ?, ?, ?)`,
                        [employee_id, today, currentTime, lateMinutes, status], (iErr) => {
                            if (iErr) return res.status(500).json({ error: 'Database error' });
                            res.json({ message: 'تم تسجيل الحضور بنجاح / Check-in successful', employee_name: employee.name });
                        });
                }
            } else if (action === 'check-out') {
                if (!record || !record.check_in) {
                    return res.status(400).json({ error: 'يجب تسجيل الحضور أولاً / Must check in first' });
                }
                if (record.check_out) {
                    return res.status(400).json({ error: 'تم تسجيل الانصراف مسبقاً / Already checked out' });
                }

                db.run(`UPDATE attendance SET check_out = ? WHERE id = ?`, [currentTime, record.id], (uErr) => {
                    if (uErr) return res.status(500).json({ error: 'Database error' });
                    res.json({ message: 'تم تسجيل الانصراف بنجاح / Check-out successful', employee_name: employee.name });
                });
            }
        });
    });
});

app.get('/api/reports', (req, res) => {
    db.all(`SELECT a.*, e.name, e.department FROM attendance a JOIN employees e ON a.employee_id = e.employee_id ORDER BY a.date DESC`, [], (err, rows) => {
        if (err) return res.status(500).json({ error: 'Failed to fetch reports' });
        res.json(rows);
    });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
