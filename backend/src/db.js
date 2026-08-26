import Database from "better-sqlite3";
import { fileURLToPath } from "url";
import path from "path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// DB_PATH permite apontar para o disco persistente da hospedagem (ex.: /data/concrm.db no Railway).
const dbFile = process.env.DB_PATH || path.join(__dirname, "..", "concrm.db");
const db = new Database(dbFile);
db.pragma("journal_mode = WAL");

db.exec(`
CREATE TABLE IF NOT EXISTS orgs (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  adm_code TEXT NOT NULL,
  wa_number TEXT,
  wa_connected INTEGER DEFAULT 0,
  distribution_ptr INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  name TEXT NOT NULL,
  email TEXT UNIQUE NOT NULL,
  pass_hash TEXT NOT NULL,   -- vazio enquanto o convite não foi confirmado
  role TEXT NOT NULL CHECK (role IN ('adm','sdr','corretor')),
  available INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS leads (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  name TEXT,
  phone TEXT,          -- normalizado: 55DDDNXXXXXXXX
  email TEXT,
  origem TEXT,
  priority TEXT,       -- QUENTE | MORNO | FRIO
  qual_json TEXT,      -- respostas de qualificação
  stage TEXT DEFAULT 'Lead',
  assigned_to TEXT,    -- users.id ou NULL (fila da catraca)
  first_resp_at INTEGER,
  meta_lead_id TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  lead_id TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('in','out')),
  from_user_id TEXT,   -- quem enviou (out); NULL para 'in'
  from_name TEXT,      -- nome assinado na mensagem
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

-- Catálogo de imóveis e terrenos. Nasceu para tirar a equipe da dependência
-- de grupo de WhatsApp para saber o que está disponível.
CREATE TABLE IF NOT EXISTS produtos (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  tipo TEXT NOT NULL CHECK (tipo IN ('casa','terreno')),
  titulo TEXT NOT NULL,
  formato TEXT,            -- casa: 'empreendimento' ou 'solta'
  quartos INTEGER,
  banheiros INTEGER,
  construtor TEXT,
  valor REAL,
  metragem REAL,           -- metragem do terreno, em m²
  cidade TEXT,
  bairro TEXT,
  endereco TEXT,
  maps_url TEXT,           -- link colado do Google Maps (sem custo de API)
  morar_bem INTEGER DEFAULT 0,
  comissao_pct REAL,       -- % de comissão da venda do produto
  captador_id TEXT,
  captador_nome TEXT,      -- guardado junto para o histórico sobreviver a exclusões
  observacoes TEXT,
  status TEXT DEFAULT 'ativo',  -- aguardando_aprovacao | ativo | recusado | vendido | inativo
  created_by TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS produto_midias (
  id TEXT PRIMARY KEY,
  produto_id TEXT NOT NULL,
  tipo TEXT NOT NULL CHECK (tipo IN ('foto','video')),
  url TEXT NOT NULL,
  chave TEXT,              -- caminho no armazenamento, para apagar depois
  ordem INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL
);

-- Aparelhos inscritos para receber notificação push. Um corretor pode ter
-- vários (celular e computador), então a chave é o endpoint, não o usuário.
CREATE TABLE IF NOT EXISTS push_subs (
  endpoint TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

-- Tentativas de ligação. O botão "Ligar" abre o discador do celular e o
-- navegador não tem como saber se a pessoa atendeu — então registramos a
-- TENTATIVA, que já diz quem está correndo atrás do lead e quem não está.
-- Histórico de etapas: quando o lead entrou em cada uma, e por quê.
--
-- O CRM guardava só ONDE o lead está, nunca DESDE QUANDO. Sem isso o card do
-- funil não distingue um lead que chegou em "Aprovação" ontem de um parado ali
-- há um mês — que é justamente a diferença que a gestão precisa ver — e o
-- relatório não consegue medir "quantos avançaram para X no período".
--
-- A coluna motivo diz de onde veio a mudança: mao, palavra, ia, venda, reanalise.
CREATE TABLE IF NOT EXISTS lead_etapas (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  lead_id TEXT NOT NULL,
  de TEXT,
  para TEXT NOT NULL,
  motivo TEXT,
  user_id TEXT,
  created_at INTEGER NOT NULL
);

-- Tarefas agendadas de um lead: ligar amanhã, levar documento na Caixa,
-- confirmar a visita de sábado.
--
-- Sem isto o compromisso vivia na cabeça do corretor ou num papel na mesa, e a
-- gestão não tinha como ver o que estava combinado sem perguntar. O que
-- importa no card do funil é uma coisa só: tem tarefa marcada, e ela já
-- venceu?
CREATE TABLE IF NOT EXISTS tarefas (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  lead_id TEXT NOT NULL,
  user_id TEXT,            -- de quem é a tarefa
  criado_por TEXT,
  titulo TEXT NOT NULL,
  quando INTEGER NOT NULL, -- data e hora combinadas
  feito_em INTEGER,
  created_at INTEGER NOT NULL
);

/* Observações do lead: o quadro de recados do atendimento.

   "O cliente só atende depois das 18h", "o marido é quem decide", "já foi
   negado na Caixa em janeiro". Coisas que não são etapa, não são tarefa e não
   cabem na conversa — mas que quem atende precisa ver antes de falar.

   O caso que motivou (pedido do Ali, 22/08/2026) é o REPASSE: a atendente faz
   o primeiro contato e passa o lead adiante. O que ela descobriu na conversa
   se perdia, e o corretor começava do zero ou relia quarenta mensagens.

   É uma LISTA, não um campo de texto único. Com um campo só, a atendente e o
   corretor escrevendo ao mesmo tempo apagariam um ao outro em silêncio — e
   observação apagada por acidente ninguém descobre que existiu. Em lista, cada
   recado tem autor e hora, e some só quando alguém manda apagar. */
CREATE TABLE IF NOT EXISTS observacoes (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  lead_id TEXT NOT NULL,
  texto TEXT NOT NULL,
  autor_id TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_obs_lead ON observacoes(lead_id, created_at);

CREATE TABLE IF NOT EXISTS ligacoes (
  id TEXT PRIMARY KEY,
  lead_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

-- Simulações de financiamento feitas no site da Caixa e registradas aqui.
-- Uma por vez não basta: o cliente simula de novo quando muda a entrada ou o
-- prazo, e o corretor precisa do histórico para lembrar o que já ofereceu.
CREATE TABLE IF NOT EXISTS simulacoes (
  id TEXT PRIMARY KEY,
  lead_id TEXT NOT NULL,
  org_id TEXT NOT NULL,
  user_id TEXT,
  valor_imovel REAL,
  entrada REAL,
  subsidio REAL,
  financiado REAL,
  prazo_meses INTEGER,
  parcela REAL,
  juros_aa REAL,
  renda REAL,
  modalidade TEXT,
  observacoes TEXT,
  print_url TEXT,          -- a imagem original, para conferência depois
  origem TEXT,             -- 'print' (lida por IA) ou 'manual'
  enviada_em INTEGER,      -- quando o resumo foi para o cliente
  created_at INTEGER NOT NULL
);

-- Cada mensalidade paga, uma linha. Antes o pagamento não deixava rastro: o
-- sistema só empurrava o vencimento um mês para a frente, então errar o botão
-- era irreversível e não havia como conferir o que foi pago quando.
--
-- Com o histórico, o vencimento passa a ser CALCULADO: vence_base + um mês por
-- pagamento. Apagar um pagamento puxa a data de volta sozinho, e a ordem em que
-- se mexe não importa — o resultado é sempre o mesmo.
CREATE TABLE IF NOT EXISTS pagamentos (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  valor REAL,
  pago_em INTEGER NOT NULL,
  origem TEXT,               -- 'manual' (baixa na tela) ou 'asaas' (webhook)
  asaas_payment_id TEXT,
  obs TEXT,
  created_at INTEGER NOT NULL
);

-- Cada planilha importada, uma linha — é o que permite desfazer UMA importação
-- sem varrer a base inteira. Sem isso, subir a lista errada com 3 mil leads não
-- tinha volta a não ser apagando lead por lead.
CREATE TABLE IF NOT EXISTS importacoes (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  rotulo TEXT,               -- nome que o gestor deu à lista
  origem TEXT,               -- origem aplicada aos leads desta lista
  arquivo TEXT,              -- nome do arquivo enviado
  total INTEGER,             -- linhas recebidas
  criados INTEGER,           -- linhas que viraram lead
  criado_por TEXT,
  created_at INTEGER NOT NULL
);

-- Cada liga/desliga da prontidão do corretor, com a hora e QUEM fez.
--
-- Existe porque a disponibilidade passou a expirar sozinha no fim do
-- expediente: sem registro, ninguém saberia distinguir "ele se prontificou e
-- trabalhou" de "o sistema desligou porque ele esqueceu" — e é justamente essa
-- diferença que a gestão precisa cobrar.
CREATE TABLE IF NOT EXISTS disponibilidade_log (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  ativo INTEGER NOT NULL,     -- 1 = ficou disponível, 0 = ficou indisponível
  origem TEXT NOT NULL,       -- 'proprio' | 'gestor' | 'sistema'
  autor_id TEXT,              -- quem mexeu, quando não foi a própria pessoa
  autor_nome TEXT,            -- guardado junto: o histórico sobrevive à exclusão
  created_at INTEGER NOT NULL
);

-- Mensagens prontas que aparecem acima do campo de conversa.
--
-- Eram uma lista fixa dentro do código do CRM: mudar o texto de abordagem
-- exigia um deploy, e o texto de abordagem é justamente o que a gestão ajusta
-- toda semana conforme o que está convertendo. Agora é da imobiliária.
CREATE TABLE IF NOT EXISTS mensagens_rapidas (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  titulo TEXT NOT NULL,       -- o rótulo do botão
  corpo TEXT NOT NULL,        -- {nome} vira o primeiro nome do lead
  ordem INTEGER DEFAULT 0,
  ativo INTEGER DEFAULT 1,    -- desligar sem perder o texto
  criado_por TEXT,
  created_at INTEGER NOT NULL
);
/* O que a EQUIPE ensina ao robô do fora-do-expediente.

   A Vanessa é quem faz o primeiro atendimento na Conecta; a IA cobre a
   ausência dela. Para as duas soarem como a mesma imobiliária, ela precisa
   poder escrever o jeito de falar — e não depender de alguém mexer no código
   toda vez que a abordagem muda.

   IMPORTANTE: isto orienta o ESTILO e o conteúdo permitido. Nunca destrava o
   que é proibido (valor, aprovação, agendamento) — a montagem do prompt em
   services/ia.js coloca as proibições DEPOIS destas linhas, e diz por
   escrito que elas não podem ser contrariadas. Campo de texto que qualquer
   pessoa preenche e que a IA obedece cegamente é porta destrancada. */
CREATE TABLE IF NOT EXISTS robo_ensino (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  texto TEXT NOT NULL,
  ordem INTEGER DEFAULT 0,
  ativo INTEGER DEFAULT 1,    -- desligar sem perder o que já foi escrito
  criado_por TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ensino_org ON robo_ensino(org_id, ordem);
CREATE INDEX IF NOT EXISTS idx_etapas_lead ON lead_etapas(lead_id, created_at);
CREATE INDEX IF NOT EXISTS idx_etapas_org ON lead_etapas(org_id, created_at);
CREATE INDEX IF NOT EXISTS idx_tarefas_lead ON tarefas(lead_id, quando);
-- A busca que mais roda: as tarefas em aberto da imobiliária, para o funil.
CREATE INDEX IF NOT EXISTS idx_tarefas_abertas ON tarefas(org_id, feito_em, quando);
CREATE INDEX IF NOT EXISTS idx_msgrapidas_org ON mensagens_rapidas(org_id, ordem);

-- Escala de plantão: quem fica de sobreaviso em cada turno, dia a dia.
--
-- Uma linha por PESSOA por turno (a Conecta usa dois corretores por turno),
-- em vez de colunas "Manhã 1 / Manhã 2" como na planilha. Assim a escala não
-- fica presa a dois: se um dia precisarem de três, é só mais uma linha.
CREATE TABLE IF NOT EXISTS plantoes (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  dia INTEGER NOT NULL,        -- meia-noite do dia, no fuso da operação
  turno TEXT NOT NULL,         -- 'manha' | 'tarde'
  user_id TEXT NOT NULL,
  criado_por TEXT,
  created_at INTEGER NOT NULL
);

-- Duas pessoas no mesmo turno é normal; a MESMA pessoa duas vezes, não.
CREATE UNIQUE INDEX IF NOT EXISTS idx_plantao_unico ON plantoes(org_id, dia, turno, user_id);
CREATE INDEX IF NOT EXISTS idx_plantao_dia ON plantoes(org_id, dia);
CREATE INDEX IF NOT EXISTS idx_disp_org ON disponibilidade_log(org_id, created_at);
CREATE INDEX IF NOT EXISTS idx_disp_user ON disponibilidade_log(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_pagamentos_org ON pagamentos(org_id, pago_em);
CREATE INDEX IF NOT EXISTS idx_importacoes_org ON importacoes(org_id, created_at);
CREATE INDEX IF NOT EXISTS idx_simulacoes_lead ON simulacoes(lead_id, created_at);
CREATE INDEX IF NOT EXISTS idx_ligacoes_user ON ligacoes(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_push_user ON push_subs(user_id);
CREATE INDEX IF NOT EXISTS idx_produtos_org ON produtos(org_id, status);
CREATE INDEX IF NOT EXISTS idx_midias_produto ON produto_midias(produto_id);
CREATE INDEX IF NOT EXISTS idx_leads_assigned ON leads(assigned_to);
CREATE INDEX IF NOT EXISTS idx_leads_phone ON leads(phone);
CREATE INDEX IF NOT EXISTS idx_msg_lead ON messages(lead_id);
`);

