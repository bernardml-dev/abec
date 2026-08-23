// monitor-loop.js
// Roda continuamente (dentro de uma única execução do GitHub Actions) checando
// o estoque de flores e concentrados a cada 1 minuto, por um período limitado
// (LOOP_MINUTES), evitando depender do agendador (cron) do GitHub para cada
// checagem individual — só depende dele pra "acordar" o loop de tempos em tempos.

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const BASE_URL = "https://bot.abecmed.com.br/api/v1";
const TYPEBOT_ID = "pix-pagamento";

const CHECK_INTERVAL_MS = 60 * 1000; // checa a cada 1 minuto
const LOOP_MINUTES = Number(process.env.LOOP_MINUTES || 115); // ~1h55 por padrão
const LOOP_DURATION_MS = LOOP_MINUTES * 60 * 1000;

const CPF = process.env.ABEC_CPF;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

if (!CPF || !TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
  console.error(
    "Faltando variáveis de ambiente obrigatórias: ABEC_CPF, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID"
  );
  process.exit(1);
}

const CATEGORIES = [
  {
    stateFile: path.join(__dirname, "state.json"),
    label: "flores",
    choiceText: "Quero adquirir flores!",
  },
  {
    stateFile: path.join(__dirname, "state-concentrados.json"),
    label: "concentrados",
    choiceText: "Quero adquirir concentrados!",
  },
];

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
    body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text, parse_mode: "HTML" }),
  });
  if (!res.ok) {
    console.error("Falha ao enviar Telegram:", await res.text());
  }
}

function loadState(stateFile) {
  try {
    return JSON.parse(fs.readFileSync(stateFile, "utf8"));
  } catch {
    return { products: [] };
  }
}

function saveState(stateFile, state) {
  fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
}

// Faz uma checagem completa (login + escolha da categoria) e retorna a lista de produtos.
async function checkCategory(category) {
  const start = await startChat();
  const sessionId = start.sessionId;

  await continueChat(sessionId, "Sou Paciente");
  await continueChat(sessionId, CPF);
  await continueChat(sessionId, "Estou ciente");

  const response = await continueChat(sessionId, category.choiceText);

  let currentProducts = [];
  for (const msg of response.messages || []) {
    currentProducts.push(...extractProductLines(msg));
  }
  return [...new Set(currentProducts)];
}

// Faz commit + push do repositório se algum arquivo de estado tiver mudado.
function commitStateIfChanged() {
  try {
    const diff = execSync("git status --porcelain -- state.json state-concentrados.json", {
      cwd: __dirname,
    })
      .toString()
      .trim();
    if (!diff) return;

    execSync("git add state.json state-concentrados.json", { cwd: __dirname });
    execSync('git commit -m "Atualiza estado do estoque [skip ci]"', { cwd: __dirname });
    execSync("git push", { cwd: __dirname });
    console.log("Estado commitado e enviado pro repositório.");
  } catch (err) {
    console.error("Falha ao commitar/enviar o estado:", err.message);
  }
}

// Evita mandar o mesmo alerta de erro repetidamente a cada minuto dentro da mesma execução.
const alreadyAlerted = new Set();

async function runOneCheck(category) {
  try {
    const currentProducts = await checkCategory(category);
    const state = loadState(category.stateFile);
    const previousProducts = state.products || [];

    const newItems = currentProducts.filter((p) => !previousProducts.includes(p));
    const removedItems = previousProducts.filter((p) => !currentProducts.includes(p));

    if (newItems.length > 0 || removedItems.length > 0) {
      let message = `🌿 <b>Mudança no estoque de ${category.label} da ABECMED!</b>\n\n`;
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

      console.log(`[${category.label}] Mudança detectada, enviando aviso no Telegram...`);
      await sendTelegram(message);
    } else {
      console.log(`[${category.label}] Sem mudanças.`);
    }

    saveState(category.stateFile, { products: currentProducts, lastChecked: new Date().toISOString() });
  } catch (err) {
    console.error(`[${category.label}] Erro:`, err.message);
    if (!alreadyAlerted.has(category.label)) {
      alreadyAlerted.add(category.label);
      await sendTelegram(
        `⚠️ <b>O monitor de ${category.label} da ABECMED encontrou um erro.</b>\n\n` +
          `Provavelmente o fluxo do chat mudou (nova pergunta, novo botão, etc). ` +
          `Vou continuar tentando nesta janela, mas se persistir, o fluxo precisa ser revisado.\n\n` +
          `Erro técnico: ${err.message}`
      );
    }
  }
}

async function main() {
  const endTime = Date.now() + LOOP_DURATION_MS;
  console.log(
    `[${new Date().toISOString()}] Iniciando loop de monitoramento por ~${LOOP_MINUTES} minutos...`
  );

  while (Date.now() < endTime) {
    const cycleStart = Date.now();

    for (const category of CATEGORIES) {
      await runOneCheck(category);
    }

    commitStateIfChanged();

    const elapsed = Date.now() - cycleStart;
    const sleepMs = Math.max(0, CHECK_INTERVAL_MS - elapsed);
    if (Date.now() + sleepMs < endTime) {
      await new Promise((resolve) => setTimeout(resolve, sleepMs));
    } else {
      break; // não vale a pena dormir se já vai passar do tempo da janela
    }
  }

  console.log(`[${new Date().toISOString()}] Fim da janela de monitoramento.`);
}

main().catch(async (err) => {
  console.error("Erro fatal no loop:", err);
  await sendTelegram(`⚠️ <b>O monitor da ABECMED caiu inesperadamente.</b>\n\nErro: ${err.message}`);
  process.exit(1);
});
