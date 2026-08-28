const mineflayer = require('mineflayer')
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder')
const { plugin: pvpPlugin } = require('mineflayer-pvp')
const http = require('http')

// ===== تنظیمات (از Environment Variables خونده می‌شوند) =====
const HOST = process.env.SERVER_HOST                     // آدرس سرور آترنوس، مثلا: something.aternos.me
const PORT = parseInt(process.env.SERVER_PORT || '25565', 10)
const USERNAME = process.env.BOT_USERNAME || 'Yuta'
const PASSWORD = process.env.BOT_PASSWORD || '13501350'
const MC_VERSION = process.env.MC_VERSION || '1.21.1'
const WALK_RADIUS = parseInt(process.env.WALK_RADIUS || '10', 10)
const WALK_INTERVAL_MIN = parseFloat(process.env.WALK_INTERVAL_MINUTES || '5')
const WALK_INTERVAL_MS = WALK_INTERVAL_MIN * 60 * 1000
const RECONNECT_DELAY_MS = 15 * 1000

// ===== تنظیمات PvP =====
const COMBAT_RADIUS = parseInt(process.env.COMBAT_RADIUS || '20', 10)
const PVP_WHITELIST = (process.env.PVP_WHITELIST || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean)

if (!HOST) {
  console.error('خطا: متغیر محیطی SERVER_HOST تنظیم نشده است.')
  process.exit(1)
}

let bot = null
let spawnPos = null
let walkTimer = null
let reconnectTimer = null
let combatWatcher = null
let inCombat = false

// ===== محافظ کلی برنامه (خط دفاعی آخر) =====
process.on('uncaughtException', (err) => {
  console.log('[Yuta] خطای غیرمنتظره کنترل شد:', err.message)
  try {
    if (bot) bot.quit()
  } catch (e) {
    // نادیده گرفته می‌شود
  }
  stopWalking()
  stopCombatWatcher()
  scheduleReconnect()
})

process.on('unhandledRejection', (reason) => {
  console.log('[Yuta] Promise rejection کنترل نشده:', reason)
})

function createBot() {
  console.log(`[Yuta] در حال اتصال به ${HOST}:${PORT} ...`)

  bot = mineflayer.createBot({
    host: HOST,
    port: PORT,
    username: USERNAME,
    version: MC_VERSION,
    auth: 'offline' // برای سرورهای آفلاین/کرک آترنوس. اگر سرور آنلاین-مود دارد، این را بردارید.
  })

  // ===== محافظ: جلوگیری از کرش به‌خاطر پیام‌های چت با فرمت ناشناخته =====
  const originalClientEmit = bot._client.emit.bind(bot._client)
  bot._client.emit = function (event, ...args) {
    try {
      return originalClientEmit(event, ...args)
    } catch (err) {
      console.log(`[Yuta] یک پیام از سرور قابل پردازش نبود و نادیده گرفته شد (${event}): ${err.message}`)
      return false
    }
  }

  bot.loadPlugin(pathfinder)
  bot.loadPlugin(pvpPlugin)

  bot.once('spawn', () => {
    console.log('[Yuta] وارد سرور شد.')
    spawnPos = bot.entity.position.clone()

    const movements = new Movements(bot)
    bot.pathfinder.setMovements(movements)

    // وقتی حریف بیش از COMBAT_RADIUS بلاک دور بشه، بات خودش دست از تعقیب می‌کشه
    bot.pvp.viewDistance = COMBAT_RADIUS
    bot.pvp.followRange = 2

    // ابتدا تلاش برای ثبت‌نام، سپس ورود
    setTimeout(() => {
      try { bot.chat(`/register ${PASSWORD} ${PASSWORD}`) } catch (e) {}
    }, 2000)

    setTimeout(() => {
      try { bot.chat(`/login ${PASSWORD}`) } catch (e) {}
    }, 5000)

    startWalking()
    startCombatWatcher()
  })

  bot.on('message', (jsonMsg) => {
    try {
      const text = jsonMsg.toString()
      if (text.trim().length > 0) console.log('[چت سرور]', text)
    } catch (e) {
      console.log('[Yuta] خطا در نمایش پیام چت (نادیده گرفته شد):', e.message)
    }
  })

  // وقتی کسی به بات حمله کنه، فوری وارد نبرد می‌شه (حتی اگه در شعاع دیدش نبود)
  bot.on('entityHurt', (entity) => {
    if (entity !== bot.entity) return
  })

  bot._client.on('damage_event', () => {})

  bot.on('stoppedAttacking', () => {
    console.log('[Yuta] نبرد پایان یافت (حریف کشته شد یا دور شد).')
    inCombat = false
  })

  bot.on('kicked', (reason) => {
    console.log('[Yuta] از سرور اخراج شد:', reason)
    stopWalking()
    stopCombatWatcher()
    scheduleReconnect()
  })

  bot.on('end', () => {
    console.log('[Yuta] اتصال قطع شد.')
    stopWalking()
    stopCombatWatcher()
    scheduleReconnect()
  })

  bot.on('error', (err) => {
    console.log('[Yuta] خطا:', err.message)
  })
}

