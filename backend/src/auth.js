import jwt from "jsonwebtoken";
import crypto from "crypto";
import db from "./db.js";
import { resumoDeToken } from "./services/cofre.js";

/* ===== O TOKEN DO LINK DE CRIAR SENHA =====

   Guardado como IMPRESSÃO DIGITAL, nunca em claro. O que ia para o banco era o
   token inteiro — o mesmo que está no link do e-mail —, e a cópia de segurança
   diária leva o banco para um armazenamento de terceiros. Ou seja: cada cópia
   era uma lista de links prontos para trocar a senha de qualquer conta que
   ainda não tivesse entrado.

   Guardar o RESUMO resolve sem tirar nada de ninguém: o link continua chegando
   por e-mail, e o servidor confere resumindo o que recebeu e comparando. A
   diferença para criptografia é a que importa — resumo não volta, nem para
   quem tem a chave.

   As duas funções ficam aqui, num lugar só, porque são oito rotas escrevendo
   convite (cadastro do corretor, do dono, do sócio, do autônomo, a porta do
   site, a redefinição pelo gestor e a do próprio cliente). Regra copiada em
   oito lugares é regra que vale em sete.

   `porConvite` ainda olha o campo antigo: quem recebeu um link ontem e for
   abri-lo amanhã precisa entrar. O campo em claro é apagado no primeiro uso e
   nunca mais é escrito. */
export const resumoDeConvite = resumoDeToken;

export function porConvite(token, campos = "*") {
  if (!token) return null;
  return db.prepare(`SELECT ${campos} FROM users WHERE invite_hash = ?`).get(resumoDeToken(token))
      || db.prepare(`SELECT ${campos} FROM users WHERE invite_token = ?`).get(String(token));
}

/* Todo cracha emitido ate agora deixa de valer. Chamado ao trocar de senha, ao
   remover alguem da equipe e ao rebaixar/desativar. Sem isto, "remover da
   equipe" deixava a pessoa entrando por ate 30 dias — ver `authRequired`. */
export const encerrarSessoes = (userId) =>
  db.prepare("UPDATE users SET sessoes_desde = ? WHERE id = ?").run(Date.now(), userId);

/* A CHAVE QUE ASSINA OS CRACHÁS — e por que o servidor agora RECUSA A SUBIR
   sem ela em produção. (02/09/2026)

   Aqui havia `process.env.JWT_SECRET || "dev-secret"`. O `||` parece cuidado
   ("se faltar, usa um padrão") e era a pior linha do sistema inteiro.

   O que o JWT_SECRET faz: ele é o que prova que um crachá foi emitido por
   NÓS. Quem souber o valor consegue FABRICAR um crachá dizendo qualquer coisa
   — "sou o Ali, master, da imobiliária X" — e o servidor aceita, porque a
   assinatura confere. Não é adivinhar senha; é dispensar a senha.

   Com o `|| "dev-secret"`, o valor secreto do sistema, na falta da variável,
   passava a ser uma palavra escrita no código-fonte. Bastaria a variável não
   estar preenchida no Railway (ou alguém publicar em outro lugar sem ela) para
   que QUALQUER PESSOA da internet, sabendo essa palavra, entrasse como master
   e lesse todas as imobiliárias da plataforma. E o modo de falhar era o pior
   possível: nada quebra, nenhum erro aparece, o CRM funciona perfeitamente —
   só está destrancado.

   Por isso a AUSÊNCIA derruba o start, em vez de virar um padrão. Servidor que
   não sobe é um problema de dez minutos, com a causa escrita na tela. Servidor
   que sobe destrancado é um problema que ninguém descobre.

   ===== MAS CHAVE CURTA NÃO DERRUBA NADA (03/09/2026) =====

   A primeira versão desta trava, publicada ontem, também derrubava o servidor
   quando a variável EXISTIA mas tinha menos de 16 caracteres. E foi exatamente
   isso que aconteceu: o CRM da Conecta saiu do ar na publicação seguinte,
   porque a chave que estava lá — a mesma que vinha funcionando havia meses —
   era curta.

   O erro de julgamento é claro quando se separa as duas situações:

   - SEM a variável, o segredo virava uma palavra escrita no código-fonte,
     pública para qualquer pessoa que olhasse o projeto. É um sistema aberto
     se passando por fechado, e derrubar é a resposta certa.
   - COM uma variável curta, o segredo é FRACO, mas é dele — ninguém de fora
     sabe qual é. Isso é um risco a corrigir com calma, não uma porta aberta.

   Trocar uma imobiliária inteira parada por um risco que não estava sendo
   explorado é um péssimo negócio, e a régua vale para qualquer trava futura:
   **derrubar o sistema só quando ficar de pé é pior do que não funcionar.**

   Agora a chave curta sobe com um aviso gritado no log a cada start — que é o
   que faz o problema continuar visível sem custar a operação de ninguém.

   Fora de produção o padrão continua, porque `npm run dev` e os testes não
   podem exigir configuração — e ali o "vazamento" é o meu próprio computador. */
