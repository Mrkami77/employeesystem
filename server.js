const express = require('express');
const { DatabaseSync } = require('node:sqlite');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const cors = require('cors');
const multer = require('multer');
const rateLimit = require('express-rate-limit');
const morgan = require('morgan');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'ems-super-secret-jwt-key-2024';

// ─── Database Setup ────────────────────────────────────────────────────────────
const db = new DatabaseSync('employee.db');
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    name TEXT NOT NULL,
    role TEXT DEFAULT 'user',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS employees (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT UNIQUE NOT NULL,
    department TEXT NOT NULL,
    position TEXT,
    salary REAL,
    phone TEXT,
    hire_date TEXT,
    status TEXT DEFAULT 'active',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS departments (
    id TEXT PRIMARY KEY,
    name TEXT UNIQUE NOT NULL,
    manager TEXT
  );

  CREATE TABLE IF NOT EXISTS conversations (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    question TEXT NOT NULL,
    answer TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS audit_logs (
    id TEXT PRIMARY KEY,
    user_id TEXT,
    action TEXT NOT NULL,
    resource TEXT,
    details TEXT,
    ip TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS documents (
    id TEXT PRIMARY KEY,
    employee_id TEXT NOT NULL,
    filename TEXT NOT NULL,
    original_name TEXT NOT NULL,
    mime_type TEXT,
    size INTEGER,
    uploaded_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (employee_id) REFERENCES employees(id)
  );
`);

// ─── Seed Data ─────────────────────────────────────────────────────────────────
const adminExists = db.prepare('SELECT id FROM users WHERE email = ?').get('admin@company.com');
if (!adminExists) {
  const adminId = uuidv4();
  db.prepare('INSERT INTO users (id,email,password,name,role) VALUES (?,?,?,?,?)').run(
    adminId, 'admin@company.com', bcrypt.hashSync('Admin@123', 10), 'System Administrator', 'admin'
  );

  ['Engineering','Sales','Marketing','HR','Finance','Operations'].forEach(d =>
    db.prepare('INSERT INTO departments (id,name) VALUES (?,?)').run(uuidv4(), d)
  );

  [
    { name:'John Smith',     email:'john.smith@company.com',     dept:'Engineering', pos:'Senior Developer',  sal:95000, phone:'+1-555-0101' },
    { name:'Sarah Johnson',  email:'sarah.johnson@company.com',  dept:'Marketing',   pos:'Marketing Manager', sal:85000, phone:'+1-555-0102' },
    { name:'Michael Brown',  email:'michael.brown@company.com',  dept:'Sales',       pos:'Sales Lead',        sal:78000, phone:'+1-555-0103' },
    { name:'Emily Davis',    email:'emily.davis@company.com',    dept:'HR',          pos:'HR Director',       sal:90000, phone:'+1-555-0104' },
    { name:'David Wilson',   email:'david.wilson@company.com',   dept:'Finance',     pos:'Financial Analyst', sal:82000, phone:'+1-555-0105' },
    { name:'Lisa Anderson',  email:'lisa.anderson@company.com',  dept:'Engineering', pos:'Frontend Developer',sal:88000, phone:'+1-555-0106' },
    { name:'James Taylor',   email:'james.taylor@company.com',   dept:'Operations',  pos:'Ops Manager',       sal:92000, phone:'+1-555-0107' },
    { name:'Jennifer Martinez',email:'jennifer.martinez@company.com',dept:'Sales',  pos:'Account Executive', sal:72000, phone:'+1-555-0108' },
  ].forEach(e => db.prepare(
    'INSERT INTO employees (id,name,email,department,position,salary,phone,hire_date) VALUES (?,?,?,?,?,?,?,?)'
  ).run(uuidv4(), e.name, e.email, e.dept, e.pos, e.sal, e.phone, '2023-01-15'));
}

// ─── Middleware ────────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(morgan(':method :url :status :res[content-length] - :response-time ms'));
app.use(express.static(path.join(__dirname)));

// Rate limiting — 100 req/min per IP
const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => res.status(429).json({
    error: 'Rate limit exceeded — 100 requests/minute',
    code: 429,
    retryAfter: 60
  })
});
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  handler: (req, res) => res.status(429).json({ error: 'Too many auth attempts', code: 429 })
});
app.use('/api/', apiLimiter);

// ─── JWT Auth Middleware ───────────────────────────────────────────────────────
const authenticateToken = (req, res, next) => {
  const token = (req.headers['authorization'] || '').split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Access token required', code: 401 });
  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.status(401).json({ error: 'Invalid or expired token', code: 401 });
    req.user = user;
    next();
  });
};

const requireAdmin = (req, res, next) => {
  if (req.user.role !== 'admin')
    return res.status(403).json({ error: 'Administrator access required', code: 403 });
  next();
};

// ─── Edge Cache Simulation ─────────────────────────────────────────────────────
const edgeCache = new Map();
const cacheMiddleware = (ttl = 60) => (req, res, next) => {
  const key = req.originalUrl + ':' + (req.headers['authorization'] || '');
  const hit = edgeCache.get(key);
  if (hit && Date.now() - hit.ts < ttl * 1000) {
    res.setHeader('X-Cache', 'HIT');
    res.setHeader('X-Cache-Age', Math.floor((Date.now() - hit.ts) / 1000) + 's');
    res.setHeader('X-Cache-TTL', ttl + 's');
    return res.json(hit.data);
  }
  res.setHeader('X-Cache', 'MISS');
  const orig = res.json.bind(res);
  res.json = data => { edgeCache.set(key, { data, ts: Date.now() }); return orig(data); };
  next();
};

// ─── Helpers ───────────────────────────────────────────────────────────────────
const auditLog = (userId, action, resource, details, ip) =>
  db.prepare('INSERT INTO audit_logs (id,user_id,action,resource,details,ip) VALUES (?,?,?,?,?,?)').run(
    uuidv4(), userId, action, resource, JSON.stringify(details), ip
  );

const clearCache = () => edgeCache.clear();

// ─── File Storage (R2 simulation) ─────────────────────────────────────────────
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => cb(null, `${uuidv4()}-${file.originalname}`)
});
const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ['application/pdf','image/jpeg','image/png','application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document'];
    allowed.includes(file.mimetype) ? cb(null, true) : cb(new Error('File type not allowed'));
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
//  AUTH ROUTES
// ═══════════════════════════════════════════════════════════════════════════════
app.post('/api/v1/auth/register', authLimiter, (req, res) => {
  const { email, password, name } = req.body;
  if (!email || !password || !name)
    return res.status(400).json({ error: 'Email, password, and name are required', code: 400 });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
    return res.status(400).json({ error: 'Invalid email format', code: 400 });
  if (password.length < 8)
    return res.status(400).json({ error: 'Password must be at least 8 characters', code: 400 });
  if (db.prepare('SELECT id FROM users WHERE email = ?').get(email))
    return res.status(409).json({ error: 'Email already registered', code: 409 });

  const id = uuidv4();
  db.prepare('INSERT INTO users (id,email,password,name) VALUES (?,?,?,?)').run(id, email, bcrypt.hashSync(password, 10), name);
  const token = jwt.sign({ id, email, name, role: 'user' }, JWT_SECRET, { expiresIn: '24h' });
  res.status(201).json({ message: 'Registered successfully', token, user: { id, email, name, role: 'user' } });
});

app.post('/api/v1/auth/login', authLimiter, (req, res) => {
  const { email, password } = req.body;
  if (!email || !password)
    return res.status(400).json({ error: 'Email and password are required', code: 400 });

  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!user || !bcrypt.compareSync(password, user.password))
    return res.status(401).json({ error: 'Invalid email or password', code: 401 });

  const token = jwt.sign(
    { id: user.id, email: user.email, name: user.name, role: user.role },
    JWT_SECRET, { expiresIn: '24h' }
  );
  auditLog(user.id, 'LOGIN', 'auth', { email }, req.ip);
  res.json({ message: 'Login successful', token, user: { id: user.id, email: user.email, name: user.name, role: user.role } });
});

// ═══════════════════════════════════════════════════════════════════════════════
//  EMPLOYEE ROUTES
// ═══════════════════════════════════════════════════════════════════════════════
app.get('/api/v1/employees', authenticateToken, cacheMiddleware(60), (req, res) => {
  const { department, status, search, page = 1, limit = 50 } = req.query;
  let q = 'SELECT * FROM employees WHERE 1=1'; const p = [];
  if (department) { q += ' AND department = ?'; p.push(department); }
  if (status)     { q += ' AND status = ?';     p.push(status); }
  if (search)     { q += ' AND (name LIKE ? OR email LIKE ? OR department LIKE ? OR position LIKE ?)'; p.push(`%${search}%`,`%${search}%`,`%${search}%`,`%${search}%`); }
  const total = db.prepare(q.replace('SELECT *', 'SELECT COUNT(*) as c')).get(...p).c;
  q += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
  p.push(parseInt(limit), (parseInt(page)-1)*parseInt(limit));
  const data = db.prepare(q).all(...p);
  res.json({ data, pagination: { total, page: +page, limit: +limit, pages: Math.ceil(total/+limit) } });
});

app.get('/api/v1/employees/:id', authenticateToken, (req, res) => {
  const emp = db.prepare('SELECT * FROM employees WHERE id = ?').get(req.params.id);
  if (!emp) return res.status(404).json({ error: 'Employee not found', code: 404 });
  const docs = db.prepare('SELECT * FROM documents WHERE employee_id = ?').all(req.params.id);
  res.json({ ...emp, documents: docs });
});

app.post('/api/v1/employees', authenticateToken, requireAdmin, (req, res) => {
  const { name, email, department, position, salary, phone, hire_date } = req.body;
  if (!name || !email || !department)
    return res.status(400).json({ error: 'Name, email, and department are required', code: 400 });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
    return res.status(400).json({ error: 'Invalid email format', code: 400 });
  if (name.trim().length < 2)
    return res.status(400).json({ error: 'Name must be at least 2 characters', code: 400 });
  if (db.prepare('SELECT id FROM employees WHERE email = ?').get(email))
    return res.status(409).json({ error: 'Employee with this email already exists', code: 409 });

  const id = uuidv4();
  db.prepare('INSERT INTO employees (id,name,email,department,position,salary,phone,hire_date) VALUES (?,?,?,?,?,?,?,?)').run(
    id, name.trim(), email.toLowerCase(), department, position||null, salary||null, phone||null,
    hire_date || new Date().toISOString().split('T')[0]
  );
  clearCache();
  auditLog(req.user.id, 'CREATE', 'employee', { id, name, email }, req.ip);
  res.status(201).json({ message: 'Employee created successfully', data: db.prepare('SELECT * FROM employees WHERE id=?').get(id) });
});

app.put('/api/v1/employees/:id', authenticateToken, requireAdmin, (req, res) => {
  const existing = db.prepare('SELECT * FROM employees WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Employee not found', code: 404 });
  const { name, email, department, position, salary, phone, hire_date, status } = req.body;
  if (email && email !== existing.email && db.prepare('SELECT id FROM employees WHERE email=? AND id!=?').get(email, req.params.id))
    return res.status(409).json({ error: 'Email already used by another employee', code: 409 });

  db.prepare(`UPDATE employees SET name=?,email=?,department=?,position=?,salary=?,phone=?,hire_date=?,status=?,updated_at=? WHERE id=?`).run(
    name||existing.name, email||existing.email, department||existing.department,
    position||existing.position, salary!==undefined?salary:existing.salary,
    phone||existing.phone, hire_date||existing.hire_date, status||existing.status,
    new Date().toISOString(), req.params.id
  );
  clearCache();
  auditLog(req.user.id, 'UPDATE', 'employee', { id: req.params.id, changes: req.body }, req.ip);
  res.json({ message: 'Employee updated successfully', data: db.prepare('SELECT * FROM employees WHERE id=?').get(req.params.id) });
});

app.delete('/api/v1/employees/:id', authenticateToken, requireAdmin, (req, res) => {
  const emp = db.prepare('SELECT * FROM employees WHERE id=?').get(req.params.id);
  if (!emp) return res.status(404).json({ error: 'Employee not found', code: 404 });
  db.prepare('DELETE FROM employees WHERE id=?').run(req.params.id);
  clearCache();
  auditLog(req.user.id, 'DELETE', 'employee', { id: req.params.id, name: emp.name }, req.ip);
  res.json({ message: 'Employee deleted successfully', code: 200 });
});

// ─── Document Upload (R2 Simulation) ──────────────────────────────────────────
app.post('/api/v1/employees/:id/documents', authenticateToken, upload.single('file'), (req, res) => {
  if (!db.prepare('SELECT id FROM employees WHERE id=?').get(req.params.id))
    return res.status(404).json({ error: 'Employee not found', code: 404 });
  if (!req.file) return res.status(400).json({ error: 'No file provided', code: 400 });

  const docId = uuidv4();
  db.prepare('INSERT INTO documents (id,employee_id,filename,original_name,mime_type,size) VALUES (?,?,?,?,?,?)').run(
    docId, req.params.id, req.file.filename, req.file.originalname, req.file.mimetype, req.file.size
  );
  auditLog(req.user.id, 'UPLOAD', 'document', { employee_id: req.params.id, file: req.file.originalname }, req.ip);
  res.status(201).json({
    message: 'File uploaded to R2 storage',
    document: { id: docId, filename: req.file.filename, original_name: req.file.originalname, size: req.file.size, r2_key: `employees/${req.params.id}/${req.file.filename}`, url: `/uploads/${req.file.filename}` }
  });
});

// Serve uploaded files
app.use('/uploads', express.static(uploadDir));

// ═══════════════════════════════════════════════════════════════════════════════
//  AI CHAT ROUTES
// ═══════════════════════════════════════════════════════════════════════════════
const AI_RESPONSES = {
  leave:      'You have 14 annual leave days remaining. You can apply for leave through the HR portal. Manager approval is required at least 2 weeks in advance for planned leaves.',
  salary:     'Salary information is confidential. For salary-related queries, contact HR at hr@company.com or visit the Compensation section in the HR portal.',
  benefit:    'Employee benefits include: health insurance, dental coverage, 14 annual leave days, 10 sick days, flexible working hours, remote work options (3 days/week), and $2,000 annual professional development budget.',
  department: 'Our company has 6 departments: Engineering, Sales, Marketing, HR, Finance, and Operations. Each has a dedicated manager and team.',
  employee:   'We currently have 8 active employees across all departments. The complete directory is available in the Employees section.',
  policy:     'Company policies are in the HR Handbook: Code of Conduct, Remote Work Policy, Information Security Policy, and Expense Policy. Access via the HR portal.',
  overtime:   'Overtime is paid at 1.5× your regular rate. It must be pre-approved by your manager and logged in the timesheet system.',
  training:   'Training programs include technical certifications, leadership development, and soft skills workshops. Contact HR for enrollment.',
  password:   'To reset your password, click "Forgot Password" on the login page or contact IT support at it@company.com.',
  holiday:    'There are 12 public holidays per year. The holiday calendar is published in the HR portal at the start of each year.',
  remote:     'Our remote work policy allows up to 3 days per week from home. Discuss your schedule with your manager. Core hours are 10am–3pm in your local timezone.',
};

app.post('/api/v1/chat', authenticateToken, (req, res) => {
  const { question } = req.body;
  if (!question || !question.trim())
    return res.status(400).json({ error: 'Question is required', code: 400 });

  const q = question.toLowerCase();
  let answer = `Thank you for your question: "${question}". Based on our knowledge base, I can assist with leave policies, benefits, HR procedures, department info, and company policies. For account-specific queries, contact HR at hr@company.com or call +1-800-COMPANY.`;

  for (const [key, resp] of Object.entries(AI_RESPONSES)) {
    if (q.includes(key)) { answer = resp; break; }
  }

  const id = uuidv4();
  db.prepare('INSERT INTO conversations (id,user_id,question,answer) VALUES (?,?,?,?)').run(id, req.user.id, question, answer);
  res.json({ id, question, answer, model: 'ems-ai-v1', timestamp: new Date().toISOString() });
});

app.get('/api/v1/chat/history', authenticateToken, (req, res) => {
  const { page = 1, limit = 50 } = req.query;
  const offset = (page-1) * limit;
  const data = db.prepare(`
    SELECT c.*, u.name as user_name, u.email as user_email
    FROM conversations c JOIN users u ON c.user_id = u.id
    WHERE c.user_id = ? ORDER BY c.created_at DESC LIMIT ? OFFSET ?
  `).all(req.user.id, +limit, offset);
  const total = db.prepare('SELECT COUNT(*) as c FROM conversations WHERE user_id=?').get(req.user.id).c;
  res.json({ data, total });
});

// ═══════════════════════════════════════════════════════════════════════════════
//  DASHBOARD & ADMIN ROUTES
// ═══════════════════════════════════════════════════════════════════════════════
app.get('/api/v1/dashboard/stats', authenticateToken, cacheMiddleware(30), (req, res) => {
  res.json({
    stats: {
      totalEmployees:   db.prepare("SELECT COUNT(*) as c FROM employees").get().c,
      activeEmployees:  db.prepare("SELECT COUNT(*) as c FROM employees WHERE status='active'").get().c,
      departments:      db.prepare("SELECT COUNT(DISTINCT department) as c FROM employees").get().c,
      totalConversations: db.prepare("SELECT COUNT(*) as c FROM conversations").get().c,
      auditEvents:      db.prepare("SELECT COUNT(*) as c FROM audit_logs").get().c,
      documents:        db.prepare("SELECT COUNT(*) as c FROM documents").get().c
    },
    recentEmployees:  db.prepare("SELECT name,department,position,status,created_at FROM employees ORDER BY created_at DESC LIMIT 5").all(),
    departmentStats:  db.prepare("SELECT department, COUNT(*) as count, AVG(salary) as avg_salary FROM employees GROUP BY department").all(),
    recentActivity:   db.prepare("SELECT a.*, u.name as user_name FROM audit_logs a LEFT JOIN users u ON a.user_id=u.id ORDER BY a.created_at DESC LIMIT 10").all()
  });
});

app.get('/api/v1/audit-logs', authenticateToken, requireAdmin, (req, res) => {
  const logs = db.prepare(`
    SELECT a.*, u.name as user_name, u.email as user_email
    FROM audit_logs a LEFT JOIN users u ON a.user_id=u.id
    ORDER BY a.created_at DESC LIMIT 200
  `).all();
  res.json({ data: logs });
});

app.get('/api/v1/departments', authenticateToken, (req, res) => {
  res.json({ data: db.prepare('SELECT DISTINCT department FROM employees ORDER BY department').all().map(d => d.department) });
});

// ═══════════════════════════════════════════════════════════════════════════════
//  HEALTH ENDPOINT
// ═══════════════════════════════════════════════════════════════════════════════
app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    service: 'Employee Management System API',
    version: '1.0.0',
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV || 'development',
    uptime: `${Math.floor(process.uptime())}s`,
    database: 'connected (SQLite)',
    storage: 'local (R2 in production)',
    auth: 'JWT (HS256)',
    rateLimit: '100 req/min',
    caching: 'edge-cache enabled',
    counts: {
      employees: db.prepare('SELECT COUNT(*) as c FROM employees').get().c,
      users:     db.prepare('SELECT COUNT(*) as c FROM users').get().c,
      conversations: db.prepare('SELECT COUNT(*) as c FROM conversations').get().c
    },
    memory: process.memoryUsage()
  });
});

// ─── Frontend ──────────────────────────────────────────────────────────────────
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

// ─── Error Handlers ────────────────────────────────────────────────────────────
app.use((err, req, res, next) => {
  if (err.code === 'LIMIT_FILE_SIZE')
    return res.status(400).json({ error: 'File too large (max 10MB)', code: 400 });
  console.error(err.stack);
  res.status(500).json({ error: 'Internal server error', code: 500 });
});

app.use((req, res) => res.status(404).json({ error: `Endpoint ${req.method} ${req.path} not found`, code: 404 }));

// ─── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log('');
  console.log('  ╔══════════════════════════════════════════════════╗');
  console.log('  ║   Employee Management System — Server Started    ║');
  console.log('  ╠══════════════════════════════════════════════════╣');
  console.log(`  ║  Dashboard  : http://localhost:${PORT}               ║`);
  console.log(`  ║  API        : http://localhost:${PORT}/api/v1         ║`);
  console.log(`  ║  Health     : http://localhost:${PORT}/health          ║`);
  console.log('  ╠══════════════════════════════════════════════════╣');
  console.log('  ║  Admin Login  : admin@company.com / Admin@123    ║');
  console.log('  ╚══════════════════════════════════════════════════╝');
  console.log('');
});

module.exports = app;
