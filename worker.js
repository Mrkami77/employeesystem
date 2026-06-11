/**
 * Cloudflare Worker — EMS Edge API Gateway
 *
 * Features:
 *   - JWT Authentication middleware (HS256, Web Crypto API)
 *   - CRUD endpoints backed by D1 database
 *   - R2 for employee document storage
 *   - Rate limiting per IP using KV
 *   - GET response caching at the edge (caches.default)
 *   - Proper HTTP status codes + JSON error messages
 *   - /health endpoint with request analytics
 *   - CORS headers
 *
 * Bindings required (wrangler.toml):
 *   DB    → D1 database
 *   R2    → R2 bucket
 *   KV    → KV namespace (rate limiting)
 */

const JWT_SECRET = 'ems-cloudflare-jwt-secret-2024';
const RATE_LIMIT  = 100;   // requests per window
const RATE_WINDOW = 60;    // seconds

// ─── Main Entry Point ──────────────────────────────────────────────────────────
export default {
  async fetch(request, env, ctx) {
    const url    = new URL(request.url);
    const path   = url.pathname;
    const method = request.method;

    // Standard CORS headers
    const CORS = {
      'Access-Control-Allow-Origin':  '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Max-Age':       '86400',
    };

    // Handle preflight
    if (method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }

    // ─── Rate Limiting ───────────────────────────────────────────────────────
    const clientIP  = request.headers.get('CF-Connecting-IP') || request.headers.get('X-Forwarded-For') || '0.0.0.0';
    const rlKey     = `rl:${clientIP}`;
    let   rlCount   = 0;

    try {
      const stored = await env.KV?.get(rlKey);
      rlCount = stored ? parseInt(stored) : 0;
      if (rlCount >= RATE_LIMIT) {
        return jsonResponse({
          error:      'Rate limit exceeded',
          code:       429,
          limit:      RATE_LIMIT,
          window:     `${RATE_WINDOW}s`,
          retryAfter: RATE_WINDOW,
        }, 429, { ...CORS, 'X-RateLimit-Limit': String(RATE_LIMIT), 'X-RateLimit-Remaining': '0', 'Retry-After': String(RATE_WINDOW) });
      }
      ctx.waitUntil(env.KV?.put(rlKey, String(rlCount + 1), { expirationTtl: RATE_WINDOW }));
    } catch { /* KV unavailable — allow request */ }

    const rlHeaders = {
      'X-RateLimit-Limit':     String(RATE_LIMIT),
      'X-RateLimit-Remaining': String(Math.max(0, RATE_LIMIT - rlCount - 1)),
    };

    // ─── Health (public) ─────────────────────────────────────────────────────
    if (path === '/health' && method === 'GET') {
      let empCount = 0;
      try { const r = await env.DB?.prepare('SELECT COUNT(*) as c FROM employees').first(); empCount = r?.c || 0; } catch {}
      return jsonResponse({
        status:      'healthy',
        service:     'EMS Edge API',
        version:     '1.0.0',
        timestamp:   new Date().toISOString(),
        region:      request.cf?.colo || 'unknown',
        edge:        true,
        cf_ray:      request.headers.get('CF-Ray') || 'N/A',
        database:    env.DB    ? 'D1 connected'  : 'unavailable',
        storage:     env.R2    ? 'R2 connected'  : 'unavailable',
        rateLimit:   env.KV    ? 'KV active'     : 'unavailable',
        employees:   empCount,
        rateLimit_config: `${RATE_LIMIT} req/${RATE_WINDOW}s`,
      }, 200, { ...CORS, ...rlHeaders });
    }

    // ─── Auth Endpoints (public) ─────────────────────────────────────────────
    if (path === '/api/v1/auth/login'    && method === 'POST') return handleLogin(request, env, CORS, rlHeaders);
    if (path === '/api/v1/auth/register' && method === 'POST') return handleRegister(request, env, CORS, rlHeaders);

    // ─── JWT Verification ────────────────────────────────────────────────────
    const authHeader = request.headers.get('Authorization') || '';
    const token      = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;

    if (!token) {
      return jsonResponse({ error: 'Authorization header required', code: 401 }, 401, { ...CORS, ...rlHeaders });
    }

    const user = await verifyJWT(token, JWT_SECRET);
    if (!user) {
      return jsonResponse({ error: 'Invalid or expired JWT token', code: 401 }, 401, { ...CORS, ...rlHeaders });
    }

    // ─── Protected Routes ────────────────────────────────────────────────────

    // GET /api/v1/employees  — with edge cache
    if (path === '/api/v1/employees' && method === 'GET') {
      return handleGetEmployees(request, env, ctx, CORS, rlHeaders);
    }

    // POST /api/v1/employees
    if (path === '/api/v1/employees' && method === 'POST') {
      return handleCreateEmployee(request, env, CORS, rlHeaders, user);
    }

    // /api/v1/employees/:id
    const empMatch = path.match(/^\/api\/v1\/employees\/([^/]+)$/);
    if (empMatch) {
      const id = empMatch[1];
      if (method === 'GET')    return handleGetEmployee(id, env, CORS, rlHeaders);
      if (method === 'PUT')    return handleUpdateEmployee(id, request, env, CORS, rlHeaders, user);
      if (method === 'DELETE') return handleDeleteEmployee(id, env, CORS, rlHeaders, user);
    }

    // POST /api/v1/employees/:id/documents  (R2 upload)
    const docMatch = path.match(/^\/api\/v1\/employees\/([^/]+)\/documents$/);
    if (docMatch && method === 'POST') {
      return handleDocumentUpload(docMatch[1], request, env, CORS, rlHeaders, user);
    }

    // GET  /api/v1/employees/:id/documents/:key  (R2 download)
    const dlMatch = path.match(/^\/api\/v1\/employees\/([^/]+)\/documents\/(.+)$/);
    if (dlMatch && method === 'GET') {
      return handleDocumentDownload(dlMatch[1], dlMatch[2], env, CORS, rlHeaders);
    }

    // AI Chat
    if (path === '/api/v1/chat' && method === 'POST') {
      return handleChat(request, env, CORS, rlHeaders, user);
    }
    if (path === '/api/v1/chat/history' && method === 'GET') {
      return handleChatHistory(env, CORS, rlHeaders, user);
    }

    // Dashboard
    if (path === '/api/v1/dashboard/stats' && method === 'GET') {
      return handleDashboard(env, CORS, rlHeaders);
    }

    return jsonResponse({ error: `Not found: ${method} ${path}`, code: 404 }, 404, { ...CORS, ...rlHeaders });
  }
};

