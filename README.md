# Monitor de estoque ABECMED

Script que passa automaticamente pelo fluxo do chat da ABECMED e te avisa no
Telegram quando a lista de flores disponíveis mudar. Roda de graça na nuvem
via GitHub Actions, a cada 5 minutos.

## Passo 1 — Criar um bot no Telegram

1. No Telegram, procure por **@BotFather** e inicie uma conversa.
2. Envie `/newbot` e siga as instruções (escolha um nome e um username).
3. Ao final, o BotFather te dá um **token** (algo como
   `123456789:ABCdefGhIJKlmNoPQRstuVwXyZ`). Guarde esse token.
4. Agora envie **qualquer mensagem** para o bot que você acabou de criar
   (procure pelo username que você escolheu e clique em "Iniciar"/"Start").
5. Para descobrir seu **chat_id**, acesse no navegador (trocando `<TOKEN>`
   pelo token do passo 3):
   `https://api.telegram.org/bot<TOKEN>/getUpdates`
   Você vai ver um JSON com `"chat":{"id": 123456789, ...}` — esse número é
   o seu `chat_id`.

## Passo 2 — Criar o repositório no GitHub

1. Crie uma conta no [GitHub](https://github.com) se ainda não tiver.
2. Crie um **repositório novo**, pode ser **privado** (recomendado, já que
   vai ter seu CPF envolvido na lógica, mesmo que não fique no código).
3. Suba estes arquivos para o repositório (pela interface web do GitHub
   dá pra arrastar e soltar os arquivos, ou usando `git` se preferir).

## Passo 3 — Configurar os "Secrets" (dados sensíveis)

No repositório, vá em **Settings → Secrets and variables → Actions →
New repository secret** e crie estes três secrets:

| Nome                 | Valor                                    |
|----------------------|-------------------------------------------|
| `ABEC_CPF`           | Seu CPF com máscara, ex: `114.100.967-69`  |
| `TELEGRAM_BOT_TOKEN` | O token do BotFather (passo 1.3)           |
| `TELEGRAM_CHAT_ID`   | O chat_id que você pegou no passo 1.5      |

Isso mantém esses dados fora do código-fonte.

## Passo 4 — Ativar

O workflow já está configurado para rodar sozinho a cada 5 minutos
(arquivo `.github/workflows/monitor.yml`). Você também pode testar na hora:
vá na aba **Actions** do repositório → escolha "Monitor estoque ABECMED" →
**Run workflow**.

Se dentro de 1-2 minutos você não receber nada no Telegram, é porque não
houve mudança na lista (comportamento esperado). Para forçar um teste de
notificação, apague o conteúdo de `state.json` (deixe `"products": []`) e
rode o workflow manualmente — ele vai comparar com uma lista vazia e achar
que tudo é "novo".

## Como funciona

O script (`monitor.js`) simula o mesmo fluxo que você faz manualmente no
chat: início → "Sou Paciente" → CPF → "Estou ciente" → "Quero adquirir
flores!". A resposta desse último passo já traz a lista de produtos com
preço, então o script para por aí — não avança para escolha de produto
nem pagamento.

Ele salva a última lista vista em `state.json` (que fica versionado no
próprio repositório) e, a cada execução, compara com a lista atual. Se
tiver item novo (ou algum sumindo), manda uma mensagem no Telegram.

## Observações importantes

- **Frequência:** o GitHub Actions não garante o `cron` no minuto exato —
  em horários de pico pode atrasar alguns minutos. Na prática funciona bem
  para esse uso.
- **Uso justo:** isso está automatizando acessos a um sistema de uma
  associação de pacientes. Vale considerar um intervalo que não sobrecarregue
  o servidor deles (5 minutos é um intervalo razoável; evite deixar isso
  rodando a cada poucos segundos).
- **Se o fluxo do bot mudar** (a ABECMED alterar as perguntas/textos), o
  script vai quebrar e vai aparecer erro nos logs da aba Actions — é só me
  mandar o novo fluxo (do mesmo jeito que fizemos aqui) que eu ajusto.