const MINIMO_SECRET = 16;
const SECRET = (() => {
  const s = process.env.JWT_SECRET;
  const producao = process.env.NODE_ENV === "production" || !!process.env.RAILWAY_ENVIRONMENT;

  if (s) {
    /* Curta demais: avisa alto e SEGUE. O aviso repete a cada reinício de
       propósito — ele tem que continuar incomodando até alguém trocar, e não
       sumir depois da primeira vez. */
    if (producao && s.length < MINIMO_SECRET)
      console.warn(
        "\n---------------------------------------------------------------------\n" +
        `  ATENÇÃO: a JWT_SECRET tem só ${s.length} caracteres (o recomendado é ${MINIMO_SECRET}+).\n\n` +
        "  Ela é a chave que assina o crachá de quem entra no CRM. Curta, ela é\n" +
        "  mais fácil de descobrir por tentativa — e quem a descobrir entra como\n" +
        "  qualquer pessoa, sem senha.\n\n" +
        "  O sistema CONTINUA FUNCIONANDO. Quando puder, troque no Railway:\n" +
        '      node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'hex\'))"\n' +
        "  Trocar desconecta todo mundo uma vez — é só entrar de novo.\n" +
        "---------------------------------------------------------------------\n");
    return s;
  }

  /* ===== SEM A VARIÁVEL, O SERVIDOR GERA A PRÓPRIA CHAVE (03/09/2026) =====

     Terceira versão desta trava, e a segunda queda do CRM por causa dela. Vale
     escrever o raciocínio inteiro, porque ele mudou duas vezes:

     1ª versão (o defeito original): `process.env.JWT_SECRET || "dev-secret"`.
        Sem a variável, o segredo do sistema virava uma palavra escrita no
        código-fonte. Um sistema aberto se passando por fechado.
     2ª versão (ontem): derrubar o servidor. Resolvia a segurança e criou um
        problema pior — uma variável de ambiente ausente passou a ser capaz de
        parar a operação de uma imobiliária inteira. E parou, duas vezes.
     3ª versão (esta): o servidor GERA uma chave aleatória no primeiro start e
        a guarda em `config_plataforma`.

     Por que isto é melhor que as duas anteriores, e não um meio-termo:

     - Contra a 1ª: a chave é aleatória de 64 bytes e ÚNICA desta instalação.
       Ninguém a conhece por ter lido o projeto. O risco que a trava existia
       para cobrir simplesmente não acontece.
     - Contra a 2ª: nada precisa estar configurado para o CRM funcionar.
       Esquecer uma variável no painel da hospedagem deixa de ser capaz de
       derrubar a operação — e essa é a regra que estas duas quedas ensinaram:
       **falha de segurança e falha de disponibilidade têm o mesmo peso.**

     Guardar no BANCO em vez do ambiente é a troca central, e ela é honesta:
     quem tiver o arquivo do banco consegue forjar um crachá. Só que quem tem o
     arquivo do banco já tem os leads, as conversas e os telefones de todo
     mundo — não há o que proteger a mais. E a cópia de segurança, que era o
     jeito realista de esse arquivo sair daqui, agora sobe criptografada.

     A VARIÁVEL CONTINUA MANDANDO quando existe: é o caminho recomendado (a
     chave não fica no mesmo lugar que os dados) e é como se troca a chave
     quando há suspeita de vazamento. O que muda é que ela deixou de ser
     obrigatória para o sistema existir. */
  const guardada = db.prepare("SELECT valor FROM config_plataforma WHERE chave = 'jwt_secret'").get()?.valor;
  if (guardada) {
    if (producao) console.warn(
      "[auth] usando a chave de sessão gerada pelo próprio servidor (não há JWT_SECRET no ambiente). " +
      "Funciona, mas o recomendado é definir JWT_SECRET no painel da hospedagem.");
    return guardada;
  }

  const nova = crypto.randomBytes(48).toString("hex");
  db.prepare(`INSERT INTO config_plataforma (chave,valor,atualizado_em) VALUES ('jwt_secret',?,?)
              ON CONFLICT(chave) DO UPDATE SET valor = excluded.valor, atualizado_em = excluded.atualizado_em`)
    .run(nova, Date.now());
  console.warn(
    "\n---------------------------------------------------------------------\n" +
    "  Não havia JWT_SECRET no ambiente, então o servidor GEROU uma chave de\n" +
    "  sessão própria e a guardou no banco. O CRM está funcionando.\n\n" +
    "  Ela é aleatória e exclusiva desta instalação — ninguém de fora a\n" +
    "  conhece. Quem já estava logado precisa entrar de novo, uma vez.\n\n" +
    "  O recomendado ainda é definir JWT_SECRET no painel da hospedagem: lá a\n" +
    "  chave fica separada dos dados, e dá para trocá-la quando quiser.\n" +
    "---------------------------------------------------------------------\n");
  return nova;
  return "dev-secret";
})();

