const mineflayer = require('mineflayer');
const fs = require('fs');
const path = require('path');
const baseConfig = require('./config');

const LOG_FILE = path.join(__dirname, 'bot.log');

const config = Object.assign({}, baseConfig);
if (process.env.DOGELAND_HOST) config.host = process.env.DOGELAND_HOST;
if (process.env.DOGELAND_PORT) config.port = parseInt(process.env.DOGELAND_PORT, 10);
if (process.env.DOGELAND_USERNAME) config.username = process.env.DOGELAND_USERNAME;
if (process.env.DOGELAND_PASSWORD) config.password = process.env.DOGELAND_PASSWORD;
if (process.env.DOGELAND_RECIPIENT) config.recipient = process.env.DOGELAND_RECIPIENT;

let bot = null;
let shuttingDown = false;
let generation = 0;
let reconnectTimer = null;
let reconnectScheduled = false;
let state = 'auth';
let authCommandSent = false;
let modeWindowHandled = false;
let afkWindowHandled = false;
let windowClickTries = 0;
let lastShardAmount = -1;
let lastGiftedAmount = -1;
let lastGiftAt = 0;
let totalGifted = 0;
let startedAt = Date.now();
let reconnectAttempts = 0;
const shardLines = [];

const runDurationMs = config.runDurationMinutes * 60 * 1000;
const checkIntervalMs = config.checkIntervalMinutes * 60 * 1000;
const giftCooldownMs = config.giftCooldownMinutes * 60 * 1000;

function log(message) {
  const line = `[${new Date().toISOString()}] ${message}`;
  console.log(line);
  fs.appendFileSync(LOG_FILE, line + '\n');
}