// Migrações leves: adiciona colunas que apareceram depois, sem apagar o banco existente.
const userCols = db.prepare("PRAGMA table_info(users)").all().map(c => c.name);
const addUserCol = (name, ddl) => { if (!userCols.includes(name)) db.exec(`ALTER TABLE users ADD COLUMN ${name} ${ddl}`); };
addUserCol("phone", "TEXT");                            // WhatsApp do corretor (contato interno)
addUserCol("status", "TEXT DEFAULT 'ativo'");           // pendente = convidado, ainda sem senha
addUserCol("invite_token", "TEXT");                     // token do link "definir senha"
addUserCol("invite_expires", "INTEGER");                // validade do token (ms)
/* Para que serve o token: "convite" (conta nova) ou "redefinicao" (esqueceu a
   senha). O mesmo link e a mesma pagina servem os dois — o que muda e que a
   redefinicao vale para conta JA ATIVA e nao mexe no status dela. */
addUserCol("invite_tipo", "TEXT");
addUserCol("avatar_url", "TEXT");
/* Preferência de tela, por CONTA e não por aparelho.

   A barra lateral recolhida segue a pessoa: ela escolhe uma vez e vale no
   computador da imobiliária e no notebook de casa. Guardar no navegador seria
   mais simples, mas aí a escolha se perderia a cada aparelho novo — e foi
   "por conta" o que o Ali pediu. */
