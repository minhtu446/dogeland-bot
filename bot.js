const mineflayer = require('mineflayer');
const EventEmitter = require('events');
const fs = require('fs');
const path = require('path');

const envFile = path.join(__dirname, '.env');
if (fs.existsSync(envFile)) {
  fs.readFileSync(envFile, 'utf8').split('\n').forEach((line) => {
    const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  });
}

const baseConfig = require('./config');
const LOG_FILE = path.join(__dirname, 'bot.log');

const config = Object.assign({}, baseConfig);
if (process.env.DOGELAND_HOST) config.host = process.env.DOGELAND_HOST;
if (process.env.DOGELAND_PORT) config.port = parseInt(process.env.DOGELAND_PORT, 10);
if (process.env.DOGELAND_USERNAME) config.username = process.env.DOGELAND_USERNAME;
if (process.env.DOGELAND_PASSWORD) config.password = process.env.DOGELAND_PASSWORD;
if (process.env.DOGELAND_RECIPIENT) config.recipient = process.env.DOGELAND_RECIPIENT;

const MODE = (process.env.DOGELAND_MODE || 'afk').toLowerCase();
let GIFT_AMOUNT = parseInt(process.env.DOGELAND_AMOUNT, 10);
if (isNaN(GIFT_AMOUNT) || GIFT_AMOUNT <= 0) GIFT_AMOUNT = 0;

const emitter = new EventEmitter();

let bot = null;
let running = false;
let online = false;
let shuttingDown = false;
let generation = 0;
let reconnectTimer = null;
let reconnectScheduled = false;
let state = 'idle';
let authCommandSent = false;
let modeWindowHandled = false;
let afkWindowHandled = false;
let windowClickTries = 0;
let lastShardAmount = -1;
let lastGiftedAmount = -1;
let lastShardUpdatedAt = 0;
let lastGiftAt = 0;
let forceGift = false;
let giftSent = false;
let exitScheduled = false;
let totalGifted = 0;
let startedAt = Date.now();
let reconnectAttempts = 0;
let checkTimer = null;
let antiAfkTimer = null;
let durationTimer = null;
const shardLines = [];

const checkIntervalMs = config.checkIntervalMinutes * 60 * 1000;
const giftCooldownMs = config.giftCooldownMinutes * 60 * 1000;

