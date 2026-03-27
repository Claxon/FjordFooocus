import json
import hashlib
import threading
import re
from datetime import datetime, timezone

import modules.constants as constants

from os.path import exists


# ---------------------------------------------------------------------------
# Legacy Gradio built-in auth (unchanged)
# ---------------------------------------------------------------------------

def auth_list_to_dict(auth_list):
    auth_dict = {}
    for auth_data in auth_list:
        if 'user' in auth_data:
            if 'hash' in auth_data:
                auth_dict |= {auth_data['user']: auth_data['hash']}
            elif 'pass' in auth_data:
                auth_dict |= {auth_data['user']: hashlib.sha256(bytes(auth_data['pass'], encoding='utf-8')).hexdigest()}
    return auth_dict


def load_auth_data(filename=None):
    auth_dict = None
    if filename != None and exists(filename):
        with open(filename, encoding='utf-8') as auth_file:
            try:
                auth_obj = json.load(auth_file)
                if isinstance(auth_obj, list) and len(auth_obj) > 0:
                    auth_dict = auth_list_to_dict(auth_obj)
            except Exception as e:
                print('load_auth_data, e: ' + str(e))
    return auth_dict


auth_dict = load_auth_data(constants.AUTH_FILENAME)

auth_enabled = auth_dict != None


def check_auth(user, password):
    if user not in auth_dict:
        return False
    else:
        return hashlib.sha256(bytes(password, encoding='utf-8')).hexdigest() == auth_dict[user]


# ---------------------------------------------------------------------------
# Account management system (accounts.json)
# ---------------------------------------------------------------------------

_accounts_lock = threading.Lock()
_accounts = []  # list of account dicts


def _hash_password(password: str) -> str:
    return hashlib.sha256(password.encode('utf-8')).hexdigest()


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec='seconds')


def _valid_username(username: str) -> tuple[bool, str]:
    if not username or not username.strip():
        return False, 'Username cannot be empty.'
    username = username.strip()
    if len(username) < 2:
        return False, 'Username must be at least 2 characters.'
    if len(username) > 64:
        return False, 'Username must be 64 characters or fewer.'
    if not re.match(r'^[a-zA-Z0-9_\-]+$', username):
        return False, 'Username may only contain letters, numbers, hyphens, and underscores.'
    return True, ''


def load_accounts(filename=None):
    """Load accounts from JSON file. Returns list of account dicts."""
    global _accounts
    if filename is None:
        filename = constants.ACCOUNTS_FILENAME
    with _accounts_lock:
        if exists(filename):
            try:
                with open(filename, encoding='utf-8') as f:
                    data = json.load(f)
                if isinstance(data, list):
                    _accounts = data
                    return _accounts
            except Exception as e:
                print(f'load_accounts error: {e}')
        _accounts = []
        return _accounts


def save_accounts(filename=None):
    """Write current accounts list to JSON file."""
    if filename is None:
        filename = constants.ACCOUNTS_FILENAME
    with _accounts_lock:
        with open(filename, 'w', encoding='utf-8') as f:
            json.dump(_accounts, f, indent=2, ensure_ascii=False)


def _find_account(username: str) -> dict | None:
    """Find account by username (case-insensitive). Must hold lock."""
    lower = username.strip().lower()
    for acc in _accounts:
        if acc.get('username', '').lower() == lower:
            return acc
    return None


def register_user(username: str, password: str) -> tuple[bool, str]:
    """Register a new account. Returns (success, message)."""
    valid, msg = _valid_username(username)
    if not valid:
        return False, msg
    username = username.strip()
    if not password or len(password) < 4:
        return False, 'Password must be at least 4 characters.'
    with _accounts_lock:
        if _find_account(username) is not None:
            return False, f'Username "{username}" is already taken.'
        account = {
            'username': username,
            'hash': _hash_password(password),
            'created_at': _now_iso(),
            'last_login': None,
            'disabled': False,
        }
        _accounts.append(account)
    save_accounts()
    return True, f'Account "{username}" created successfully.'


def authenticate(username: str, password: str) -> tuple[bool, str]:
    """Validate credentials. Returns (success, message)."""
    if not username or not password:
        return False, 'Username and password are required.'
    with _accounts_lock:
        acc = _find_account(username)
        if acc is None:
            return False, 'Invalid username or password.'
        if acc.get('disabled', False):
            return False, 'This account has been disabled.'
        if acc['hash'] != _hash_password(password):
            return False, 'Invalid username or password.'
        acc['last_login'] = _now_iso()
    save_accounts()
    return True, acc['username']  # return canonical username


def delete_account(username: str) -> tuple[bool, str]:
    """Remove an account. Returns (success, message)."""
    with _accounts_lock:
        acc = _find_account(username)
        if acc is None:
            return False, f'Account "{username}" not found.'
        _accounts.remove(acc)
    save_accounts()
    return True, f'Account "{username}" deleted.'


def disable_account(username: str) -> tuple[bool, str]:
    """Disable an account. Returns (success, message)."""
    with _accounts_lock:
        acc = _find_account(username)
        if acc is None:
            return False, f'Account "{username}" not found.'
        acc['disabled'] = True
    save_accounts()
    return True, f'Account "{username}" disabled.'


def enable_account(username: str) -> tuple[bool, str]:
    """Enable a disabled account. Returns (success, message)."""
    with _accounts_lock:
        acc = _find_account(username)
        if acc is None:
            return False, f'Account "{username}" not found.'
        acc['disabled'] = False
    save_accounts()
    return True, f'Account "{username}" enabled.'


def is_admin(username: str) -> bool:
    """Check if username is in the admin_users config list."""
    import modules.config
    admin_list = getattr(modules.config, 'admin_users', [])
    return username.strip().lower() in [u.lower() for u in admin_list]


def get_all_accounts() -> list[dict]:
    """Return all accounts (without password hashes) for admin display."""
    with _accounts_lock:
        result = []
        for acc in _accounts:
            result.append({
                'username': acc.get('username', ''),
                'created_at': acc.get('created_at', ''),
                'last_login': acc.get('last_login', ''),
                'disabled': acc.get('disabled', False),
            })
        return result


def migrate_auth_to_accounts():
    """One-time migration: convert auth.json entries to accounts.json."""
    if not exists(constants.AUTH_FILENAME) or exists(constants.ACCOUNTS_FILENAME):
        return
    try:
        with open(constants.AUTH_FILENAME, encoding='utf-8') as f:
            auth_obj = json.load(f)
        if not isinstance(auth_obj, list):
            return
        migrated = []
        for entry in auth_obj:
            if 'user' not in entry:
                continue
            acc = {
                'username': entry['user'],
                'hash': entry.get('hash', ''),
                'created_at': _now_iso(),
                'last_login': None,
                'disabled': False,
            }
            if not acc['hash'] and 'pass' in entry:
                acc['hash'] = _hash_password(entry['pass'])
            if acc['hash']:
                migrated.append(acc)
        if migrated:
            global _accounts
            with _accounts_lock:
                _accounts = migrated
            save_accounts()
            print(f'Migrated {len(migrated)} accounts from auth.json to accounts.json')
    except Exception as e:
        print(f'migrate_auth_to_accounts error: {e}')


# Initialize on import
migrate_auth_to_accounts()
load_accounts()
