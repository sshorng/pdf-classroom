const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const baseDir = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(baseDir, 'index.html'), 'utf8');
const gas = fs.readFileSync(path.join(baseDir, 'Code.gs'), 'utf8');
const cache = new Map();
const properties = new Map();
let tokenSequence = 0;

const context = {
  CacheService: {
    getScriptCache: () => ({
      get: key => cache.get(key) || null,
      put: (key, value) => cache.set(key, String(value)),
      remove: key => cache.delete(key)
    })
  },
  PropertiesService: {
    getScriptProperties: () => ({
      getProperty: key => properties.get(key) || null,
      setProperty: (key, value) => properties.set(key, String(value)),
      deleteProperty: key => properties.delete(key)
    })
  },
  Utilities: {
    getUuid: () => 'token-' + (++tokenSequence)
  }
};

vm.createContext(context);
vm.runInContext(gas, context);
context.getSetting_ = () => 'secret';

const token = context.issueAdminToken_();
assert.equal(context.isAdminToken_(token), true, 'A newly issued token must be valid');
cache.clear();
assert.equal(context.isAdminToken_(token), true, 'The token must survive CacheService eviction');
assert.equal(context.verifyAdmin_({ adminToken: token }).persistent, true, 'The API must identify a persistent session');
assert.equal(typeof context.revokeAdminToken_, 'function', 'The backend must expose token revocation');
context.revokeAdminToken_({ adminToken: token });
assert.equal(context.isAdminToken_(token), false, 'Logout must revoke the server-side token');

assert.match(html, /localStorage\.setItem\(APP_KEY \+ "admin_token"/);
assert.match(html, /localStorage\.removeItem\(APP_KEY \+ "admin_token"/);
assert.match(html, /gasPost\("logoutAdmin"/);

console.log('PASS teacher-auth: persistent token survives cache eviction and logout revokes it');