function log(message) {
  const line = `[${new Date().toISOString()}] ${message}`;
  console.log(line);
  try {
    fs.appendFileSync(LOG_FILE, line + '\n');
  } catch (err) {}
  emitter.emit('log', line);
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

function maybeGift(force) {
  if (!bot || !online) return { ok: false, error: 'Bot is not connected.' };
  if (lastShardAmount <= 0) return { ok: false, error: 'No shard balance detected.' };
  if (!force && lastShardAmount === lastGiftedAmount) return { ok: false, error: 'Already gifted this balance.' };
  if (!force && Date.now() - lastGiftAt < giftCooldownMs) return { ok: false, error: 'Gift cooldown active.' };
  lastGiftAt = Date.now();
  lastGiftedAmount = lastShardAmount;
  totalGifted += lastShardAmount;
  log(`Gifting ${lastShardAmount} shard(s) to ${config.recipient}.`);
  safeChat(`/shard pay ${config.recipient} ${lastShardAmount}`);
  return { ok: true, message: `Sent ${lastShardAmount} shards to ${config.recipient}.` };
}

const BALANCE_FILE = path.join(__dirname, 'balance.json');

function saveBalance() {
  try {
    const data = {
      shard: lastShardAmount,
      updatedAt: new Date().toISOString(),
      mode: MODE
    };
    fs.writeFileSync(BALANCE_FILE, JSON.stringify(data, null, 2));
    log(`balance.json updated: ${lastShardAmount} shard(s).`);
  } catch (err) {
    log(`saveBalance error: ${err.message}`);
  }
}

function scheduleExit(reason, delayMs) {
  if (exitScheduled) return;
  exitScheduled = true;
  log(`${reason} Exiting in ${Math.round(delayMs / 1000)}s.`);
  setTimeout(() => {
    if (running) stopBot();
    setTimeout(() => process.exit(0), 1500);
  }, delayMs);
}

function handleGiftMode() {
  if (giftSent || lastShardAmount <= 0) return;
  let amount = lastShardAmount;
  if (GIFT_AMOUNT > 0) {
    if (GIFT_AMOUNT <= lastShardAmount) {
      amount = GIFT_AMOUNT;
    } else {
      log(`Requested ${GIFT_AMOUNT} but only ${lastShardAmount} available; sending all.`);
    }
  }
  giftSent = true;
  lastGiftAt = Date.now();
  lastGiftedAmount = amount;
  totalGifted += amount;
  log(`GIFT MODE: sending ${amount} shard(s) to ${config.recipient}.`);
  safeChat(`/shard pay ${config.recipient} ${amount}`);
  scheduleExit('Gift sent.', 15000);
}

function decodeReason(reason) {
  try {
    if (typeof reason === 'string' && reason.startsWith('{')) reason = JSON.parse(reason);
  } catch (err) {}
  if (reason && typeof reason === 'object') {
    const parts = [];
    if (reason.text) parts.push(reason.text);
    if (reason.translate) parts.push(reason.translate);
    if (Array.isArray(reason.extra)) {
      for (const e of reason.extra) parts.push(decodeReason(e));
    }
    const s = parts.join('').replace(/§[0-9a-fk-or]/gi, '').trim();
    if (s) return s;
    return JSON.stringify(reason);
  }
  return clean(reason);
}

function handleMessage(raw, gen) {
  const text = clean(raw);
  if (config.debugChat) log(`CHAT: ${text}`);
  if (/shard/i.test(text)) {
    shardLines.push(text);
    if (shardLines.length > 60) shardLines.shift();
  }

  if (gen === generation && running && state === 'auth' && !authCommandSent && config.password) {
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
    if (/(không tìm thấy người chơi|player not found|không thể chuyển|không thể tặng)/i.test(text)) {
      if (lastGiftedAmount !== -1) {
        log('Gift failed (recipient unavailable), will retry.');
        lastGiftedAmount = -1;
      }
      if (MODE === 'gift') scheduleExit('Gift failed (recipient likely offline).', 4000);
    }
    if (!/(nhận được|đã gửi|đã chuyển|received|sent|paid)/i.test(text)) {
      const amount = extractShardAmount(text);
      if (amount !== null && amount > 0) {
        if (amount !== lastShardAmount) log(`Detected shard balance: ${amount}.`);
        lastShardAmount = amount;
        lastShardUpdatedAt = Date.now();
        saveBalance();
        if (MODE === 'gift') {
          handleGiftMode();
        } else if (MODE === 'check') {
          log(`CHECK RESULT: bot currently has ${lastShardAmount} shard(s).`);
          scheduleExit('Check complete.', 4000);
        } else {
          maybeGift(forceGift);
          forceGift = false;
        }
      }
    }
    if (MODE === 'gift' && /(đã gửi|đã chuyển|sent).*shard/i.test(text)) {
      scheduleExit('Gift confirmed by server.', 4000);
    }
  }
}

function scheduleModeSelection() {
  setTimeout(() => {
    if (!running || shuttingDown || state !== 'auth') return;
    state = 'mode';
    log('Starting game-mode selection.');
    tryModeSelection();
  }, 5000);
}

function findModeItem() {
  if (!bot || !bot.inventory) return null;
  const want = config.modeItemName ? config.modeItemName.toLowerCase() : null;
  for (const slot of bot.inventory.slots) {
    if (slot && slot.item) {
      const n = (slot.item.name || '').toLowerCase();
      const d = (slot.item.displayName || '').toLowerCase();
      if ((want && n === want) || d.includes('la bàn') || d.includes('compass') || n.includes('compass')) {
        return slot;
      }
    }
  }
  return null;
}

async function prepareHand() {
  for (let i = 0; i < 12; i++) {
    if (i > 0) await sleep(1500);
    try {
      const slot = findModeItem();
      if (slot) {
        await bot.equip(slot.item.name, 'hand');
        log(`Equipped ${slot.item.name} into hand.`);
        return;
      }
      if (config.modeHotbarSlot !== null && config.modeHotbarSlot !== undefined) {
        bot.setQuickBarSlot(config.modeHotbarSlot);
        await sleep(300);
        const held = bot.heldItem;
        if (held && held.item) {
          log(`Held item: ${held.item.name} (quickbar slot ${config.modeHotbarSlot}).`);
          return;
        }
      }
      if (i === 0) log('No compass yet, waiting for inventory sync...');
      if (bot && bot.inventory) {
        const names = [...new Set(bot.inventory.slots.filter((s) => s && s.item).map((s) => s.item.name))];
        if (names.length) log(`  inventory so far: ${names.join(', ')}`);
      }
    } catch (err) {
      log(`prepareHand error: ${err.message}`);
    }
  }
  log('Compass not found in inventory.');
}

function tryModeSelection() {
  if (shuttingDown || !running || state !== 'mode') return;
  windowClickTries++;
  log(`Attempt ${windowClickTries} to open mode menu...`);
  prepareHand().then(() => {
    if (shuttingDown || !running || state !== 'mode') return;
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
  if (shuttingDown || !running || state !== 'afkRoom') return;
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
      lastGiftedAmount = -1;
      lastShardUpdatedAt = 0;
      giftSent = false;
      log('Entered AFK room. Starting AFK.');
      safeChat(config.checkCommand);
    }), 800);
  }
}

