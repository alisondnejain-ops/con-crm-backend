/* SEGURANÇA DO CONTORNO — freios, cabeçalhos e o que pode aparecer no log.
   (02/09/2026, pedido do Ali: "encontre vulnerabilidades e corrija todas")

   Três coisas moram aqui, e as três têm a mesma natureza: são regras que
   precisam valer em TODA rota, e por isso não podem estar escritas dentro de
   nenhuma. É a mesma razão de `semMaster` e de `moverLead` existirem — regra
   copiada em vinte lugares é regra que vale em dezenove. */

import crypto from "crypto";

/* ===== 1. O FREIO (força bruta) =====

   O `POST /auth/login` não tinha nenhum. Quem tivesse o e-mail de um corretor
   podia tentar senha atrás de senha, sem limite e sem deixar rastro — e como o
   `bcrypt.compareSync` PARA o servidor enquanto calcula (~20 ms cada), mil
   tentativas por segundo não descobririam só a senha: derrubariam o CRM da
   imobiliária inteira junto. Era uma porta e um martelo na mesma fechadura.

   A contagem é em MEMÓRIA, de propósito, e é a mesma decisão já tomada no
   `/publico/comecar`: some no reinício, não vira cadastro de ninguém, e o
   objetivo é impedir a enxurrada — não manter dossiê de quem errou a senha.
   Guardar tentativa de login no banco criaria um registro de comportamento de
   pessoas que a LGPD me obrigaria a justificar, para proteger contra um ataque
   que a memória já barra.

   DUAS CHAVES, sempre, e é o que a rota de esqueci-senha já ensinou: por IP
   (impede a varredura de senhas contra uma conta) e por CONTA (impede a
   varredura de contas a partir de muitos IPs). Só a primeira deixaria passar o
   ataque distribuído; só a segunda deixaria alguém trancar a conta do colega
   de fora — por isso a trava por conta é mais larga e mais curta. */
const tentativas = new Map();

/* Limpeza preguiçosa: sem ela o Map cresce para sempre num servidor que fica
   meses de pé, e um Map que só cresce é um vazamento de memória com outro
   nome. Roda quando ele passa de mil chaves, que é muito mais do que uma
   operação real produz por janela. */
function limpar(agora) {
  if (tentativas.size < 1000) return;
  for (const [k, v] of tentativas) if (v.ate <= agora) tentativas.delete(k);
}

/* Devolve `true` enquanto ainda há tentativa sobrando, e conta a atual. */
export function podeTentar(chave, teto, janelaMs) {
  const agora = Date.now();
  limpar(agora);
  const atual = tentativas.get(chave);
  if (!atual || atual.ate <= agora) {
    tentativas.set(chave, { n: 1, ate: agora + janelaMs });
    return true;
  }
  atual.n += 1;
  return atual.n <= teto;
}

/* Acertou a senha: a conta zera. Sem isto, quem erra quatro vezes, acerta na
   quinta e sai para o almoço volta bloqueado por um erro que já foi resolvido
   — e o freio passaria a atrapalhar exatamente quem ele deveria proteger. */
export const zerarTentativas = (...chaves) => { for (const c of chaves) tentativas.delete(c); };

/* Quantos segundos faltam. A resposta 429 DIZ o tempo: "tente de novo mais
   tarde" faz a pessoa tentar de novo agora, e cada nova tentativa renova o
   bloqueio dela. */
export function faltamSegundos(chave) {
  const a = tentativas.get(chave);
  return a && a.ate > Date.now() ? Math.ceil((a.ate - Date.now()) / 1000) : 0;
}

/* O IP de quem chamou.

   Atrás do Railway/Cloudflare o `req.ip` é o do proxy — igual para todo mundo
   —, e um freio por IP que vê um IP só bloquearia a internet inteira junto na
   primeira tentativa errada. O primeiro endereço do `x-forwarded-for` é o do
   visitante. Ele é falsificável por quem chama direto, e é por isso que ele
   NUNCA é a única trava: a segunda chave, a da conta, não depende de IP. */
export const ipDe = (req) =>
  String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() ||
  req.ip || req.socket?.remoteAddress || "sem-ip";

