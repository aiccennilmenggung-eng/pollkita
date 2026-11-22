const app = document.getElementById('app');

// ---------- Helper ----------
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (v !== false && v != null) el.setAttribute(k, v);
  }
    for (const c of children.flat()) {
    if (c === false || c == null) continue;
    el.append(c instanceof Node ? c : document.createTextNode(c));
  }
  return el;
}

async function api(url, opts = {}) {
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Terjadi kesalahan.');
  return data;
}

function timeAgo(ts) {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return 'baru saja';
  if (s < 3600) return `${Math.floor(s / 60)} menit lalu`;
  if (s < 86400) return `${Math.floor(s / 3600)} jam lalu`;
  return `${Math.floor(s / 86400)} hari lalu`;
}


// ---------- Tampilan: buat polling ----------
function renderCreate() {
  const optionInputs = [];
  const optionsBox = h('div');
  const errorBox = h('div', { class: 'error' });

  function addOption(value = '') {
    if (optionInputs.length >= 10) return;
    const input = h('input', {
      type: 'text',
      placeholder: `Pilihan ${optionInputs.length + 1}`,
      maxlength: 100,
      value,
    });
    optionInputs.push(input);
    optionsBox.append(input);
  }

  const question = h('input', {
    type: 'text',
    placeholder: 'Contoh: Makan siang enaknya apa?',
    maxlength: 200,
  });
  addOption();
  addOption();

  const form = h(
    'form',
    {
      class: 'card',
      onsubmit: async (e) => {
        e.preventDefault();
        errorBox.textContent = '';
        try {
          const poll = await api('/api/polls', {
            method: 'POST',
            body: { question: question.value, options: optionInputs.map((i) => i.value) },
          });
          location.hash = `#/poll/${poll.id}`;
        } catch (err) {
          errorBox.textContent = err.message;
        }
      },
    },
    h('h2', {}, 'Buat Polling Baru'),
    h('p', { class: 'meta' }, 'Tulis pertanyaan, tambahkan pilihan, lalu bagikan tautannya ke teman-temanmu.'),
    h('label', {}, 'Pertanyaan'),
    question,
    h('label', {}, 'Pilihan jawaban (2-10)'),
    optionsBox,
    h('div', { class: 'row' },
      h('button', { type: 'button', class: 'secondary', onclick: () => addOption() }, '+ Tambah pilihan'),
      h('button', { type: 'submit' }, 'Buat Polling')
    ),
    errorBox
  );
  app.replaceChildren(form);
}

// ---------- Tampilan: detail polling ----------
async function renderPoll(id) {
  let p;
  try {
    p = await api(`/api/polls/${id}`);
  } catch (err) {
    app.replaceChildren(h('div', { class: 'card' }, err.message, h('p', {}, h('a', { href: '#/' }, '← Buat polling baru'))));
    return;
  }

  const showResults = p.myVote || p.closed;
  const errorBox = h('div', { class: 'error' });

  async function vote(optionId) {
    try {
      await api(`/api/polls/${id}/vote`, { method: 'POST', body: { optionId } });
      renderPoll(id);
    } catch (err) {
      errorBox.textContent = err.message;
    }
  }

  const optionEls = p.options.map((o) => {
    const pct = p.total ? Math.round((o.votes / p.total) * 100) : 0;
    if (showResults) {
      return h(
        'div',
        { class: o.id === p.myVote ? 'option mine' : 'option' },
        h('div', { class: 'bar', style: `width:${pct}%` }),
        h('div', { class: 'label' },
          h('span', {}, o.text + (o.id === p.myVote ? ' ✓' : '')),
          h('span', {}, `${o.votes} (${pct}%)`)
        )
      );
    }
    return h('button', { class: 'option', onclick: () => vote(o.id) }, h('div', { class: 'label' }, h('span', {}, o.text)));
  });

  const shareBtn = h('button', {
    class: 'secondary',
    onclick: async (e) => {
      try {
        await navigator.clipboard.writeText(location.href);
        e.target.textContent = 'Tautan disalin ✓';
      } catch {
        prompt('Salin tautan ini:', location.href);
      }
    },
  }, 'Bagikan tautan');

  const ownerBtns = p.isOwner
    ? [
        !p.closed &&
          h('button', {
            class: 'secondary',
            onclick: async () => {
              if (confirm('Tutup polling ini? Orang tidak bisa memberi suara lagi.')) {
                await api(`/api/polls/${id}/close`, { method: 'POST' });
                renderPoll(id);
              }
            },
          }, 'Tutup polling'),
        h('button', {
          class: 'danger',
          onclick: async () => {
            if (confirm('Hapus polling ini secara permanen?')) {
              await api(`/api/polls/${id}`, { method: 'DELETE' });
              location.hash = '#/';
            }
          },
        }, 'Hapus'),
      ]
    : [];

  app.replaceChildren(
    h('p', {}, h('a', { href: '#/' }, '← Buat polling baru')),
    h('div', { class: 'card' },
      h('h2', {}, p.question),
      h('div', { class: 'meta' },
        `${p.total} suara · ${timeAgo(p.createdAt)} `,
        h('span', { class: p.closed ? 'badge closed' : 'badge' }, p.closed ? 'Ditutup' : 'Aktif')
      ),
      h('div', { style: 'margin-top:14px' }, optionEls),
      !showResults && h('div', { class: 'meta' }, 'Pilih salah satu untuk memberi suara dan melihat hasil.'),
      errorBox,
      h('div', { class: 'row' }, shareBtn, ownerBtns)
    )
  );
}

// ---------- Router ----------
function route() {
  const m = /^#\/poll\/([a-f0-9]+)$/.exec(location.hash || '');
  if (m) return renderPoll(m[1]);
  return renderCreate();
}
window.addEventListener('hashchange', route);
route();

// ---------- Real-time: perbarui otomatis saat ada suara baru ----------
const events = new EventSource('/api/events');
events.onmessage = (e) => {
  const { pollId } = JSON.parse(e.data);
  if (location.hash === `#/poll/${pollId}`) route();
};