function scheduleReconnect() {
  if (shuttingDown || !running) return;
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
  if (!running) return;
  generation++;
  const gen = generation;
  online = false;
  state = 'auth';
  authCommandSent = false;
  modeWindowHandled = false;
  afkWindowHandled = false;
  windowClickTries = 0;
  giftSent = false;

  log(`Connecting to ${config.host}:${config.port} (${config.version}) as ${config.username}...`);
  bot = mineflayer.createBot({
    host: config.host,
    port: config.port,
    version: config.version,
    username: config.username,
    auth: 'offline'
  });

  bot.on('login', () => {
    online = true;
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
        if (gen !== generation || (state === 'auth' && !authCommandSent)) {
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
    log(`Kicked: ${decodeReason(reason)}`);
    scheduleReconnect();
  });
  bot.on('end', () => {
    online = false;
    log('Connection ended.');
    scheduleReconnect();
  });
  bot.on('error', (err) => {
    log(`Error: ${err.message}`);
    scheduleReconnect();
  });
}

function startBot(options) {
  if (running) return { ok: false, error: 'Bot is already running.' };
  shuttingDown = false;
  running = true;
  state = 'auth';
  startedAt = Date.now();
  totalGifted = 0;
  lastShardAmount = -1;
  lastGiftedAmount = -1;
  reconnectAttempts = 0;
  clearInterval(checkTimer);
  clearInterval(antiAfkTimer);
  clearTimeout(durationTimer);
  checkTimer = setInterval(() => {
    if (state === 'afk' && bot && online) {
      log(`AFK running (${elapsedMinutes()} min). Total gifted: ${totalGifted}. Running ${config.checkCommand}...`);
      safeChat(config.checkCommand);
    }
  }, checkIntervalMs);
  if (config.antiAfk) {
    antiAfkTimer = setInterval(() => {
      if (state === 'afk' && bot && online) bot.jump();
    }, 30000);
  }
  if (options && options.runDurationMs) {
    durationTimer = setTimeout(() => {
      log(`Run duration reached. Total gifted: ${totalGifted}. Stopping.`);
      stopBot();
    }, options.runDurationMs);
  }
  giftSent = false;
  exitScheduled = false;
  if (MODE !== 'afk') {
    setTimeout(() => {
      if (!exitScheduled) scheduleExit('Mode safety timeout.', 0);
    }, 180000);
  }
  createBot();
  return { ok: true, message: `Bot started (mode: ${MODE}).` };
}

function stopBot() {
  if (!running) return { ok: false, error: 'Bot is not running.' };
  log('Stopping bot...');
  running = false;
  shuttingDown = true;
  state = 'idle';
  clearInterval(checkTimer);
  clearInterval(antiAfkTimer);
  clearTimeout(durationTimer);
  clearTimeout(reconnectTimer);
  reconnectScheduled = false;
  if (bot) {
    try {
      bot.end();
    } catch (err) {}
  }
  bot = null;
  online = false;
  return { ok: true, message: 'Bot stopped.' };
}

function giftNow() {
  if (!running || !bot || !online) return { ok: false, error: 'Bot is not connected.' };
  const fresh = Date.now() - lastShardUpdatedAt < 30000;
  if (lastShardAmount > 0 && fresh) {
    return maybeGift(true);
  }
  forceGift = true;
  safeChat(config.checkCommand);
  return { ok: true, message: 'Checking balance; bot will gift as soon as it is detected.' };
}

function checkNow() {
  if (!running || !bot || !online) return { ok: false, error: 'Bot is not connected.' };
  safeChat(config.checkCommand);
  return { ok: true, message: `Ran ${config.checkCommand}.` };
}

function getStatus() {
  return {
    running,
    online,
    state,
    host: config.host,
    port: config.port,
    version: config.version,
    username: config.username,
    recipient: config.recipient,
    elapsedMin: Math.round((Date.now() - startedAt) / 60000),
    totalGifted,
    lastShardAmount,
    lastGiftAt,
    reconnectAttempts,
    authMode: config.authMode,
    mode: MODE,
    giftAmount: GIFT_AMOUNT
  };
}

function onLog(listener) {
  emitter.on('log', listener);
}

function shutdownStandalone() {
  if (!running) process.exit(0);
  log('Shutting down gracefully...');
  stopBot();
  setTimeout(() => process.exit(0), 2000);
}

process.on('uncaughtException', (err) => {
  log(`Uncaught exception: ${err.stack || err.message}`);
  if (require.main === module) process.exit(1);
  else stopBot();
});
process.on('unhandledRejection', (err) => {
  log(`Unhandled rejection: ${err && err.stack ? err.stack : err}`);
});

if (require.main === module) {
  process.on('SIGINT', shutdownStandalone);
  process.on('SIGTERM', shutdownStandalone);
  const runMs = MODE === 'afk' ? config.runDurationMinutes * 60 * 1000 : 0;
  startBot({ runDurationMs: runMs });
}

module.exports = { startBot, stopBot, giftNow, checkNow, getStatus, onLog };
