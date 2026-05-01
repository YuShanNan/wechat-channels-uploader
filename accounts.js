const fs = require('fs');
const path = require('path');

const ACCOUNTS_PATH = path.join(__dirname, 'accounts.json');
const BASE_PROFILE_DIR = path.join(__dirname, 'browser-profile');

const DEFAULT_ACCOUNTS = [
  { name: 'default', profileDir: BASE_PROFILE_DIR, label: '主账号', status: 'ready', lastLogin: null, createdAt: null },
];

function loadAccounts() {
  if (!fs.existsSync(ACCOUNTS_PATH)) {
    saveAccounts(DEFAULT_ACCOUNTS);
    return JSON.parse(JSON.stringify(DEFAULT_ACCOUNTS));
  }
  try {
    const data = fs.readFileSync(ACCOUNTS_PATH, 'utf-8');
    return JSON.parse(data);
  } catch {
    // Corrupted file — restore from backup or defaults
    const bak = ACCOUNTS_PATH + '.bak';
    if (fs.existsSync(bak)) {
      try {
        const bakData = fs.readFileSync(bak, 'utf-8');
        const restored = JSON.parse(bakData);
        saveAccounts(restored);
        return restored;
      } catch {}
    }
    saveAccounts(DEFAULT_ACCOUNTS);
    return JSON.parse(JSON.stringify(DEFAULT_ACCOUNTS));
  }
}

function saveAccounts(accounts) {
  // Backup before overwriting
  if (fs.existsSync(ACCOUNTS_PATH)) {
    try { fs.copyFileSync(ACCOUNTS_PATH, ACCOUNTS_PATH + '.bak'); } catch {}
  }
  fs.writeFileSync(ACCOUNTS_PATH, JSON.stringify(accounts, null, 2), 'utf-8');
}

function getAccount(name) {
  return loadAccounts().find(a => a.name === name) || null;
}

function createAccount(name, label) {
  const accounts = loadAccounts();
  if (accounts.find(a => a.name === name)) {
    throw new Error(`Account "${name}" already exists`);
  }
  const profileDir = path.join(__dirname, `browser-profile-${name}`);
  if (!fs.existsSync(profileDir)) {
    fs.mkdirSync(profileDir, { recursive: true });
  }
  const account = {
    name,
    profileDir,
    label: label || name,
    status: 'needs-login',
    lastLogin: null,
    createdAt: new Date().toISOString(),
  };
  accounts.push(account);
  saveAccounts(accounts);
  return account;
}

function deleteAccount(name) {
  if (name === 'default') throw new Error('Cannot delete default account');
  const accounts = loadAccounts();
  const idx = accounts.findIndex(a => a.name === name);
  if (idx === -1) throw new Error(`Account "${name}" not found`);
  const [account] = accounts.splice(idx, 1);
  saveAccounts(accounts);
  // Remove profile directory (best effort)
  if (fs.existsSync(account.profileDir)) {
    fs.rmSync(account.profileDir, { recursive: true, force: true });
  }
  return account;
}

function updateAccount(name, updates) {
  const accounts = loadAccounts();
  const account = accounts.find(a => a.name === name);
  if (!account) throw new Error(`Account "${name}" not found`);
  Object.assign(account, updates);
  saveAccounts(accounts);
  return account;
}

function updateAccountStatus(name, status) {
  const accounts = loadAccounts();
  const account = accounts.find(a => a.name === name);
  if (!account) return;
  account.status = status;
  if (status === 'ready') account.lastLogin = new Date().toISOString();
  saveAccounts(accounts);
}

module.exports = { loadAccounts, saveAccounts, getAccount, createAccount, deleteAccount, updateAccount, updateAccountStatus };
