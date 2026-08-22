// monitor.js
// Percorre o fluxo do bot da ABECMED até a lista de flores e avisa no Telegram
// quando a lista de produtos disponíveis mudar (item novo aparecer).

const fs = require("fs");
const path = require("path");

const BASE_URL = "https://bot.abecmed.com.br/api/v1";
const TYPEBOT_ID = "pix-pagamento";
const STATE_FILE = path.join(__dirname, "state.json");

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

// Extrai texto puro de um bloco richText do Typebot (percorre recursivamente).
function extractText(richText) {
  let out = "";
  for (const node of richText || []) {
    if (typeof node.text === "string") out += node.text;
    if (node.children) out += extractText(node.children);
    if (node.type === "li" || node.type === "p") out += "\n";
  }
  return out;
}

// Extrai as linhas "Nome - R$ preço" de dentro de uma mensagem (procura por listas <ul><li>).
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
  console.log(`[${new Date().toISOString()}] Checando estoque...`);

  // 1. Inicia a conversa
  const start = await startChat();
  const sessionId = start.sessionId;

  // 2. "Sou Paciente"
  await continueChat(sessionId, "Sou Paciente");

  // 3. Envia o CPF
  await continueChat(sessionId, CPF);

  // 4. "Estou ciente" (tela de aviso sobre validade da receita)
  await continueChat(sessionId, "Estou ciente");

  // 5. "Quero adquirir flores!" -> essa resposta já traz a lista de produtos
  const flowerResponse = await continueChat(sessionId, "Quero adquirir flores!");

  // Extrai todos os produtos listados em qualquer mensagem desta resposta
  let currentProducts = [];
  for (const msg of flowerResponse.messages || []) {
    currentProducts.push(...extractProductLines(msg));
  }
  currentProducts = [...new Set(currentProducts)]; // remove duplicados

  console.log("Produtos encontrados agora:", currentProducts);

  const state = loadState();
  const previousProducts = state.products || [];

  const newItems = currentProducts.filter((p) => !previousProducts.includes(p));
  const removedItems = previousProducts.filter((p) => !currentProducts.includes(p));

  if (newItems.length > 0 || removedItems.length > 0) {
    let message = "🌿 <b>Mudança no estoque da ABECMED!</b>\n\n";
    if (newItems.length > 0) {
      message += "✅ <b>Novos itens:</b>\n" + newItems.map((p) => `• ${p}`).join("\n") + "\n\n";
    }
    if (removedItems.length > 0) {
      message += "❌ <b>Saíram da lista:</b>\n" + removedItems.map((p) => `• ${p}`).join("\n") + "\n\n";
    }
    message += "📋 <b>Lista atual completa:</b>\n" + currentProducts.map((p) => `• ${p}`).join("\n");

    console.log("Mudança detectada, enviando aviso no Telegram...");
    await sendTelegram(message);
  } else {
    console.log("Sem mudanças desde a última checagem.");
  }

  saveState({ products: currentProducts, lastChecked: new Date().toISOString() });
}

main().catch(async (err) => {
  console.error("Erro:", err);
  // Opcional: descomente a linha abaixo se quiser ser avisado quando o script falhar
  // await sendTelegram(`⚠️ Erro no monitor da ABECMED: ${err.message}`);
  process.exit(1);
});
