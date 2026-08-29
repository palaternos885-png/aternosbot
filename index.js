const mineflayer = require('mineflayer')
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder')
const { plugin: pvpPlugin } = require('mineflayer-pvp')
const http = require('http')

// ===== تنظیمات (از Environment Variables خونده می‌شوند) =====
const HOST = process.env.SERVER_HOST
const PORT = parseInt(process.env.SERVER_PORT || '25565', 10)
const USERNAME = process.env.BOT_USERNAME || 'Yuta'
const PASSWORD = process.env.BOT_PASSWORD || '13501350'
const MC_VERSION = process.env.MC_VERSION || '1.21.1'
const WALK_RADIUS = parseInt(process.env.WALK_RADIUS || '10', 10)
const WALK_INTERVAL_MIN = parseFloat(process.env.WALK_INTERVAL_MINUTES || '5')
const WALK_INTERVAL_MS = WALK_INTERVAL_MIN * 60 * 1000
const RECONNECT_DELAY_MS = 15 * 1000

// افرادی که یوتا هرگز بهشون حمله نمی‌کنه، ولی همیشه ازشون دفاع می‌کنه
const PROTECTED_PLAYERS = (process.env.PVP_WHITELIST || 'ImVairo,TheDexline')
  .split(',').map(s => s.trim()).filter(Boolean)

// کسی که یوتا کمکش می‌کنه و دنبالش راه می‌ره (معدن‌کاوی و غیره)
const FOLLOW_PLAYER = process.env.FOLLOW_PLAYER || 'ImVairo'
const FOLLOW_DISTANCE = 3
const TELEPORT_DISTANCE = 40
const POST_TELEPORT_GRACE_MS = 3000 // بعد از /tp چند ثانیه صبر می‌کنیم تا چانک‌ها لود بشن

// توجه: موجودات پرنده (phantom, ghast, blaze, vex) عمداً حذف شدن، چون
// تعقیب هدف در هوا باعث میشه حرکت بات با فیزیک سرور همخونی نداشته باشه
// و سرور اونو با خطای invalid_player_movement اخراج کنه.
const HOSTILE_MOBS = new Set([
  'zombie', 'skeleton', 'spider', 'creeper', 'enderman', 'witch', 'drowned',
  'husk', 'stray', 'pillager', 'vindicator', 'evoker', 'ravager',
  'zombie_villager', 'cave_spider', 'silverfish',
  'magma_cube', 'slime', 'piglin_brute', 'hoglin', 'zoglin',
  'wither_skeleton', 'guardian', 'elder_guardian', 'shulker'
])

if (!HOST) {
  console.error('خطا: متغیر محیطی SERVER_HOST تنظیم نشده است.')
  process.exit(1)
}

let bot = null
let spawnPos = null
let walkTimer = null
let followTimer = null
let reconnectTimer = null
let inCombat = false
let followingImVairo = false
let teleportGraceUntil = 0

// ===== محافظ عمومی: هیچ خطای داخلی نباید کل برنامه رو کرش کنه =====
// این تابع روی هر EventEmitter (bot و bot._client) اعمال می‌شه تا اگه هر
// کدام از پلاگین‌ها (pathfinder, pvp, و غیره) یا خود کد ما خطا بده،
// فقط لاگ بشه و اتصال قطع نشه.
function guardEmitter(emitter, label) {
  const original = emitter.emit.bind(emitter)
  emitter.emit = function (event, ...args) {
    try {
      return original(event, ...args)
    } catch (err) {
      console.log(`[Yuta] خطای داخلی کنترل شد (${label}/${event}): ${err.message}`)
      return false
    }
  }
}

process.on('uncaughtException', (err) => {
  console.log('[Yuta] خطای غیرمنتظره کنترل شد:', err.message)
  try { if (bot) bot.quit() } catch (e) {}
  stopAllTimers()
  scheduleReconnect()
})

process.on('unhandledRejection', (reason) => {
  console.log('[Yuta] Promise rejection کنترل نشده (نادیده گرفته شد):', reason && reason.message ? reason.message : reason)
})