addUserCol("barra_recolhida", "INTEGER DEFAULT 0");                       // foto de perfil
addUserCol("avatar_key", "TEXT");                       // caminho no armazenamento
/* Gestor MASTER — dono da plataforma, não da imobiliária.

   É uma coluna e não um papel novo porque o papel manda no que a pessoa PODE
   fazer, e o master faz tudo que um gestor faz. O que muda é a VISIBILIDADE:
   ele não aparece na equipe, na catraca, nos relatórios nem no ranking da
   imobiliária. Papel novo exigiria mexer no CHECK da tabela (que o SQLite não
   altera sem recriar) e revisar todo `roles("adm")` do sistema.

   Com o ConHub virando SaaS, é o que separa "quem opera a Conecta" de "quem
   mantém o sistema". Ver auth.js -> semMaster(). */
addUserCol("master", "INTEGER DEFAULT 0");
// Quando a pessoa se prontificou. É o que faz a disponibilidade expirar no fim
// do expediente: vale só enquanto for da janela de hoje (ver services/expediente.js).
addUserCol("available_desde", "INTEGER");

/* Registro de ponto da atendente.

   Para o corretor, ligar a chave é "estou de prontidão para receber lead".
   Para a atendente é outra coisa: ela atende o dia inteiro por definição, e o
   que interessa é a PRESENÇA — a que horas começou e de onde. Por isso a
   marcação dela carrega o local e, quando ela não está na imobiliária, o
   motivo. Sem esses dois campos o registro não serviria de ponto. */
