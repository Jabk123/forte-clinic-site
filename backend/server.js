/**
 * Forte Community Clinic — API server (Node + Express + mssql)
 *
 * CONNECTION STRING LOCATION:
 *   Put the real connection string in a file named `.env` in this folder
 *   (copy from .env.example). Never commit `.env` to Git.
 *
 *   Example line in .env:
 *   DB_CONNECTION_STRING="Server=...;Database=ForteCommunityClinicDB;User Id=...;Password=...;Encrypt=true;"
 */

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const sql = require('mssql');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'dev-only-change-me';
const API_VERSION = '2026.10.20-reception-1';

// CORS — allow your GitHub Pages origin and local dev
const allowedOrigins = (process.env.CORS_ORIGIN || 'http://localhost:5500,http://127.0.0.1:5500')
  .split(',')
  .map(s => s.trim());

app.use(cors({
  origin: function (origin, cb) {
    if (!origin || allowedOrigins.includes(origin) || allowedOrigins.includes('*')) {
      return cb(null, true);
    }
    return cb(new Error('Not allowed by CORS'));
  },
  credentials: true
}));
app.use(express.json());

// ---------- Database pool ----------
let pool = null;

async function getPool() {
  if (pool) return pool;
  const connectionString = process.env.DB_CONNECTION_STRING;
  if (!connectionString) {
    throw new Error(
      'DB_CONNECTION_STRING is not set. Copy backend/.env.example to backend/.env and fill in your SQL Server connection string.'
    );
  }
  pool = await sql.connect(connectionString);
  return pool;
}

async function findAccountByEmail(db, email) {
  const result = await db.request()
    .input('Email', sql.NVarChar, email)
    .query(`
      SELECT TOP (1) 'Patient' AS UserType
      FROM Patient
      WHERE LOWER(Email) = @Email
      UNION ALL
      SELECT TOP (1) 'Employee' AS UserType
      FROM Employee
      WHERE LOWER(Email) = @Email
    `);
  return result.recordset[0] || null;
}

async function writeAuditEvent(req, event) {
  try {
    const db = await getPool();
    await db.request()
      .input('UserType', sql.NVarChar(50), event.userType)
      .input('User_ID', sql.Int, event.userId)
      .input('EventCategory', sql.NVarChar(100), event.category)
      .input('ActionType', sql.NVarChar(100), event.action)
      .input('TableAffected', sql.NVarChar(100), event.table)
      .input('RecordID', sql.Int, event.recordId)
      .input('IPAddress', sql.NVarChar(50), req.ip || null)
      .input('EventDetails', sql.NVarChar(sql.MAX), event.details)
      .query(`
        INSERT INTO AuditLog
          (UserType, User_ID, EventCategory, ActionType, TableAffected, RecordID, IPAddress, EventDetails)
        VALUES
          (@UserType, @User_ID, @EventCategory, @ActionType, @TableAffected, @RecordID, @IPAddress, @EventDetails)
      `);
  } catch (err) {
    console.error('Unable to write audit event:', err);
  }
}

async function getTableColumns(db, tableName) {
  const result = await db.request()
    .input('TableName', sql.NVarChar(128), tableName)
    .query(`
      SELECT COLUMN_NAME AS ColumnName,
             IS_NULLABLE AS IsNullable,
             COLUMN_DEFAULT AS ColumnDefault
      FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = 'dbo' AND TABLE_NAME = @TableName
    `);
  return result.recordset;
}

function prescriptionDispensedExpression(columnNames, alias = '') {
  const prefix = alias ? `${alias}.` : '';
  if (columnNames.has('IsDispensed')) {
    return `COALESCE(${prefix}IsDispensed, 0) = 1`;
  }
  if (columnNames.has('DispenseType')) {
    return `UPPER(COALESCE(NULLIF(LTRIM(RTRIM(${prefix}DispenseType)), ''), 'PRESCRIBED')) = 'GIVEN'`;
  }
  if (columnNames.has('DispensedDate')) {
    return `${prefix}DispensedDate IS NOT NULL`;
  }
  return null;
}

// Simple health check
app.get('/api/health', async (_req, res) => {
  try {
    await getPool();
    res.json({
      status: 'ok',
      database: 'connected',
      apiVersion: API_VERSION,
      clinicalRoutes: ['/consultations', '/diagnoses']
    });
  } catch (err) {
    res.status(503).json({ status: 'error', message: err.message });
  }
});

// ---------- Auth helper ----------
function signToken(payload) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: '12h' });
}

function authMiddleware(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ message: 'Authentication required' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ message: 'Invalid or expired token' });
  }
}

// ---------- Auth routes ----------
app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) {
      return res.status(400).json({ message: 'Email and password are required' });
    }
    const db = await getPool();
    const emailLower = String(email).trim().toLowerCase();

    // Try patient first
    let result = await db.request()
      .input('email', sql.NVarChar, emailLower)
      .query('SELECT * FROM Patient WHERE LOWER(Email) = @email AND IsActive = 1');

    let user = result.recordset[0];
    let userType = 'Patient';

    if (!user) {
      result = await db.request()
        .input('email', sql.NVarChar, emailLower)
        .query('SELECT * FROM Employee WHERE LOWER(Email) = @email AND IsActive = 1');
      user = result.recordset[0];
      userType = 'Employee';
    }

    if (!user || !(await bcrypt.compare(password, user.PasswordHash))) {
      return res.status(401).json({ message: 'Email or password is incorrect' });
    }

    const token = signToken({
      id: userType === 'Patient' ? user.Patient_ID : user.Employee_ID,
      role: userType === 'Patient' ? 'Patient' : user.EmployeeType,
      type: userType
    });

    if (userType === 'Employee' && user.EmployeeType === 'Admin') {
      await writeAuditEvent(req, {
        userType,
        userId: user.Employee_ID,
        category: 'Login',
        action: 'Sign in',
        table: 'Employee',
        recordId: user.Employee_ID,
        details: 'Admin sign-in successful'
      });
    }

    // Never return the hash
    const safe = { ...user };
    delete safe.PasswordHash;

    res.json({
      user: safe,
      userType,
      token
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: err.message || 'Login failed' });
  }
});

// ---------- Patient registration ----------
app.post('/api/patients/register', async (req, res) => {
  try {
    const b = req.body || {};
    const required = ['FirstName', 'LastName', 'Email', 'Password'];
    for (const f of required) {
      if (!b[f]) return res.status(400).json({ message: f + ' is required' });
    }
    const db = await getPool();
    const email = String(b.Email).trim().toLowerCase();
    if (await findAccountByEmail(db, email)) {
     return res.status(409).json({
       message: 'An account with that email already exists'
     });
    }
    const hash = await bcrypt.hash(b.Password, 10);
    const result = await db.request()
      .input('FirstName', sql.NVarChar, b.FirstName)
      .input('LastName', sql.NVarChar, b.LastName)
      .input('ContactNumber', sql.NVarChar, b.ContactNumber || null)
      .input('Email', sql.NVarChar, email)
      .input('PasswordHash', sql.NVarChar, hash)
      .input('DateOfBirth', sql.Date, b.DateOfBirth || null)
      .input('Gender', sql.NVarChar, b.Gender || null)
      .input('EmergencyContact', sql.NVarChar, b.EmergencyContact || null)
      .input('Address', sql.NVarChar, b.Address || null)
      .query(`
        INSERT INTO Patient (FirstName, LastName, ContactNumber, Email, PasswordHash, DateOfBirth, Gender, EmergencyContact, Address)
        OUTPUT INSERTED.*
        VALUES (@FirstName, @LastName, @ContactNumber, @Email, @PasswordHash, @DateOfBirth, @Gender, @EmergencyContact, @Address)
      `);
    const user = result.recordset[0];
    delete user.PasswordHash;
    const token = signToken({ id: user.Patient_ID, role: 'Patient', type: 'Patient' });
    res.status(201).json({ user, userType: 'Patient', token });
  } catch (err) {
    if (err.number === 2627 || err.number === 2601) return res.status(409).json({ message: 'An account with that email already exists' });
    console.error(err);
    res.status(500).json({ message: err.message || 'Registration failed' });
  }
});