function scheduleReconnect() {
  if (reconnectTimer) return
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null
    createBot()
  }, RECONNECT_DELAY_MS)
}

// ===== راه رفتن معمولی (AFK) =====
function startWalking() {
  stopWalking()
  walkTimer = setInterval(walkRandom, WALK_INTERVAL_MS)
}

function stopWalking() {
  if (walkTimer) {
    clearInterval(walkTimer)
    walkTimer = null
  }
}

function walkRandom() {
  if (!bot || !bot.entity || !spawnPos || inCombat) return

  const dx = Math.floor(Math.random() * (WALK_RADIUS * 2 + 1)) - WALK_RADIUS
  const dz = Math.floor(Math.random() * (WALK_RADIUS * 2 + 1)) - WALK_RADIUS
  const targetX = spawnPos.x + dx
  const targetZ = spawnPos.z + dz

  console.log(`[Yuta] در حال حرکت به سمت (${targetX.toFixed(1)}, ${targetZ.toFixed(1)})`)

  try {
    const goal = new goals.GoalNear(targetX, spawnPos.y, targetZ, 1)
    bot.pathfinder.setGoal(goal)
  } catch (e) {
    console.log('[Yuta] خطا در حرکت:', e.message)
  }
}

// ===== نگهبان PvP: هر ثانیه دنبال نزدیک‌ترین بازیکن در شعاع نبرد می‌گرده =====
function startCombatWatcher() {
  stopCombatWatcher()
  combatWatcher = setInterval(() => {
    if (!bot || !bot.entity) return

    // اگر همین الان درگیر نبرد است، کاری نکن (خود پلاگین pvp مدیریتش می‌کنه)
    if (bot.pvp.target) {
      inCombat = true
      return
    }

    const target = findNearestEnemyPlayer()
    if (target) {
      console.log(`[Yuta] وارد نبرد شد با: ${target.username}`)
      inCombat = true
      equipBestWeapon()
      bot.pathfinder.setGoal(null) // توقف راه رفتن معمولی
      bot.pvp.attack(target)
    }
  }, 1000)
}

function stopCombatWatcher() {
  if (combatWatcher) {
    clearInterval(combatWatcher)
    combatWatcher = null
  }
  inCombat = false
}

function findNearestEnemyPlayer() {
  let nearest = null
  let nearestDist = Infinity

  for (const name in bot.players) {
    if (name === bot.username) continue
    if (PVP_WHITELIST.includes(name)) continue

    const player = bot.players[name]
    if (!player.entity) continue

    const dist = bot.entity.position.distanceTo(player.entity.position)
    if (dist <= COMBAT_RADIUS && dist < nearestDist) {
      nearest = player.entity
      nearestDist = dist
    }
  }

  return nearest
}

function equipBestWeapon() {
  const weaponPriority = [
    'netherite_sword', 'diamond_sword', 'iron_sword', 'stone_sword', 'golden_sword', 'wooden_sword',
    'netherite_axe', 'diamond_axe', 'iron_axe', 'stone_axe', 'golden_axe', 'wooden_axe'
  ]
  for (const name of weaponPriority) {
    const item = bot.inventory.items().find(i => i.name === name)
    if (item) {
      bot.equip(item, 'hand').catch(() => {})
      return
    }
  }
}

// یک سرور HTTP کوچک فقط برای اینکه Railway بتونه سلامت سرویس رو چک کنه
const HEALTH_PORT = process.env.PORT || 3000
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' })
  res.end('Yuta bot is running.')
}).listen(HEALTH_PORT, () => {
  console.log(`[Yuta] سرور سلامت روی پورت ${HEALTH_PORT} فعال شد.`)
})

createBot()
