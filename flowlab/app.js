// FlowLab — minimal state + logic
const $ = id => document.getElementById(id);
let users = {}, items = [], currentUser = null, editIdx = -1, deleteIdx = -1;

// Toast
function toast(msg) {
  const t = $('toast'); t.textContent = msg; t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 2000);
}

// Auth toggle
$('show-login').onclick = e => { e.preventDefault(); $('signup-card').classList.add('hidden'); $('login-card').classList.remove('hidden'); };
$('show-signup').onclick = e => { e.preventDefault(); $('login-card').classList.add('hidden'); $('signup-card').classList.remove('hidden'); };

// Signup
$('signup-btn').onclick = () => {
  const name = $('signup-name').value.trim();
  const email = $('signup-email').value.trim();
  const pw = $('signup-password').value;
  const role = $('signup-role').value;
  const terms = $('signup-terms').checked;
  const err = $('signup-error');
  if (!name || !email || !pw || !role) { err.textContent = 'All fields required'; err.classList.remove('hidden'); return; }
  if (!terms) { err.textContent = 'Please agree to terms'; err.classList.remove('hidden'); return; }
  if (users[email]) { err.textContent = 'Email already registered'; err.classList.remove('hidden'); return; }
  err.classList.add('hidden');
  users[email] = { name, pw, role };
  login(email, name);
};

// Login
$('login-btn').onclick = () => {
  const email = $('login-email').value.trim();
  const pw = $('login-password').value;
  const err = $('login-error');
  if (!users[email] || users[email].pw !== pw) { err.textContent = 'Invalid credentials'; err.classList.remove('hidden'); return; }
  err.classList.add('hidden');
  login(email, users[email].name);
};

function login(email, name) {
  currentUser = email;
  $('auth-section').classList.add('hidden');
  $('app-section').classList.remove('hidden');
  $('welcome-msg').textContent = `Hi, ${name}`;
  toast('Logged in');
  renderItems();
}

$('logout-btn').onclick = () => {
  currentUser = null;
  $('app-section').classList.add('hidden');
  $('auth-section').classList.remove('hidden');
  toast('Logged out');
};

// Items CRUD
function renderItems() {
  const list = $('items-list');
  if (!items.length) { list.innerHTML = '<p class="loading">No items yet</p>'; return; }
  list.innerHTML = items.map((it, i) => `
    <div class="item" data-idx="${i}">
      <span class="item-title">${it.title}</span>
      <div class="item-actions">
        <button class="btn-secondary btn-small edit-btn" data-idx="${i}">Edit</button>
        <button class="btn-danger btn-small del-btn" data-idx="${i}">Delete</button>
      </div>
    </div>`).join('');
  list.querySelectorAll('.edit-btn').forEach(b => b.onclick = () => openEdit(+b.dataset.idx));
  list.querySelectorAll('.del-btn').forEach(b => b.onclick = () => openDelete(+b.dataset.idx));
}

// Modal
$('add-item-btn').onclick = () => { editIdx = -1; $('modal-title').textContent = 'New Item'; $('item-title').value = ''; $('item-desc').value = ''; $('modal').classList.add('open'); };
function openEdit(i) { editIdx = i; $('modal-title').textContent = 'Edit Item'; $('item-title').value = items[i].title; $('item-desc').value = items[i].desc || ''; $('modal').classList.add('open'); }
$('modal-cancel').onclick = () => $('modal').classList.remove('open');
$('modal-save').onclick = () => {
  const title = $('item-title').value.trim();
  if (!title) return;
  if (editIdx === -1) items.push({ title, desc: $('item-desc').value.trim() });
  else { items[editIdx].title = title; items[editIdx].desc = $('item-desc').value.trim(); }
  $('modal').classList.remove('open');
  renderItems();
  toast(editIdx === -1 ? 'Item created' : 'Item updated');
};

// Delete confirm
function openDelete(i) { deleteIdx = i; $('confirm-modal').classList.add('open'); }
$('confirm-no').onclick = () => $('confirm-modal').classList.remove('open');
$('confirm-yes').onclick = () => { items.splice(deleteIdx, 1); $('confirm-modal').classList.remove('open'); renderItems(); toast('Item deleted'); };

// Scroll test rows
const sl = $('long-list');
for (let i = 1; i <= 50; i++) { const d = document.createElement('div'); d.className = 'item'; d.innerHTML = `<span class="item-title">Row ${i}</span>`; sl.appendChild(d); }
