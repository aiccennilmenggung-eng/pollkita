import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import { getAuth, onAuthStateChanged, signInAnonymously } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';
import {
  getFirestore, doc, collection, setDoc, deleteDoc, updateDoc, getDocs, onSnapshot, serverTimestamp, writeBatch,
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';
import { firebaseConfig } from './firebase-config.js';

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

function timeAgo(ts) {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return 'baru saja';
  if (s < 3600) return `${Math.floor(s / 60)} menit lalu`;
  if (s < 86400) return `${Math.floor(s / 3600)} jam lalu`;
  return `${Math.floor(s / 86400)} hari lalu`;
}

function randomId() {
  const b = crypto.getRandomValues(new Uint8Array(4));
  return [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
}

// ---------- Firebase ----------
const fb = initializeApp(firebaseConfig);
const auth = getAuth(fb);
const db = getFirestore(fb);
let uid = null;
let unsubscribers = [];

function stopListening() {
  unsubscribers.forEach((u) => u());
  unsubscribers = [];
}

function waitForUser() {
  return new Promise((resolve, reject) => {
    const off = onAuthStateChanged(auth, (user) => {
      if (user) { off(); resolve(user.uid); }
    });
    if (!auth.currentUser) signInAnonymously(auth).catch(reject);
  });
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
        const q = question.value.trim();
        const options = optionInputs.map((i) => i.value.trim()).filter(Boolean);
        if (q.length < 3 || q.length > 200) return (errorBox.textContent = 'Pertanyaan harus 3-200 karakter.');
        if (options.length < 2 || options.length > 10) return (errorBox.textContent = 'Isi 2 sampai 10 pilihan.');
        if (options.some((o) => o.length > 100)) return (errorBox.textContent = 'Setiap pilihan maksimal 100 karakter.');
        if (new Set(options.map((o) => o.toLowerCase())).size !== options.length)
          return (errorBox.textContent = 'Pilihan tidak boleh sama.');
        try {
          const id = randomId();
          await setDoc(doc(db, 'polls', id), {
            question: q,
            options,
            ownerUid: uid,
            closed: false,
            createdAt: serverTimestamp(),
          });
          location.hash = `#/poll/${id}`;
        } catch (err) {
          console.error(err);
          errorBox.textContent = 'Gagal membuat polling. Coba lagi.';
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

// ---------- Tampilan: detail polling (real-time) ----------
function renderPoll(id) {
  app.replaceChildren(h('div', { class: 'card' }, 'Memuat…'));
  let poll = null;      // data dokumen polling
  let votes = [];       // [{uid, choice}]
  let gotPoll = false;
  let gotVotes = false;
  const errorBox = h('div', { class: 'error' });

  const notFound = () =>
    app.replaceChildren(h('div', { class: 'card' }, 'Polling tidak ditemukan.', h('p', {}, h('a', { href: '#/' }, '← Buat polling baru'))));

  function draw() {
    if (!gotPoll || !gotVotes) return;
    if (!poll) return notFound();

    const total = votes.length;
    const counts = poll.options.map((_, i) => votes.filter((v) => v.choice === i).length);
    const mine = votes.find((v) => v.uid === uid);
    const myVote = mine ? mine.choice : null;
    const showResults = myVote !== null || poll.closed;
    const isOwner = poll.ownerUid === uid;

    const optionEls = poll.options.map((text, i) => {
      const pct = total ? Math.round((counts[i] / total) * 100) : 0;
      if (showResults) {
        return h('div', { class: i === myVote ? 'option mine' : 'option' },
          h('div', { class: 'bar', style: `width:${pct}%` }),
          h('div', { class: 'label' },
            h('span', {}, text + (i === myVote ? ' ✓' : '')),
            h('span', {}, `${counts[i]} (${pct}%)`)));
      }
      return h('button', {
        class: 'option',
        onclick: async () => {
          try {
            await setDoc(doc(db, 'polls', id, 'votes', uid), { choice: i });
          } catch (err) {
            console.error(err);
            errorBox.textContent = 'Gagal memberi suara. Polling mungkin sudah ditutup.';
          }
        },
      }, h('div', { class: 'label' }, h('span', {}, text)));
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

    const waBtn = h('a', {
      class: 'btn secondary',
      href: 'https://wa.me/?text=' + encodeURIComponent('Ayo ikut polling: "' + poll.question + '"\n' + location.href),
      target: '_blank',
      rel: 'noopener',
    }, 'Bagikan ke WhatsApp');
    const ownerBtns = isOwner? [
          !poll.closed && h('button', {
            class: 'secondary',
            onclick: async () => {
              if (confirm('Tutup polling ini? Orang tidak bisa memberi suara lagi.')) {
                try { await updateDoc(doc(db, 'polls', id), { closed: true }); }
                catch (err) { console.error(err); errorBox.textContent = 'Gagal menutup polling.'; }
              }
            },
          }, 'Tutup polling'),
          h('button', {
            class: 'danger',
            onclick: async () => {
              if (!confirm('Hapus polling ini secara permanen?')) return;
              try {
                const batch = writeBatch(db);
                const snap = await getDocs(collection(db, 'polls', id, 'votes'));
                snap.forEach((d) => batch.delete(d.ref));
                await batch.commit();
                await deleteDoc(doc(db, 'polls', id));
                location.hash = '#/';
              } catch (err) {
                console.error(err);
                errorBox.textContent = 'Gagal menghapus polling.';
              }
            },
          }, 'Hapus'),
        ]
      : [];

    const createdMs = poll.createdAt ? poll.createdAt.toMillis() : Date.now();
    app.replaceChildren(
      h('p', {}, h('a', { href: '#/' }, '← Buat polling baru')),
      h('div', { class: 'card' },
        h('h2', {}, poll.question),
        h('div', { class: 'meta' },
          `${total} suara · ${timeAgo(createdMs)} `,
          h('span', { class: poll.closed ? 'badge closed' : 'badge' }, poll.closed ? 'Ditutup' : 'Aktif')),
        h('div', { style: 'margin-top:14px' }, optionEls),
        !showResults && h('div', { class: 'meta' }, 'Pilih salah satu untuk memberi suara dan melihat hasil.'),
        errorBox,
        h('div', { class: 'row' }, shareBtn, waBtn, ownerBtns))
    );
  }

  const onErr = (err) => {
    console.error(err);
    app.replaceChildren(h('div', { class: 'card' }, 'Tidak dapat memuat polling.', h('p', {}, h('a', { href: '#/' }, '← Buat polling baru'))));
  };

  unsubscribers.push(
    onSnapshot(doc(db, 'polls', id), (snap) => {
      poll = snap.exists() ? snap.data() : null;
      gotPoll = true;
      draw();
    }, onErr),
    onSnapshot(collection(db, 'polls', id, 'votes'), (snap) => {
      votes = snap.docs.map((d) => ({ uid: d.id, choice: d.data().choice }));
      gotVotes = true;
      draw();
    }, onErr)
  );
}

// ---------- Router ----------
function route() {
  stopListening();
  const m = /^#\/poll\/([a-f0-9]+)$/.exec(location.hash || '');
  if (m) return renderPoll(m[1]);
  return renderCreate();
}

waitForUser()
  .then((id) => {
    uid = id;
    window.addEventListener('hashchange', route);
    route();
  })
  .catch((err) => {
    console.error(err);
    app.replaceChildren(h('div', { class: 'card error' },
      'Tidak dapat terhubung ke Firebase. Periksa firebase-config.js dan pastikan Anonymous sign-in sudah diaktifkan.'));
  });