const dispCols = db.prepare("PRAGMA table_info(disponibilidade_log)").all().map(c => c.name);
const addDispCol = (name, ddl) => { if (!dispCols.includes(name)) db.exec(`ALTER TABLE disponibilidade_log ADD COLUMN ${name} ${ddl}`); };
addDispCol("local", "TEXT");        // 'imobiliaria' | 'fora'
addDispCol("observacao", "TEXT");   // obrigatória quando o local é 'fora'
/* Turnos de plantão da pessoa NAQUELE dia, gravados junto com a marcação de
   disponibilidade ("manha", "tarde" ou "manha,tarde").

   Guardado no momento do clique, e não consultado depois: a escala pode ser
   remontada meses adiante, e o registro precisa dizer o que valia no dia — do
   contrário o histórico mudaria sozinho. */
addDispCol("plantao", "TEXT");
db.exec("CREATE INDEX IF NOT EXISTS idx_users_invite ON users(invite_token)");

// Ponteiro do rodízio dos ATENDENTES, separado do distribution_ptr (que é dos
// corretores). Se os dois compartilhassem o mesmo contador, uma catraca
// embaralharia a ordem da outra.
const orgCols = db.prepare("PRAGMA table_info(orgs)").all().map(c => c.name);
const addOrgCol = (name, ddl) => { if (!orgCols.includes(name)) db.exec(`ALTER TABLE orgs ADD COLUMN ${name} ${ddl}`); };
addOrgCol("atendente_ptr", "INTEGER DEFAULT 0");