function clean(text) {
  return String(text).replace(/§[0-9a-fk-or]/gi, '');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function elapsedMinutes() {
  return Math.round((Date.now() - startedAt) / 60000);
}

function extractShardAmount(text) {
  const m = String(text).match(config.shardRegex);
  if (!m) return null;
  const n = parseInt(String(m[1]).replace(/[^\d]/g, ''), 10);
  return isNaN(n) ? null : n;
}

function safeChat(message) {
  try {
    if (bot && bot._client && typeof bot._client.chat === 'function') {
      bot.chat(message);
    } else {
      log(`WARN chat not ready, skipped: ${message}`);
    }
  } catch (err) {
    log(`Chat error (${message}): ${err.message}`);
  }
}

function logWindowSlots(window) {
  const slots = window && window.slots ? window.slots : [];
  const lines = [];
  for (let i = 0; i < slots.length; i++) {
    const slot = slots[i];
    if (slot && slot.item) {
      lines.push(`  o ${i}: ${slot.item.name} | ${slot.item.displayName || ''} (x${slot.item.count})`);
    }
  }
  if (lines.length) {
    log(`GUI content:\n${lines.join('\n')}`);
  } else {
    log('GUI has no visible slots.');
  }
}

function logInventory() {
  if (!bot || !bot.inventory) return;
  const lines = [];
  for (let i = 0; i < bot.inventory.slots.length; i++) {
    const s = bot.inventory.slots[i];
    if (s && s.item) lines.push(`  slot ${i}: ${s.item.name} (x${s.item.count})`);
  }
  if (lines.length) log(`Inventory:\n${lines.join('\n')}`);
  try {
    const held = bot.heldItem;
    if (held && held.item) log(`Held item: ${held.item.name}`);
    else log('Held item: (empty)');
  } catch (err) {}
}

function maybeGift() {
  if (!bot) return;
  if (lastShardAmount <= 0) return;
  if (lastShardAmount === lastGiftedAmount) return;
  if (Date.now() - lastGiftAt < giftCooldownMs) return;
  lastGiftAt = Date.now();
  lastGiftedAmount = lastShardAmount;
  totalGifted += lastShardAmount;
  log(`Gifting ${lastShardAmount} shard(s) to ${config.recipient}.`);
  safeChat(`/shard pay ${config.recipient} ${lastShardAmount}`);
}

function handleMessage(raw, gen) {
  const text = clean(raw);
  if (config.debugChat) log(`CHAT: ${text}`);
  if (/shard/i.test(text)) {
    shardLines.push(text);
    if (shardLines.length > 60) shardLines.shift();
  }

  if (gen === generation && state === 'auth' && !authCommandSent && config.password) {
    if (/(\/register|please register|dang ky|đăng ký|register)/i.test(text)) {
      log('Register prompt detected, sending /register.');
      authCommandSent = true;
      safeChat(`/register ${config.password} ${config.password}`);
      scheduleModeSelection();
      return;
    }
    if (/(\/login|please login|dang nhap|đăng nhập|login)/i.test(text)) {
      log('Login prompt detected, sending /login.');
      authCommandSent = true;
      safeChat(`/login ${config.password}`);
      scheduleModeSelection();
      return;
    }
  }

  if (gen === generation && state === 'afk') {
    const amount = extractShardAmount(text);
    if (amount !== null && amount > 0 && lastShardAmount !== amount) {
      log(`Detected shard balance: ${amount}.`);
      lastShardAmount = amount;
      maybeGift();
    }
  }
}

function scheduleModeSelection() {
  setTimeout(() => {
    if (state !== 'auth' || shuttingDown) return;
    state = 'mode';
    log('Starting game-mode selection.');
    tryModeSelection();
  }, 5000);
}

async function prepareHand() {
  try {
    if (config.modeHotbarSlot !== null && config.modeHotbarSlot !== undefined) {
      bot.setQuickBarSlot(config.modeHotbarSlot);
      await sleep(400);
      return;
    }
    if (config.modeItemName) {
      await bot.equip(config.modeItemName, 'hand');
      await sleep(400);
    }
  } catch (err) {
    log(`Equip/setQuickBarSlot error: ${err.message}`);
  }
}

function tryModeSelection() {
  if (shuttingDown || state !== 'mode') return;
  windowClickTries++;
  log(`Attempt ${windowClickTries} to open mode menu...`);
  prepareHand().then(() => {
    if (shuttingDown || state !== 'mode') return;
    Promise.resolve(bot.activateItem()).catch((err) => log(`activateItem error: ${err.message}`));
    setTimeout(() => {
      if (state === 'mode' && !modeWindowHandled) {
        log('Mode menu did not open, retrying.');
        setTimeout(tryModeSelection, config.retryDelayMs);
      }
    }, 5000);
  });
}

function tryOpenAfkRoom() {
  if (shuttingDown || state !== 'afkRoom') return;
  log(`Running ${config.afkCommand}...`);
  safeChat(config.afkCommand);
  setTimeout(() => {
    if (state === 'afkRoom' && !afkWindowHandled) {
      log('AFK room menu did not open, retrying.');
      setTimeout(tryOpenAfkRoom, config.retryDelayMs);
    }
  }, 5000);
}

function clickAndClose(window, slot, label, after) {
  if (slot === null || slot === undefined || slot < 0) {
    log(`No slot configured for ${label}, skipping click.`);
    after();
    return;
  }
  if (slot >= window.slotCount) {
    log(`Slot ${slot} out of range (${window.slotCount}) for ${label}, skipping.`);
    after();
    return;
  }
  Promise.resolve(bot.clickWindow(slot, 0, 0)).catch((err) => {
    log(`Click slot ${slot} (${label}) error: ${err.message}`);
  });
  log(`Clicked slot ${slot} (${label}).`);
  setTimeout(() => {
    try {
      if (bot.currentWindow) bot.closeWindow(bot.currentWindow);
    } catch (err) {}
    after();
  }, 800);
}

function windowOpenHandler(window, gen) {
  const title = window && window.title ? clean(String(window.title)) : '(none)';
  const n = window && window.slots ? window.slots.length : '?';
  log(`GUI opened: title="${title}" type=${window && window.containerType} slots=${n}`);
  logWindowSlots(window);

  if (gen !== generation) return;

  if (state === 'mode' && !modeWindowHandled) {
    modeWindowHandled = true;
    setTimeout(() => clickAndClose(window, config.modeSlot, 'game mode', () => {
      state = 'afkRoom';
      log('Game mode selected. Opening AFK room menu...');
      setTimeout(tryOpenAfkRoom, 1000);
    }), 800);
    return;
  }

  if (state === 'afkRoom' && !afkWindowHandled) {
    afkWindowHandled = true;
    setTimeout(() => clickAndClose(window, config.afkRoomSlot, 'AFK room', () => {
      state = 'afk';
      lastShardAmount = -1;
      log('Entered AFK room. Starting AFK.');
      safeChat(config.checkCommand);
    }), 800);
  }
}

function scheduleReconnect() {
  if (shuttingDown) return;
  if (reconnectScheduled) return;
  reconnectScheduled = true;
  const wait = Math.min(300000, config.reconnectBaseMs * Math.pow(2, Math.min(reconnectAttempts, 4)));
  reconnectAttempts++;
  log(`Reconnecting in ${Math.round(wait / 1000)}s (attempt ${reconnectAttempts}).`);
  reconnectTimer = setTimeout(() => {
    reconnectScheduled = false;
    createBot();
  }, wait);
}

function createBot() {
  generation++;
  const gen = generation;
  state = 'auth';
  authCommandSent = false;
  modeWindowHandled = false;
  afkWindowHandled = false;
  windowClickTries = 0;

  log(`Connecting to ${config.host}:${config.port} (${config.version}) as ${config.username}...`);
  bot = mineflayer.createBot({
    host: config.host,
    port: config.port,
    version: config.version,
    username: config.username,
    auth: 'offline'
  });

  bot.on('login', () => {
    log('Connected to server.');
    reconnectAttempts = 0;
  });

  bot.on('spawn', () => {
    log('Spawned in game.');
    setTimeout(() => {
      if (gen !== generation) return;
      logInventory();
    }, 4000);
    setTimeout(() => {
      if (gen !== generation || state !== 'auth' || shuttingDown) return;
      if (!config.password || config.authMode === 'none') {
        log('No auth needed, starting mode selection.');
        state = 'mode';
        tryModeSelection();
        return;
      }
      if (config.authMode === 'login' && !authCommandSent) {
        log('Sending /login.');
        authCommandSent = true;
        safeChat(`/login ${config.password}`);
        scheduleModeSelection();
        return;
      }
      if (config.authMode === 'register' && !authCommandSent) {
        log('Sending /register.');
        authCommandSent = true;
        safeChat(`/register ${config.password} ${config.password}`);
        scheduleModeSelection();
        return;
      }
      log('Waiting for login/register prompt (25s)...');
      setTimeout(() => {
        if (gen !== generation || state === 'auth' && !authCommandSent) {
          log('No auth prompt received, trying /login.');
          authCommandSent = true;
          safeChat(`/login ${config.password}`);
          scheduleModeSelection();
        }
      }, 25000);
    }, 3000);
  });

  bot.on('messagestr', (m) => handleMessage(m, gen));
  bot.on('windowOpen', (w) => windowOpenHandler(w, gen));
  bot.on('kicked', (reason) => {
    log(`Kicked: ${clean(reason)}`);
    scheduleReconnect();
  });
  bot.on('end', () => {
    log('Connection ended.');
    scheduleReconnect();
  });
  bot.on('error', (err) => {
    log(`Error: ${err.message}`);
    scheduleReconnect();
  });
}

setInterval(() => {
  if (state === 'afk' && bot) {
    log(`AFK running (${elapsedMinutes()} min). Total gifted: ${totalGifted}. Running ${config.checkCommand}...`);
    safeChat(config.checkCommand);
  }
}, checkIntervalMs);

if (config.antiAfk) {
  setInterval(() => {
    if (state === 'afk' && bot) bot.jump();
  }, 30000);
}

setTimeout(() => {
  log(`Run duration (${config.runDurationMinutes} min) reached. Total gifted: ${totalGifted}. Shutting down.`);
  shardLines.slice(-20).forEach((l) => log('  last-shard-msg: ' + l));
  shuttingDown = true;
  if (bot) bot.end();
  setTimeout(() => process.exit(0), 3000);
}, runDurationMs);

process.on('uncaughtException', (err) => {
  log(`Uncaught exception: ${err.stack || err.message}`);
  process.exit(1);
});
process.on('unhandledRejection', (err) => {
  log(`Unhandled rejection: ${err && err.stack ? err.stack : err}`);
});

createBot();