// ═══════════════════════════════════════════════════════════════════════════════
//  JWT  (Web Crypto API — no external dependencies)
// ═══════════════════════════════════════════════════════════════════════════════
async function signJWT(payload, secret) {
  const enc     = new TextEncoder();
  const header  = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body    = b64url(JSON.stringify({ ...payload, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 86400 }));
  const key     = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig     = await crypto.subtle.sign('HMAC', key, enc.encode(`${header}.${body}`));
  return `${header}.${body}.${arrayToB64url(sig)}`;
}

async function verifyJWT(token, secret) {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const payload = JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/')));
    if (payload.exp && Date.now() / 1000 > payload.exp) return null;
    const enc  = new TextEncoder();
    const key  = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
    const sig  = Uint8Array.from(atob(parts[2].replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
    const valid = await crypto.subtle.verify('HMAC', key, sig, enc.encode(`${parts[0]}.${parts[1]}`));
    return valid ? payload : null;
  } catch { return null; }
}

function b64url(str) { return btoa(str).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_'); }
function arrayToB64url(buf) { return btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_'); }

// ═══════════════════════════════════════════════════════════════════════════════
//  AUTH HANDLERS
// ═══════════════════════════════════════════════════════════════════════════════
async function handleLogin(request, env, CORS, rl) {
  let body; try { body = await request.json(); } catch { return jsonResponse({ error: 'Invalid JSON', code: 400 }, 400, { ...CORS, ...rl }); }
  const { email, password } = body;
  if (!email || !password) return jsonResponse({ error: 'Email and password required', code: 400 }, 400, { ...CORS, ...rl });

  let user;
  try { user = await env.DB?.prepare('SELECT * FROM users WHERE email = ?').bind(email).first(); } catch {}

  // Simple password check (production: use bcrypt via a DO or external service)
  if (!user || user.password !== password) {
    return jsonResponse({ error: 'Invalid email or password', code: 401 }, 401, { ...CORS, ...rl });
  }

  const token = await signJWT({ id: user.id, email: user.email, name: user.name, role: user.role }, JWT_SECRET);
  return jsonResponse({ message: 'Login successful', token, user: { id: user.id, email: user.email, name: user.name, role: user.role } }, 200, { ...CORS, ...rl });
}

async function handleRegister(request, env, CORS, rl) {
  let body; try { body = await request.json(); } catch { return jsonResponse({ error: 'Invalid JSON', code: 400 }, 400, { ...CORS, ...rl }); }
  const { email, password, name } = body;
  if (!email || !password || !name) return jsonResponse({ error: 'All fields required', code: 400 }, 400, { ...CORS, ...rl });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return jsonResponse({ error: 'Invalid email format', code: 400 }, 400, { ...CORS, ...rl });

  const id = crypto.randomUUID();
  try {
    await env.DB?.prepare('INSERT INTO users (id, email, password, name, role) VALUES (?, ?, ?, ?, ?)').bind(id, email, password, name, 'user').run();
  } catch { return jsonResponse({ error: 'Email already registered', code: 409 }, 409, { ...CORS, ...rl }); }

  const token = await signJWT({ id, email, name, role: 'user' }, JWT_SECRET);
  return jsonResponse({ message: 'Registered successfully', token, user: { id, email, name, role: 'user' } }, 201, { ...CORS, ...rl });
}

// ═══════════════════════════════════════════════════════════════════════════════
//  EMPLOYEE HANDLERS
// ═══════════════════════════════════════════════════════════════════════════════
async function handleGetEmployees(request, env, ctx, CORS, rl) {
  // Check edge cache
  const cacheKey = new Request(request.url, { headers: { 'cache-control': 'no-transform' } });
  const cache    = caches.default;
  const cached   = await cache.match(cacheKey);

  if (cached) {
    const headers = new Headers(cached.headers);
    Object.entries({ ...CORS, ...rl, 'X-Cache': 'HIT', 'X-Cache-TTL': '60s' }).forEach(([k, v]) => headers.set(k, v));
    return new Response(cached.body, { status: cached.status, headers });
  }

  let result;
  try { result = await env.DB?.prepare('SELECT * FROM employees ORDER BY created_at DESC').all(); } catch { result = { results: [] }; }

  const response = jsonResponse(
    { data: result?.results || [], total: result?.results?.length || 0, source: 'D1', cached: false },
    200,
    { ...CORS, ...rl, 'X-Cache': 'MISS', 'Cache-Control': 'public, max-age=60', 'X-Cache-TTL': '60s' }
  );

  ctx.waitUntil(cache.put(cacheKey, response.clone()));
  return response;
}

async function handleGetEmployee(id, env, CORS, rl) {
  let emp;
  try { emp = await env.DB?.prepare('SELECT * FROM employees WHERE id = ?').bind(id).first(); } catch {}
  if (!emp) return jsonResponse({ error: 'Employee not found', code: 404 }, 404, { ...CORS, ...rl });

  let docs = [];
  try { const r = await env.DB?.prepare('SELECT id, original_name, size, uploaded_at FROM documents WHERE employee_id = ?').bind(id).all(); docs = r?.results || []; } catch {}

  return jsonResponse({ data: { ...emp, documents: docs } }, 200, { ...CORS, ...rl });
}

async function handleCreateEmployee(request, env, CORS, rl, user) {
  if (user.role !== 'admin') return jsonResponse({ error: 'Admin access required', code: 403 }, 403, { ...CORS, ...rl });

  let body; try { body = await request.json(); } catch { return jsonResponse({ error: 'Invalid JSON', code: 400 }, 400, { ...CORS, ...rl }); }
  const { name, email, department, position, salary } = body;

  if (!name || !email || !department) return jsonResponse({ error: 'Name, email, and department are required', code: 400 }, 400, { ...CORS, ...rl });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return jsonResponse({ error: 'Invalid email format', code: 400 }, 400, { ...CORS, ...rl });

  const id = crypto.randomUUID();
  try {
    await env.DB?.prepare('INSERT INTO employees (id, name, email, department, position, salary, hire_date) VALUES (?, ?, ?, ?, ?, ?, ?)').bind(id, name, email, department, position || null, salary || null, new Date().toISOString().split('T')[0]).run();
  } catch { return jsonResponse({ error: 'Email already exists', code: 409 }, 409, { ...CORS, ...rl }); }

  const emp = await env.DB?.prepare('SELECT * FROM employees WHERE id = ?').bind(id).first();
  return jsonResponse({ message: 'Employee created successfully', data: emp }, 201, { ...CORS, ...rl });
}

async function handleUpdateEmployee(id, request, env, CORS, rl, user) {
  if (user.role !== 'admin') return jsonResponse({ error: 'Admin access required', code: 403 }, 403, { ...CORS, ...rl });

  const existing = await env.DB?.prepare('SELECT * FROM employees WHERE id = ?').bind(id).first();
  if (!existing) return jsonResponse({ error: 'Employee not found', code: 404 }, 404, { ...CORS, ...rl });

  let body; try { body = await request.json(); } catch { return jsonResponse({ error: 'Invalid JSON', code: 400 }, 400, { ...CORS, ...rl }); }

  await env.DB?.prepare('UPDATE employees SET name=?, email=?, department=?, position=?, salary=?, updated_at=? WHERE id=?').bind(
    body.name || existing.name, body.email || existing.email,
    body.department || existing.department, body.position || existing.position,
    body.salary !== undefined ? body.salary : existing.salary,
    new Date().toISOString(), id
  ).run();

  const updated = await env.DB?.prepare('SELECT * FROM employees WHERE id = ?').bind(id).first();
  return jsonResponse({ message: 'Employee updated successfully', data: updated }, 200, { ...CORS, ...rl });
}

async function handleDeleteEmployee(id, env, CORS, rl, user) {
  if (user.role !== 'admin') return jsonResponse({ error: 'Admin access required', code: 403 }, 403, { ...CORS, ...rl });

  const emp = await env.DB?.prepare('SELECT * FROM employees WHERE id = ?').bind(id).first();
  if (!emp) return jsonResponse({ error: 'Employee not found', code: 404 }, 404, { ...CORS, ...rl });

  await env.DB?.prepare('DELETE FROM employees WHERE id = ?').bind(id).run();
  return jsonResponse({ message: 'Employee deleted successfully', deleted: { id, name: emp.name } }, 200, { ...CORS, ...rl });
}

// ═══════════════════════════════════════════════════════════════════════════════
//  R2 DOCUMENT HANDLERS
// ═══════════════════════════════════════════════════════════════════════════════
async function handleDocumentUpload(empId, request, env, CORS, rl, user) {
  const emp = await env.DB?.prepare('SELECT id FROM employees WHERE id = ?').bind(empId).first();
  if (!emp) return jsonResponse({ error: 'Employee not found', code: 404 }, 404, { ...CORS, ...rl });

  let formData;
  try { formData = await request.formData(); } catch { return jsonResponse({ error: 'Invalid form data', code: 400 }, 400, { ...CORS, ...rl }); }

  const file = formData.get('file');
  if (!file) return jsonResponse({ error: 'No file provided', code: 400 }, 400, { ...CORS, ...rl });

  const allowedTypes = ['application/pdf', 'image/jpeg', 'image/png', 'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document'];
  if (!allowedTypes.includes(file.type)) {
    return jsonResponse({ error: 'File type not allowed. Use PDF, DOCX, JPG, or PNG.', code: 400 }, 400, { ...CORS, ...rl });
  }

  const docId = crypto.randomUUID();
  const r2Key = `employees/${empId}/${docId}-${file.name}`;

  try {
    await env.R2?.put(r2Key, file.stream(), {
      httpMetadata:   { contentType: file.type, contentDisposition: `attachment; filename="${file.name}"` },
      customMetadata: { employeeId: empId, originalName: file.name, uploadedBy: user.id },
    });

    await env.DB?.prepare('INSERT INTO documents (id, employee_id, filename, original_name, mime_type, size) VALUES (?, ?, ?, ?, ?, ?)').bind(docId, empId, r2Key, file.name, file.type, file.size).run();
  } catch (e) {
    return jsonResponse({ error: 'Upload failed', detail: e.message, code: 500 }, 500, { ...CORS, ...rl });
  }

  return jsonResponse({
    message:  'File uploaded to R2 successfully',
    document: { id: docId, r2_key: r2Key, original_name: file.name, size: file.size, type: file.type,
      download_url: `/api/v1/employees/${empId}/documents/${docId}` }
  }, 201, { ...CORS, ...rl });
}

async function handleDocumentDownload(empId, docId, env, CORS, rl) {
  let doc;
  try { doc = await env.DB?.prepare('SELECT * FROM documents WHERE id = ? AND employee_id = ?').bind(docId, empId).first(); } catch {}
  if (!doc) return jsonResponse({ error: 'Document not found', code: 404 }, 404, { ...CORS, ...rl });

  const obj = await env.R2?.get(doc.filename);
  if (!obj) return jsonResponse({ error: 'File not found in R2', code: 404 }, 404, { ...CORS, ...rl });

  return new Response(obj.body, {
    headers: { ...CORS, 'Content-Type': doc.mime_type || 'application/octet-stream', 'Content-Disposition': `attachment; filename="${doc.original_name}"` }
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
//  AI CHAT
// ═══════════════════════════════════════════════════════════════════════════════
async function handleChat(request, env, CORS, rl, user) {
  let body; try { body = await request.json(); } catch { return jsonResponse({ error: 'Invalid JSON', code: 400 }, 400, { ...CORS, ...rl }); }
  const { question } = body;
  if (!question) return jsonResponse({ error: 'Question is required', code: 400 }, 400, { ...CORS, ...rl });

  const KB = {
    leave:    'You have 14 annual leave days remaining. Apply through the HR portal with 2 weeks advance notice.',
    salary:   'Salary details are confidential. Contact HR at hr@company.com for salary-related queries.',
    benefit:  'Benefits: health insurance, dental, 14 annual leave, 10 sick days, remote work (3 days/wk), $2k training budget.',
    policy:   'Company policies are in the HR Handbook: Code of Conduct, Remote Work, Security, and Expense policies.',
    overtime: 'Overtime is paid at 1.5x. Requires manager pre-approval and must be logged in the timesheet system.',
    remote:   'Up to 3 remote days/week. Core hours: 10am–3pm local time. Discuss schedule with your manager.',
  };

  const q = question.toLowerCase();
  let answer = `Thank you for your question about "${question}". I'm the EMS AI running on Cloudflare Workers at the edge. For specific queries, contact HR at hr@company.com.`;
  for (const [key, resp] of Object.entries(KB)) { if (q.includes(key)) { answer = resp; break; } }

  const id = crypto.randomUUID();
  try { await env.DB?.prepare('INSERT INTO conversations (id, user_id, question, answer) VALUES (?, ?, ?, ?)').bind(id, user.id, question, answer).run(); } catch {}

  return jsonResponse({ id, question, answer, model: 'ems-edge-ai-v1', timestamp: new Date().toISOString(), processed_at: request.cf?.colo || 'edge' }, 200, { ...CORS, ...rl });
}

async function handleChatHistory(env, CORS, rl, user) {
  let data = [];
  try { const r = await env.DB?.prepare('SELECT * FROM conversations WHERE user_id = ? ORDER BY created_at DESC LIMIT 50').bind(user.id).all(); data = r?.results || []; } catch {}
  return jsonResponse({ data, total: data.length }, 200, { ...CORS, ...rl });
}

async function handleDashboard(env, CORS, rl) {
  try {
    const [total, active, depts, convs] = await Promise.all([
      env.DB?.prepare('SELECT COUNT(*) as c FROM employees').first(),
      env.DB?.prepare("SELECT COUNT(*) as c FROM employees WHERE status='active'").first(),
      env.DB?.prepare('SELECT COUNT(DISTINCT department) as c FROM employees').first(),
      env.DB?.prepare('SELECT COUNT(*) as c FROM conversations').first(),
    ]);
    return jsonResponse({ stats: { totalEmployees: total?.c||0, activeEmployees: active?.c||0, departments: depts?.c||0, conversations: convs?.c||0 } }, 200, { ...CORS, ...rl });
  } catch { return jsonResponse({ error: 'Database error', code: 500 }, 500, { ...CORS, ...rl }); }
}

// ─── Utility ───────────────────────────────────────────────────────────────────
function jsonResponse(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers }
  });
}