// Assinatura mensal. Enquanto vence_em for nulo a imobiliária usa sem cobrança
// — é o estado de quem ainda não foi cobrado, e não pode virar bloqueio por
// omissão: sistema que se tranca sozinho por falta de configuração é armadilha.
addOrgCol("plano", "TEXT");                    // nome do plano, só para a tela
addOrgCol("valor_mensal", "REAL");
addOrgCol("vence_em", "INTEGER");              // data do próximo vencimento
addOrgCol("dias_carencia", "INTEGER DEFAULT 5");
addOrgCol("assinatura_status", "TEXT");        // pago | atrasado | cancelado (o bloqueio é calculado)
addOrgCol("ultimo_pagamento_em", "INTEGER");
addOrgCol("link_pagamento", "TEXT");           // fatura em aberto, para o cliente pagar
addOrgCol("asaas_customer_id", "TEXT");
addOrgCol("asaas_subscription_id", "TEXT");
/* Dono da conta. A mensalidade é assunto de quem paga: mesmo havendo outro
   gestor com acesso total ao CRM, o valor, o histórico de pagamentos e os
   dados de cobrança só aparecem para ele. Ficando nulo, o bootstrap adota o
   gestor mais antigo — bancos criados antes desta coluna não ficam sem dono. */
addOrgCol("dono_user_id", "TEXT");
/* A conexão do WhatsApp é DE CADA IMOBILIÁRIA, e é por isso que mora aqui.

   Antes vinha de UAZAPI_HOST/UAZAPI_TOKEN do servidor, valendo para todas.
   Com mais de uma imobiliária, a segunda enxergava o WhatsApp da primeira
   como se fosse dela — enviava pelo número dos outros e podia desconectá-lo.
   O bootstrap copia as variáveis antigas para a imobiliária dona delas, então
   quem já estava conectado continua conectado. */
addOrgCol("uazapi_host", "TEXT");
addOrgCol("uazapi_token", "TEXT");
/* Data do vencimento ANTES de qualquer pagamento. O vencimento em vigor é
   vence_base + (um mês por pagamento registrado), o que faz apagar pagamento
   voltar a data sozinho. Ver services/assinatura.js. */