/* ===== 2. COMPARAÇÃO DE SEGREDO SEM VAZAR PELO TEMPO =====

   `a === b` em JavaScript para no primeiro caractere diferente, e o tempo que
   ele leva conta quantos caracteres iniciais estavam certos. Contra um token
   de webhook, onde o atacante pode tentar à vontade e medir, isso é uma pista
   real. `timingSafeEqual` compara sempre o texto inteiro.

   O tamanho é comparado antes porque `timingSafeEqual` LANÇA com tamanhos
   diferentes — e o tamanho de um token não é segredo. */
export function segredoConfere(recebido, esperado) {
  const a = Buffer.from(String(recebido || ""), "utf8");
  const b = Buffer.from(String(esperado || ""), "utf8");
  if (!b.length || a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/* ===== 3. O QUE PODE APARECER NO LOG =====

   O log do Railway não é privado: quem tem acesso ao painel da hospedagem lê
   tudo, ele fica retido, e num dia qualquer alguém liga um coletor de logs de
   terceiros. Antes disto o servidor escrevia, em texto puro:

     - o LINK DE CRIAR SENHA a cada redefinição. É a chave da conta. Um log com
       ele dentro é uma lista de contas prontas para serem tomadas, e o pior é
       que ninguém olharia para o log procurando isso;
     - o TELEFONE e o NOME de cada lead que entra. Isso é dado pessoal de
       cliente da imobiliária, guardado fora do banco, sem prazo para sumir e
       fora de qualquer pedido de exclusão que a pessoa faça. É exatamente o
       que a LGPD chama de tratamento sem finalidade nem retenção definida.

   O log continua servindo para diagnóstico — que é para o que ele existe. O
   que muda é que ele passa a identificar SEM identificar: dá para reconhecer o
   registro e cruzar com o banco, não dá para ler a agenda de clientes. */
export const semSegredo = (link) =>
  String(link || "").replace(/([?&](token|c)=)[^&\s]+/gi, "$1***");

export function mascararTelefone(tel) {
  const d = String(tel || "").replace(/\D/g, "");
  if (d.length < 6) return "***";
  // Guarda o DDD e os quatro últimos: é o bastante para achar a linha no banco
  // quando alguém reclama, e não é um número que se possa discar.
  return `${d.slice(0, 4)}****${d.slice(-2)}`;
}

export function mascararEmail(email) {
  const s = String(email || "");
  const [nome, dominio] = s.split("@");
  if (!dominio) return "***";
  return `${nome.slice(0, 1)}***${nome.slice(-1) || ""}@${dominio}`;
}

/* ===== 4. CABEÇALHOS DE SEGURANÇA =====

   Escritos à mão em vez de instalar o `helmet`. Não é teimosia: são seis
   linhas, e cada dependência nova neste projeto é mais uma coisa que pode
   quebrar o `npm install` numa hospedagem que o Ali administra sozinho — o
   `better-sqlite3` já ensinou isso.

   O que cada um evita, em uma linha:

   - `X-Content-Type-Options: nosniff` — impede o navegador de "adivinhar" que
     um arquivo enviado por um cliente é, na verdade, JavaScript e executá-lo.
     Este CRM aceita upload de arquivo de cliente, então isso não é teórico.
   - `X-Frame-Options: DENY` — ninguém abre o CRM dentro de um site falso para
     roubar clique (o corretor pensa que está clicando num anúncio e está
     apagando um lead).
   - `Referrer-Policy` — o endereço do CRM tem id de lead na navegação; sem
     isto ele viaja no cabeçalho para todo site que a pessoa abrir a seguir.
   - `Strict-Transport-Security` — trava o navegador em HTTPS por um ano.
     Só faz sentido em produção: no `localhost` ele impediria o próprio
     desenvolvimento, e desfazer isso no navegador é trabalhoso.
   - `Permissions-Policy` — o CRM usa microfone (áudio) e câmera; a lista diz
     que só ELE pode, e nada embutido nele.
   - `Cross-Origin-Opener-Policy` — a aba do checkout do Asaas é aberta por
     `window.open`; isto impede que a página aberta mexa na que a abriu. */
export function cabecalhosDeSeguranca(req, res, next) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("Permissions-Policy", "geolocation=(self), microphone=(self), camera=(self), payment=()");
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  // Só quando a conexão JÁ é HTTPS: mandar em HTTP não faz nada e, em
  // desenvolvimento, trancaria o localhost em https para sempre.
  if (req.secure || req.headers["x-forwarded-proto"] === "https")
    res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  next();
}
