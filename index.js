const mineflayer = require('mineflayer')
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder')
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

// ===== تنظیمات نبرد شبیه‌انسان =====
const ATTACK_COOLDOWN_MS = 650      // فاصله بین ضربات، مثل ریتم واقعی یه شمشیر
const ATTACK_REACH = 3              // فاصله‌ای که ضربه بزنه
const COMBAT_GIVEUP_RADIUS_MULT = 1.5 // اگه حریف چند برابر COMBAT_RADIUS دور شد، ول کن
const MAX_COMBAT_DURATION_MS = 90 * 1000 // سقف امن برای یه نبرد، بعدش عقب‌نشینی

if (!HOST) {
  console.error('خطا: متغیر محیطی SERVER_HOST تنظیم نشده است.')
  process.exit(1)
}

let bot = null
let spawnPos = null
let walkTimer = null
let reconnectTimer = null
let combatWatcher = null
let attackInterval = null
let combatTarget = null
let combatStartedAt = null
let inCombat = false
let loggedIn = false

// عبارت‌هایی که نشون میدن AuthMe لاگین رو تایید کرده (بسته به پلاگین ممکنه فرق کنه)
const LOGIN_SUCCESS_PATTERNS = [
  'successful login',
  'logged in',
  'you are now logged in',
  'ورود موفق'
]

// فاصله‌ی امن بعد از تایید لاگین، قبل از فعال کردن حرکت/نبرد
const POST_LOGIN_GRACE_MS = 3000

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

  bot.once('spawn', () => {
    console.log('[Yuta] وارد سرور شد.')
    spawnPos = bot.entity.position.clone()

    const movements = new Movements(bot)
    bot.pathfinder.setMovements(movements)

    // نبرد با منطق دستی (نه پلاگین pvp) برای اینکه حرکت طبیعی‌تر باشه

    loggedIn = false

    // ابتدا تلاش برای ثبت‌نام، سپس ورود
    setTimeout(() => {
      try { bot.chat(`/register ${PASSWORD} ${PASSWORD}`) } catch (e) {}
    }, 2000)

    setTimeout(() => {
      try { bot.chat(`/login ${PASSWORD}`) } catch (e) {}
    }, 5000)

    // اگه هیچ پیام تاییدی از سرور نگرفتیم، حداکثر بعد از ۱۲ ثانیه (فرض بر لاگین موفق) شروع کن
    // این یه fallback است، راه اصلی تشخیص از روی پیام چت سرور است (پایین)
    setTimeout(() => {
      confirmLogin('fallback timeout')
    }, 12000)
  })

  bot.on('message', (jsonMsg) => {
    try {
      const text = jsonMsg.toString()
      if (text.trim().length > 0) console.log('[چت سرور]', text)

      const lower = text.toLowerCase()
      if (!loggedIn && LOGIN_SUCCESS_PATTERNS.some(p => lower.includes(p))) {
        confirmLogin('پیام سرور: ' + text.trim())
      }
    } catch (e) {
      console.log('[Yuta] خطا در نمایش پیام چت (نادیده گرفته شد):', e.message)
    }
  })

  // وقتی هدفِ نبرد کشته می‌شه
  bot.on('entityDead', (entity) => {
    if (combatTarget && entity === combatTarget) {
      endCombat('حریف کشته شد')
    }
  })

  bot.on('kicked', (reason) => {
    console.log('[Yuta] از سرور اخراج شد:', reason)
    loggedIn = false
    endCombat('اتصال قطع شد')
    stopWalking()
    stopCombatWatcher()
    scheduleReconnect()
  })

  bot.on('end', () => {
    console.log('[Yuta] اتصال قطع شد.')
    loggedIn = false
    endCombat('اتصال قطع شد')
    stopWalking()
    stopCombatWatcher()
    scheduleReconnect()
  })

  bot.on('error', (err) => {
    console.log('[Yuta] خطا:', err.message)
  })
}