addOrgCol("vence_base", "INTEGER");
// Quando a imobiliária entrou na plataforma — aparece no hub de contas.
addOrgCol("created_at", "INTEGER");
/* Fim do expediente, "HH:MM". Às 18:00 (padrão) a prontidão de todo mundo cai,
   e cada um precisa se prontificar de novo no dia seguinte. Vazio desliga a
   regra — imobiliária com plantão à noite não pode ficar refém dela. */
addOrgCol("expediente_fim", "TEXT DEFAULT '18:00'");
addOrgCol("ultimo_corte", "INTEGER");   // até quando o corte já foi aplicado
// Até quando o aviso das 08:00 do plantão já foi disparado. Mesma ideia do
// corte: guardar o dia evita mandar duas vezes se o servidor reiniciar.
addOrgCol("ultimo_aviso_plantao", "INTEGER");
// Minutos de espera do cliente até o corretor ser avisado. 0 desliga.
addOrgCol("alerta_resposta_min", "INTEGER DEFAULT 30");

/* Primeiro atendimento automático: ligado/desligado e a janela de horário.

   Nasce DESLIGADO. É um robô falando com cliente no WhatsApp da imobiliária —
   isso não pode começar a acontecer porque uma versão nova subiu; tem que ser
   alguém decidindo, num botão, sabendo o que faz.

   A janela é "das 18:00 às 09:00", ou seja, atravessa a meia-noite. É por isso
   que ela não reaproveita o `expediente_fim`: aquele é um instante (o corte da
   prontidão), este é um intervalo. */
addOrgCol("robo_ativo", "INTEGER DEFAULT 0");
addOrgCol("robo_inicio", "TEXT DEFAULT '18:00'");   // hora em que o robô assume
addOrgCol("robo_fim", "TEXT DEFAULT '09:00'");      // hora em que a atendente assume
addOrgCol("robo_teto", "INTEGER DEFAULT 12");       // máximo de mensagens por lead
/* Dias em que a EQUIPE trabalha (0=domingo … 6=sábado, como o JavaScript
   conta). Nos dias que NÃO estão aqui o robô atende o dia inteiro: no fim de
   semana não existe "fora do expediente", existe "não tem expediente". */
addOrgCol("robo_dias", "TEXT DEFAULT '1,2,3,4,5'");

/* Quem foi o ÚLTIMO corretor a receber lead pelo rodízio.

   Substitui o `distribution_ptr`, que era um contador e virava outra pessoa
   sozinho: a vez era "contador % quantos estão disponíveis", e a lista de
   disponíveis muda o dia inteiro. Guardando QUEM recebeu, a fila só anda
   quando alguém de fato recebe. */
addOrgCol("rodizio_ultimo", "TEXT");

/* A MARCA DA IMOBILIÁRIA (white-label).

   A plataforma é multi-imobiliária desde sempre, mas a aparência era uma só —
   e uma imobiliária que assina o sistema não pode ver o nome nem as cores de
   outra. Duas coisas ficam por conta dela: a logo, que aparece no alto da
   barra lateral, e a cor da própria barra.

   `logo_key` é o caminho no armazenamento, guardado ao lado da URL para a
   logo antiga poder ser apagada quando outra sobe — sem isso cada troca
   deixaria um arquivo órfão pagando espaço para sempre.

   Cor vazia = o verde profundo do padrão. Guardar NULL em vez de gravar o
   padrão é o que permite mudar o padrão depois sem reescrever a base. */
addOrgCol("logo_url", "TEXT");
addOrgCol("logo_key", "TEXT");
addOrgCol("cor_barra", "TEXT");