/* `orgId` existe para o gestor master trocar de imobiliária sem trocar de
   conta: o token passa a valer para a imobiliária escolhida, e todas as rotas
   continuam lendo req.user.org_id como sempre — nenhuma precisou mudar.

   Só o master usa isso. Para qualquer outra pessoa o org_id é o da conta dela,
   e quem emite o token é o login, não o usuário. */
export function sign(user, { orgId } = {}) {
  /* `sd` é o CARIMBO DE VALIDADE DAS SESSÕES desta pessoa (`sessoes_desde`).

     A primeira versão desta trava comparava o `iat` do crachá com a data em que
     as sessões foram encerradas — e o `iat` do JWT tem precisão de SEGUNDO.
     Resultado: crachá emitido no mesmo segundo da troca de senha sobrevivia a
     ela. O teste 3 de `teste:seguranca` pegou isso na primeira execução, com os
     dois "aparelhos" logando no mesmo segundo — que num teste é o caso normal
     e na vida real é o caso raro, o pior tipo de defeito para se ter numa trava
     de segurança: aquele que quase nunca aparece.

     Comparar um valor EXATO acaba com a classe inteira do problema: ou o
     carimbo do crachá é o mesmo que está no banco, ou não é.

     Lido do BANCO e não do objeto recebido: são cinco chamadores, e um deles
     passando um registro lido antes da atualização emitiria um crachá já
     vencido — sem erro nenhum, só a pessoa sendo deslogada sozinha. É o preço
     de um SELECT por login, e a regra passa a valer sem depender de quem chama.

     Ausente vale ZERO, que é o estado de todo mundo hoje: por isso publicar
     esta versão NÃO desloga a equipe inteira. */
  const sd = db.prepare("SELECT sessoes_desde FROM users WHERE id = ?").get(user.id)?.sessoes_desde || 0;
  return jwt.sign({ id: user.id, role: user.role, org_id: orgId || user.org_id,
    name: user.name, master: !!user.master, sd }, SECRET, { expiresIn: "30d" });
}

