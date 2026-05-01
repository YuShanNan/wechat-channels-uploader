import json
import os
import shutil
from copy import deepcopy
from datetime import datetime

_BASE_DIR = os.environ.get('APP_BASE_DIR', os.path.dirname(os.path.abspath(__file__)))
ACCOUNTS_PATH = os.path.join(_BASE_DIR, 'accounts.json')
BASE_PROFILE_DIR = os.path.join(_BASE_DIR, 'browser-profiles', 'default')

DEFAULT_ACCOUNTS = [
    {'name': 'default', 'profileDir': BASE_PROFILE_DIR, 'label': '主账号', 'status': 'ready', 'lastLogin': None, 'createdAt': None},
]


def loadAccounts():
    if not os.path.exists(ACCOUNTS_PATH):
        return deepcopy(DEFAULT_ACCOUNTS)
    try:
        with open(ACCOUNTS_PATH, 'r', encoding='utf-8') as f:
            accounts = json.load(f)
            return accounts or []
    except (json.JSONDecodeError, OSError):
        bak = ACCOUNTS_PATH + '.bak'
        if os.path.exists(bak):
            try:
                with open(bak, 'r', encoding='utf-8') as f:
                    restored = json.load(f)
                if restored:
                    saveAccounts(restored)
                    return restored
            except (json.JSONDecodeError, OSError):
                pass
        return deepcopy(DEFAULT_ACCOUNTS)


def saveAccounts(accounts):
    if os.path.exists(ACCOUNTS_PATH):
        try:
            shutil.copy2(ACCOUNTS_PATH, ACCOUNTS_PATH + '.bak')
        except OSError:
            pass
    with open(ACCOUNTS_PATH, 'w', encoding='utf-8') as f:
        json.dump(accounts, f, indent=2, ensure_ascii=False)


def getAccount(name):
    accounts = loadAccounts()
    for a in accounts:
        if a['name'] == name:
            return a
    return None


def createAccount(name, label):
    accounts = loadAccounts()
    for a in accounts:
        if a['name'] == name:
            raise Exception('Account "' + name + '" already exists')
    profileDir = os.path.join(_BASE_DIR, 'browser-profiles', name)
    if not os.path.exists(profileDir):
        os.makedirs(profileDir, exist_ok=True)
    account = {
        'name': name,
        'profileDir': profileDir,
        'label': label or name,
        'status': 'needs-login',
        'lastLogin': None,
        'createdAt': datetime.now().isoformat(),
    }
    accounts.append(account)
    saveAccounts(accounts)
    return account


def deleteAccount(name):
    accounts = loadAccounts()
    idx = None
    for i, a in enumerate(accounts):
        if a['name'] == name:
            idx = i
            break
    if idx is None:
        raise Exception('Account "' + name + '" not found')
    account = accounts.pop(idx)
    saveAccounts(accounts)
    if os.path.exists(account['profileDir']):
        shutil.rmtree(account['profileDir'], ignore_errors=True)
    return account


def updateAccount(name, updates):
    accounts = loadAccounts()
    for a in accounts:
        if a['name'] == name:
            a.update(updates)
            saveAccounts(accounts)
            return a
    raise Exception('Account "' + name + '" not found')


def updateAccountStatus(name, status):
    accounts = loadAccounts()
    for a in accounts:
        if a['name'] == name:
            a['status'] = status
            if status == 'ready':
                a['lastLogin'] = datetime.now().isoformat()
            saveAccounts(accounts)
            return

# snake_case aliases
load_accounts = loadAccounts
save_accounts = saveAccounts
get_account = getAccount
create_account = createAccount
delete_account = deleteAccount
update_account = updateAccount
update_account_status = updateAccountStatus
