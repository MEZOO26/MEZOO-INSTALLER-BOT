require("dotenv").config();

const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion
} = require("@whiskeysockets/baileys");
const pino = require("pino");
const qrcode = require("qrcode-terminal");

const BOT_NAME = process.env.BOT_NAME || "MEZOO BOT";
const API_KEY = process.env.OPENAI_API_KEY;
const MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";
const GROUP_COOLDOWN = Number(process.env.GROUP_REPLY_COOLDOWN_MS || 7000);
const MAX_PER_HOUR = Number(process.env.MAX_REPLIES_PER_GROUP_HOUR || 25);

const enabledGroups = new Set(); // تفعيل الجروب مؤقتًا أثناء تشغيل البوت
const lastReplyAt = new Map();
const hourlyCounts = new Map();
const seenMessages = new Set();
let sock;
let reconnecting = false;

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

function isGroup(jid) {
  return typeof jid === "string" && jid.endsWith("@g.us");
}

function getText(message) {
  const m = message?.message;
  if (!m) return "";
  return (
    m.conversation ||
    m.extendedTextMessage?.text ||
    m.imageMessage?.caption ||
    m.videoMessage?.caption ||
    m.documentMessage?.caption ||
    m.buttonsResponseMessage?.selectedDisplayText ||
    m.listResponseMessage?.title ||
    ""
  ).trim();
}

function getHourBucket(jid) {
  return `${jid}:${Math.floor(Date.now() / 3600000)}`;
}

function withinLimits(jid) {
  const now = Date.now();
  const last = lastReplyAt.get(jid) || 0;
  if (now - last < GROUP_COOLDOWN) return false;

  const bucket = getHourBucket(jid);
  const count = hourlyCounts.get(bucket) || 0;
  if (count >= MAX_PER_HOUR) return false;

  lastReplyAt.set(jid, now);
  hourlyCounts.set(bucket, count + 1);
  return true;
}

async function askAI(text, groupName = "محادثة") {
  if (!API_KEY || API_KEY.includes("ضع_مفتاح")) {
    return "خدمة الذكاء الاصطناعي غير مُعدّة بعد. أضف OPENAI_API_KEY في متغيرات البيئة.";
  }

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: MODEL,
      temperature: 0.7,
      max_tokens: 220,
      messages: [
        {
          role: "system",
          content: `أنت ${BOT_NAME}، مساعد ودود داخل ${groupName}. أجب بالعربية المصرية غالبًا، باختصار واحترام. لا تدّعِ أنك إنسان، ولا تكرر الرسائل، ولا تساعد في الإساءة أو الإزعاج أو كشف البيانات الخاصة.`
        },
        { role: "user", content: text.slice(0, 2500) }
      ]
    })
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    log("AI API error:", response.status, detail.slice(0, 300));
    return "حصلت مشكلة مؤقتة في خدمة الذكاء الاصطناعي. جرّب بعد شوية.";
  }

  const data = await response.json();
  return data.choices?.[0]?.message?.content?.trim() ||
    "مش قادر أجهز رد دلوقتي.";
}

async function isGroupAdmin(jid, participant) {
  try {
    const metadata = await sock.groupMetadata(jid);
    const member = metadata.participants.find(p => p.id === participant);
    return member?.admin === "admin" || member?.admin === "superadmin";
  } catch {
    return false;
  }
}

async function handleMessage(msg) {
  const jid = msg.key.remoteJid;
  if (!jid || msg.key.fromMe || msg.key.remoteJid === "status@broadcast") return;

  const id = msg.key.id;
  if (!id || seenMessages.has(id)) return;
  seenMessages.add(id);
  if (seenMessages.size > 3000) {
    const first = seenMessages.values().next().value;
    seenMessages.delete(first);
  }

  const text = getText(msg);
  if (!text) return;

  const sender = msg.key.participant || msg.key.remoteJid;
  const lower = text.toLowerCase();

  if (isGroup(jid)) {
    const admin = await isGroupAdmin(jid, sender);

    if (lower === "!enable") {
      if (!admin) return;
      enabledGroups.add(jid);
      return sock.sendMessage(jid, {
        text: `تم تفعيل ${BOT_NAME} في الجروب. هيرد على الرسائل مع وجود حدود لتقليل الإزعاج. استخدم !disable للإيقاف.`
      });
    }

    if (lower === "!disable") {
      if (!admin) return;
      enabledGroups.delete(jid);
      return sock.sendMessage(jid, { text: `تم إيقاف ${BOT_NAME} في هذا الجروب.` });
    }

    if (lower === "!menu" || lower === "!help") {
      return sock.sendMessage(jid, {
        text: `*${BOT_NAME}*\n!menu - عرض القائمة\n!enable - تفعيل الردود (للمشرفين)\n!disable - إيقاف الردود (للمشرفين)\n\nالرد على رسائل الجروب يعمل بعد موافقة المشرف وتفعيل البوت.`
      });
    }

    // لا يرد في الجروبات إلا بعد موافقة مشرف بتفعيل !enable.
    if (!enabledGroups.has(jid)) return;
    if (!withinLimits(jid)) return;

    const metadata = await sock.groupMetadata(jid).catch(() => null);
    const answer = await askAI(text, metadata?.subject || "جروب واتساب");
    await sock.sendMessage(jid, { text: answer }, { quoted: msg });
    return;
  }

  if (lower === "!menu" || lower === "!help") {
    return sock.sendMessage(jid, {
      text: `*${BOT_NAME}*\nابعت رسالتك وهرد عليك بالذكاء الاصطناعي.\nالأوامر: !menu و !help`
    });
  }

  const answer = await askAI(text, "محادثة خاصة");
  await sock.sendMessage(jid, { text: answer }, { quoted: msg });
}

async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState("auth_info");
  let version;
  try {
    ({ version } = await fetchLatestBaileysVersion());
  } catch {
    version = undefined;
  }

  sock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: "silent" }),
    printQRInTerminal: false,
    markOnlineOnConnect: false,
    syncFullHistory: false,
    generateHighQualityLinkPreview: false,
    defaultQueryTimeoutMs: 60000
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", update => {
    const { connection, lastDisconnect, qr } = update;
    if (qr) {
      log("امسح QR من واتساب > الأجهزة المرتبطة > ربط جهاز.");
      qrcode.generate(qr, { small: true });
    }
    if (connection === "open") {
      reconnecting = false;
      log(`${BOT_NAME} connected successfully.`);
    }
    if (connection === "close") {
      const code = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = code !== DisconnectReason.loggedOut;
      log("Connection closed. Reconnect:", shouldReconnect);
      if (shouldReconnect && !reconnecting) {
        reconnecting = true;
        setTimeout(() => startBot().catch(err => log("Restart error:", err)), 5000);
      } else if (!shouldReconnect) {
        log("تم تسجيل الخروج. احذف auth_info فقط إذا كنت تريد ربطًا جديدًا.");
      }
    }
  });

  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;
    for (const msg of messages) {
      try {
        await handleMessage(msg);
      } catch (err) {
        log("Message handler error:", err?.message || err);
      }
    }
  });
}

process.on("unhandledRejection", err => log("Unhandled rejection:", err));
process.on("uncaughtException", err => log("Uncaught exception:", err));

startBot().catch(err => {
  log("Startup failed:", err);
  process.exitCode = 1;
});