function createBot() {
  console.log(`[Yuta] در حال اتصال به ${HOST}:${PORT} ...`)

  bot = mineflayer.createBot({
    host: HOST,
    port: PORT,
    username: USERNAME,
    version: MC_VERSION,
    auth: 'offline'
  })

  guardEmitter(bot._client, 'client')
  guardEmitter(bot, 'bot')

  bot.loadPlugin(pathfinder)
  bot.loadPlugin(pvpPlugin)

  bot.once('spawn', () => {
    console.log('[Yuta] وارد سرور شد.')
    spawnPos = bot.entity.position.clone()

    const movements = new Movements(bot)
    movements.allowParkour = false
    movements.canDig = false
    movements.allow1by1towers = false
    bot.pathfinder.setMovements(movements)

    bot.pvp.followRange = 2

    setTimeout(() => { safeChat(`/register ${PASSWORD} ${PASSWORD}`) }, 2000)
    setTimeout(() => { safeChat(`/login ${PASSWORD}`) }, 5000)

    startWalking()
    startFollowing()
  })

  bot.on('message', (jsonMsg) => {
    try {
      const text = jsonMsg.toString()
      if (text.trim().length > 0) console.log('[چت سرور]', text)
    } catch (e) {
      console.log('[Yuta] خطا در نمایش پیام چت (نادیده گرفته شد):', e.message)
    }
  })

  // ===== تشخیص دقیق حمله‌کننده با استفاده از پکت damage_event =====
  bot._client.on('packet', (data, meta) => {
    if (meta.name !== 'damage_event') return
    try {
      handleDamageEvent(data)
    } catch (e) {
      console.log('[Yuta] خطا در پردازش رویداد آسیب (نادیده گرفته شد):', e.message)
    }
  })

  bot.on('stoppedAttacking', () => {
    console.log('[Yuta] نبرد پایان یافت.')
    inCombat = false
    resumeIdleBehavior()
  })

  bot.on('kicked', (reason) => {
    console.log('[Yuta] از سرور اخراج شد:', reason)
    stopAllTimers()
    scheduleReconnect()
  })

  bot.on('end', () => {
    console.log('[Yuta] اتصال قطع شد.')
    stopAllTimers()
    scheduleReconnect()
  })

  bot.on('error', (err) => {
    console.log('[Yuta] خطا:', err.message)
  })
}

// ===== منطق واکنش به آسیب =====
function handleDamageEvent(data) {
  if (!bot || !bot.entity) return

  const victim = bot.entities[data.entityId]
  if (!victim) return

  let attacker = null
  const rawCauseId = data.sourceCauseId
  if (rawCauseId) {
    attacker = bot.entities[rawCauseId] || bot.entities[rawCauseId - 1] || null
  }
  if (!attacker) return // آسیب بدون منبع مشخص (افتادن، آتش و غیره) - نادیده بگیر

  const victimIsBot = victim.id === bot.entity.id
  const victimUsername = victim.username || null
  const attackerUsername = attacker.username || null

  // حالت ۱: خود یوتا آسیب دیده
  if (victimIsBot) {
    console.log(`[Yuta] یوتا آسیب دید از: ${attackerUsername || attacker.name || 'نامشخص'}`)
    if (attackerUsername && PROTECTED_PLAYERS.includes(attackerUsername)) {
      console.log('[Yuta] حمله‌کننده جزو افراد محافظت‌شده‌ست، فقط واکنش نشون می‌ده.')
      sitStandGesture()
      return
    }
    if (attacker.type === 'player' || HOSTILE_MOBS.has(attacker.name)) {
      engageCombat(attacker)
    }
    return
  }

  // حالت ۲: یکی از افراد تحت حمایت (ImVairo / TheDexline) آسیب دیده
  if (victimUsername && PROTECTED_PLAYERS.includes(victimUsername)) {
    // اگه حمله‌کننده خود یوتاست، کاری نکن
    if (attacker.id === bot.entity.id) return
    // اگه حمله‌کننده یکی دیگه از افراد تحت حمایته (اتفاقی)، دخالت نکن
    if (attackerUsername && PROTECTED_PLAYERS.includes(attackerUsername)) return

    if (attacker.type === 'player' || HOSTILE_MOBS.has(attacker.name)) {
      engageCombat(attacker)
    }
    return
  }

  // حالت ۳: بقیه‌ی درگیری‌ها به یوتا ربطی نداره
}

