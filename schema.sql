-- ═══════════════════════════════════════════════════════════════
--  EMS Database Schema
--  Compatible with: SQLite (local), Cloudflare D1 (production)
-- ═══════════════════════════════════════════════════════════════

-- Users (authentication)
CREATE TABLE IF NOT EXISTS users (
  id         TEXT PRIMARY KEY,
  email      TEXT UNIQUE NOT NULL,
  password   TEXT NOT NULL,
  name       TEXT NOT NULL,
  role       TEXT DEFAULT 'user',      -- 'admin' | 'user'
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Employees (core entity)
CREATE TABLE IF NOT EXISTS employees (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  email       TEXT UNIQUE NOT NULL,
  department  TEXT NOT NULL,
  position    TEXT,
  salary      REAL,
  phone       TEXT,
  hire_date   TEXT,
  status      TEXT DEFAULT 'active',   -- 'active' | 'inactive'
  created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at  DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Departments
CREATE TABLE IF NOT EXISTS departments (
  id      TEXT PRIMARY KEY,
  name    TEXT UNIQUE NOT NULL,
  manager TEXT
);

-- AI Conversation History (Question 2A)
CREATE TABLE IF NOT EXISTS conversations (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  question   TEXT NOT NULL,
  answer     TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

-- Documents (R2 metadata — Question 2C)
CREATE TABLE IF NOT EXISTS documents (
  id            TEXT PRIMARY KEY,
  employee_id   TEXT NOT NULL,
  filename      TEXT NOT NULL,           -- R2 object key
  original_name TEXT NOT NULL,
  mime_type     TEXT,
  size          INTEGER,
  uploaded_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (employee_id) REFERENCES employees(id)
);

-- Audit Logs (security tracking)
CREATE TABLE IF NOT EXISTS audit_logs (
  id         TEXT PRIMARY KEY,
  user_id    TEXT,
  action     TEXT NOT NULL,             -- 'CREATE' | 'UPDATE' | 'DELETE' | 'LOGIN' | 'UPLOAD'
  resource   TEXT,
  details    TEXT,                      -- JSON
  ip         TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- ─── Indexes ──────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_employees_email      ON employees(email);
CREATE INDEX IF NOT EXISTS idx_employees_department ON employees(department);
CREATE INDEX IF NOT EXISTS idx_employees_status     ON employees(status);
CREATE INDEX IF NOT EXISTS idx_conversations_user   ON conversations(user_id);
CREATE INDEX IF NOT EXISTS idx_documents_employee   ON documents(employee_id);
CREATE INDEX IF NOT EXISTS idx_audit_user           ON audit_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_audit_created        ON audit_logs(created_at);

-- ─── Seed Admin User ──────────────────────────────────────────────────────────
-- Password: Admin@123 (bcrypt hash — use real hash in production)
INSERT OR IGNORE INTO users (id, email, password, name, role)
VALUES ('admin-001', 'admin@company.com', 'Admin@123', 'System Administrator', 'admin');

-- ─── Seed Departments ─────────────────────────────────────────────────────────
INSERT OR IGNORE INTO departments (id, name) VALUES
  ('dept-001', 'Engineering'),
  ('dept-002', 'Sales'),
  ('dept-003', 'Marketing'),
  ('dept-004', 'HR'),
  ('dept-005', 'Finance'),
  ('dept-006', 'Operations');