const leadCols = db.prepare("PRAGMA table_info(leads)").all().map(c => c.name);
const addLeadCol = (name, ddl) => { if (!leadCols.includes(name)) db.exec(`ALTER TABLE leads ADD COLUMN ${name} ${ddl}`); };
addLeadCol("last_read_at", "INTEGER");   // até quando o atendente já leu a conversa
addLeadCol("sale_value", "REAL");        // registro da venda: valor do imóvel
addLeadCol("sale_date", "INTEGER");      // data da venda
addLeadCol("sale_property", "TEXT");     // qual imóvel/unidade foi vendido
addLeadCol("produto_id", "TEXT");        // imóvel de interesse do lead (opcional)
addLeadCol("closed_at", "INTEGER");      // atendimento finalizado: sai da caixa de entrada, fica no funil
addLeadCol("import_id", "TEXT");         // de qual planilha veio, para dar para desfazer a importação
// Aviso de cliente sem resposta. `alerta_em` guarda a mensagem do cliente que
// já gerou aviso — é o que impede a mesma espera de cobrar de minuto em minuto.
addLeadCol("alerta_em", "INTEGER");
addLeadCol("cutucado_em", "INTEGER");    // a gestão pediu atenção neste atendimento
addLeadCol("cutucado_por", "TEXT");
/* Resumo da conversa feito pela IA, guardado para não pagar de novo a cada
   clique. `resumo_msgs` diz com quantas mensagens ele foi feito: é assim que a
   tela sabe avisar "há 6 mensagens novas desde este resumo" em vez de mostrar
   um retrato velho como se fosse atual. */
addLeadCol("resumo_json", "TEXT");
addLeadCol("resumo_em", "INTEGER");
addLeadCol("resumo_msgs", "INTEGER");
addLeadCol("cutucado_recado", "TEXT");   // recado curto que a gestão deixou junto
/* Etapa que a IA leu na conversa — SUGESTÃO, não a etapa do lead.

   Fica em coluna separada de propósito: `stage` continua sendo só o que uma
   pessoa marcou ou o que a palavra-chave moveu. Enquanto ninguém confirmar, a
   leitura da IA é opinião guardada, e o funil e os relatórios não mudam. */
/* Quando o lead caiu na mão de quem está com ele agora.

   Diferente de created_at: o lead pode ter entrado em junho e ter sido
   repassado hoje. Sem esta data, o lead recem-transferido afundava na lista do
   corretor — atras de leads antigos, so porque era antigo — e ele nao via
   justamente o que acabou de receber. */
addLeadCol("assigned_at", "INTEGER");
/* De onde veio a temperatura do lead.

   A marcação "MORNO" era o padrão da coluna e ninguém sabia disso — a tela a
   mostrava como se fosse avaliação de gente. Guardar a origem impede a mesma
   história: `mao` (alguém marcou), `ia` (leitura da conversa) ou nulo (nunca
   foi marcada). */
addLeadCol("priority_por", "TEXT");
addLeadCol("priority_em", "INTEGER");
addLeadCol("etapa_ia_json", "TEXT");
addLeadCol("etapa_ia_em", "INTEGER");
addLeadCol("etapa_ia_msgs", "INTEGER");
/* Primeiro atendimento automático, fora do expediente.

   O robô conversa com o lead que chega de madrugada ou no fim de semana e
   colhe as informações da simulação. O que ele apurou fica em `robo_json`
   (os mesmos cinco campos do formulário do Meta) e o CRM sabe em que pé
   está a conversa:

   - `robo_msgs`: quantas mensagens ele já mandou neste lead. É o teto que
     impede uma conversa sem fim — e uma conta sem fim;
   - `robo_parado`: gente entrou na conversa. A partir daí ele não fala mais,
     nunca, neste lead. Quem atende é quem atende;
   - `robo_conferido_em`: a atendente já passou o olho no que ele colheu. É o
     que tira o lead da lista de segunda-feira. */
addLeadCol("robo_json", "TEXT");
addLeadCol("robo_msgs", "INTEGER DEFAULT 0");
addLeadCol("robo_em", "INTEGER");
addLeadCol("robo_parado", "INTEGER DEFAULT 0");
addLeadCol("robo_conferido_em", "INTEGER");
/* Consumo da IA, por pessoa.

   Recurso que gasta dinheiro precisa ter dono registrado. O log do servidor
   dizia quantos tokens foram gastos, mas não quem clicou — então ninguém
   conseguia responder "quanto já usamos e quem usou", que é a primeira
   pergunta de quem paga a conta.

   Guardamos os tokens, não o texto: nem a conversa nem o resumo passam por
   aqui. O custo fica gravado no momento do uso, porque preço de tabela muda
   e um relatório que recalcula o passado com o preço de hoje mente. */