// ---------- Placeholder protected routes (extend as needed) ----------
app.get('/api/patients', authMiddleware, async (req, res) => {
  try {
    if (!['Admin', 'Manager', 'Receptionist', 'Doctor', 'Nurse'].includes(req.user.role)) {
      return res.status(403).json({ message: 'Not allowed to view patient records' });
    }
    const db = await getPool();
    const result = await db.request().query(`
      SELECT Patient_ID, FirstName, LastName, Email, ContactNumber, IsActive,
             DateOfBirth, Gender, EmergencyContact, Address, AccountBalance, CreatedDate
      FROM Patient
      ORDER BY LastName, FirstName
    `);
    res.json(result.recordset);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

app.get('/api/patients/:id', authMiddleware, async (req, res) => {
  if (!['Admin', 'Manager', 'Receptionist', 'Doctor', 'Nurse'].includes(req.user.role)) {
    return res.status(403).json({ message: 'Not allowed to view patient records' });
  }
  const patientId = Number(req.params.id);
  if (!Number.isInteger(patientId) || patientId <= 0) {
    return res.status(400).json({ message: 'Invalid patient ID' });
  }
  try {
    const db = await getPool();
    const result = await db.request()
      .input('Patient_ID', sql.Int, patientId)
      .query(`
        SELECT Patient_ID, FirstName, LastName, Email, ContactNumber, IsActive,
               DateOfBirth, Gender, EmergencyContact, Address, AccountBalance, CreatedDate
        FROM Patient
        WHERE Patient_ID = @Patient_ID
      `);
    if (!result.recordset.length) return res.status(404).json({ message: 'Patient not found' });
    res.json(result.recordset[0]);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

app.put('/api/patients/:id', authMiddleware, async (req, res) => {
  if (!['Admin', 'Receptionist'].includes(req.user.role)) {
    return res.status(403).json({ message: 'Only receptionists and admins can update patient details' });
  }
  const patientId = Number(req.params.id);
  const body = req.body || {};
  const firstName = String(body.FirstName || '').trim();
  const lastName = String(body.LastName || '').trim();
  const email = String(body.Email || '').trim().toLowerCase();
  const contactNumber = String(body.ContactNumber || '').replace(/\s/g, '');
  const address = String(body.Address || '').trim();
  const emergencyContact = String(body.EmergencyContact || '').replace(/\s/g, '') || null;

  if (!Number.isInteger(patientId) || patientId <= 0) {
    return res.status(400).json({ message: 'Invalid patient ID' });
  }
  if (firstName.length < 2 || firstName.length > 100 ||
      lastName.length < 2 || lastName.length > 100 ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 255 ||
      !/^0\d{9}$/.test(contactNumber) ||
      address.length < 8 || address.length > 500 ||
      (emergencyContact && !/^0\d{9}$/.test(emergencyContact))) {
    return res.status(400).json({ message: 'Enter valid patient name, email, South African contact number, and address.' });
  }

  try {
    const db = await getPool();
    const result = await db.request()
      .input('Patient_ID', sql.Int, patientId)
      .input('FirstName', sql.NVarChar(100), firstName)
      .input('LastName', sql.NVarChar(100), lastName)
      .input('Email', sql.NVarChar(255), email)
      .input('ContactNumber', sql.NVarChar(20), contactNumber)
      .input('Address', sql.NVarChar(500), address)
      .input('EmergencyContact', sql.NVarChar(20), emergencyContact)
      .query(`
        UPDATE Patient
        SET FirstName = @FirstName,
            LastName = @LastName,
            Email = @Email,
            ContactNumber = @ContactNumber,
            Address = @Address,
            EmergencyContact = @EmergencyContact
        OUTPUT INSERTED.Patient_ID, INSERTED.FirstName, INSERTED.LastName,
               INSERTED.Email, INSERTED.ContactNumber, INSERTED.IsActive,
               INSERTED.DateOfBirth, INSERTED.Gender, INSERTED.EmergencyContact,
               INSERTED.Address, INSERTED.AccountBalance, INSERTED.CreatedDate
        WHERE Patient_ID = @Patient_ID
      `);
    if (!result.recordset.length) return res.status(404).json({ message: 'Patient not found' });
    await writeAuditEvent(req, {
      userType: req.user.type,
      userId: req.user.id,
      category: 'Action',
      action: 'Update patient details',
      table: 'Patient',
      recordId: patientId,
      details: 'Patient contact and demographic details updated'
    });
    res.json(result.recordset[0]);
  } catch (err) {
    const errorNumber = err && (
      err.number ||
      (err.originalError && err.originalError.info && err.originalError.info.number)
    );
    if (errorNumber === 2627 || errorNumber === 2601) {
      return res.status(409).json({ message: 'That email address is already in use by another patient' });
    }
    console.error('Unable to update patient details:', err);
    res.status(500).json({ message: err.message || 'Unable to update patient details' });
  }
});

app.get('/api/employees', authMiddleware, async (_req, res) => {
  try {
    const db = await getPool();
    const result = await db.request().query('SELECT Employee_ID, FirstName, LastName, Email, ContactNumber, EmployeeType, IsActive FROM Employee ORDER BY LastName, FirstName');
    res.json(result.recordset);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

app.get('/api/appointments', authMiddleware, async (req, res) => {
  try {
    if (req.user.type !== 'Patient' &&
        !['Admin', 'Manager', 'Receptionist', 'Doctor', 'Nurse'].includes(req.user.role)) {
      return res.status(403).json({ message: 'Not allowed to view appointments' });
    }
    const db = await getPool();
    const request = db.request();
    let patientFilter = '';
    if (req.user.type === 'Patient') {
      request.input('Patient_ID', sql.Int, req.user.id);
      patientFilter = 'WHERE a.Patient_ID = @Patient_ID';
    } else if (req.query.patientId) {
      const patientId = Number(req.query.patientId);
      if (!Number.isInteger(patientId) || patientId <= 0) {
        return res.status(400).json({ message: 'Invalid patient ID' });
      }
      request.input('Patient_ID', sql.Int, patientId);
      patientFilter = 'WHERE a.Patient_ID = @Patient_ID';
    }
    const result = await request.query(`
      SELECT a.Appointment_ID,
             CONVERT(char(10), a.AppointmentDate, 23) AS AppointmentDate,
             CONVERT(char(8), a.AppointmentTime, 108) AS AppointmentTime,
             a.Patient_ID, a.Employee_ID, a.Reason,
             COALESCE(NULLIF(LTRIM(RTRIM(a.Status)), ''), 'Scheduled') AS Status,
             COALESCE(NULLIF(LTRIM(RTRIM(a.Status)), ''), 'Scheduled') AS AppointmentStatus,
             a.CreatedDate,
             p.FirstName AS PatientFirstName, p.LastName AS PatientLastName
      FROM Appointment a
      JOIN Patient p ON p.Patient_ID = a.Patient_ID
      ${patientFilter}
      ORDER BY a.AppointmentDate DESC, a.AppointmentTime DESC
    `);
    res.json(result.recordset);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

app.post('/api/appointments', authMiddleware, async (req, res) => {
  const appointmentDate = String((req.body || {}).AppointmentDate || '');
  const appointmentTime = String((req.body || {}).AppointmentTime || '');
  const reason = String((req.body || {}).Reason || '').trim();
  const isPatient = req.user.type === 'Patient';
  const staffRoles = ['Admin', 'Receptionist', 'Doctor', 'Nurse'];

  if (!isPatient && !staffRoles.includes(req.user.role)) {
    return res.status(403).json({ message: 'You are not allowed to book appointments' });
  }
  const parsedDate = new Date(`${appointmentDate}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(appointmentDate) ||
      Number.isNaN(parsedDate.getTime()) ||
      parsedDate.toISOString().slice(0, 10) !== appointmentDate ||
      !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(appointmentTime)) {
    return res.status(400).json({ message: 'A valid appointment date and time are required' });
  }
  if (reason.length > 500) {
    return res.status(400).json({ message: 'Reason must be 500 characters or fewer' });
  }

  const patientId = isPatient ? Number(req.user.id) : Number((req.body || {}).Patient_ID);
  if (!Number.isInteger(patientId) || patientId <= 0) {
    return res.status(400).json({ message: 'A valid patient is required' });
  }

  let transaction;
  let transactionStarted = false;
  try {
    const db = await getPool();
    transaction = new sql.Transaction(db);
    await transaction.begin(sql.ISOLATION_LEVEL.SERIALIZABLE);
    transactionStarted = true;

    const request = transaction.request()
      .input('Patient_ID', sql.Int, patientId)
      .input('AppointmentDate', sql.Date, appointmentDate)
      .input('AppointmentTime', sql.VarChar(5), appointmentTime)
      .input('Reason', sql.NVarChar(500), reason || null);

    const patientResult = await request.query(`
      SELECT Patient_ID
      FROM Patient WITH (UPDLOCK, HOLDLOCK)
      WHERE Patient_ID = @Patient_ID AND IsActive = 1
    `);
    if (!patientResult.recordset.length) {
      await transaction.rollback();
      transactionStarted = false;
      return res.status(404).json({ message: 'Active patient account not found' });
    }

    const currentSlot = await transaction.request()
      .input('AppointmentDate', sql.Date, appointmentDate)
      .input('AppointmentTime', sql.VarChar(5), appointmentTime)
      .query(`
        SELECT TOP (1) Appointment_ID
        FROM Appointment WITH (UPDLOCK, HOLDLOCK)
        WHERE AppointmentDate = @AppointmentDate
          AND AppointmentTime = CONVERT(TIME(0), @AppointmentTime)
          AND Status <> 'Cancelled'
      `);
    if (currentSlot.recordset.length) {
      await transaction.rollback();
      transactionStarted = false;
      return res.status(409).json({ message: 'That date and time slot is already taken' });
    }

    const pastSlot = await transaction.request()
      .input('AppointmentDate', sql.Date, appointmentDate)
      .input('AppointmentTime', sql.VarChar(5), appointmentTime)
      .query(`
        SELECT CASE
          WHEN @AppointmentDate < CONVERT(date, GETDATE())
            OR (@AppointmentDate = CONVERT(date, GETDATE())
              AND CONVERT(TIME(0), @AppointmentTime) <= CONVERT(TIME(0), GETDATE()))
          THEN 1 ELSE 0
        END AS IsPast
      `);
    if (pastSlot.recordset[0].IsPast) {
      await transaction.rollback();
      transactionStarted = false;
      return res.status(400).json({ message: 'Appointments must be booked for a future date and time' });
    }

    const inserted = await transaction.request()
      .input('Patient_ID', sql.Int, patientId)
      .input('AppointmentDate', sql.Date, appointmentDate)
      .input('AppointmentTime', sql.VarChar(5), appointmentTime)
      .input('Reason', sql.NVarChar(500), reason || null)
      .query(`
        INSERT INTO Appointment (Patient_ID, AppointmentDate, AppointmentTime, Reason)
        OUTPUT INSERTED.Appointment_ID, INSERTED.Patient_ID, INSERTED.Employee_ID,
               CONVERT(char(10), INSERTED.AppointmentDate, 23) AS AppointmentDate,
               CONVERT(char(8), INSERTED.AppointmentTime, 108) AS AppointmentTime,
               INSERTED.Reason,
               COALESCE(NULLIF(LTRIM(RTRIM(INSERTED.Status)), ''), 'Scheduled') AS Status,
               COALESCE(NULLIF(LTRIM(RTRIM(INSERTED.Status)), ''), 'Scheduled') AS AppointmentStatus,
               INSERTED.CreatedDate
        VALUES (@Patient_ID, @AppointmentDate, CONVERT(TIME(0), @AppointmentTime), @Reason)
      `);
    await transaction.commit();
    transactionStarted = false;

    const appointment = inserted.recordset[0];
    await writeAuditEvent(req, {
      userType: req.user.type,
      userId: req.user.id,
      category: 'Action',
      action: 'Book appointment',
      table: 'Appointment',
      recordId: appointment.Appointment_ID,
      details: `Appointment booked for ${appointment.AppointmentDate} at ${appointment.AppointmentTime}`
    });
    res.status(201).json(appointment);
  } catch (err) {
    if (transactionStarted) await transaction.rollback();
    const errorNumber = err && (
      err.number ||
      (err.originalError && err.originalError.info && err.originalError.info.number)
    );
    if (errorNumber === 2601 || errorNumber === 2627) {
      return res.status(409).json({ message: 'That date and time slot is already taken' });
    }
    console.error('Unable to book appointment:', err);
    res.status(500).json({ message: err.message || 'Unable to book appointment' });
  }
});

app.patch('/api/appointments/:id/cancel', authMiddleware, async (req, res) => {
  const isPatient = req.user.type === 'Patient';
  const staffRoles = ['Admin', 'Receptionist', 'Doctor', 'Nurse'];
  const appointmentId = Number(req.params.id);
  if (!Number.isInteger(appointmentId) || appointmentId <= 0) {
    return res.status(400).json({ message: 'Invalid appointment ID' });
  }
  if (!isPatient && !staffRoles.includes(req.user.role)) {
    return res.status(403).json({ message: 'You are not allowed to cancel appointments' });
  }

  try {
    const db = await getPool();
    const result = await db.request()
      .input('Appointment_ID', sql.Int, appointmentId)
      .input('Patient_ID', sql.Int, Number(req.user.id))
      .input('IsPatient', sql.Bit, isPatient)
      .query(`
        UPDATE Appointment
        SET Status = 'Cancelled'
        OUTPUT INSERTED.Appointment_ID, INSERTED.Patient_ID, INSERTED.Status
        WHERE Appointment_ID = @Appointment_ID
          AND UPPER(COALESCE(NULLIF(LTRIM(RTRIM(Status)), ''), 'Scheduled')) = 'SCHEDULED'
          AND (@IsPatient = 0 OR Patient_ID = @Patient_ID)
      `);
    if (!result.recordset.length) {
      return res.status(409).json({ message: 'Appointment not found or is no longer scheduled' });
    }
    await writeAuditEvent(req, {
      userType: req.user.type,
      userId: req.user.id,
      category: 'Action',
      action: 'Cancel appointment',
      table: 'Appointment',
      recordId: appointmentId,
      details: 'Appointment cancelled'
    });
    res.json(result.recordset[0]);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

app.get('/api/payments', authMiddleware, async (req, res) => {
  try {
    if (req.user.type !== 'Patient' &&
        !['Admin', 'Manager', 'Receptionist'].includes(req.user.role)) {
      return res.status(403).json({ message: 'Not allowed to view payment records' });
    }
    const db = await getPool();
    const request = db.request();
    let patientFilter = '';
    if (req.user.type === 'Patient') {
      request.input('Patient_ID', sql.Int, req.user.id);
      patientFilter = 'WHERE p.Patient_ID = @Patient_ID';
    } else if (req.query.patientId) {
      const patientId = Number(req.query.patientId);
      if (!Number.isInteger(patientId) || patientId <= 0) {
        return res.status(400).json({ message: 'Invalid patient ID' });
      }
      request.input('Patient_ID', sql.Int, patientId);
      patientFilter = 'WHERE p.Patient_ID = @Patient_ID';
    }
    const result = await request.query(`
      SELECT p.Payment_ID, p.Patient_ID, p.ServiceName, p.ServicePrice, p.PaymentType,
             p.PaymentAmount, p.PaymentDate, p.IsPaid,
             patient.FirstName AS PatientFirstName, patient.LastName AS PatientLastName
      FROM Payment p
      INNER JOIN Patient patient ON patient.Patient_ID = p.Patient_ID
      ${patientFilter}
      ORDER BY p.PaymentDate DESC, p.Payment_ID DESC
    `);
    res.json(result.recordset);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

app.post('/api/payments', authMiddleware, async (req, res) => {
  if (!['Admin', 'Receptionist'].includes(req.user.role)) {
    return res.status(403).json({ message: 'Only receptionists and admins can record payments' });
  }
  const body = req.body || {};
  const patientId = Number(body.Patient_ID);
  const serviceName = String(body.ServiceName || '').trim();
  const servicePrice = Number(body.ServicePrice);
  const paymentType = String(body.PaymentType || '');
  const isPaid = body.IsPaid === true || String(body.IsPaid).toLowerCase() === 'yes';
  if (!Number.isInteger(patientId) || patientId <= 0) {
    return res.status(400).json({ message: 'Select a valid patient' });
  }
  if (!serviceName || serviceName.length > 200) {
    return res.status(400).json({ message: 'Enter a service name (up to 200 characters)' });
  }
  if (!Number.isFinite(servicePrice) || servicePrice <= 0 || servicePrice > 10000000) {
    return res.status(400).json({ message: 'Service price must be greater than zero' });
  }
  if (!['Cash', 'Card', 'MedicalAid'].includes(paymentType)) {
    return res.status(400).json({ message: 'Choose Cash, Card, or Medical Aid as the payment type' });
  }

  let transaction;
  let transactionStarted = false;
  try {
    const db = await getPool();
    transaction = new sql.Transaction(db);
    await transaction.begin(sql.ISOLATION_LEVEL.SERIALIZABLE);
    transactionStarted = true;
    const patient = await transaction.request()
      .input('Patient_ID', sql.Int, patientId)
      .query('SELECT Patient_ID FROM Patient WITH (UPDLOCK, HOLDLOCK) WHERE Patient_ID = @Patient_ID AND IsActive = 1');
    if (!patient.recordset.length) {
      await transaction.rollback();
      transactionStarted = false;
      return res.status(404).json({ message: 'Active patient account not found' });
    }

    const payment = await transaction.request()
      .input('Patient_ID', sql.Int, patientId)
      .input('ServiceName', sql.NVarChar(200), serviceName)
      .input('ServicePrice', sql.Decimal(12, 2), servicePrice)
      .input('PaymentType', sql.NVarChar(50), paymentType)
      .input('PaymentAmount', sql.Decimal(12, 2), isPaid ? servicePrice : 0)
      .input('IsPaid', sql.NVarChar(10), isPaid ? 'Yes' : 'No')
      .query(`
        INSERT INTO Payment (Patient_ID, ServiceName, ServicePrice, PaymentType, PaymentAmount, PaymentDate, IsPaid)
        OUTPUT INSERTED.Payment_ID, INSERTED.Patient_ID, INSERTED.ServiceName,
               INSERTED.ServicePrice, INSERTED.PaymentType, INSERTED.PaymentAmount,
               INSERTED.PaymentDate, INSERTED.IsPaid
        VALUES (@Patient_ID, @ServiceName, @ServicePrice, @PaymentType, @PaymentAmount,
                CONVERT(date, GETDATE()), @IsPaid)
      `);
    if (!isPaid) {
      await transaction.request()
        .input('Patient_ID', sql.Int, patientId)
        .input('ServicePrice', sql.Decimal(12, 2), servicePrice)
        .query('UPDATE Patient SET AccountBalance = COALESCE(AccountBalance, 0) + @ServicePrice WHERE Patient_ID = @Patient_ID');
    }
    await transaction.commit();
    transactionStarted = false;
    await writeAuditEvent(req, {
      userType: req.user.type,
      userId: req.user.id,
      category: 'Action',
      action: 'Record payment',
      table: 'Payment',
      recordId: payment.recordset[0].Payment_ID,
      details: `${isPaid ? 'Paid' : 'Unpaid'} service recorded`
    });
    res.status(201).json(payment.recordset[0]);
  } catch (err) {
    if (transactionStarted) await transaction.rollback();
    console.error('Unable to record payment:', err);
    res.status(500).json({ message: err.message || 'Unable to record payment' });
  }
});

app.patch('/api/payments/:id/confirm', authMiddleware, async (req, res) => {
  if (!['Admin', 'Receptionist'].includes(req.user.role)) {
    return res.status(403).json({ message: 'Only receptionists and admins can confirm payments' });
  }
  const paymentId = Number(req.params.id);
  if (!Number.isInteger(paymentId) || paymentId <= 0) {
    return res.status(400).json({ message: 'Invalid payment ID' });
  }

  let transaction;
  let transactionStarted = false;
  try {
    const db = await getPool();
    transaction = new sql.Transaction(db);
    await transaction.begin(sql.ISOLATION_LEVEL.SERIALIZABLE);
    transactionStarted = true;
    const payment = await transaction.request()
      .input('Payment_ID', sql.Int, paymentId)
      .query(`
        SELECT Payment_ID, Patient_ID, ServicePrice, PaymentAmount, IsPaid
        FROM Payment WITH (UPDLOCK, HOLDLOCK)
        WHERE Payment_ID = @Payment_ID
      `);
    const record = payment.recordset[0];
    if (!record) {
      await transaction.rollback();
      transactionStarted = false;
      return res.status(404).json({ message: 'Payment not found' });
    }
    if (String(record.IsPaid).toLowerCase() === 'yes') {
      await transaction.rollback();
      transactionStarted = false;
      return res.status(409).json({ message: 'This payment has already been confirmed' });
    }

    const amountDue = Math.max(0, Number(record.ServicePrice) - Number(record.PaymentAmount || 0));
    const updated = await transaction.request()
      .input('Payment_ID', sql.Int, paymentId)
      .input('ServicePrice', sql.Decimal(12, 2), Number(record.ServicePrice))
      .query(`
        UPDATE Payment
        SET IsPaid = 'Yes', PaymentAmount = ServicePrice
        OUTPUT INSERTED.Payment_ID, INSERTED.Patient_ID, INSERTED.ServiceName,
               INSERTED.ServicePrice, INSERTED.PaymentType, INSERTED.PaymentAmount,
               INSERTED.PaymentDate, INSERTED.IsPaid
        WHERE Payment_ID = @Payment_ID
      `);
    await transaction.request()
      .input('Patient_ID', sql.Int, record.Patient_ID)
      .input('AmountDue', sql.Decimal(12, 2), amountDue)
      .query(`
        UPDATE Patient
        SET AccountBalance = CASE
          WHEN COALESCE(AccountBalance, 0) >= @AmountDue THEN COALESCE(AccountBalance, 0) - @AmountDue
          ELSE 0
        END
        WHERE Patient_ID = @Patient_ID
      `);
    await transaction.commit();
    transactionStarted = false;
    await writeAuditEvent(req, {
      userType: req.user.type,
      userId: req.user.id,
      category: 'Action',
      action: 'Confirm payment',
      table: 'Payment',
      recordId: paymentId,
      details: 'Payment marked as paid'
    });
    res.json(updated.recordset[0]);
  } catch (err) {
    if (transactionStarted) await transaction.rollback();
    console.error('Unable to confirm payment:', err);
    res.status(500).json({ message: err.message || 'Unable to confirm payment' });
  }
});

app.get('/api/inventory', authMiddleware, async (_req, res) => {
  try {
    const db = await getPool();
    const result = await db.request().query('SELECT * FROM Inventory ORDER BY MedicationName');
    res.json(result.recordset);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

app.post('/api/inventory', authMiddleware, async (req, res) => {
  if (!['Admin', 'Pharmacist'].includes(req.user.role)) {
    return res.status(403).json({ message: 'Only pharmacists and admins can add inventory' });
  }
  const body = req.body || {};
  const medicationName = String(body.MedicationName || '').trim();
  const concentration = String(body.Concentration || '').trim();
  const medicationType = String(body.MedicationType || '').trim();
  const stockQuantity = Number(body.StockQuantity);
  const unitPrice = Number(body.UnitPrice);
  const reorderLevel = Number(body.ReorderLevel);
  const manufacturedDate = body.ManufacturedDate || null;
  const expiryDate = body.ExpiryDate || null;
  const isValidDate = value => !value || (
    /^\d{4}-\d{2}-\d{2}$/.test(String(value)) &&
    !Number.isNaN(new Date(`${value}T00:00:00Z`).getTime()) &&
    new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value
  );

  if (!medicationName || medicationName.length > 200) {
    return res.status(400).json({ message: 'Medication name is required and must be 200 characters or fewer' });
  }
  if (concentration.length > 50 || medicationType.length > 100) {
    return res.status(400).json({ message: 'Concentration must be 50 characters or fewer and type 100 or fewer' });
  }
  if (!Number.isInteger(stockQuantity) || stockQuantity < 0 ||
      !Number.isInteger(reorderLevel) || reorderLevel < 0 ||
      !Number.isFinite(unitPrice) || unitPrice < 0 ||
      !isValidDate(manufacturedDate) || !isValidDate(expiryDate)) {
    return res.status(400).json({ message: 'Enter valid non-negative stock, reorder level, price, and dates' });
  }
  if (manufacturedDate && expiryDate && manufacturedDate > expiryDate) {
    return res.status(400).json({ message: 'Expiry date must be on or after the manufactured date' });
  }

  try {
    const db = await getPool();
    const result = await db.request()
      .input('MedicationName', sql.NVarChar(200), medicationName)
      .input('Concentration', sql.NVarChar(50), concentration || null)
      .input('MedicationType', sql.NVarChar(100), medicationType || null)
      .input('ManufacturedDate', sql.Date, manufacturedDate)
      .input('ExpiryDate', sql.Date, expiryDate)
      .input('StockQuantity', sql.Int, stockQuantity)
      .input('UnitPrice', sql.Decimal(12, 2), unitPrice)
      .input('ReorderLevel', sql.Int, reorderLevel)
      .query(`
        INSERT INTO Inventory
          (MedicationName, Concentration, MedicationType, ManufacturedDate, ExpiryDate,
           StockQuantity, UnitPrice, ReorderLevel)
        OUTPUT INSERTED.*
        VALUES
          (@MedicationName, @Concentration, @MedicationType, @ManufacturedDate, @ExpiryDate,
           @StockQuantity, @UnitPrice, @ReorderLevel)
      `);
    const item = result.recordset[0];
    await writeAuditEvent(req, {
      userType: req.user.type,
      userId: req.user.id,
      category: 'Action',
      action: 'Add medication inventory',
      table: 'Inventory',
      recordId: item.Inventory_ID,
      details: `Added ${medicationName} with ${stockQuantity} unit(s)`
    });
    res.status(201).json(item);
  } catch (err) {
    console.error('Unable to add inventory item:', err);
    res.status(500).json({ message: err.message || 'Unable to add medication' });
  }
});

app.patch('/api/inventory/:id/stock', authMiddleware, async (req, res) => {
  if (!['Admin', 'Pharmacist'].includes(req.user.role)) {
    return res.status(403).json({ message: 'Only pharmacists and admins can update stock' });
  }
  const inventoryId = Number(req.params.id);
  const stockQuantity = Number((req.body || {}).quantity);
  if (!Number.isInteger(inventoryId) || inventoryId <= 0) {
    return res.status(400).json({ message: 'Invalid inventory ID' });
  }
  if (!Number.isInteger(stockQuantity) || stockQuantity < 0) {
    return res.status(400).json({ message: 'Stock quantity must be a non-negative whole number' });
  }

  try {
    const db = await getPool();
    const result = await db.request()
      .input('Inventory_ID', sql.Int, inventoryId)
      .input('StockQuantity', sql.Int, stockQuantity)
      .query(`
        UPDATE Inventory
        SET StockQuantity = @StockQuantity, LastUpdated = SYSUTCDATETIME()
        OUTPUT INSERTED.*
        WHERE Inventory_ID = @Inventory_ID
      `);
    if (!result.recordset.length) {
      return res.status(404).json({ message: 'Inventory item not found' });
    }
    await writeAuditEvent(req, {
      userType: req.user.type,
      userId: req.user.id,
      category: 'Action',
      action: 'Update medication stock',
      table: 'Inventory',
      recordId: inventoryId,
      details: `Set stock quantity to ${stockQuantity}`
    });
    res.json(result.recordset[0]);
  } catch (err) {
    console.error('Unable to update inventory stock:', err);
    res.status(500).json({ message: err.message || 'Unable to update stock quantity' });
  }
});

app.get('/api/prescriptions', authMiddleware, async (req, res) => {
  if (!['Admin', 'Pharmacist'].includes(req.user.role)) {
    return res.status(403).json({ message: 'Only pharmacists and admins can view prescriptions' });
  }
  try {
    const db = await getPool();
    const columns = await getTableColumns(db, 'Prescription');
    const prescriptionColumns = new Set(columns.map(column => column.ColumnName));
    const dispensedExpression = prescriptionDispensedExpression(prescriptionColumns, 'pr');
    if (!dispensedExpression) {
      return res.status(500).json({ message: 'Prescription table has no supported dispensing status column' });
    }
    const dispensedDateExpression = prescriptionColumns.has('DispensedDate')
      ? 'pr.DispensedDate'
      : 'NULL';
    const instructionColumns = [
      'DosageInstructions',
      'Dosage',
      'Frequency',
      'PrescriptionDuration',
      'Duration',
      'Instructions'
    ].filter(column => prescriptionColumns.has(column));
    const instructionExpression = instructionColumns.length
      ? `COALESCE(${instructionColumns
          .map(column => `NULLIF(LTRIM(RTRIM(CONVERT(nvarchar(500), pr.[${column}]))), '')`)
          .join(', ')})`
      : 'NULL';
    const result = await db.request().query(`
      SELECT pr.Prescription_ID, pr.Consultation_ID, pr.Inventory_ID,
             pr.Quantity, ${instructionExpression} AS DosageInstructions,
             CASE WHEN ${dispensedExpression} THEN 1 ELSE 0 END AS IsDispensed,
             ${dispensedDateExpression} AS DispensedDate,
             CONVERT(char(10), c.ConsultationDate, 23) AS PrescribedDate,
             i.MedicationName, i.Concentration, i.StockQuantity,
             p.FirstName AS PatientFirstName, p.LastName AS PatientLastName,
             p.ContactNumber
      FROM Prescription pr
      INNER JOIN Consultation c ON c.Consultation_ID = pr.Consultation_ID
      INNER JOIN Patient p ON p.Patient_ID = c.Patient_ID
      INNER JOIN Inventory i ON i.Inventory_ID = pr.Inventory_ID
      WHERE NOT (${dispensedExpression})
      ORDER BY c.ConsultationDate DESC, pr.Prescription_ID DESC
    `);
    res.json(result.recordset);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

app.post('/api/prescriptions/:id/dispense', authMiddleware, async (req, res) => {
  if (!['Admin', 'Pharmacist'].includes(req.user.role)) {
    return res.status(403).json({ message: 'Only pharmacists and admins can dispense medication' });
  }
  const prescriptionId = Number(req.params.id);
  if (!Number.isInteger(prescriptionId) || prescriptionId <= 0) {
    return res.status(400).json({ message: 'Invalid prescription ID' });
  }

  let transaction;
  let transactionStarted = false;
  try {
    const db = await getPool();
    const prescriptionColumns = await getTableColumns(db, 'Prescription');
    const columnNames = new Set(prescriptionColumns.map(column => column.ColumnName));
    const dispensedExpression = prescriptionDispensedExpression(columnNames);
    if (!dispensedExpression) {
      return res.status(500).json({ message: 'Prescription table has no supported dispensing status column' });
    }
    const statusUpdates = [];
    if (columnNames.has('IsDispensed')) statusUpdates.push('IsDispensed = 1');
    if (columnNames.has('DispenseType')) statusUpdates.push("DispenseType = 'Given'");
    if (columnNames.has('DispensedDate')) statusUpdates.push('DispensedDate = SYSUTCDATETIME()');
    if (!statusUpdates.length) {
      return res.status(500).json({ message: 'Prescription table has no supported dispensing status column' });
    }
    transaction = new sql.Transaction(db);
    await transaction.begin(sql.ISOLATION_LEVEL.SERIALIZABLE);
    transactionStarted = true;

    const prescriptionResult = await transaction.request()
      .input('Prescription_ID', sql.Int, prescriptionId)
      .query(`
        SELECT pr.Prescription_ID, pr.Consultation_ID, pr.Inventory_ID, pr.Quantity,
               CASE WHEN ${prescriptionDispensedExpression(columnNames, 'pr')} THEN 1 ELSE 0 END AS IsDispensed
        FROM Prescription pr WITH (UPDLOCK, HOLDLOCK)
        WHERE pr.Prescription_ID = @Prescription_ID
      `);
    const prescription = prescriptionResult.recordset[0];
    if (!prescription) {
      await transaction.rollback();
      transactionStarted = false;
      return res.status(404).json({ message: 'Prescription not found' });
    }
    if (prescription.IsDispensed) {
      await transaction.rollback();
      transactionStarted = false;
      return res.status(409).json({ message: 'This prescription has already been dispensed' });
    }

    const inventoryResult = await transaction.request()
      .input('Inventory_ID', sql.Int, prescription.Inventory_ID)
      .query(`
        SELECT Inventory_ID, MedicationName, StockQuantity
        FROM Inventory WITH (UPDLOCK, HOLDLOCK)
        WHERE Inventory_ID = @Inventory_ID
      `);
    const inventory = inventoryResult.recordset[0];
    if (!inventory) {
      await transaction.rollback();
      transactionStarted = false;
      return res.status(404).json({ message: 'Prescribed medication was not found in inventory' });
    }
    if (inventory.StockQuantity < prescription.Quantity) {
      await transaction.rollback();
      transactionStarted = false;
      return res.status(409).json({ message: 'Insufficient stock to dispense this prescription' });
    }

    await transaction.request()
      .input('Inventory_ID', sql.Int, prescription.Inventory_ID)
      .input('Quantity', sql.Int, prescription.Quantity)
      .query(`
        UPDATE Inventory
        SET StockQuantity = StockQuantity - @Quantity,
            LastUpdated = SYSUTCDATETIME()
        WHERE Inventory_ID = @Inventory_ID AND StockQuantity >= @Quantity
      `);
    const updated = await transaction.request()
      .input('Prescription_ID', sql.Int, prescriptionId)
      .query(`
        UPDATE Prescription
        SET ${statusUpdates.join(', ')}
        OUTPUT INSERTED.Prescription_ID, INSERTED.Inventory_ID, INSERTED.Quantity
        WHERE Prescription_ID = @Prescription_ID AND NOT (${dispensedExpression})
      `);
    if (!updated.recordset.length) {
      await transaction.rollback();
      transactionStarted = false;
      return res.status(409).json({ message: 'This prescription has already been dispensed' });
    }

    await transaction.commit();
    transactionStarted = false;
    await writeAuditEvent(req, {
      userType: req.user.type,
      userId: req.user.id,
      category: 'Action',
      action: 'Dispense prescription',
      table: 'Prescription',
      recordId: prescriptionId,
      details: `Dispensed ${prescription.Quantity} unit(s) of ${inventory.MedicationName}`
    });
    res.json({ ...updated.recordset[0], IsDispensed: true });
  } catch (err) {
    if (transactionStarted) await transaction.rollback();
    console.error('Unable to dispense prescription:', err);
    res.status(500).json({ message: err.message || 'Unable to dispense prescription' });
  }
});

app.get('/api/diagnoses', authMiddleware, async (req, res) => {
  try {
    if (!['Admin', 'Manager', 'Doctor', 'Nurse'].includes(req.user.role)) {
      return res.status(403).json({ message: 'Not allowed to view diagnosis options' });
    }
    const db = await getPool();
    const diagnosisColumns = new Set((await getTableColumns(db, 'Diagnose')).map(column => column.ColumnName));
    const severityColumn = diagnosisColumns.has('Severity')
      ? 'Severity'
      : diagnosisColumns.has('DiagnoseSeverity')
        ? 'DiagnoseSeverity'
        : null;
    const result = await db.request().query(`
      SELECT Diagnose_ID, DiagnoseName,
             ${severityColumn ? `[${severityColumn}]` : 'NULL'} AS Severity
      FROM Diagnose
      ORDER BY DiagnoseName
    `);
    res.json(result.recordset);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

app.get('/api/consultations', authMiddleware, async (req, res) => {
  try {
    if (!['Admin', 'Manager', 'Doctor', 'Nurse'].includes(req.user.role)) {
      return res.status(403).json({ message: 'Not allowed to view consultations' });
    }
    const db = await getPool();
    const columns = await getTableColumns(db, 'Consultation');
    const columnNames = new Set(columns.map(column => column.ColumnName));
    if (!columnNames.has('Consultation_ID')) {
      return res.status(500).json({ message: 'Consultation table is missing Consultation_ID' });
    }
    const request = db.request();
    let clinicianFilter = '';
    if (req.user.role === 'Doctor' || req.user.role === 'Nurse') {
      request.input('Employee_ID', sql.Int, req.user.id);
      clinicianFilter = 'WHERE c.Employee_ID = @Employee_ID';
    }
    const notesColumns = ['Notes', 'ConsultationNotes']
      .filter(column => columnNames.has(column))
      .map(column => `c.[${column}]`);
    const diagnosisColumns = ['DiagnosisSummary', 'ConsultationDiagnosis', 'Diagnosis']
      .filter(column => columnNames.has(column))
      .map(column => `c.[${column}]`);
    const notesExpression = notesColumns.length > 1
      ? `COALESCE(${notesColumns.join(', ')})`
      : notesColumns[0] || 'NULL';
    const diagnosisExpression = diagnosisColumns.length > 1
      ? `COALESCE(${diagnosisColumns.join(', ')})`
      : diagnosisColumns[0] || 'NULL';
    const patientJoin = columnNames.has('Patient_ID')
      ? 'p.Patient_ID = c.Patient_ID'
      : columnNames.has('Appointment_ID')
        ? 'p.Patient_ID = a.Patient_ID'
        : null;
    if (!patientJoin) {
      return res.status(500).json({ message: 'Consultation table has no patient link to display recent consultations' });
    }
    const appointmentJoin = !columnNames.has('Patient_ID') && columnNames.has('Appointment_ID')
      ? 'LEFT JOIN Appointment a ON a.Appointment_ID = c.Appointment_ID'
      : '';
    const result = await request.query(`
      SELECT c.Consultation_ID,
             ${columnNames.has('Appointment_ID') ? 'c.Appointment_ID' : 'NULL'} AS Appointment_ID,
             ${columnNames.has('Patient_ID') ? 'c.Patient_ID' : 'a.Patient_ID'} AS Patient_ID,
             ${columnNames.has('Employee_ID') ? 'c.Employee_ID' : 'NULL'} AS Employee_ID,
             ${columnNames.has('ConsultationDate') ? 'c.ConsultationDate' : 'NULL'} AS ConsultationDate,
             ${notesExpression} AS Notes,
             ${diagnosisExpression} AS DiagnosisSummary,
             p.FirstName AS PatientFirstName, p.LastName AS PatientLastName
      FROM Consultation c
      ${appointmentJoin}
      LEFT JOIN Patient p ON ${patientJoin}
      ${clinicianFilter}
      ORDER BY c.ConsultationDate DESC
    `);
    res.json(result.recordset);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

app.post('/api/consultations', authMiddleware, async (req, res) => {
  if (!['Doctor', 'Nurse'].includes(req.user.role)) {
    return res.status(403).json({ message: 'Only doctors and nurses can record consultations' });
  }

  const body = req.body || {};
  const appointmentId = Number(body.Appointment_ID);
  const duration = Number(body.Duration ?? body.ConsultationDuration ?? 15);
  const diagnosisId = body.Diagnose_ID ? Number(body.Diagnose_ID) : null;
  const inventoryId = body.Inventory_ID ? Number(body.Inventory_ID) : null;
  const quantity = body.Quantity ? Number(body.Quantity) : 1;
  const dispenseType = body.DispenseType === 'Given' ? 'Given' : 'Prescribed';
  const heartRate = body.HeartRate == null || body.HeartRate === '' ? null : Number(body.HeartRate);
  const temperature = body.Temperature == null || body.Temperature === '' ? null : Number(body.Temperature);
  const weight = body.Weight == null || body.Weight === '' ? null : Number(body.Weight);
  if (!Number.isInteger(appointmentId) || appointmentId <= 0) {
    return res.status(400).json({ message: 'Select a valid appointment' });
  }
  if (!Number.isInteger(duration) || duration < 1 || duration > 1440) {
    return res.status(400).json({ message: 'Duration must be between 1 and 1440 minutes' });
  }
  if (diagnosisId !== null && (!Number.isInteger(diagnosisId) || diagnosisId <= 0)) {
    return res.status(400).json({ message: 'Select a valid diagnosis' });
  }
  if (inventoryId !== null && (!Number.isInteger(inventoryId) || inventoryId <= 0)) {
    return res.status(400).json({ message: 'Select a valid medication' });
  }
  if (inventoryId !== null && (!Number.isInteger(quantity) || quantity < 1)) {
    return res.status(400).json({ message: 'Medication quantity must be a positive whole number' });
  }
  const dosage = String(body.Dosage || '').trim();
  if (inventoryId !== null && !dosage) {
    return res.status(400).json({ message: 'Enter the medication dosage before saving the prescription' });
  }
  if (heartRate !== null && (!Number.isInteger(heartRate) || heartRate < 1 || heartRate > 300)) {
    return res.status(400).json({ message: 'Heart rate must be a whole number between 1 and 300' });
  }
  if (temperature !== null && (!Number.isFinite(temperature) || temperature < 30 || temperature > 45)) {
    return res.status(400).json({ message: 'Temperature must be between 30 and 45 degrees C' });
  }
  if (weight !== null && (!Number.isFinite(weight) || weight <= 0 || weight > 500)) {
    return res.status(400).json({ message: 'Weight must be greater than 0 and no more than 500 kg' });
  }
  const consultationNotes = [
    body.Complaint ? `Chief complaint: ${String(body.Complaint).trim()}` : null,
    body.Examination ? `Examination findings: ${String(body.Examination).trim()}` : null,
    body.Notes ? `Consultation notes: ${String(body.Notes).trim()}` : null
  ].filter(Boolean).join('\n');
  const notes = [
    `Duration: ${duration} minutes`,
    consultationNotes,
    body.BloodPressure ? `Blood pressure: ${String(body.BloodPressure).trim()}` : null,
    heartRate !== null ? `Heart rate: ${heartRate} bpm` : null,
    temperature !== null ? `Temperature: ${temperature} C` : null,
    weight !== null ? `Weight: ${weight} kg` : null,
    body.Severity ? `Severity: ${String(body.Severity).trim()}` : null
  ].filter(Boolean).join('\n');
  if (notes.length > 20000) {
    return res.status(400).json({ message: 'Consultation notes are too long' });
  }

  let transaction;
  let transactionStarted = false;
  try {
    const db = await getPool();
    transaction = new sql.Transaction(db);
    await transaction.begin(sql.ISOLATION_LEVEL.SERIALIZABLE);
    transactionStarted = true;

    const appointmentResult = await transaction.request()
      .input('Appointment_ID', sql.Int, appointmentId)
      .query(`
        SELECT Appointment_ID, Patient_ID,
               COALESCE(NULLIF(LTRIM(RTRIM(Status)), ''), 'Scheduled') AS Status
        FROM Appointment WITH (UPDLOCK, HOLDLOCK)
        WHERE Appointment_ID = @Appointment_ID
      `);
    const appointment = appointmentResult.recordset[0];
    if (!appointment) {
      await transaction.rollback();
      transactionStarted = false;
      return res.status(404).json({ message: 'Appointment not found' });
    }
    if (String(appointment.Status || '').trim().toLowerCase() !== 'scheduled') {
      await transaction.rollback();
      transactionStarted = false;
      return res.status(409).json({ message: 'Only scheduled appointments can be completed' });
    }

    let diagnosisName = null;
    if (diagnosisId !== null) {
      const diagnosisResult = await transaction.request()
        .input('Diagnose_ID', sql.Int, diagnosisId)
        .query('SELECT Diagnose_ID, DiagnoseName FROM Diagnose WHERE Diagnose_ID = @Diagnose_ID');
      if (!diagnosisResult.recordset.length) {
        await transaction.rollback();
        transactionStarted = false;
        return res.status(400).json({ message: 'Selected diagnosis was not found' });
      }
      diagnosisName = diagnosisResult.recordset[0].DiagnoseName;
    }

    if (inventoryId !== null) {
      const inventoryResult = await transaction.request()
        .input('Inventory_ID', sql.Int, inventoryId)
        .query('SELECT Inventory_ID, StockQuantity FROM Inventory WITH (UPDLOCK, HOLDLOCK) WHERE Inventory_ID = @Inventory_ID');
      const inventory = inventoryResult.recordset[0];
      if (!inventory) {
        await transaction.rollback();
        transactionStarted = false;
        return res.status(400).json({ message: 'Selected medication was not found' });
      }
      if (dispenseType === 'Given' && inventory.StockQuantity < quantity) {
        await transaction.rollback();
        transactionStarted = false;
        return res.status(409).json({ message: 'Insufficient stock for the selected quantity' });
      }
    }

    const diagnosisSummary = [
      diagnosisName,
      body.DiagnosisReason ? String(body.DiagnosisReason).trim() : null
    ].filter(Boolean).join(': ').slice(0, 1000) || null;

    const consultationColumns = await getTableColumns(db, 'Consultation');
    const consultationColumnNames = new Set(consultationColumns.map(column => column.ColumnName));
    const fieldValues = {
      Appointment_ID: { type: sql.Int, value: appointmentId },
      Patient_ID: { type: sql.Int, value: appointment.Patient_ID },
      Employee_ID: { type: sql.Int, value: req.user.id },
      ConsultationDate: { type: sql.DateTime2, value: new Date() },
      ConsultationDuration: { type: sql.Int, value: duration },
      Notes: { type: sql.NVarChar(sql.MAX), value: notes || null },
      ConsultationNotes: { type: sql.NVarChar(sql.MAX), value: consultationNotes || notes || null },
      DiagnosisSummary: { type: sql.NVarChar(1000), value: diagnosisSummary },
      ComplaintInfo: { type: sql.NVarChar(2000), value: body.Complaint ? String(body.Complaint).trim() : null },
      PatientBP: { type: sql.NVarChar(50), value: body.BloodPressure ? String(body.BloodPressure).trim() : null },
      PatientHR: { type: sql.Int, value: heartRate },
      PatientTemp: { type: sql.Decimal(5, 2), value: temperature },
      PatientWeight: { type: sql.Decimal(6, 2), value: weight },
      PatientExamination: { type: sql.NVarChar(sql.MAX), value: body.Examination ? String(body.Examination).trim() : null },
      SeverityStatus: { type: sql.NVarChar(30), value: body.Severity ? String(body.Severity).trim() : null }
    };
    const insertableFields = Object.entries(fieldValues)
      .filter(([columnName]) => consultationColumnNames.has(columnName));
    const missingRequiredColumns = consultationColumns
      .filter(column =>
        column.IsNullable === 'NO' &&
        column.ColumnDefault === null &&
        column.ColumnName !== 'Consultation_ID' &&
        (!Object.prototype.hasOwnProperty.call(fieldValues, column.ColumnName) ||
          fieldValues[column.ColumnName].value == null)
      )
      .map(column => column.ColumnName);
    if (missingRequiredColumns.length) {
      await transaction.rollback();
      transactionStarted = false;
      return res.status(500).json({
        message: `Consultation table requires fields the form does not provide: ${missingRequiredColumns.join(', ')}`
      });
    }
    const consultationRequest = transaction.request();
    for (const [columnName, field] of insertableFields) {
      consultationRequest.input(columnName, field.type, field.value);
    }
    const consultationResult = await consultationRequest.query(`
      INSERT INTO Consultation (${insertableFields.map(([columnName]) => `[${columnName}]`).join(', ')})
      OUTPUT INSERTED.Consultation_ID AS Consultation_ID
      VALUES (${insertableFields.map(([columnName]) => `@${columnName}`).join(', ')})
    `);
    const consultation = {
      ...consultationResult.recordset[0],
      Appointment_ID: appointmentId,
      Patient_ID: appointment.Patient_ID,
      Employee_ID: req.user.id,
      ConsultationDate: new Date(),
      Notes: notes || null,
      DiagnosisSummary: diagnosisSummary
    };

    if (diagnosisId !== null) {
      await transaction.request()
        .input('Consultation_ID', sql.Int, consultation.Consultation_ID)
        .input('Diagnose_ID', sql.Int, diagnosisId)
        .query('INSERT INTO ConsultationDiagnose (Consultation_ID, Diagnose_ID) VALUES (@Consultation_ID, @Diagnose_ID)');
    }

    if (inventoryId !== null) {
      const dosageInstructions = [
        dosage ? `Dosage: ${dosage}` : null,
        body.Frequency ? `Frequency: ${String(body.Frequency).trim()}` : null,
        body.PrescriptionDuration ? `Duration: ${String(body.PrescriptionDuration).trim()}` : null,
        body.Instructions ? `Instructions: ${String(body.Instructions).trim()}` : null
      ].filter(Boolean).join('; ').slice(0, 500);
      const isDispensed = dispenseType === 'Given';
      const prescriptionColumns = await getTableColumns(db, 'Prescription');
      const prescriptionColumnNames = new Set(prescriptionColumns.map(column => column.ColumnName));
      const prescriptionValues = {
        Consultation_ID: { type: sql.Int, value: consultation.Consultation_ID },
        Inventory_ID: { type: sql.Int, value: inventoryId },
        Quantity: { type: sql.Int, value: quantity },
        DosageInstructions: { type: sql.NVarChar(500), value: dosageInstructions || null },
        Dosage: { type: sql.NVarChar(500), value: dosage },
        Frequency: { type: sql.NVarChar(100), value: String(body.Frequency || '').trim() || null },
        PrescriptionDuration: { type: sql.NVarChar(100), value: String(body.PrescriptionDuration || '').trim() || null },
        Duration: { type: sql.NVarChar(100), value: String(body.PrescriptionDuration || '').trim() || null },
        Instructions: { type: sql.NVarChar(500), value: String(body.Instructions || '').trim() || null },
        DispenseType: { type: sql.NVarChar(30), value: dispenseType },
        PrescribedDate: { type: sql.DateTime2, value: new Date() },
        IsDispensed: { type: sql.Bit, value: isDispensed },
        DispensedDate: { type: sql.DateTime2, value: isDispensed ? new Date() : null }
      };
      const insertablePrescriptionFields = Object.entries(prescriptionValues)
        .filter(([columnName, field]) =>
          prescriptionColumnNames.has(columnName) && field.value != null
        );
      const missingPrescriptionColumns = prescriptionColumns
        .filter(column =>
          column.IsNullable === 'NO' &&
          column.ColumnDefault === null &&
          column.ColumnName !== 'Prescription_ID' &&
          !insertablePrescriptionFields.some(([name]) => name === column.ColumnName)
        )
        .map(column => column.ColumnName);
      if (missingPrescriptionColumns.length) {
        await transaction.rollback();
        transactionStarted = false;
        const instructionFields = [
          'DosageInstructions',
          'Dosage',
          'Frequency',
          'PrescriptionDuration',
          'Duration',
          'Instructions'
        ];
        const missingInstructions = missingPrescriptionColumns.filter(column =>
          instructionFields.includes(column)
        );
        if (missingInstructions.length) {
          return res.status(400).json({
            message: `Enter the required prescription details: ${missingInstructions.join(', ')}`
          });
        }
        return res.status(500).json({
          message: `Prescription table requires unsupported fields: ${missingPrescriptionColumns.join(', ')}`
        });
      }
      const prescriptionRequest = transaction.request();
      for (const [columnName, field] of insertablePrescriptionFields) {
        prescriptionRequest.input(columnName, field.type, field.value);
      }
      await prescriptionRequest.query(`
        INSERT INTO Prescription
          (${insertablePrescriptionFields.map(([columnName]) => `[${columnName}]`).join(', ')})
        VALUES
          (${insertablePrescriptionFields.map(([columnName]) => `@${columnName}`).join(', ')})
      `);
      if (isDispensed) {
        await transaction.request()
          .input('Inventory_ID', sql.Int, inventoryId)
          .input('Quantity', sql.Int, quantity)
          .query(`
            UPDATE Inventory
            SET StockQuantity = StockQuantity - @Quantity, LastUpdated = SYSUTCDATETIME()
            WHERE Inventory_ID = @Inventory_ID AND StockQuantity >= @Quantity
          `);
      }
    }

    await transaction.request()
      .input('Appointment_ID', sql.Int, appointmentId)
      .query("UPDATE Appointment SET Status = 'Completed' WHERE Appointment_ID = @Appointment_ID");
    await transaction.commit();
    transactionStarted = false;

    await writeAuditEvent(req, {
      userType: req.user.type,
      userId: req.user.id,
      category: 'Action',
      action: 'Record consultation',
      table: 'Consultation',
      recordId: consultation.Consultation_ID,
      details: `Consultation recorded for appointment ${appointmentId}`
    });
    res.status(201).json(consultation);
  } catch (err) {
    if (transactionStarted) await transaction.rollback();
    console.error('Unable to record consultation:', err);
    res.status(500).json({ message: err.message || 'Unable to record consultation' });
  }
});

app.get('/api/metrics', authMiddleware, async (_req, res) => {
  try {
    const db = await getPool();
    const patients = await db.request().query('SELECT COUNT(*) AS c FROM Patient WHERE IsActive = 1');
    const employees = await db.request().query('SELECT COUNT(*) AS c FROM Employee WHERE IsActive = 1');
    const appts = await db.request().query("SELECT COUNT(*) AS c FROM Appointment WHERE Status = 'Scheduled'");
    res.json({
      activePatients: patients.recordset[0].c,
      activeEmployees: employees.recordset[0].c,
      scheduledAppointments: appts.recordset[0].c
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});


// ---------- Register employee ----------
app.post('/api/employees', authMiddleware, async (req, res) => {
  let db = null;
  let email = '';
  try {
    if (req.user.role !== 'Admin') {
      return res.status(403).json({ message: 'Only Admin can register employees' });
    }
    const b = req.body || {};
    const required = ['FirstName', 'LastName', 'Email', 'Password', 'EmployeeType'];
    for (const f of required) {
      if (!b[f]) return res.status(400).json({ message: f + ' is required' });
    }
    db = await getPool();
    email = String(b.Email).trim().toLowerCase();
    const existingAccount = await findAccountByEmail(db, email);
    if (existingAccount) {
      return res.status(409).json({
        message: `This email is already used by a ${existingAccount.UserType.toLowerCase()} account. Use a different email or update that account.`
      });
    }
    const hash = await bcrypt.hash(b.Password, 10);
    const result = await db.request()
      .input('FirstName', sql.NVarChar, b.FirstName)
      .input('LastName', sql.NVarChar, b.LastName)
      .input('ContactNumber', sql.NVarChar, b.ContactNumber || null)
      .input('Email', sql.NVarChar, email)
      .input('PasswordHash', sql.NVarChar, hash)
      .input('EmployeeType', sql.NVarChar, b.EmployeeType)
      .input('HPCSANumber', sql.NVarChar, b.HPCSANumber || null)
      .input('Address', sql.NVarChar, b.Address || null)
      .input('HireDate', sql.Date, b.HireDate || new Date())
      .query(`
        INSERT INTO Employee (FirstName, LastName, ContactNumber, Email, PasswordHash, IsActive, EmployeeType, HPCSANumber, Address, HireDate)
        OUTPUT INSERTED.Employee_ID, INSERTED.FirstName, INSERTED.LastName, INSERTED.Email, INSERTED.EmployeeType, INSERTED.IsActive
        VALUES (@FirstName, @LastName, @ContactNumber, @Email, @PasswordHash, 1, @EmployeeType, @HPCSANumber, @Address, @HireDate)
      `);
    const employee = result.recordset[0];
    await writeAuditEvent(req, {
      userType: 'Employee',
      userId: req.user.id,
      category: 'Action',
      action: 'Register employee',
      table: 'Employee',
      recordId: employee.Employee_ID,
      details: `Registered ${employee.EmployeeType} account`
    });
    res.status(201).json(employee);
  } catch (err) {
    const errorNumber = err && (
      err.number ||
      (err.originalError && err.originalError.info && err.originalError.info.number)
    );
    if (errorNumber === 2627 || errorNumber === 2601) {
      console.error('Unique constraint rejected employee registration:', err);
      if (db && email) {
        try {
          const existingAccount = await findAccountByEmail(db, email);
          if (existingAccount) {
            return res.status(409).json({
              message: `This email is already used by a ${existingAccount.UserType.toLowerCase()} account. Use a different email or update that account.`
            });
          }
        } catch (lookupError) {
          console.error('Unable to verify the conflicting account email:', lookupError);
          return res.status(500).json({ message: 'Unable to verify the registration conflict. Check backend logs.' });
        }
      }
      return res.status(409).json({
        message: 'A different value conflicts with a unique database constraint. Check backend logs for the conflicting field.'
      });
    }
    console.error(err);
    res.status(500).json({ message: err.message || 'Registration failed' });
  }
});

// ---------- Activate / deactivate accounts ----------
app.patch('/api/patients/:id/active', authMiddleware, async (req, res) => {
  try {
    if (req.user.role !== 'Admin') return res.status(403).json({ message: 'Admin only' });
    const id = parseInt(req.params.id, 10);
    const isActive = !!(req.body && req.body.isActive);
    const db = await getPool();
    await db.request()
      .input('id', sql.Int, id)
      .input('isActive', sql.Bit, isActive ? 1 : 0)
      .query('UPDATE Patient SET IsActive = @isActive WHERE Patient_ID = @id');
    await writeAuditEvent(req, {
      userType: 'Employee',
      userId: req.user.id,
      category: 'Action',
      action: isActive ? 'Activate patient account' : 'Deactivate patient account',
      table: 'Patient',
      recordId: id,
      details: `Patient account ${isActive ? 'activated' : 'deactivated'}`
    });
    res.json({ ok: true, id, isActive });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

app.patch('/api/employees/:id/active', authMiddleware, async (req, res) => {
  try {
    if (req.user.role !== 'Admin') return res.status(403).json({ message: 'Admin only' });
    const id = parseInt(req.params.id, 10);
    const isActive = !!(req.body && req.body.isActive);
    const db = await getPool();
    await db.request()
      .input('id', sql.Int, id)
      .input('isActive', sql.Bit, isActive ? 1 : 0)
      .query('UPDATE Employee SET IsActive = @isActive WHERE Employee_ID = @id');
    await writeAuditEvent(req, {
      userType: 'Employee',
      userId: req.user.id,
      category: 'Action',
      action: isActive ? 'Activate employee account' : 'Deactivate employee account',
      table: 'Employee',
      recordId: id,
      details: `Employee account ${isActive ? 'activated' : 'deactivated'}`
    });
    res.json({ ok: true, id, isActive });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ---------- Audit log ----------
app.get('/api/audit', authMiddleware, async (req, res) => {
  try {
    if (req.user.role !== 'Admin' && req.user.role !== 'Manager') {
      return res.status(403).json({ message: 'Not allowed' });
    }
    const db = await getPool();
    const result = await db.request().query(`
      SELECT TOP 200 AuditLog_ID, UserType, User_ID, EventCategory, ActionType,
             TableAffected, RecordID, IPAddress, EventTime, EventDetails
      FROM AuditLog
      ORDER BY EventTime DESC
    `);
    res.json(result.recordset);
  } catch (err) {
    console.error('Unable to load audit log:', err);
    res.status(500).json({ message: err.message || 'Unable to load audit log' });
  }
});

// Catch-all for unimplemented endpoints so the frontend gets a clear message
app.use('/api', (_req, res) => {
  res.status(501).json({
    message: 'This endpoint is not yet implemented on the server. Extend backend/server.js to match the frontend API calls.'
  });
});

app.listen(PORT, () => {
  console.log(`Forte Clinic API listening on http://localhost:${PORT}`);
  console.log(`API version: ${API_VERSION}`);
  console.log('Health check: GET /api/health');
  if (!process.env.DB_CONNECTION_STRING) {
    console.warn('\n⚠  DB_CONNECTION_STRING is not set. Copy .env.example to .env and add your connection string.\n');
  }
});
