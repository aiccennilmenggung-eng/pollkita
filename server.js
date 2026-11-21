// Server polling multi-user - hanya memakai modul bawaan Node.js (tanpa npm install)
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'data.json');
const PUBLIC_DIR = path.join(__dirname, 'public');

// ---------- Penyimpanan sederhana (file JSON) ----------
let db = { polls: [] };
try {
  db = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
} catch {
  /* file belum ada, mulai dari kosong */
}

function save() {
  const tmp = DATA_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, DATA_FILE);
}

// ---------- Helper ----------
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
};

function send(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 10 * 1024) {
        reject(new Error('too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(new Error('bad json'));
      }
    });
  });
}

function view(p, vid) {
  const total = p.options.reduce((s, o) => s + o.votes, 0);
  return {
    id: p.id,
    question: p.question,
    closed: p.closed,
    createdAt: p.createdAt,
    total,
    options: p.options.map((o) => ({ id: o.id, text: o.text, votes: o.votes })),
    myVote: p.voters[vid] || null,
    isOwner: p.owner === vid,
  };
}

const findPoll = (id) => db.polls.find((p) => p.id === id);

// ---------- Real-time (Server-Sent Events) ----------
const clients = new Set();

function broadcast(pollId) {
  const msg = `data: ${JSON.stringify({ pollId })}\n\n`;
  for (const c of clients) c.write(msg);
}

setInterval(() => {
  for (const c of clients) c.write(': ping\n\n');
}, 25000);

// ---------- Handler API ----------
async function handleApi(req, res, pathname, vid) {
  const method = req.method;

  // Stream real-time
  if (method === 'GET' && pathname === '/api/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.write(': connected\n\n');
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }

  // Buat polling
  if (method === 'POST' && pathname === '/api/polls') {
    let body;
    try { body = await readBody(req); } catch { return send(res, 400, { error: 'Data tidak valid.' }); }

    const question = String(body.question || '').trim();
    const options = (Array.isArray(body.options) ? body.options : [])
      .map((o) => String(o || '').trim())
      .filter(Boolean);

    if (question.length < 3 || question.length > 200)
      return send(res, 400, { error: 'Pertanyaan harus 3-200 karakter.' });
    if (options.length < 2 || options.length > 10)
      return send(res, 400, { error: 'Isi 2 sampai 10 pilihan.' });
    if (options.some((o) => o.length > 100))
      return send(res, 400, { error: 'Setiap pilihan maksimal 100 karakter.' });
    if (new Set(options.map((o) => o.toLowerCase())).size !== options.length)
      return send(res, 400, { error: 'Pilihan tidak boleh sama.' });

    // Kata kunci buatan pengguna (opsional)
    const slug = String(body.slug || '').trim();
    let id;
    if (slug) {
      if (!/^[a-z0-9-]{3,40}$/.test(slug))
        return send(res, 400, { error: 'Kata kunci 3-40 karakter: huruf kecil, angka, tanda hubung.' });
      if (findPoll(slug))
        return send(res, 409, { error: 'Kata kunci sudah dipakai, coba yang lain.' });
      id = slug;
    } else {
      do {
        id = crypto.randomBytes(4).toString('hex');
      } while (findPoll(id));
    }


    const poll = {
      id,
      question,
      options: options.map((text, i) => ({ id: i + 1, text, votes: 0 })),
      voters: {}, // { vid: optionId }
      owner: vid,
      closed: false,
      createdAt: Date.now(),
    };
    db.polls.push(poll);
    save();
    broadcast(poll.id);
    return send(res, 201, view(poll, vid));
  }

  // Rute dengan id: /api/polls/:id[/aksi]
  const m = /^\/api\/polls\/([a-z0-9-]+)(?:\/(vote|close))?$/.exec(pathname);
  if (!m) return send(res, 404, { error: 'Tidak ditemukan.' });
  const p = findPoll(m[1]);
  if (!p) return send(res, 404, { error: 'Polling tidak ditemukan.' });
  const action = m[2];

  // Detail polling
  if (method === 'GET' && !action) return send(res, 200, view(p, vid));

  // Memberi suara
  if (method === 'POST' && action === 'vote') {
    let body;
    try { body = await readBody(req); } catch { return send(res, 400, { error: 'Data tidak valid.' }); }
    if (p.closed) return send(res, 409, { error: 'Polling sudah ditutup.' });
    if (p.voters[vid]) return send(res, 409, { error: 'Kamu sudah memberi suara.' });
    const opt = p.options.find((o) => o.id === Number(body.optionId));
    if (!opt) return send(res, 400, { error: 'Pilihan tidak valid.' });
    opt.votes += 1;
    p.voters[vid] = opt.id;
    save();
    broadcast(p.id);
    return send(res, 200, view(p, vid));
  }

  // Tutup polling (hanya pembuat)
  if (method === 'POST' && action === 'close') {
    if (p.owner !== vid) return send(res, 403, { error: 'Hanya pembuat yang boleh menutup.' });
    p.closed = true;
    save();
    broadcast(p.id);
    return send(res, 200, view(p, vid));
  }

  // Hapus polling (hanya pembuat)
  if (method === 'DELETE' && !action) {
    if (p.owner !== vid) return send(res, 403, { error: 'Hanya pembuat yang boleh menghapus.' });
    db.polls = db.polls.filter((x) => x.id !== p.id);
    save();
    broadcast(p.id);
    return send(res, 200, { ok: true });
  }

  return send(res, 405, { error: 'Metode tidak didukung.' });
}

// ---------- Server ----------
const server = http.createServer(async (req, res) => {
  // Identitas pemilih: cookie "vid" (satu browser = satu pemilih)
  const cm = /(?:^|;\s*)vid=([a-f0-9-]{36})/.exec(req.headers.cookie || '');
  let vid = cm && cm[1];
  if (!vid) {
    vid = crypto.randomUUID();
    res.setHeader('Set-Cookie', `vid=${vid}; Path=/; Max-Age=31536000; HttpOnly; SameSite=Lax`);
  }

  const { pathname } = new URL(req.url, 'http://localhost');

  try {
    if (pathname.startsWith('/api/')) return await handleApi(req, res, pathname, vid);

    // File statis dari folder public/
    const rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
    const file = path.join(PUBLIC_DIR, rel);
    if (!file.startsWith(PUBLIC_DIR + path.sep)) {
      res.writeHead(403);
      return res.end('Forbidden');
    }
    fs.readFile(file, (err, content) => {
      if (err) {
        res.writeHead(404);
        return res.end('Not found');
      }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
      res.end(content);
    });
  } catch (err) {
    console.error(err);
    if (!res.headersSent) send(res, 500, { error: 'Kesalahan server.' });
  }
});

server.listen(PORT, () => {
  console.log(`Polling berjalan di http://localhost:${PORT}`);
});