function confirmLogin(reason) {
  if (loggedIn) return
  loggedIn = true
  console.log(`[Yuta] لاگین تایید شد (${reason}) — بعد از ${POST_LOGIN_GRACE_MS / 1000} ثانیه حرکت/نبرد فعال می‌شود.`)
  setTimeout(() => {
    if (!bot || !bot.entity) return
    startWalking()
    startCombatWatcher()
  }, POST_LOGIN_GRACE_MS)
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
  if (!bot || !bot.entity || !spawnPos || inCombat || !loggedIn) return

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
    if (!bot || !bot.entity || !loggedIn) return
    if (combatTarget) return // همین الان درگیر نبرد است

    const target = findNearestEnemyPlayer()
    if (target) {
      engageCombat(target)
    }
  }, 1000)
}

function stopCombatWatcher() {
  if (combatWatcher) {
    clearInterval(combatWatcher)
    combatWatcher = null
  }
}

// شروع نبرد: تعقیب با pathfinder (همون سیستمی که برای راه‌رفتن پایدار بود)
// + ضربه با ریتم واقعی یه بازیکن، نه هر تیک
// + اگه حریف خیلی بالاتر باشه (مثلاً داره پرواز می‌کنه)، تعقیبش نمی‌کنیم چون
//   pathfinder زمینی برای رسیدن بهش مدام تلاش/شکست می‌خوره و همین حرکت نامنظم تولید می‌کنه
const MAX_CHASE_HEIGHT_DIFF = 3

function engageCombat(target) {
  console.log(`[Yuta] وارد نبرد شد با: ${target.username}`)
  inCombat = true
  combatTarget = target
  combatStartedAt = Date.now()
  equipBestWeapon()

  let chasing = false

  const updateChase = () => {
    if (!bot || !bot.entity || !combatTarget) return
    const dy = combatTarget.position.y - bot.entity.position.y

    if (dy > MAX_CHASE_HEIGHT_DIFF) {
      // حریف احتمالاً در حال پروازه - تعقیب نمی‌کنیم، فقط سرجامون می‌مونیم
      if (chasing) {
        try { bot.pathfinder.setGoal(null) } catch (e) {}
        chasing = false
      }
    } else if (!chasing) {
      try {
        bot.pathfinder.setGoal(new goals.GoalFollow(combatTarget, 2), true)
        chasing = true
      } catch (e) {
        console.log('[Yuta] خطا در تعقیب حریف:', e.message)
      }
    }
  }

  updateChase()

  if (attackInterval) clearInterval(attackInterval)
  attackInterval = setInterval(() => {
    if (!bot || !bot.entity || !combatTarget) {
      endCombat('حریف در دسترس نیست')
      return
    }

    // اگه بازیکن دیگه توی لیست بازیکنای سرور نیست (خارج شد)
    const stillPresent = Object.values(bot.players).some(p => p.entity === combatTarget)
    if (!stillPresent) {
      endCombat('حریف دیگه در سرور نیست')
      return
    }

    const dist = bot.entity.position.distanceTo(combatTarget.position)

    if (dist > COMBAT_RADIUS * COMBAT_GIVEUP_RADIUS_MULT) {
      endCombat('حریف خیلی دور شد')
      return
    }

    if (Date.now() - combatStartedAt > MAX_COMBAT_DURATION_MS) {
      endCombat('سقف زمانی نبرد (احتیاطی)')
      return
    }

    updateChase()

    if (dist <= ATTACK_REACH) {
      try {
        bot.lookAt(combatTarget.position.offset(0, combatTarget.height * 0.8, 0))
        bot.attack(combatTarget)
      } catch (e) {
        // نادیده گرفته می‌شود
      }
    }
  }, ATTACK_COOLDOWN_MS)
}

function endCombat(reason) {
  if (!combatTarget && !inCombat) return
  console.log(`[Yuta] نبرد پایان یافت: ${reason}`)
  inCombat = false
  combatTarget = null
  combatStartedAt = null
  if (attackInterval) {
    clearInterval(attackInterval)
    attackInterval = null
  }
  try {
    if (bot && bot.pathfinder) bot.pathfinder.setGoal(null)
  } catch (e) {
    // نادیده گرفته می‌شود
  }
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
