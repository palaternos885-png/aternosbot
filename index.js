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

if (!HOST) {
  console.error('خطا: متغیر محیطی SERVER_HOST تنظیم نشده است.')
  process.exit(1)
}

let bot = null
let spawnPos = null
let walkTimer = null
let reconnectTimer = null

// ===== محافظ کلی برنامه (خط دفاعی آخر) =====
process.on('uncaughtException', (err) => {
  console.log('[Yuta] خطای غیرمنتظره کنترل شد:', err.message)
  try {
    if (bot) bot.quit()
  } catch (e) {
    // نادیده گرفته می‌شود
  }
  stopWalking()
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

  // ===== محافظ اصلی: جلوگیری از کرش به‌خاطر پیام‌های چت با فرمت ناشناخته =====
  // بعضی از پیام‌های چت سرور (فرمت‌های خاص پروتکل 1.21.x مثل اسکوربورد یا اکشن‌بار)
  // کتابخونه‌ی داخلی prismarine-chat رو کرش می‌دن. با wrap کردن emit روی کلاینت
  // پروتکل، هر خطای پرتاب‌شده توسط هر شنونده‌ای (از جمله خود mineflayer) گرفته
  // می‌شه و فقط همون یک پیام نادیده گرفته می‌شه، بدون قطع اتصال.
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

    // ابتدا تلاش برای ثبت‌نام، سپس ورود
    setTimeout(() => {
      try { bot.chat(`/register ${PASSWORD} ${PASSWORD}`) } catch (e) {}
    }, 2000)

    setTimeout(() => {
      try { bot.chat(`/login ${PASSWORD}`) } catch (e) {}
    }, 5000)

    startWalking()
  })

  bot.on('message', (jsonMsg) => {
    try {
      const text = jsonMsg.toString()
      if (text.trim().length > 0) console.log('[چت سرور]', text)
    } catch (e) {
      console.log('[Yuta] خطا در نمایش پیام چت (نادیده گرفته شد):', e.message)
    }
  })

  bot.on('kicked', (reason) => {
    console.log('[Yuta] از سرور اخراج شد:', reason)
    stopWalking()
    scheduleReconnect()
  })

  bot.on('end', () => {
    console.log('[Yuta] اتصال قطع شد.')
    stopWalking()
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
  if (!bot || !bot.entity || !spawnPos) return

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

// یک سرور HTTP کوچک فقط برای اینکه Railway بتونه سلامت سرویس رو چک کنه
const HEALTH_PORT = process.env.PORT || 3000
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' })
  res.end('Yuta bot is running.')
}).listen(HEALTH_PORT, () => {
  console.log(`[Yuta] سرور سلامت روی پورت ${HEALTH_PORT} فعال شد.`)
})

createBot()