db.exec(`CREATE TABLE IF NOT EXISTS ia_uso (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  user_id TEXT,
  lead_id TEXT,
  recurso TEXT NOT NULL,          -- 'resumo' | 'print_simulacao'
  modelo TEXT,
  tokens_entrada INTEGER DEFAULT 0,
  tokens_saida INTEGER DEFAULT 0,
  custo_usd REAL DEFAULT 0,
  created_at INTEGER NOT NULL
)`);
db.exec("CREATE INDEX IF NOT EXISTS idx_iauso_org ON ia_uso(org_id, created_at)");
db.exec("CREATE INDEX IF NOT EXISTS idx_leads_import ON leads(import_id)");

// Modalidade de financiamento do imóvel. Antes existia só a caixinha
// "morar_bem" (sim/não), que não dava conta da realidade: a Conecta trabalha
// com três programas. A coluna antiga fica onde está para o histórico não se
// perder, e quem estava marcado vira "Morar Bem PE".
const prodCols = db.prepare("PRAGMA table_info(produtos)").all().map(c => c.name);
if (!prodCols.includes("modalidade")) {
  db.exec("ALTER TABLE produtos ADD COLUMN modalidade TEXT");
  db.exec("UPDATE produtos SET modalidade = 'Morar Bem PE' WHERE morar_bem = 1");
}

// Foto, áudio e documento que o cliente manda pelo WhatsApp. Antes o arquivo era
// descartado e a conversa guardava só um marcador de texto tipo "[ImageMessage]".
/* Resultado da ligação. A tabela nasceu guardando só a TENTATIVA — o navegador
   não tem como saber se a pessoa atendeu. Só que "20 ligações" sem resultado
   nenhum não é produtividade: é 20 toques no botão. Quem responde o que
   aconteceu é o corretor, no popup logo depois da chamada. */
const ligCols = db.prepare("PRAGMA table_info(ligacoes)").all().map(c => c.name);
const addLigCol = (name, ddl) => { if (!ligCols.includes(name)) db.exec(`ALTER TABLE ligacoes ADD COLUMN ${name} ${ddl}`); };
addLigCol("resultado", "TEXT");        // falou | nao_atendeu | caixa_postal | numero_errado
addLigCol("obs", "TEXT");              // o que ficou combinado, em uma linha
addLigCol("respondido_em", "INTEGER"); // quando o corretor respondeu o popup

const msgCols = db.prepare("PRAGMA table_info(messages)").all().map(c => c.name);
const addMsgCol = (name, ddl) => { if (!msgCols.includes(name)) db.exec(`ALTER TABLE messages ADD COLUMN ${name} ${ddl}`); };
addMsgCol("media_url", "TEXT");   // endereço público do arquivo guardado
addMsgCol("media_mime", "TEXT");  // image/jpeg, audio/ogg, application/pdf...
addMsgCol("media_name", "TEXT");  // nome original, quando é documento
/* Identificador da mensagem no WhatsApp. Guardado no que o CRM envia para
   reconhecer o webhook de volta como eco e não gravar a mesma mensagem duas
   vezes — é o que permite aceitar as mensagens digitadas direto no celular. */
addMsgCol("wa_id", "TEXT");
db.exec("CREATE INDEX IF NOT EXISTS idx_messages_wa_id ON messages(wa_id)");
/* Qual mensagem esta responde. Guarda o id LOCAL (m_...), não o do WhatsApp:
   é ele que permite montar a citação na tela mesmo quando a mensagem citada
   é antiga e não tem `wa_id` — o do WhatsApp a gente busca na hora de enviar. */
addMsgCol("reply_to", "TEXT");
/* Edição da mensagem, nas regras do WhatsApp (15 minutos, só texto, só o que
   saiu daqui). `body_original` guarda o que foi enviado da primeira vez: o CRM
   é registro de atendimento, e registro que perde a versão original deixa de
   servir para resolver discussão sobre o que foi combinado. */
addMsgCol("edited_at", "INTEGER");
addMsgCol("edited_by", "TEXT");
addMsgCol("body_original", "TEXT");

export default db;