/* O CRACHÁ VALE — MAS A CONTA AINDA EXISTE? (02/09/2026)

   Antes esta função fazia uma coisa só: conferir a assinatura do token. E o
   token dura 30 DIAS. Ou seja, tudo que ele dizia sobre a pessoa continuava
   valendo por um mês, mesmo depois de deixar de ser verdade:

   - CORRETOR DEMITIDO. O gestor clicava em "Remover da equipe", a pessoa sumia
     da tela — e continuava entrando no CRM, lendo as conversas dos clientes e
     mandando mensagem pelo WhatsApp da imobiliária, por até trinta dias. Este
     é o furo mais provável de acontecer de verdade numa imobiliária, e o mais
     caro: quem sai brigado sai com a base de clientes na mão.
   - GESTOR REBAIXADO a corretor continuava com poder de gestor.
   - SENHA TROCADA não derrubava nada. Quem troca a senha porque desconfia que
     alguém a descobriu continuava com o intruso dentro, com o crachá antigo —
     e a troca de senha, que é o gesto universal de "me tira daqui", não fazia
     absolutamente nada contra ele.

   Agora o crachá é conferido contra o BANCO a cada chamada. É um `SELECT` por
   id num SQLite que roda dentro do próprio processo: microssegundos, o mesmo
   preço que `ehDonoAutonomo` já pagava e ninguém notou.

   O `role` vem do banco e SOBRESCREVE o do token — é isso que faz a promoção
   e o rebaixamento valerem na hora. O `org_id` NÃO: ele vem do crachá de
   propósito, porque para o master ele é a casa em que ele escolheu trabalhar,
   e não a dele. Por isso a linha logo abaixo: se o crachá aponta para uma casa
   diferente da da pessoa, ela precisa SER master no banco agora — senão um
   crachá emitido quando ela era vira passe livre para a casa alheia. */
export function authRequired(req, res, next) {
  const h = req.headers.authorization || "";
  const token = h.startsWith("Bearer ") ? h.slice(7) : null;
  if (!token) return res.status(401).json({ error: "Não autenticado" });

  let dados;
  try {
    dados = jwt.verify(token, SECRET);
  } catch {
    return res.status(401).json({ error: "Token inválido" });
  }

  const u = db.prepare(
    "SELECT id, org_id, role, status, master, sessoes_desde FROM users WHERE id = ?").get(dados.id);
  if (!u) return res.status(401).json({ error: "Sua conta não existe mais. Fale com a gestão da sua imobiliária." });
  if (u.status !== "ativo")
    return res.status(401).json({ error: "Seu acesso foi encerrado. Fale com a gestão da sua imobiliária." });

  /* O carimbo do crachá tem que ser IGUAL ao do banco. Trocar a senha, sair da
     equipe ou mudar de função move o carimbo, e todo crachá emitido antes fica
     para trás — o novo, emitido logo depois, já nasce com o carimbo novo.

     Comparação exata, e não "emitido antes de": o `iat` do JWT tem precisão de
     segundo, e o crachá emitido no mesmo segundo da troca sobrevivia a ela. */
  if ((dados.sd || 0) !== (u.sessoes_desde || 0))
    return res.status(401).json({ error: "Sua sessão foi encerrada. Entre de novo." });

  if (dados.org_id !== u.org_id && !u.master)
    return res.status(403).json({ error: "Este acesso não vale mais para esta conta." });

  req.user = { ...dados, role: u.role, master: !!u.master };
  next();
}

/* O CORRETOR AUTÔNOMO É AS DUAS COISAS. (02/09/2026)

   Na casa de uma pessoa só, ele é o corretor E o gestor: atende os leads e
   também configura o WhatsApp, monta o funil e paga a conta. Até hoje ele era
   criado como `adm`, e isso o deixava de fora de tudo que procura corretor —
   a catraca, o rodízio, o score, o relatório de produtividade. Ele pagava por
   um CRM cujo relatório principal nunca teria o nome dele.

   Agora ele nasce `corretor`, que é o papel que faz o sistema enxergá-lo
   trabalhando, e ganha o acesso de gestor POR SER O DONO — aqui, num lugar só.

   Por que aqui e não em cada rota: são dezenas de `roles("adm")` espalhadas, e
   liberar uma a uma deixaria a esquecida barrando o próprio dono da conta em
   silêncio. É a mesma razão de `semMaster` existir.

   E é SÓ O DONO. O atendente que ele contratar continua sendo atendente: a
   conta é de uma pessoa, mas a permissão de gestor é de UMA pessoa, não de
   quem estiver dentro dela. */
export function ehDonoAutonomo(user) {
  if (!user || !user.org_id || !user.id) return false;
  const org = db.prepare("SELECT tipo, dono_user_id FROM orgs WHERE id = ?").get(user.org_id);
  return !!org && org.tipo === "autonomo" && org.dono_user_id === user.id;
}

