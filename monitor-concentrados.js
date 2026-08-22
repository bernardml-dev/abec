// monitor-concentrados.js
// Igual ao monitor.js, mas clica em "Quero adquirir concentrados!" em vez de flores.
// Mantém um arquivo de estado separado (state-concentrados.json) pra não misturar
// as duas listas.

const fs = require("fs");
const path = require("path");

const BASE_URL = "https://bot.abecmed.com.br/api/v1";
const TYPEBOT_ID = "pix-pagamento";
const STATE_FILE = path.join(__dirname, "state-concentrados.json");
const CATEGORY_LABEL = "concentrados";
const CHOICE_TEXT = "Quero adquirir concentrados!";

const CPF = process.env.ABEC_CPF;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

if (!CPF || !TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
  console.error(
    "Faltando variáveis de ambiente obrigatórias: ABEC_CPF, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID"
  );
  process.exit(1);
}

const commonHeaders = {
  accept: "application/json",
  "content-type": "application/json",
};

function extractText(richText) {
  let out = "";
  for (const node of richText || []) {
    if (typeof node.text === "string") out += node.text;
    if (node.children) out += extractText(node.children);
    if (node.type === "li" || node.type === "p") out += "\n";
  }
  return out;
}

function extractProductLines(message) {
  const lines = [];
  function walk(nodes) {
    for (const node of nodes || []) {
      if (node.type === "li" || node.type === "lic") {
        const text = extractText(node.children).trim();
        if (text) lines.push(text);
      }
      if (node.children) walk(node.children);
    }
  }
  walk(message?.content?.richText || []);
  return lines;
}

async function continueChat(sessionId, text) {
  const res = await fetch(`${BASE_URL}/sessions/${sessionId}/continueChat`, {
    method: "POST",
    headers: commonHeaders,
    body: JSON.stringify({ message: { type: "text", text } }),
  });
  if (!res.ok) {
    throw new Error(`continueChat falhou (${res.status}): ${await res.text()}`);
  }
  return res.json();
}

async function startChat() {
  const res = await fetch(`${BASE_URL}/typebots/${TYPEBOT_ID}/startChat`, {
    method: "POST",
    headers: commonHeaders,
    body: JSON.stringify({
      isStreamEnabled: true,
      prefilledVariables: {},
      isOnlyRegistering: false,
    }),
  });
  if (!res.ok) {
    throw new Error(`startChat falhou (${res.status}): ${await res.text()}`);
  }
  return res.json();
}

async function sendTelegram(text) {
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chat_id: TELEGRAM_CHAT_ID,
      text,
      parse_mode: "HTML",
    }),
  });
  if (!res.ok) {
    console.error("Falha ao enviar Telegram:", await res.text());
  }
}

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch {
    return { products: [] };
  }
}

function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

async function main() {
  console.log(`[${new Date().toISOString()}] Checando estoque de ${CATEGORY_LABEL}...`);

  const start = await startChat();
  const sessionId = start.sessionId;

  await continueChat(sessionId, "Sou Paciente");
  await continueChat(sessionId, CPF);
  await continueChat(sessionId, "Estou ciente");

  // Essa resposta já traz a lista de produtos (ou a mensagem de "sem disponibilidade",
  // que não tem nenhum item de lista, então currentProducts naturalmente fica vazio).
  const response = await continueChat(sessionId, CHOICE_TEXT);

  let currentProducts = [];
  for (const msg of response.messages || []) {
    currentProducts.push(...extractProductLines(msg));
  }
  currentProducts = [...new Set(currentProducts)];

  console.log("Produtos encontrados agora:", currentProducts);

  const state = loadState();
  const previousProducts = state.products || [];

  const newItems = currentProducts.filter((p) => !previousProducts.includes(p));
  const removedItems = previousProducts.filter((p) => !currentProducts.includes(p));

  if (newItems.length > 0 || removedItems.length > 0) {
    let message = `🌿 <b>Mudança no estoque de ${CATEGORY_LABEL} da ABECMED!</b>\n\n`;
    if (newItems.length > 0) {
      message += "✅ <b>Novos itens:</b>\n" + newItems.map((p) => `• ${p}`).join("\n") + "\n\n";
    }
    if (removedItems.length > 0) {
      message += "❌ <b>Saíram da lista:</b>\n" + removedItems.map((p) => `• ${p}`).join("\n") + "\n\n";
    }
    message +=
      currentProducts.length > 0
        ? "📋 <b>Lista atual completa:</b>\n" + currentProducts.map((p) => `• ${p}`).join("\n")
        : "📋 Lista atual: nenhum item disponível no momento.";

    console.log("Mudança detectada, enviando aviso no Telegram...");
    await sendTelegram(message);
  } else {
    console.log("Sem mudanças desde a última checagem.");
  }

  saveState({ products: currentProducts, lastChecked: new Date().toISOString() });
}

main().catch(async (err) => {
  console.error("Erro:", err);
  try {
    await sendTelegram(
      `⚠️ <b>O monitor de ${CATEGORY_LABEL} da ABECMED parou de funcionar.</b>\n\n` +
        `Provavelmente o fluxo do chat mudou (nova pergunta, novo botão, etc).\n\n` +
        `Erro técnico: ${err.message}`
    );
  } catch (telegramErr) {
    console.error("Além do erro original, falhou ao avisar no Telegram:", telegramErr);
  }
  process.exit(1);
});