function engageCombat(target) {
  if (!bot || !bot.pvp) return
  console.log(`[Yuta] وارد نبرد شد با: ${target.username || target.name}`)
  inCombat = true
  pauseIdleBehavior()
  equipBestWeapon()
  try {
    bot.pvp.attack(target)
  } catch (e) {
    console.log('[Yuta] خطا در شروع نبرد:', e.message)
    inCombat = false
    resumeIdleBehavior()
  }
}

function sitStandGesture() {
  console.log('[Yuta] نشستن/بلندشدن (بدون حمله متقابل).')
  try {
    bot.setControlState('sneak', true)
    setTimeout(() => {
      try { bot.setControlState('sneak', false) } catch (e) {}
    }, 1200)
  } catch (e) {}
}

function equipBestWeapon() {
  const weaponPriority = [
    'netherite_sword', 'diamond_sword', 'iron_sword', 'stone_sword', 'golden_sword', 'wooden_sword',
    'netherite_axe', 'diamond_axe', 'iron_axe', 'stone_axe', 'golden_axe', 'wooden_axe'
  ]
  try {
    for (const name of weaponPriority) {
      const item = bot.inventory.items().find(i => i.name === name)
      if (item) {
        bot.equip(item, 'hand').catch(() => {})
        return
      }
    }
  } catch (e) {}
}

// ===== دنبال کردن و کمک به ImVairo =====
function startFollowing() {
  stopFollowing()
  followTimer = setInterval(() => {
    try {
      if (inCombat) return
      if (Date.now() < teleportGraceUntil) return // تازه تلپورت شده، صبر کن چانک‌ها لود بشن

      const target = bot.players[FOLLOW_PLAYER]
      if (!target) {
        if (followingImVairo) {
          followingImVairo = false
          try { bot.pathfinder.setGoal(null) } catch (e) {}
        }
        return
      }

      if (!target.entity) {
        followingImVairo = false
        try { bot.pathfinder.setGoal(null) } catch (e) {}
        safeChat(`/tp ${USERNAME} ${FOLLOW_PLAYER}`)
        teleportGraceUntil = Date.now() + POST_TELEPORT_GRACE_MS
        return
      }

      const dist = bot.entity.position.distanceTo(target.entity.position)
      if (dist > TELEPORT_DISTANCE) {
        followingImVairo = false
        try { bot.pathfinder.setGoal(null) } catch (e) {}
        safeChat(`/tp ${USERNAME} ${FOLLOW_PLAYER}`)
        teleportGraceUntil = Date.now() + POST_TELEPORT_GRACE_MS
        return
      }

      if (!followingImVairo) {
        followingImVairo = true
        stopWalking()
        bot.pathfinder.setGoal(new goals.GoalFollow(target.entity, FOLLOW_DISTANCE), true)
      }
    } catch (e) {
      console.log('[Yuta] خطا در دنبال کردن (نادیده گرفته شد):', e.message)
    }
  }, 5000)
}

function stopFollowing() {
  if (followTimer) {
    clearInterval(followTimer)
    followTimer = null
  }
  followingImVairo = false
}

// ===== راه رفتن معمولی وقتی وایرو آنلاین نیست =====
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
  if (!bot || !bot.entity || !spawnPos || inCombat || followingImVairo) return

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

function pauseIdleBehavior() {
  followingImVairo = false
  try { bot.pathfinder.setGoal(null) } catch (e) {}
}

function resumeIdleBehavior() {
  // چرخه‌های follow و walk خودشون در تیک بعدی وضعیت رو دوباره می‌سنجن
}

function safeChat(message) {
  try {
    if (bot) bot.chat(message)
  } catch (e) {
    console.log('[Yuta] خطا در ارسال پیام چت (نادیده گرفته شد):', e.message)
  }
}

function stopAllTimers() {
  stopWalking()
  stopFollowing()
  inCombat = false
}

function scheduleReconnect() {
  if (reconnectTimer) return
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null
    createBot()
  }, RECONNECT_DELAY_MS)
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