// Restringe a rota a determinados papéis. Ex: roles("adm","sdr")
export function roles(...allowed) {
  return (req, res, next) => {
    if (allowed.includes(req.user.role)) return next();
    /* A conferência vai ao BANCO e não ao crachá: o token dura 30 dias, e quem
       deixasse de ser dono continuaria com o acesso por um mês. Mesma decisão
       do `porteiro` com o master. */
    if (allowed.includes("adm") && ehDonoAutonomo(req.user)) return next();
    return res.status(403).json({ error: "Sem permissão" });
  };
}

/* Gestor MASTER: quem mantém a plataforma, não quem trabalha na imobiliária.

   Ele tem o acesso de um gestor, mas some de tudo que a equipe enxerga —
   lista de pessoas, catraca, relatórios, ranking, campo de captador. Para a
   Conecta ele simplesmente não existe.

   `semMaster` é o pedaço de SQL que faz isso. Fica aqui, num lugar só, porque
   a regra tem que valer em toda consulta que lista gente: esquecer de um único
   SELECT é o master reaparecendo na tela do corretor.

   Uso: `... WHERE u.org_id = ? ${semMaster("u")}` */
export const semMaster = (alias = "u") => ` AND COALESCE(${alias}.master, 0) = 0`;

/* Trava das rotas da plataforma (hub de contas, criar imobiliária).

   Confere no BANCO, não só no token. O token é assinado por nós e é confiável,
   mas dura 30 dias: se um master for despromovido hoje, o crachá antigo
   continuaria abrindo a plataforma inteira até o mês que vem. */
export function soMaster(req, res, next) {
  const u = db.prepare("SELECT master FROM users WHERE id = ?").get(req.user.id);
  if (!u || !u.master) return res.status(403).json({ error: "Área restrita ao ConHub." });
  next();
}

// Quem enxerga e comanda a operação inteira: gestor (adm) e atendente (sdr).
// O atendente tem o mesmo alcance do gestor — por isso o cadastro dele precisa
// de aprovação, diferente do corretor, que entra direto pelo link.
/* Quem enxerga a casa inteira, e não só o que está no próprio nome.

   O DONO DA CONTA AUTÔNOMA entra aqui (02/09/2026) mesmo sendo `corretor`.
   Sem isso, o lead que estivesse com o atendente dele ficaria invisível para
   ele — o titular da conta sem acesso ao atendimento que ele paga para
   existir. A casa é dele; a supervisão da casa também.

   A conferência vai ao banco, e é um `SELECT` por id: barato o bastante para
   valer em toda checagem, e é o preço de a regra morar num lugar só. */
export const supervisiona = (user) =>
  user.role === "adm" || user.role === "sdr" || ehDonoAutonomo(user);

/* Quem pode mexer NESTE lead.

   A conta é multi-imobiliária: cada uma é uma organização, e a supervisão de
   uma NÃO pode alcançar o lead da outra. Por isso a comparação de org_id vive
   aqui, num lugar só — antes cada rota escrevia a sua checagem, e as rotas de
   mensagem tinham esquecido a parte da organização: a gestão de uma
   imobiliária conseguia escrever na conversa de outra se soubesse o id do
   lead. O corretor sempre esteve preso ao que é dele. */
export const podeVerLead = (user, lead) => {
  if (!lead) return false;
  if (supervisiona(user)) return lead.org_id === user.org_id;
  return lead.assigned_to === user.id;
};

// Nomes que aparecem para o usuário. Internamente os papéis continuam
// adm/sdr/corretor para não quebrar o banco e as rotas existentes.
// Todo cadastro passa pela gestão — inclusive corretor. Quem entra vê conversa
// de cliente, então ninguém é liberado sozinho.
export const PAPEIS = {
  corretor: { rotulo: "Corretor(a)", precisaAprovacao: true },
  sdr:      { rotulo: "Atendente",   precisaAprovacao: true },
  adm:      { rotulo: "Gestor(a)",   precisaAprovacao: true },
};
export const papelDoFormulario = (v) => ({ corretor: "corretor", atendente: "sdr", gestor: "adm" }[String(v || "").toLowerCase()]);
