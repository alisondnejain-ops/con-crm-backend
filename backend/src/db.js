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
  -- venda ou aluguel (21/09/2026, pedido do Ali: a captação só tinha venda).
  -- Default 'venda' porque é o que a base inteira já era antes desta coluna
  -- existir — sem o default, todo produto anterior nasceria sem finalidade.
  finalidade TEXT NOT NULL DEFAULT 'venda' CHECK (finalidade IN ('venda','aluguel')),
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

/* AJUSTES DA PLATAFORMA, acima das imobiliárias.

   Uma tabela chave-valor pequena, e de propósito: o que mora aqui não pertence
   a imobiliária nenhuma — hoje é só a foto da tela de entrada, que é a mesma
   para todo mundo que abre o sistema.

   Não virou coluna em "orgs" porque não é de uma org, e não virou variável de
   ambiente porque quem troca é o Ali pela tela, não a hospedagem.

   (Sem crases neste comentário: ele vive dentro do template literal do
   db.exec, e uma crase aqui fecharia a string no meio do schema.) */
CREATE TABLE IF NOT EXISTS config_plataforma (
  chave TEXT PRIMARY KEY,
  valor TEXT,
  atualizado_em INTEGER
);
/* ===== PIPELINES E ETAPAS CONFIGURAVEIS =====
   (28/08/2026 - o core de gestao do ConHub)

   O funil era uma lista fixa de 11 nomes num arquivo do servidor
   (services/stages.js), igual para toda imobiliaria. Isso servia enquanto o
   produto era o CRM de uma casa. Nao serve para uma plataforma: uma operacao
   de locacao, uma de lancamento e uma de recaptacao nao tem as mesmas etapas,
   e nenhuma delas tem que pedir mudanca de codigo para existir.

   Agora cada empresa monta os proprios fluxos. As etapas deixam de ser texto
   solto e passam a ser LINHA, com dono (pipeline), ordem, cor, SLA, campos
   obrigatorios e configuracao de automacao.

   COMPATIBILIDADE: leads.stage (o NOME da etapa) continua existindo e continua
   sendo escrito. E de proposito. Umas trinta consultas e a tela inteira leem
   esse campo hoje; troca-lo de uma vez seria reescrever o sistema num commit.
   O caminho e outro: moverEtapa passa a gravar stage_id E stage juntos, quem
   ja lia o nome continua funcionando sem saber de nada, e os leitores migram
   um a um. Ver services/etapas.js. */
CREATE TABLE IF NOT EXISTS pipelines (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  -- sdr, commercial, rental, launch, recapture, post_sale, custom
  type TEXT DEFAULT 'custom',
  is_default INTEGER DEFAULT 0,
  is_active INTEGER DEFAULT 1,
  ordem INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER
);

/* org_id fica desnormalizado aqui, repetido do pipeline.

   Nao e descuido: quase toda consulta de etapa comeca por "as etapas desta
   imobiliaria", e sem a coluna cada uma delas precisaria de um JOIN com
   pipelines so para chegar ao org_id. E o isolamento entre empresas fica mais
   dificil de errar quando o filtro esta na propria tabela. */
CREATE TABLE IF NOT EXISTS pipeline_stages (
  id TEXT PRIMARY KEY,
  pipeline_id TEXT NOT NULL,
  org_id TEXT NOT NULL,
  name TEXT NOT NULL,
  ordem INTEGER DEFAULT 0,
  color TEXT,
  -- aberto | ganho | perdido. Serve para o relatorio saber o que e desfecho
  -- sem depender do nome que a empresa deu a etapa.
  status_type TEXT DEFAULT 'aberto',
  is_active INTEGER DEFAULT 1,
  /* O que separa FUNIL DE CONVERSAO de AVANCO OPERACIONAL. Etapa
     administrativa (Documentacao, Analise) faz parte da operacao e nao e
     degrau de venda; conta-la como conversao inventa numero que ninguem
     reconhece. Quem decide e a empresa, etapa por etapa. */
  counts_as_conversion INTEGER DEFAULT 0,
  -- SLA: minutos sem interacao ate a etapa estourar, e o aviso antes disso.
  sla_minutes INTEGER,
  warning_before_minutes INTEGER,
  -- JSON: chaves de campo que precisam estar preenchidas para ENTRAR aqui.
  required_fields TEXT,
  -- JSON: base para as automacoes (mover, distribuir, notificar, criar tarefa).
  automation_config TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER
);

/* ===== CAMPOS PERSONALIZADOS =====

   A DEFINICAO e tabela; o VALOR mora em leads.custom_fields (JSON).

   Definicao em tabela porque a empresa precisa listar, ordenar, dizer o tipo e
   escolher ONDE cada campo aparece — isso e dado estruturado e a tela le o
   tempo todo.

   Valor em JSON no lead porque a consulta quente do sistema (o /leads que a
   gestao recarrega de 10 em 10 segundos) ja carrega a linha do lead inteira:
   uma tabela de valores obrigaria um JOIN por campo por lead, e foi justamente
   esse tipo de custo que os indices de 27/08 vieram tirar. Se um dia for
   preciso consultar POR valor de campo, a tabela de valores entra ao lado sem
   quebrar nada — o JSON continua sendo a leitura rapida. */
CREATE TABLE IF NOT EXISTS custom_fields (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  name TEXT NOT NULL,
  key TEXT NOT NULL,
  -- text, number, currency, select, multiselect, date, boolean, phone, email
  type TEXT NOT NULL DEFAULT 'text',
  options TEXT,
  is_required_default INTEGER DEFAULT 0,
  show_on_card INTEGER DEFAULT 0,
  show_on_lead_profile INTEGER DEFAULT 1,
  show_on_conversation_sidebar INTEGER DEFAULT 0,
  show_on_reports INTEGER DEFAULT 0,
  ordem INTEGER DEFAULT 0,
  is_active INTEGER DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER
);

/* ===== HISTORICO DE TRANSFERENCIA =====

   lead_etapas ja guarda mudanca de ETAPA. Isto guarda a mudanca de DONO e de
   PIPELINE, que e outra pergunta: "por onde este lead passou e por quem".

   Existe separado porque as duas coisas acontecem em momentos diferentes — um
   lead pode trocar de responsavel sem sair da etapa, e pode mudar de pipeline
   inteiro numa transferencia do SDR para o comercial. Juntar as duas numa
   tabela so faria toda leitura ter que filtrar qual tipo de linha e qual. */
CREATE TABLE IF NOT EXISTS lead_transfers (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  lead_id TEXT NOT NULL,
  from_pipeline_id TEXT,
  from_stage_id TEXT,
  to_pipeline_id TEXT,
  to_stage_id TEXT,
  from_user_id TEXT,
  to_user_id TEXT,
  triggered_by_user_id TEXT,
  -- 'automatica' (regra da etapa), 'mao', 'rodizio', 'importacao'
  trigger_reason TEXT,
  observacao TEXT,
  created_at INTEGER NOT NULL
);

/* ===== TAGS (08/09/2026) =====

   A marcacao livre do lead: "investidor", "indicacao", "so financia", "nao
   perturbe". O que nao cabe em etapa (que e uma so e anda em ordem), nem em
   campo (que tem um valor por lead), nem em observacao (que e texto que
   ninguem consegue filtrar).

   DUAS TABELAS, E NAO UM JSON NO LEAD — ao contrario dos campos
   personalizados, que guardam o valor em leads.custom_fields. A diferenca e
   a pergunta que cada um responde. Do campo se pergunta "quanto e o orcamento
   DESTE lead", sempre a partir do lead. Da tag se pergunta o contrario:
   "QUAIS leads sao investidores" — e essa e a razao de a tag existir, porque e
   dela que sai o disparo segmentado e o filtro do funil. Varrer o JSON de
   todos os leads para responder isso e o tipo de consulta que fica lenta
   justamente quando a base cresce e a resposta comeca a importar.

   A DEFINICAO E A APLICACAO SAO SEPARADAS de proposito: renomear a tag ou
   trocar a cor dela vale nos leads que ja a tem, sem varredura nenhuma. */
CREATE TABLE IF NOT EXISTS tags (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  nome TEXT NOT NULL,
  cor TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  criada_por TEXT
);

/* A ligacao. A chave primaria composta e a trava que impede a mesma tag
   de entrar duas vezes no mesmo lead — dois cliques rapidos no mesmo botao, ou
   a automacao repetindo a acao, viram uma linha so. */
CREATE TABLE IF NOT EXISTS lead_tags (
  lead_id TEXT NOT NULL,
  tag_id TEXT NOT NULL,
  org_id TEXT NOT NULL,
  marcada_em INTEGER NOT NULL,
  marcada_por TEXT,
  PRIMARY KEY (lead_id, tag_id)
);

CREATE INDEX IF NOT EXISTS idx_tags_org ON tags(org_id, nome);
-- Os dois sentidos da pergunta: as tags de um lead, e os leads de uma tag.
CREATE INDEX IF NOT EXISTS idx_leadtags_lead ON lead_tags(lead_id);
CREATE INDEX IF NOT EXISTS idx_leadtags_tag ON lead_tags(tag_id);

/* METAS DO MES (08/09/2026): ligacoes, contatos, visitas, propostas e VGV, por
   mes, para a operacao inteira OU para um corretor especifico.

   user_id igual a string vazia (nao NULL) e a meta DA OPERACAO — sentinela de
   proposito, e nao NULL, porque o SQLite trata cada NULL como diferente de si
   mesmo dentro de um UNIQUE: duas linhas com user_id NULL para o mesmo mes nao
   colidiriam, e a trava "uma meta por alvo por mes" furaria exatamente para a
   meta da casa. */
CREATE TABLE IF NOT EXISTS metas (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  user_id TEXT NOT NULL DEFAULT '',
  mes TEXT NOT NULL,
  ligacoes INTEGER,
  contatos INTEGER,
  visitas_agendadas INTEGER,
  visitas_realizadas INTEGER,
  propostas INTEGER,
  vgv REAL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(org_id, user_id, mes)
);
CREATE INDEX IF NOT EXISTS idx_metas_org_mes ON metas(org_id, mes);

CREATE INDEX IF NOT EXISTS idx_pipelines_org ON pipelines(org_id, ordem);
CREATE INDEX IF NOT EXISTS idx_stages_pipeline ON pipeline_stages(pipeline_id, ordem);
CREATE INDEX IF NOT EXISTS idx_stages_org ON pipeline_stages(org_id, is_active);
CREATE INDEX IF NOT EXISTS idx_customfields_org ON custom_fields(org_id, ordem);
CREATE INDEX IF NOT EXISTS idx_transfers_lead ON lead_transfers(lead_id, created_at);
CREATE INDEX IF NOT EXISTS idx_transfers_org ON lead_transfers(org_id, created_at);
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

--
-- QUEM VEIO AO PLANTÃO. A atendente confere depois que o turno acontece.
--
-- Tabela SEPARADA de plantoes, e a chave é dia+turno+pessoa — não o id da
-- linha da escala. É de propósito: subir a planilha de novo APAGA e recria as
-- linhas de plantoes (é assim que a substituição do mês funciona). Se a
-- presença morasse lá, corrigir um nome na planilha e reenviar apagaria a
-- conferência do mês inteiro, sem nada aparecer na tela — e conferência
-- perdida ninguém descobre que existiu.
--
-- presente é 1 (veio), 0 (não veio) — e a AUSÊNCIA de linha é "ainda não
-- conferido", que é um terceiro estado de verdade, não um "não veio" com
-- outro nome. Contar quem ninguém conferiu como falta faria o relatório
-- inventar faltas no mês em que a atendente esqueceu de marcar.
CREATE TABLE IF NOT EXISTS plantao_presencas (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  dia INTEGER NOT NULL,
  turno TEXT NOT NULL,
  user_id TEXT NOT NULL,
  presente INTEGER NOT NULL,   -- 1 veio · 0 não veio
  obs TEXT,
  marcado_por TEXT,
  marcado_em INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_presenca_unica ON plantao_presencas(org_id, dia, turno, user_id);
CREATE INDEX IF NOT EXISTS idx_presenca_dia ON plantao_presencas(org_id, dia);
CREATE INDEX IF NOT EXISTS idx_presenca_user ON plantao_presencas(user_id, dia);
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

/* OS TRES INDICES QUE SEGURAM A PLATAFORMA CRESCER (medido em 27/08/2026).

   Com 100 imobiliarias e 6,4 milhoes de mensagens no banco, o poll de 10
   segundos da gestao custava 78 ms de servidor e o relatorio custava 1,6
   SEGUNDO. Como o better-sqlite3 e SINCRONO, esse tempo nao e "a consulta
   demora" — e o servidor inteiro parado, para todo mundo. Com os tres, o poll
   caiu para 16 ms e o relatorio para 2 ms.

   1) leads(org_id, created_at) — o /leads da gestao filtra por org_id e ordena
      por created_at, e nao havia indice nenhum por org: cada poll fazia um SCAN
      da tabela de leads da PLATAFORMA INTEIRA para achar os de uma imobiliaria.
      Com uma imobiliaria isso nao aparece; com cinquenta, cada uma paga o
      tamanho de todas as outras.

   2) messages(lead_id, created_at) — as tres subconsultas de "ultima mensagem"
      rodam por lead e faziam ORDER BY em memoria (USE TEMP B-TREE) porque o
      indice so tinha lead_id. Com a data junto, o SQLite le a ultima direto.

   3) messages(from_user_id, created_at) — o score mede o tempo de resposta DE
      CADA PESSOA, entao filtra mensagem por autor. Sem indice era varredura das
      milhoes de mensagens; e este era o pior de todos.

   Criar custa uma vez, no primeiro start depois da publicacao (13 s num banco
   de 2,4 GB; instantaneo no tamanho de hoje). Depois o IF NOT EXISTS nao faz
   mais nada. */
CREATE INDEX IF NOT EXISTS idx_leads_org ON leads(org_id, created_at);
CREATE INDEX IF NOT EXISTS idx_msg_lead_data ON messages(lead_id, created_at);
CREATE INDEX IF NOT EXISTS idx_msg_autor ON messages(from_user_id, created_at);
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

/* A PARTIR DE QUANDO os crachas desta pessoa valem. (02/09/2026)

   O token dura 30 dias e, ate aqui, nao havia NENHUM jeito de derrubar um:
   trocar a senha nao derrubava, e "remover da equipe" tambem nao — a pessoa
   demitida continuava entrando no CRM por ate um mes. Esta coluna e o carimbo
   que resolve os dois: `authRequired` recusa todo cracha emitido antes dela.

   E um INSTANTE e nao um contador de sessoes porque o que se quer dizer e
   sempre a mesma coisa — "tudo que foi emitido antes de agora morreu" — e um
   instante diz isso sem precisar guardar lista de token nenhum. Nulo significa
   "nunca invalidei nada", que e o estado de todo mundo hoje. */
addUserCol("sessoes_desde", "INTEGER");

/* O token do link de criar senha guardado como IMPRESSAO DIGITAL (sha-256).

   `invite_token` continua existindo para os links que ja estao na caixa de
   entrada de alguem — sao conferidos pelos dois campos durante a transicao e
   o antigo e apagado assim que o link e usado. O novo NASCE so aqui.

   O motivo: em claro, uma copia do banco (e a copia de seguranca diaria vai
   para um armazenamento de terceiros) era uma lista de links prontos para
   trocar a senha de qualquer conta pendente. Ver `resumoDeToken` em
   services/cofre.js — e por que e resumo, e nao criptografia. */
addUserCol("invite_hash", "TEXT");

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
/* O gestor liberou esta pessoa a ligar o WhatsApp DELA no CRM?

   Nasce desligado, e é nominal de propósito. Cada linha ligada é cobrada à
   parte, então quem decide é quem paga — sem isso a fatura da imobiliária
   cresceria por decisão de quem não assina a conta. E é uma coluna, não uma
   conta de "os N primeiros que pedirem": autorização deduzida de um número é
   autorização que muda sozinha quando o número muda. */
addUserCol("canal_liberado", "INTEGER DEFAULT 0");
/* EM QUE FUNIL OS LEADS DESTA PESSOA ENTRAM.

   O lead sempre nascia no funil PADRÃO da imobiliária, fosse de quem fosse. Com
   vários funis isso deixou de servir: os leads que caem na atendente pertencem
   ao funil de pré-atendimento, e os do corretor ao comercial — e é o DONO que
   diz qual, porque é ele quem trabalha o lead.

   Nulo é o funil padrão da casa, que é o que todo mundo era antes disto
   existir. Só quem for configurado muda de comportamento: preenchido, este
   campo também faz o lead TROCAR de funil quando é repassado para a pessoa.
   Vazio não move nada — senão um lead posto de propósito num funil especial
   voltaria para o padrão no primeiro repasse, sem ninguém pedir. */
addUserCol("pipeline_entrada", "TEXT");

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
db.exec("CREATE INDEX IF NOT EXISTS idx_users_invite_hash ON users(invite_hash)");

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
/* QUANTAS LINHAS DE WHATSAPP esta conta pode ligar, e quanto custa cada uma.

   O plano de imobiliária vendido hoje é "até 10 corretores", e a leitura em
   linhas é 1 da casa + 10 pessoais = 11. `limite_canais` é o TETO, não o que
   está contratado: cada linha ligada é cobrada à parte, mensalmente. Por isso
   o teto e o preço são campos separados — teto é o que o plano permite, preço
   é o que cada linha custa quando o gestor decide ligá-la.

   `canais_incluidos` é quantas já estão pagas dentro da mensalidade. O padrão
   é 1 porque a linha da casa já vinha junto do plano desde antes disto existir;
   passar a cobrar por ela seria aumentar o preço de quem já é cliente sem
   ninguém ter combinado. O ConHub muda esse número pelo hub quando quiser. */
addOrgCol("limite_canais", "INTEGER DEFAULT 11");
addOrgCol("canais_incluidos", "INTEGER DEFAULT 1");
addOrgCol("valor_canal", "REAL");
/* Data do vencimento ANTES de qualquer pagamento. O vencimento em vigor é
   vence_base + (um mês por pagamento registrado), o que faz apagar pagamento
   voltar a data sozinho. Ver services/assinatura.js. */
addOrgCol("vence_base", "INTEGER");
/* Qual dos planos de prateleira o corretor autônomo escolheu (services/planos.js).
   A imobiliária fica sem: o preço dela e combinado caso a caso e mora em
   valor_mensal. E o plano que diz quantos meses cada pagamento compra — o
   semestral paga seis de uma vez, e sem isso o cliente pagava meio ano e era
   bloqueado no mes seguinte. */
addOrgCol("plano_id", "TEXT");
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

/* O robô atende A QUALQUER HORA, sem janela nenhuma? (02/09/2026, pedido do Ali)

   NULO É UM ESTADO VÁLIDO e é o estado da maioria das linhas: significa
   "ninguém escolheu ainda", e a resposta sai do TIPO da conta —
   `configDoRobo` resolve nulo como ligado no corretor autônomo e desligado na
   imobiliária. É o que faz a mudança valer para as contas que já existem sem
   nenhuma migração de dados, e sem mexer no que uma imobiliária configurou.

   A razão é a diferença entre as duas casas. A imobiliária tem expediente: o
   robô cobre a ausência da atendente e se cala às 09:00 justamente para o
   tempo de resposta DELA continuar sendo o número do relatório. O corretor
   autônomo não tem turno nem tempo de resposta de outra pessoa para preservar
   — ele atende quando pode, e o lead que chega às 22h esfria até ele ver. Ali
   pediu o contrário do padrão: a IA atende sempre, e o horário fica como
   OPÇÃO para quem quiser se organizar como uma imobiliária. */
addOrgCol("robo_sempre", "INTEGER");

/* Quem foi o ÚLTIMO corretor a receber lead pelo rodízio.

   Substitui o `distribution_ptr`, que era um contador e virava outra pessoa
   sozinho: a vez era "contador % quantos estão disponíveis", e a lista de
   disponíveis muda o dia inteiro. Guardando QUEM recebeu, a fila só anda
   quando alguém de fato recebe. */
addOrgCol("rodizio_ultimo", "TEXT");
addOrgCol("atendente_ultimo", "TEXT");   // a vez das atendentes (services/catraca.js)

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
/* CORRETOR AUTÔNOMO: a mesma caixa da imobiliária, com a roda de um lugar só.

   `tipo` = 'imobiliaria' (padrão, o que já existe) ou 'autonomo'. A conta do
   autônomo é uma org como qualquer outra — WhatsApp próprio, kanban, funil,
   IA, expediente, importação de leads e mensalidade própria. O que muda é o
   tamanho: ele é o único corretor, então a catraca some (fila de uma pessoa
   não é fila) e a equipe aceita no máximo UM atendente.

   O atendente dele pode ser gente ou a IA do fora-do-expediente fazendo a
   qualificação — as duas coisas já existem e não precisam de código novo.

   `trial_ate` guarda o fim do teste grátis, e ele só começa quando a conta é
   EFETIVADA (quando a pessoa define a senha) — não na criação. Criar a conta e
   o relógio começar a correr antes de o corretor sequer receber o link seria
   vender 14 dias e entregar menos. */
addOrgCol("tipo", "TEXT DEFAULT 'imobiliaria'");
addOrgCol("trial_ate", "INTEGER");

/* LIBERAÇÃO PELO MASTER, pelo tempo que ele escolher (27/09/2026). Enquanto
   vale, a conta não trava — nem por mensalidade atrasada, nem por falta de
   cartão, nem por teste vencido. Não mexe em pagamento nenhum: é uma cortesia
   por cima da cobrança, e quando vence a conta volta a seguir a régua de
   sempre. Ver `situacao()` em services/assinatura.js. */
addOrgCol("liberado_ate", "INTEGER");

/* O PLANO QUE A PESSOA ESCOLHEU NO SITE, antes de existir cobrança. (02/09/2026)

   É diferente de `plano_id`, e a diferença é a razão de existirem os dois:
   `plano_id` é o plano CONTRATADO — só é gravado quando o Asaas confirma uma
   cobrança em curso, e é ele que manda no vencimento (`mesesPagos`).
   `plano_escolhido` é a INTENÇÃO, declarada no popup do site quando ainda não
   há cartão, nem cobrança, nem nada para o Asaas saber.

   Guardar a intenção em `plano_id` seria dizer que a conta tem plano contratado
   durante os 14 dias de teste — e a partir daí `mesesPagos` e a tela de
   assinatura passariam a descrever uma contratação que não aconteceu.

   O que ele faz de útil: no fim do teste, a tela de pagar já vem com o plano
   certo marcado, em vez de perguntar de novo o que a pessoa respondeu no
   primeiro clique do site. E diz, no hub, o que cada conta em teste pretendia
   pagar — que é a única leitura de intenção que existe antes da primeira
   fatura. */
addOrgCol("plano_escolhido", "TEXT");

/* CARTÃO OBRIGATÓRIO NO TESTE GRÁTIS (22/09/2026, pedido do Ali: "sim temos um
   teste de 14 dias mas precisa SIM cadastrar o cartão de crédito"). Até aqui o
   teste começava liberado, sem cartão nenhum, e a cobrança só existia se a
   pessoa escolhesse contratar — o que muitas vezes nunca acontecia. Agora
   quem entra pela porta pública (site) precisa passar pela fatura da Asaas e
   ANEXAR um cartão antes de o CRM abrir de verdade.

   `exige_cartao`: marca as contas nascidas pela porta pública (autônomo e
   imobiliária), para o resto do sistema saber que este É o modelo dela.
   Contas que o Ali cria na mão pelo hub (POST /orgs, /orgs/autonomos) NÃO
   ganham a marca — ele continua repassando o link de convite do jeito que já
   faz numa venda conversada, sem essa trava no meio. Default 0: toda conta
   que já existe hoje continua exatamente como está, sem migração nenhuma.

   `cartao_confirmado_em`: quando o Asaas de fato confirmou que há um cartão
   anexado à assinatura — NÃO quando ela foi criada (criar só reserva a
   cobrança futura; o cartão só existe depois que a pessoa abre a fatura
   hospedada e preenche os dados lá, fora do nosso servidor). É este campo,
   não `trial_ate`, que separa "ainda não cadastrou" de "já pode entrar" — e
   é só a partir dele que o relógio de 14 dias passa a contar (ver
   `situacao()` em services/assinatura.js). */
addOrgCol("exige_cartao", "INTEGER DEFAULT 0");
addOrgCol("cartao_confirmado_em", "INTEGER");
addOrgCol("logo_url", "TEXT");
addOrgCol("logo_key", "TEXT");
addOrgCol("cor_barra", "TEXT");

/* A CONTA DE DEMONSTRAÇÃO (03/09/2026, pedido do Ali) — uma imobiliária de
   mentira, sempre com leads e conversas em dia, para reunião comercial e
   print. `demo=1` é só uma etiqueta: para o resto do sistema (catraca, robô,
   score) esta org é uma imobiliária como qualquer outra, e é assim que tem
   que ser — senão o que aparece na reunião não é o que o cliente vai usar.
   O que a etiqueta muda é UM lugar só: o serviço que apaga e recria os leads
   dela toda madrugada (`services/demo.js`), para nunca aparecer "3 semanas
   atrás" numa tela que devia parecer viva. */
addOrgCol("demo", "INTEGER DEFAULT 0");

/* Quantos MESES de acesso este pagamento comprou.

   Era um por linha, contado com COUNT(*), e isso valia enquanto todo plano
   fosse mensal. Com o semestral do corretor autônomo deixou de valer: uma
   cobrança de R$ 1.482 empurrava o vencimento um mês só, e quem tinha acabado
   de pagar meio ano era bloqueado trinta dias depois.

   Linha antiga fica nula e conta como 1, que e o que ela sempre foi. */
const pagCols = db.prepare("PRAGMA table_info(pagamentos)").all().map(c => c.name);
if (!pagCols.includes("meses")) db.exec("ALTER TABLE pagamentos ADD COLUMN meses INTEGER");

/* Em que ETAPA do funil cada mensagem pronta aparece primeiro (24/09/2026,
   pedido do Ali). Lista JSON de ids de `pipeline_stages`; nula ou vazia é
   "todas as etapas" — que é o que toda mensagem já existente era, então a
   migração não precisa tocar em nenhuma linha. Id, e não nome: renomear a
   etapa não pode desligar a mensagem dela. */
const msgRapCols = db.prepare("PRAGMA table_info(mensagens_rapidas)").all().map(c => c.name);
if (!msgRapCols.includes("etapas")) db.exec("ALTER TABLE mensagens_rapidas ADD COLUMN etapas TEXT");

const leadCols = db.prepare("PRAGMA table_info(leads)").all().map(c => c.name);
const addLeadCol = (name, ddl) => { if (!leadCols.includes(name)) db.exec(`ALTER TABLE leads ADD COLUMN ${name} ${ddl}`); };

/* ===== O LEAD DENTRO DE UM PIPELINE =====

   `stage` (o nome) continua e continua sendo escrito — ver o comentario da
   tabela pipelines. Estas colunas sao o mesmo dado em forma de vinculo, e sao
   elas que permitem etapa configuravel, SLA e campo obrigatorio.

   Ficam NULAS nos leads anteriores a isto ate o bootstrap ligar cada um ao
   pipeline padrao da imobiliaria (ver bootstrap.js). Codigo novo tem que
   aguentar nulo aqui: base grande demora a converter e o CRM nao pode parar
   enquanto isso. */
addLeadCol("pipeline_id", "TEXT");
addLeadCol("stage_id", "TEXT");
/* Desde quando o lead esta NESTA etapa. Existe em lead_etapas, mas so a partir
   de 13/08/2026 e so quando houve mudanca — o lead que nunca se mexeu nao tem
   linha. Como o SLA precisa responder isso para TODO lead e a cada leitura de
   card, a data vira coluna: uma consulta a menos numa tela que recarrega
   sozinha o dia inteiro. */
addLeadCol("stage_entered_at", "INTEGER");
/* Ultima interacao de qualquer lado (mensagem recebida, enviada, ligacao).
   O SLA de abandono se mede por ela, e nao pela data de entrada na etapa: lead
   que entrou ontem mas conversou agora esta saudavel; lead que entrou hoje e
   nao teve resposta esta em chamas. */
addLeadCol("last_interaction_at", "INTEGER");
// Valores dos campos personalizados da empresa. JSON: {chave: valor}.
addLeadCol("custom_fields", "TEXT");

/* ===== DE ONDE O LEAD VEIO =====

   Isto estava se PERDENDO. O webhook da Meta guardava o meta_lead_id e as
   respostas do formulario, e jogava fora campanha, conjunto, anuncio e
   formulario — que e exatamente o que liga o dinheiro de marketing ao
   resultado do atendimento.

   E dado que nao volta: lead que entrou ontem sem a campanha gravada perdeu a
   atribuicao para sempre. Por isso estas colunas entram antes de qualquer
   tela que as use. */
addLeadCol("source", "TEXT");          // meta, whatsapp, importacao, manual, site
addLeadCol("platform", "TEXT");        // facebook, instagram, messenger
addLeadCol("campaign_name", "TEXT");
addLeadCol("campaign_id", "TEXT");
addLeadCol("adset_name", "TEXT");
addLeadCol("adset_id", "TEXT");
addLeadCol("ad_name", "TEXT");
addLeadCol("ad_id", "TEXT");
addLeadCol("form_name", "TEXT");
addLeadCol("form_id", "TEXT");
/* PEDIDO DE ELIMINACAO ATENDIDO — LGPD, art. 18, VI. (02/09/2026)

   Guarda QUANDO e POR QUEM, e nao o pedido em si: o registro de ter atendido e
   parte de conseguir provar que a empresa atendeu. Nulo e o normal — a imensa
   maioria dos leads nunca passa por isto.

   Ver `services/lgpd.js` para o porque de anonimizar em vez de apagar. */
addLeadCol("anonimizado_em", "INTEGER");
addLeadCol("anonimizado_por", "TEXT");

addLeadCol("last_read_at", "INTEGER");   // até quando o atendente já leu a conversa
addLeadCol("sale_value", "REAL");        // registro da venda: valor do imóvel
addLeadCol("sale_date", "INTEGER");      // data da venda
addLeadCol("sale_property", "TEXT");     // qual imóvel/unidade foi vendido
// Comissão por venda, em percentual (08/09/2026, pedido do Ali: "percentual
// por venda" — cada venda carrega a própria taxa, não um valor fixo da casa.
// Nula quando ninguém preencheu: VGC some do card em vez de virar zero falso.
addLeadCol("sale_commission_pct", "REAL");
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

/* A ETAPA QUE A CONVERSA SUGERE — e que NINGUÉM aplicou ainda.

   Até 26/08/2026 a palavra-chave MOVIA o lead sozinha. Foi tirado a pedido do
   Ali: o funil andava pela regra, a gestão corrigia na mão, e depois não havia
   como saber qual etapa era leitura de gente e qual era palpite de regex — o
   relatório virava cobrança em cima de um número que ninguém reconhecia.

   Agora a mesma leitura vira RECOMENDAÇÃO. Fica guardada aqui, ao lado do
   lead, e só entra no funil quando alguém confirma. Duas colunas e não uma:
   sem a data, "sugerido" e "sugerido há três semanas e ignorado" seriam a
   mesma coisa na tela.

   `sugestao_de` guarda a etapa em que o lead estava quando a sugestão nasceu.
   Se ele andou desde então, a sugestão está velha e some sozinha — confirmar
   uma recomendação feita sobre outro estado é como mover o lead para trás sem
   querer. */
addLeadCol("sugestao_etapa", "TEXT");
addLeadCol("sugestao_de", "TEXT");
addLeadCol("sugestao_em", "INTEGER");
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
// Captação só tinha imóvel para VENDA (21/09/2026, relatado pelo Ali). Toda
// linha que já existia é venda de verdade — é isso que ela sempre foi, então
// o default cobre a migração sozinho.
if (!prodCols.includes("finalidade")) db.exec("ALTER TABLE produtos ADD COLUMN finalidade TEXT NOT NULL DEFAULT 'venda'");

/* O ANÚNCIO NOS PORTAIS (24/09/2026, ZAP/VivaReal/OLX e Chaves na Mão).
   O catálogo nasceu para uso INTERNO — mandar o imóvel no WhatsApp — e por
   isso guardava só o que o corretor precisa ver. Portal pede o que o
   COMPRADOR precisa ver: descrição pública (separada de `observacoes`, que
   é interna e pode ter "dono aceita 10% abaixo"), endereço estruturado, vagas,
   suítes, área construída (a `metragem` que existe é a do TERRENO),
   condomínio e IPTU. `publicar_portais` nasce 0: nenhum imóvel vai para a
   internet porque uma versão nova subiu — alguém escolhe publicar. */
for (const [col, tipo] of [
  ["publicar_portais", "INTEGER DEFAULT 0"], ["descricao", "TEXT"], ["uf", "TEXT"], ["cep", "TEXT"],
  ["numero_end", "TEXT"], ["complemento", "TEXT"], ["latitude", "REAL"], ["longitude", "REAL"],
  ["vagas", "INTEGER"], ["suites", "INTEGER"], ["area_util", "REAL"], ["condominio", "REAL"], ["iptu", "REAL"],
  ["exibir_endereco", "TEXT DEFAULT 'bairro'"], ["atualizado_em", "INTEGER"],
]) if (!prodCols.includes(col)) db.exec(`ALTER TABLE produtos ADD COLUMN ${col} ${tipo}`);

/* Configuração de portais POR IMOBILIÁRIA. Dois tokens, e não um, de
   propósito: o do FEED é colado no painel de cada portal e circula por lá
   (é só leitura dos anúncios que a casa já publica); o dos LEADS abre a
   porta de ESCRITA — com ele se cria lead na conta. Um só token faria de
   quem viu o endereço do feed alguém capaz de encher o CRM de lead falso. */
/* PÁGINAS DO FACEBOOK CONECTADAS PELO BOTÃO "Conectar com Facebook"
   (01/10/2026). `page_id` é a CHAVE: uma página pertence a UMA conta do
   ConHub, e é por ela que o lead de formulário que a Meta avisa encontra a
   imobiliária certa. Lead de página que não está aqui não é entregue a
   ninguém (exceto a página antiga da instalação, ver meta.webhook.js).
   `page_token` vai fechado pelo cofre quando a CRYPTO_KEY existe. */
db.exec(`CREATE TABLE IF NOT EXISTS meta_paginas (
  page_id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  nome TEXT,
  page_token TEXT NOT NULL,
  conectado_por TEXT,
  conectado_em INTEGER NOT NULL,
  ultimo_lead_em INTEGER,
  ultimo_erro TEXT,
  ultimo_erro_em INTEGER
)`);
db.exec("CREATE INDEX IF NOT EXISTS idx_meta_paginas_org ON meta_paginas(org_id)");
/* FORMULÁRIOS DA META E O FUNIL DE CADA UM (03/10/2026, pedido do Ali: "a
   opção de aplicar um determinado formulário a um funil específico"). Uma
   linha por formulário que a imobiliária configurou. `pipeline_id` nulo é
   "seguir a regra de sempre" (o funil de quem recebe o lead). A chave inclui a
   conta: o id do formulário vem de fora, e a escolha de uma imobiliária nunca
   vale para a outra. */
db.exec(`CREATE TABLE IF NOT EXISTS meta_formularios (
  org_id TEXT NOT NULL,
  form_id TEXT NOT NULL,
  page_id TEXT,
  nome TEXT,
  pipeline_id TEXT,
  stage_id TEXT,
  atualizado_por TEXT,
  atualizado_em INTEGER,
  PRIMARY KEY (org_id, form_id)
)`);
/* CATRACAS POR PRODUTO (03/10/2026, pedido do Ali: "várias catracas de
   atendimento para vários produtos que a imobiliária tenha, e cada formulário
   vinculado a uma catraca"). A catraca de sempre (todos os corretores, a vez em
   `orgs.rodizio_ultimo`) continua existindo SEM linha aqui — ela é a "Catraca
   principal". Esta tabela só guarda as catracas NOVAS, então nenhum cliente
   muda de comportamento enquanto não criar uma.

   `entrega`: 'atendente' (o lead do formulário vai para a atendente da vez e
   ela repassa pela catraca do produto) ou 'corretor' (vai direto para o
   próximo corretor disponível desta catraca). `ultimo_user_id` é a vez desta
   catraca — separada da principal, senão uma embaralharia a outra. */
db.exec(`CREATE TABLE IF NOT EXISTS catracas (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  nome TEXT NOT NULL,
  entrega TEXT NOT NULL DEFAULT 'atendente',
  ativa INTEGER NOT NULL DEFAULT 1,
  ultimo_user_id TEXT,
  criada_por TEXT,
  created_at INTEGER NOT NULL
)`);
db.exec("CREATE INDEX IF NOT EXISTS idx_catracas_org ON catracas(org_id)");
// Um corretor pode estar em várias catracas (decisão do Ali).
db.exec(`CREATE TABLE IF NOT EXISTS catraca_membros (
  catraca_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  org_id TEXT NOT NULL,
  added_at INTEGER NOT NULL,
  PRIMARY KEY (catraca_id, user_id)
)`);
const metaFormCols = db.prepare("PRAGMA table_info(meta_formularios)").all().map(c => c.name);
if (!metaFormCols.includes("catraca_id")) db.exec("ALTER TABLE meta_formularios ADD COLUMN catraca_id TEXT");
db.exec(`CREATE TABLE IF NOT EXISTS portais_config (
  org_id TEXT PRIMARY KEY,
  token_feed TEXT UNIQUE NOT NULL,
  token_leads TEXT UNIQUE NOT NULL,
  email TEXT,
  telefone TEXT,
  created_at INTEGER NOT NULL
)`);
/* Lead que o portal já entregou. O portal REENVIA quando não recebe 200 a
   tempo — sem esta tabela, cada reenvio viraria uma observação repetida
   (ou um lead repetido, se o telefone vier diferente). */
db.exec(`CREATE TABLE IF NOT EXISTS portais_leads (
  org_id TEXT NOT NULL,
  portal TEXT NOT NULL,
  externo_id TEXT NOT NULL,
  lead_id TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (org_id, portal, externo_id)
)`);

/* O SITE DA IMOBILIÁRIA (24/09/2026): um portal próprio com o catálogo e uma
   página por imóvel, em /imoveis/<slug>. Tabela à parte e não colunas em
   `orgs` porque é um produto com vida própria — endereço, WhatsApp, Pixel —
   e a linha só existe para quem abriu a tela.

   `ligado` nasce 0 pela mesma régua do `publicar_portais`: o catálogo inteiro
   não vai para a internet porque uma versão nova subiu. O gestor liga.

   `slug` é o endereço público e é ÚNICO na plataforma inteira: duas
   imobiliárias com o mesmo endereço seriam um site mostrando o catálogo da
   outra. */
db.exec(`CREATE TABLE IF NOT EXISTS sites (
  org_id TEXT PRIMARY KEY,
  slug TEXT UNIQUE NOT NULL,
  ligado INTEGER NOT NULL DEFAULT 0,
  whatsapp TEXT,
  pixel_id TEXT,
  frase TEXT,
  created_at INTEGER NOT NULL,
  atualizado_em INTEGER
)`);

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
/* O texto da mensagem que o CLIENTE respondeu, quando o WhatsApp o manda junto
   e a mensagem citada NÃO existe no CRM (anterior ao lead, ou mandada do
   celular antes). Reserva do `reply_to`: sem ela a resposta aparecia solta. */
addMsgCol("reply_trecho", "TEXT");
/* Identificador da mensagem no WhatsApp. Guardado no que o CRM envia para
   reconhecer o webhook de volta como eco e não gravar a mesma mensagem duas
   vezes — é o que permite aceitar as mensagens digitadas direto no celular. */
addMsgCol("wa_id", "TEXT");
db.exec("CREATE INDEX IF NOT EXISTS idx_messages_wa_id ON messages(wa_id)");

/* MESMO wa_id NUNCA MAIS DUAS VEZES (22/09/2026, relatado pelo Ali: "as
   mensagens estão indo duplicadas para o lead do cliente" — só no CRM, o
   cliente recebia uma vez só).

   A checagem de eco em `processarMensagemRecebida` (mensageria.js) faz um
   SELECT por wa_id ANTES de inserir. Para mensagem de TEXTO isso nunca
   falhava, porque não existe `await` de verdade entre o SELECT e o INSERT.
   Mensagem de MÍDIA tem: o download do áudio/foto na Uazapi é uma chamada
   de rede real, com tempo real. Se a Uazapi mandar o MESMO evento duas
   vezes em sucessão rápida (Baileys, a base da maioria dos provedores como
   a Uazapi, resincroniza mensagens entre dispositivos e pode reentregar) —
   o segundo webhook roda o PRÓPRIO SELECT enquanto o primeiro ainda está
   baixando o arquivo, não acha nada (o primeiro ainda não inseriu) e
   também insere. Dois SELECTs "ao mesmo tempo", os dois vazios — checagem
   em JavaScript não fecha essa fresta, só o BANCO fecha, porque a escrita
   em si é atômica.

   Por isso o índice é ÚNICO, não só de busca: `processarMensagemRecebida`
   passa a tratar a recusa do banco como "perdi a corrida, é eco" — não
   como erro. PARCIAL, e em DOIS sentidos:

   - `WHERE wa_id IS NOT NULL`: mensagem sem wa_id é normal (enviada antes
     de 08/08/2026, ou envio que nunca recebeu id — ver `envio_sem_id`) e
     não deve competir contra outras sem id;
   - `AND direction = 'out'`: a corrida só existe para `fromMe` (o
     download de mídia é o `await` no meio do caminho). Mensagem
     RECEBIDA do cliente (`direction='in'`) é OUTRA regra, testada de
     propósito em `teste:whatsapp-oficial` caso 8: a Meta pode reentregar
     o mesmo `wamid` para uma mensagem que o cliente mandou de novo por
     conta própria, e as duas contam — travar por `wa_id` aqui apagaria
     conversa de verdade. Único = só do lado em que "mesmo id duas vezes"
     SEMPRE significa eco, nunca conteúdo novo.

   LIMPA ANTES DE TRAVAR: se este defeito já duplicou alguma mensagem em
   produção — e já duplicou —, criar o índice sem limpar faria o SERVIDOR
   NÃO SUBIR (`CREATE UNIQUE INDEX` falha na hora se já existe violação).
   Mantém a linha mais ANTIGA de cada grupo (a que chegou primeiro) e
   apaga as repetidas — nunca a mais nova, porque é a antiga que o
   cliente viu primeiro e a que uma citação já feita, se houver, aponta.
   Só entre linhas `direction='out'`, pela mesma razão do índice: apagar
   uma repetição de mensagem RECEBIDA apagaria histórico de verdade. */
const waDuplicados = db.prepare(
  "SELECT wa_id FROM messages WHERE wa_id IS NOT NULL AND direction = 'out' GROUP BY wa_id HAVING COUNT(*) > 1").all();
if (waDuplicados.length) {
  const apagarExtras = db.prepare(`DELETE FROM messages WHERE wa_id = ? AND direction = 'out' AND id NOT IN (
    SELECT id FROM messages WHERE wa_id = ? AND direction = 'out' ORDER BY created_at ASC, rowid ASC LIMIT 1)`);
  let apagadas = 0;
  for (const { wa_id } of waDuplicados) apagadas += apagarExtras.run(wa_id, wa_id).changes;
  console.log(`[messages] ${waDuplicados.length} wa_id duplicado(s) (enviadas) — ${apagadas} mensagem(ns) repetida(s) apagada(s) antes de travar o índice único.`);
}
db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_wa_id_unico ON messages(wa_id) WHERE wa_id IS NOT NULL AND direction = 'out'");
/* ===== A MESMA MENSAGEM RECEBIDA TAMBÉM NÃO ENTRA DUAS VEZES (29/09/2026) =====

   Relato do Ali: "as mensagens estão indo duplicadas no CRM". O CRM passou a
   ligar sozinho o webhook de cada número (services/webhook-uazapi.js) — e
   numa conta que JÁ recebia pelo webhook GERAL da Uazapi (o da conta de
   administração, que o token da instância não enxerga), cada mensagem passou
   a chegar duas vezes. Entrar duas vezes só foi possível porque a trava
   acima valia só para as ENVIADAS: a de 22/09 partia de que "o mesmo id
   recebido duas vezes pode ser o cliente mandando de novo". Não pode — cada
   mensagem que o cliente manda ganha um id novo do WhatsApp. O mesmo id é a
   mesma mensagem, entregue duas vezes.

   Por LEAD, e não na plataforma inteira: a mesma mensagem só pode ser
   repetida dentro da mesma conversa. O caminho principal é a conferência em
   `processarMensagemRecebida`, que também casa o id com e sem o número da
   instância na frente ("5587…:3EB0…" e "3EB0…"); este índice é o fecho
   contra a corrida de duas entregas simultâneas.

   LIMPA ANTES DE TRAVAR, uma vez só (marcada em config_plataforma): mantém a
   linha mais antiga de cada grupo, e quem citava uma das repetidas passa a
   citar a que ficou. Sem a limpeza o índice falharia e o servidor não
   subiria. */
if (!db.prepare("SELECT 1 FROM config_plataforma WHERE chave = 'limpeza_recebidas_duplicadas'").get()) {
  const chave = "substr(wa_id, instr(wa_id, ':') + 1)";
  const grupos = db.prepare(`SELECT lead_id, ${chave} AS k FROM messages
    WHERE wa_id IS NOT NULL AND direction = 'in' GROUP BY lead_id, k HAVING COUNT(*) > 1`).all();
  let apagadas = 0;
  // `reply_to` pode ainda não existir neste ponto num banco antigo (as
  // colunas novas de messages são acrescentadas mais adiante neste arquivo).
  const temCitacao = db.prepare("PRAGMA table_info(messages)").all().some(c => c.name === "reply_to");
  db.transaction(() => {
    for (const g of grupos) {
      const linhas = db.prepare(`SELECT id FROM messages WHERE lead_id = ? AND direction = 'in' AND wa_id IS NOT NULL
        AND ${chave} = ? ORDER BY created_at ASC, rowid ASC`).all(g.lead_id, g.k);
      const [fica, ...sai] = linhas.map(l => l.id);
      for (const id of sai) {
        if (temCitacao) db.prepare("UPDATE messages SET reply_to = ? WHERE reply_to = ?").run(fica, id);
        apagadas += db.prepare("DELETE FROM messages WHERE id = ?").run(id).changes;
      }
    }
    db.prepare("INSERT OR REPLACE INTO config_plataforma (chave, valor, atualizado_em) VALUES ('limpeza_recebidas_duplicadas', ?, ?)")
      .run(String(apagadas), Date.now());
  })();
  if (apagadas) console.log(`[messages] ${apagadas} mensagem(ns) recebida(s) repetida(s) apagada(s) (a mesma mensagem entregue duas vezes).`);
}
db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_wa_id_recebida ON messages(lead_id, wa_id) WHERE wa_id IS NOT NULL AND direction = 'in'");
/* As leituras novas do core de gestao: o kanban por pipeline e o painel de SLA
   filtram leads por etapa e por pipeline dentro da imobiliaria. Sem indice,
   cada um deles varre a tabela de leads da plataforma inteira — foi o que os
   indices de 27/08 vieram consertar, e nao vale reintroduzir o problema. */
/* ===== ULTIMA INTERACAO DO LEAD, POR GATILHO =====

   `leads.last_interaction_at` e a base do SLA: e dela que sai "abandonado ha
   X horas". Manter esse campo do lado de fora significaria lembrar de
   atualiza-lo em SEIS lugares diferentes hoje (dois webhooks, tres rotas de
   mensagem, o robo) e no setimo que alguem escrever daqui a tres meses — e o
   esquecido nao da erro: ele so faz o lead parecer abandonado enquanto a
   conversa acontece.

   Por isso a regra mora no BANCO. O gatilho roda junto do INSERT, na mesma
   transacao, e nao ha caminho que escape dele.

   O preco e conhecido e esta escrito aqui de proposito: gatilho e codigo
   invisivel: nao aparece em nenhum arquivo de rota, e quem for procurar por
   que um campo mudou nao vai encontrar. Vale a troca porque a alternativa e
   um campo que fica errado em silencio — e um SLA que mente e pior que um SLA
   que nao existe.

   `MAX` protege contra a mensagem antiga que chega atrasada (reenvio da
   Uazapi, importacao de historico): ela nao pode fazer o lead retroceder para
   uma data anterior a ultima conversa de verdade. */
/* MENSAGEM DE DISPARO NÃO É INTERAÇÃO (27/09/2026). Uma campanha passando
   por trezentos leads esquecidos deixaria os trezentos "em dia" no prazo da
   etapa, sem ninguém da equipe ter tocado neles. A resposta do cliente conta
   (é mensagem recebida); a campanha não. A mesma regra de
   services/marca-disparo.js, escrita aqui em SQL porque gatilho não chama
   JavaScript — se uma mudar, a outra muda junto. O gatilho é recriado a cada
   start para a versão nova valer nos bancos que já têm a antiga. */
db.exec(`DROP TRIGGER IF EXISTS trg_msg_interacao;
  CREATE TRIGGER trg_msg_interacao
  AFTER INSERT ON messages
  WHEN NOT (NEW.direction = 'out' AND NEW.from_user_id IS NULL AND COALESCE(NEW.from_name, '') LIKE 'Disparo%')
  BEGIN
    UPDATE leads SET last_interaction_at = MAX(COALESCE(last_interaction_at, 0), NEW.created_at)
    WHERE id = NEW.lead_id;
  END;`);
db.exec(`CREATE TRIGGER IF NOT EXISTS trg_ligacao_interacao
  AFTER INSERT ON ligacoes BEGIN
    UPDATE leads SET last_interaction_at = MAX(COALESCE(last_interaction_at, 0), NEW.created_at)
    WHERE id = NEW.lead_id;
  END;`);

/* A base de hoje nasce com o campo nulo, e nulo faria todo lead antigo
   aparecer como "nunca teve interacao" — coral no painel inteiro no primeiro
   dia. Uma vez so, preenche a partir da ultima mensagem que cada um tem. */
db.exec(`UPDATE leads SET last_interaction_at = (
    SELECT MAX(m.created_at) FROM messages m WHERE m.lead_id = leads.id)
  WHERE last_interaction_at IS NULL
    AND EXISTS (SELECT 1 FROM messages m WHERE m.lead_id = leads.id)`);

db.exec("CREATE INDEX IF NOT EXISTS idx_leads_stage_id ON leads(org_id, stage_id)");
db.exec("CREATE INDEX IF NOT EXISTS idx_leads_pipeline ON leads(org_id, pipeline_id, stage_id)");
db.exec("CREATE INDEX IF NOT EXISTS idx_leads_campanha ON leads(org_id, campaign_id)");
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

/* ===== AS LINHAS DE WHATSAPP (canais) =====

   Até aqui a imobiliária tinha UMA conexão, guardada em `orgs.uazapi_*`, e o
   sistema inteiro assumia isso: o número era um só, e por isso toda mensagem
   que saía era assinada com o nome do corretor (`*Marina:*`) — o lead precisava
   saber com quem falava.

   Agora o corretor pode ligar o WhatsApp DELE. A conversa continua acontecendo
   dentro do CRM, mas sai por outra linha. Uma linha por LUGAR de onde a
   mensagem sai e para onde ela chega: a da casa (tipo 'imobiliaria') e as
   pessoais (tipo 'corretor', com `user_id`).

   `orgs.uazapi_host/uazapi_token` CONTINUAM sendo escritos, sempre em par com
   a linha da casa. É a mesma escolha de `leads.stage` ao lado de `stage_id`:
   há código demais lendo as colunas antigas para trocar tudo num commit com a
   operação rodando em cima. O par é mantido num lugar só (services/canais.js).

   O token é único no sistema INTEIRO, não só dentro da imobiliária: é ele que
   o webhook usa para descobrir de quem é a mensagem que chegou. Dois canais com
   o mesmo token seriam duas conversas disputando a mesma entrada, e o
   desempate seria a ordem das linhas na tabela — ou seja, sorte. */
db.exec(`
CREATE TABLE IF NOT EXISTS canais (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  tipo TEXT NOT NULL,            -- 'imobiliaria' | 'corretor'
  user_id TEXT,                  -- nulo na linha da casa
  nome TEXT,
  host TEXT,
  token TEXT,
  wa_number TEXT,                -- o número pareado, para o diagnóstico
  ativo INTEGER DEFAULT 1,
  robo_ligado INTEGER DEFAULT 0, -- o robô fora do expediente responde nesta linha?
  criado_por TEXT,
  created_at INTEGER NOT NULL,
  conectado_em INTEGER
);
CREATE INDEX IF NOT EXISTS idx_canal_org ON canais(org_id, tipo);
-- Uma linha pessoal por pessoa: duas seriam duas caixas de entrada para a
-- mesma pessoa, e a tela "Meu WhatsApp" não teria como escolher entre elas.
CREATE UNIQUE INDEX IF NOT EXISTS idx_canal_user ON canais(org_id, user_id) WHERE user_id IS NOT NULL;
`);

/* ===== API OFICIAL DA META (WhatsApp Cloud API) — 03/09/2026 =====

   Até aqui só existia a Uazapi, que é API NÃO OFICIAL: cada linha é uma
   instância que se identifica por HOST (o endereço da instância) + TOKEN (a
   credencial dela), e um token pertence a UMA linha só — daí o índice único
   antigo em `token`.

   A API OFICIAL da Meta funciona diferente, e o schema precisa refletir isso:

   - Não existe "host": o endereço é sempre o mesmo (graph.facebook.com), e o
     que identifica CADA NÚMERO é o `phone_number_id`, que a Meta atribui.
   - O TOKEN é do APP/WABA (a "empresa" cadastrada na Meta), não da linha. Uma
     imobiliária pode ter várias linhas (a da casa + a de cada corretor) sob o
     MESMO WABA — na prática, várias pessoas registrando o próprio número
     dentro do mesmo "aplicativo" que o gestor criou. Isso significa que o
     MESMO token aparece em VÁRIAS linhas — o oposto do que a Uazapi permitia,
     e é por isso que o índice único antigo (`idx_canal_token`) tinha que sair:
     ele proibiria a segunda linha oficial de existir.
   - `app_secret` e `verify_token` também são do WABA/App, e por isso ficam
     copiados em toda linha oficial da mesma imobiliária (mesma filosofia de
     `orgs.uazapi_*` ao lado de `canais`: duplicação que se paga num lugar só,
     em `services/canais.js`, para toda leitura poder confiar só na própria
     linha sem precisar de um JOIN).
   - `waba_id` é o identificador da conta comercial, usado para listar os
     modelos de mensagem aprovados (necessários fora da janela de 24h).

   `provider` decide qual código de envio/recebimento uma linha usa. Nasce
   'uazapi' em toda linha que já existe — é o comportamento de sempre, sem
   migração nenhuma precisar rodar. */
const canalCols = db.prepare("PRAGMA table_info(canais)").all().map(c => c.name);
const addCanalCol = (name, ddl) => { if (!canalCols.includes(name)) db.exec(`ALTER TABLE canais ADD COLUMN ${name} ${ddl}`); };
addCanalCol("provider", "TEXT DEFAULT 'uazapi'");
addCanalCol("phone_number_id", "TEXT");
addCanalCol("waba_id", "TEXT");
addCanalCol("app_secret", "TEXT");
addCanalCol("verify_token", "TEXT");
/* O RECEBIMENTO DE CADA LINHA (29/09/2026, ver services/webhook-uazapi.js):
   se o webhook da instância na Uazapi aponta para o CRM. `webhook_estado` é
   'ok' | 'erro' | nulo (nunca conferido); `webhook_detalhe` é a frase que a
   tela mostra quando não está ok. */
addCanalCol("webhook_estado", "TEXT");
addCanalCol("webhook_em", "INTEGER");
addCanalCol("webhook_detalhe", "TEXT");

/* TRIAGEM DE NÚMEROS NOVOS (03/10/2026, pedido do Ali: "não espelhar conversas
   pessoais"). Até aqui todo número que escrevia virava lead — no WhatsApp
   pessoal do corretor, a mãe e o grupo da família viravam "lead" na caixa
   dele, com a conversa inteira gravada (services/triagem.js).

   `canais.triagem` NULO é "ninguém escolheu": ligada na linha pessoal,
   desligada no número da casa. Escolher grava 0/1 e vale mais que o tipo. */
addCanalCol("triagem", "INTEGER");
db.exec(`
/* Quem escreveu e ainda não foi decidido. Guarda o MÍNIMO — nome, número,
   quando e quantas mensagens —, nunca o texto: se for conversa pessoal, nada
   dela fica no CRM. linha = '' é o número da casa (sentinela, e não NULL:
   dentro de um UNIQUE, cada NULL é diferente de si mesmo). */
CREATE TABLE IF NOT EXISTS contatos_novos (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  linha TEXT NOT NULL DEFAULT '',
  phone TEXT NOT NULL,
  nome TEXT,
  primeira_em INTEGER NOT NULL,
  ultima_em INTEGER NOT NULL,
  quantas INTEGER NOT NULL DEFAULT 1,
  UNIQUE(org_id, linha, phone)
);
/* Número marcado como pessoal naquela linha: a mensagem dele nem chega a ser
   lida. Tem volta ("voltar a receber"), porque o clique errado tiraria um
   cliente de verdade do CRM sem ninguém perceber. */
CREATE TABLE IF NOT EXISTS numeros_pessoais (
  org_id TEXT NOT NULL,
  linha TEXT NOT NULL DEFAULT '',
  phone TEXT NOT NULL,
  nome TEXT,
  marcado_por TEXT,
  marcado_em INTEGER NOT NULL,
  PRIMARY KEY (org_id, linha, phone)
);
`);

/* O índice único de TOKEN só vale para a Uazapi — é lá que token = uma linha.
   Precisa de DROP e recriação porque um banco já publicado criou o antigo sem
   a condição de provider, e `CREATE INDEX IF NOT EXISTS` não troca a definição
   de um índice que já existe com esse nome. */
db.exec("DROP INDEX IF EXISTS idx_canal_token");
db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_canal_token ON canais(token) WHERE token IS NOT NULL AND provider = 'uazapi'");
/* E o de `phone_number_id` é o equivalente para a linha oficial: um número da
   Meta só pode estar registrado numa linha do ConHub por vez — não porque duas
   imobiliárias possam disputar o mesmo número (a Meta já impede isso do lado
   dela), mas porque é a mesma garantia que o token dava: a coluna que aponta
   para "qual linha é esta" tem que ser única. */
db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_canal_phone ON canais(phone_number_id) WHERE phone_number_id IS NOT NULL");

/* Por qual linha esta conversa está acontecendo AGORA.

   Nulo = a linha da casa, que é o que toda conversa existente é. Não é um
   enfeite de histórico: é para onde a próxima mensagem vai sair. A regra que
   o mantém é uma só — **responde-se pela linha que o cliente usou por último**
   —, e ela é a única sem buraco: o cliente escreve para o número que ele tem
   no telefone, e responder por outro faria a resposta chegar como mensagem de
   um desconhecido. */
addLeadCol("canal_id", "TEXT");
db.exec("CREATE INDEX IF NOT EXISTS idx_leads_canal ON leads(org_id, canal_id)");
/* Por qual catraca este lead é repassado (03/10/2026). Nulo = a catraca
   principal, que é o que todo lead existente é — nada precisa ser migrado. */
addLeadCol("catraca_id", "TEXT");
/* E por qual linha CADA mensagem passou. O lead aponta para o presente; a
   mensagem guarda o passado. Sem ela, uma conversa que começou no número da
   casa e migrou para o do corretor ficaria toda marcada como se tivesse saído
   da linha atual — e "por onde isso foi combinado" é justamente a pergunta que
   duas linhas na mesma conversa criam. */
addMsgCol("canal_id", "TEXT");

/* ===== MARKETING: A ESTRUTURA DO DISPARO EM MASSA (27/09/2026) =====

   Primeira fase, pedido do Ali: antes de qualquer envio existir, tudo o que
   PROVA que o ConHub cumpriu a lei e que a responsabilidade pelos contatos é
   da imobiliária. Ver services/marketing.js.

   - `orgs.marketing_liberado`: o master liga por conta, no hub. Desligado é o
     padrão — o recurso não aparece para quem não foi liberado.
   - `marketing_termos`: cada aceite do termo, com quem, quando, de onde e o
     resumo (hash) do texto exato que foi aceito. Linha nunca é apagada.
   - `marketing_numero`: o número SEPARADO de onde os disparos vão sair.
   - `marketing_listas` + `marketing_contatos`: cada lista enviada, com a
     declaração de origem e o ARQUIVO ORIGINAL guardado no banco (compactado),
     nunca num endereço público — é dado pessoal e é a prova.
   - `marketing_bloqueio`: quem pediu para sair. Permanente por imobiliária. */
addOrgCol("marketing_liberado", "INTEGER DEFAULT 0");
addOrgCol("marketing_liberado_em", "INTEGER");
addOrgCol("marketing_liberado_por", "TEXT");
db.exec(`
CREATE TABLE IF NOT EXISTS marketing_termos (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  user_nome TEXT,
  user_email TEXT,
  papel TEXT,
  versao TEXT NOT NULL,
  texto_hash TEXT NOT NULL,
  ip TEXT,
  user_agent TEXT,
  aceito_em INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_mkt_termo_org ON marketing_termos(org_id, aceito_em);
CREATE TABLE IF NOT EXISTS marketing_numero (
  org_id TEXT PRIMARY KEY,
  host TEXT NOT NULL,
  token TEXT NOT NULL,
  numero TEXT,
  conectado INTEGER,
  atualizado_em INTEGER NOT NULL,
  atualizado_por TEXT
);
CREATE TABLE IF NOT EXISTS marketing_listas (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  nome TEXT NOT NULL,
  origem TEXT NOT NULL,
  origem_detalhe TEXT,
  coletado_em TEXT,
  declaracao TEXT NOT NULL,
  arquivo_nome TEXT,
  arquivo_hash TEXT,
  arquivo_bytes INTEGER,
  arquivo_gz BLOB,
  total INTEGER DEFAULT 0,
  validos INTEGER DEFAULT 0,
  invalidos INTEGER DEFAULT 0,
  repetidos INTEGER DEFAULT 0,
  bloqueados INTEGER DEFAULT 0,
  criado_por TEXT,
  criado_por_nome TEXT,
  ip TEXT,
  criado_em INTEGER NOT NULL,
  arquivada_em INTEGER,
  arquivada_por TEXT
);
CREATE INDEX IF NOT EXISTS idx_mkt_listas_org ON marketing_listas(org_id, criado_em);
CREATE TABLE IF NOT EXISTS marketing_contatos (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  lista_id TEXT NOT NULL,
  telefone TEXT NOT NULL,
  nome TEXT,
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_mkt_contato_lista ON marketing_contatos(lista_id, telefone);
CREATE INDEX IF NOT EXISTS idx_mkt_contato_tel ON marketing_contatos(org_id, telefone);
CREATE TABLE IF NOT EXISTS marketing_bloqueio (
  org_id TEXT NOT NULL,
  telefone TEXT NOT NULL,
  motivo TEXT NOT NULL,
  texto TEXT,
  criado_por TEXT,
  criado_em INTEGER NOT NULL,
  PRIMARY KEY (org_id, telefone)
);
`);

/* ===== MARKETING: FLUXOS E DISPAROS (27/09/2026) =====

   A segunda fase. Ver services/disparo.js para as regras.

   - `marketing_numero` ganha os LIMITES do envio (por dia, intervalo,
     horário) e aponta para uma linha em `canais` do tipo 'disparo' — é por
     ela que as respostas do cliente entram na conversa do lead.
   - `marketing_fluxos`: o desenho do fluxo (o construtor), editável.
   - `marketing_campanhas`: cada disparo, com uma CÓPIA do fluxo no momento
     de começar (mexer no fluxo depois não muda o que já está no ar), o
     público escolhido e a declaração de quem disparou.
   - `marketing_execucoes`: uma linha por pessoa em cada campanha — em que
     bloco ela está e quando é a próxima ação.
   - `marketing_envios`: cada mensagem que saiu (ou falhou). É o relatório e é
     o que conta o limite por dia. */
const mktNumCols = db.prepare("PRAGMA table_info(marketing_numero)").all().map(c => c.name);
const addMktNumCol = (name, ddl) => { if (!mktNumCols.includes(name)) db.exec(`ALTER TABLE marketing_numero ADD COLUMN ${name} ${ddl}`); };
addMktNumCol("canal_id", "TEXT");
addMktNumCol("limite_dia", "INTEGER DEFAULT 150");
addMktNumCol("intervalo_min", "INTEGER DEFAULT 30");
addMktNumCol("intervalo_max", "INTEGER DEFAULT 90");
addMktNumCol("hora_inicio", "INTEGER DEFAULT 8");
addMktNumCol("hora_fim", "INTEGER DEFAULT 20");
addMktNumCol("domingo", "INTEGER DEFAULT 0");
addMktNumCol("proximo_envio_em", "INTEGER");
/* O RITMO passou a ser da conta (27/09/2026): o número de disparo virou
   opcional (sem ele o disparo sai pela linha da casa), e o ritmo não podia
   continuar morando na linha de um número que talvez não exista. As colunas
   de limite em `marketing_numero` ficam, sem uso — copiadas uma vez para cá. */
db.exec(`CREATE TABLE IF NOT EXISTS marketing_ritmo (
  org_id TEXT PRIMARY KEY,
  limite_dia INTEGER DEFAULT 150,
  intervalo_min INTEGER DEFAULT 30,
  intervalo_max INTEGER DEFAULT 90,
  hora_inicio INTEGER DEFAULT 8,
  hora_fim INTEGER DEFAULT 20,
  domingo INTEGER DEFAULT 0,
  proximo_envio_em INTEGER
)`);
db.exec(`INSERT OR IGNORE INTO marketing_ritmo (org_id,limite_dia,intervalo_min,intervalo_max,hora_inicio,hora_fim,domingo,proximo_envio_em)
  SELECT org_id,limite_dia,intervalo_min,intervalo_max,hora_inicio,hora_fim,domingo,proximo_envio_em FROM marketing_numero`);
db.exec(`
CREATE TABLE IF NOT EXISTS marketing_fluxos (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  nome TEXT NOT NULL,
  grafo TEXT NOT NULL,
  criado_por TEXT,
  criado_em INTEGER NOT NULL,
  atualizado_em INTEGER NOT NULL,
  apagado_em INTEGER
);
CREATE INDEX IF NOT EXISTS idx_mkt_fluxos_org ON marketing_fluxos(org_id, atualizado_em);
CREATE TABLE IF NOT EXISTS marketing_campanhas (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  nome TEXT NOT NULL,
  fluxo_id TEXT,
  fluxo_nome TEXT,
  grafo TEXT NOT NULL,
  publico TEXT NOT NULL,
  declaracao TEXT,
  status TEXT NOT NULL,
  motivo TEXT,
  falhas_seguidas INTEGER DEFAULT 0,
  total INTEGER DEFAULT 0,
  criado_por TEXT,
  criado_por_nome TEXT,
  ip TEXT,
  criado_em INTEGER NOT NULL,
  iniciada_em INTEGER,
  concluida_em INTEGER
);
CREATE INDEX IF NOT EXISTS idx_mkt_camp_org ON marketing_campanhas(org_id, criado_em);
CREATE TABLE IF NOT EXISTS marketing_execucoes (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  campanha_id TEXT NOT NULL,
  telefone TEXT NOT NULL,
  nome TEXT,
  lead_id TEXT,
  no_atual TEXT,
  estado TEXT NOT NULL,
  proxima_em INTEGER,
  espera_ate INTEGER,
  tentativas INTEGER DEFAULT 0,
  primeira_enviada INTEGER DEFAULT 0,
  respondeu INTEGER DEFAULT 0,
  fim_motivo TEXT,
  criado_em INTEGER NOT NULL,
  atualizado_em INTEGER
);
CREATE INDEX IF NOT EXISTS idx_mkt_exec_fila ON marketing_execucoes(estado, proxima_em);
CREATE INDEX IF NOT EXISTS idx_mkt_exec_tel ON marketing_execucoes(org_id, telefone);
CREATE INDEX IF NOT EXISTS idx_mkt_exec_camp ON marketing_execucoes(campanha_id);
CREATE TABLE IF NOT EXISTS marketing_envios (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  campanha_id TEXT NOT NULL,
  execucao_id TEXT,
  telefone TEXT NOT NULL,
  lead_id TEXT,
  no_id TEXT,
  texto TEXT,
  media_url TEXT,
  media_mime TEXT,
  media_nome TEXT,
  status TEXT NOT NULL,
  erro TEXT,
  wa_id TEXT,
  enviado_em INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_mkt_envios_org ON marketing_envios(org_id, enviado_em);
CREATE INDEX IF NOT EXISTS idx_mkt_envios_camp ON marketing_envios(campanha_id);
CREATE INDEX IF NOT EXISTS idx_mkt_envios_tel ON marketing_envios(org_id, telefone);
`);
/* HORÁRIO LIVRE POR PADRÃO (27/09/2026, pedido do Ali: "prefiro que o
   cliente dispare quando ele quiser"). `janela` = 1 limita o envio ao horário
   e aos dias do ritmo; nulo ou 0 envia a qualquer hora. Nulo em toda linha
   que já existe, de propósito: as janelas antigas eram o padrão da coluna,
   não escolha de ninguém. */
if (!db.prepare("PRAGMA table_info(marketing_ritmo)").all().some(c => c.name === "janela"))
  db.exec("ALTER TABLE marketing_ritmo ADD COLUMN janela INTEGER");
/* Disparo AGENDADO: as execuções nascem com a primeira ação nesta data. */
if (!db.prepare("PRAGMA table_info(marketing_campanhas)").all().some(c => c.name === "agendada_para"))
  db.exec("ALTER TABLE marketing_campanhas ADD COLUMN agendada_para INTEGER");
// A linha por onde cada envio saiu (nulo = a da casa). Guardada no envio
// porque o número de disparo é opcional e pode mudar depois: ao ligar o
// histórico a um lead novo, a conversa precisa dizer por onde ele saiu DE FATO.
if (!db.prepare("PRAGMA table_info(marketing_envios)").all().some(c => c.name === "canal_id"))
  db.exec("ALTER TABLE marketing_envios ADD COLUMN canal_id TEXT");

/* Os leads que o disparo tocou antes do gatilho novo ficaram com a "última
   interação" na data da campanha. Refaz a conta só deles (a tabela de envios
   é pequena), a partir do que é interação de verdade: mensagem que não é de
   disparo e ligação. Idempotente. */
db.exec(`UPDATE leads SET last_interaction_at = (
    SELECT MAX(t) FROM (
      SELECT MAX(m.created_at) t FROM messages m WHERE m.lead_id = leads.id
        AND NOT (m.direction = 'out' AND m.from_user_id IS NULL AND COALESCE(m.from_name, '') LIKE 'Disparo%')
      UNION ALL SELECT MAX(g.created_at) FROM ligacoes g WHERE g.lead_id = leads.id))
  WHERE id IN (SELECT DISTINCT lead_id FROM marketing_envios WHERE lead_id IS NOT NULL AND status = 'ok')`);

/* A LISTA DE LEADS MANDA SÓ O QUE MUDOU (28/09/2026, teste de carga).

   Todo aparelho aberto recarregava a lista INTEIRA de leads a cada 10
   segundos: na Conecta, ~2,6 MB por vez; numa imobiliária grande (30 mil
   leads), 39 MB e 5 segundos com o servidor parado — e o servidor parado não
   recebe webhook, que é quando para de entrar lead. Agora cada lead tem uma
   VERSÃO, tirada de um contador único que sobe a cada mudança, e o aparelho
   pede `GET /leads?desde=N`: vem só o que mudou depois da versão N.

   Quem sobe a versão é o BANCO, por gatilho, e não as rotas: são dezenas de
   lugares que mexem num lead (mensagem, etapa, dono, tarefa, tag, venda,
   robô…), e o esquecido não daria erro — só deixaria a tela do corretor
   desatualizada até alguém recarregar. É a mesma razão do gatilho do
   `last_interaction_at`.

   A tabela de apagados existe porque lead apagado não tem mais linha para
   dizer "mudei": sem ela, o aparelho mostraria para sempre um lead que não
   existe. Fica só uma semana (quem ficou mais que isso sem abrir o CRM
   recebe a lista inteira de qualquer jeito). */
const leadColsV = db.prepare("PRAGMA table_info(leads)").all().map(c => c.name);
if (!leadColsV.includes("versao")) db.exec("ALTER TABLE leads ADD COLUMN versao INTEGER");
db.exec(`
CREATE TABLE IF NOT EXISTS leads_seq (id INTEGER PRIMARY KEY CHECK (id = 1), n INTEGER NOT NULL);
INSERT OR IGNORE INTO leads_seq (id, n) VALUES (1, 0);
CREATE TABLE IF NOT EXISTS leads_apagados (lead_id TEXT NOT NULL, org_id TEXT, versao INTEGER NOT NULL, em INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS idx_leads_apagados ON leads_apagados(org_id, versao);
CREATE INDEX IF NOT EXISTS idx_leads_versao ON leads(org_id, versao);
-- O aviso de "cliente sem resposta" olha só quem conversou nos últimos dias.
CREATE INDEX IF NOT EXISTS idx_leads_interacao ON leads(org_id, last_interaction_at);
-- O Painel conta avanços por etapa no período (visitas, propostas, vendas).
CREATE INDEX IF NOT EXISTS idx_etapas_org_para ON lead_etapas(org_id, para, created_at);
DROP TRIGGER IF EXISTS trg_leads_versao_ins;
CREATE TRIGGER trg_leads_versao_ins AFTER INSERT ON leads BEGIN
  UPDATE leads_seq SET n = n + 1 WHERE id = 1;
  UPDATE leads SET versao = (SELECT n FROM leads_seq WHERE id = 1) WHERE id = NEW.id;
END;
DROP TRIGGER IF EXISTS trg_leads_versao_upd;
CREATE TRIGGER trg_leads_versao_upd AFTER UPDATE ON leads WHEN NEW.versao IS OLD.versao BEGIN
  UPDATE leads_seq SET n = n + 1 WHERE id = 1;
  UPDATE leads SET versao = (SELECT n FROM leads_seq WHERE id = 1) WHERE id = NEW.id;
END;
DROP TRIGGER IF EXISTS trg_leads_versao_del;
CREATE TRIGGER trg_leads_versao_del AFTER DELETE ON leads BEGIN
  UPDATE leads_seq SET n = n + 1 WHERE id = 1;
  INSERT INTO leads_apagados (lead_id, org_id, versao, em)
    VALUES (OLD.id, OLD.org_id, (SELECT n FROM leads_seq WHERE id = 1), CAST(strftime('%s','now') AS INTEGER) * 1000);
END;
-- "Tocar" o lead (SET versao = versao) faz o gatilho acima subir a versão.
DROP TRIGGER IF EXISTS trg_msg_versao_ins;
CREATE TRIGGER trg_msg_versao_ins AFTER INSERT ON messages BEGIN
  UPDATE leads SET versao = versao WHERE id = NEW.lead_id;
END;
DROP TRIGGER IF EXISTS trg_msg_versao_upd;
CREATE TRIGGER trg_msg_versao_upd AFTER UPDATE ON messages BEGIN
  UPDATE leads SET versao = versao WHERE id = NEW.lead_id;
END;
DROP TRIGGER IF EXISTS trg_msg_versao_del;
CREATE TRIGGER trg_msg_versao_del AFTER DELETE ON messages BEGIN
  UPDATE leads SET versao = versao WHERE id = OLD.lead_id;
END;
DROP TRIGGER IF EXISTS trg_tag_versao_ins;
CREATE TRIGGER trg_tag_versao_ins AFTER INSERT ON lead_tags BEGIN
  UPDATE leads SET versao = versao WHERE id = NEW.lead_id;
END;
DROP TRIGGER IF EXISTS trg_tag_versao_del;
CREATE TRIGGER trg_tag_versao_del AFTER DELETE ON lead_tags BEGIN
  UPDATE leads SET versao = versao WHERE id = OLD.lead_id;
END;
DROP TRIGGER IF EXISTS trg_tarefa_versao_ins;
CREATE TRIGGER trg_tarefa_versao_ins AFTER INSERT ON tarefas BEGIN
  UPDATE leads SET versao = versao WHERE id = NEW.lead_id;
END;
DROP TRIGGER IF EXISTS trg_tarefa_versao_upd;
CREATE TRIGGER trg_tarefa_versao_upd AFTER UPDATE ON tarefas BEGIN
  UPDATE leads SET versao = versao WHERE id = NEW.lead_id;
END;
DROP TRIGGER IF EXISTS trg_tarefa_versao_del;
CREATE TRIGGER trg_tarefa_versao_del AFTER DELETE ON tarefas BEGIN
  UPDATE leads SET versao = versao WHERE id = OLD.lead_id;
END;
`);
db.prepare("DELETE FROM leads_apagados WHERE em < ?").run(Date.now() - 7 * 86400000);
export const versaoDosLeads = () => db.prepare("SELECT n FROM leads_seq WHERE id = 1").get().n;

/* CONSULTAS COM LISTA DE IDs, EM LOTES (28/09/2026, teste de carga para uma
   imobiliária maior que a Conecta). `WHERE id IN (?,?,…)` com um marcador por
   lead quebra acima de ~32 mil itens — o SQLite recusa ("too many SQL
   variables") e a tela inteira que dependia da consulta deixa de abrir, só na
   imobiliária grande e sem aviso nenhum antes. Toda consulta assim passa por
   aqui: `consulta(marcadores, lote)` roda uma vez por lote e os resultados
   vêm juntos. Cada id cai em um lote só, então o que era agrupado por lead
   continua agrupado. */
export function emLotes(ids, consulta, tamanho = 900) {
  const saida = [];
  for (let i = 0; i < ids.length; i += tamanho) {
    const lote = ids.slice(i, i + tamanho);
    for (const linha of consulta("?,".repeat(lote.length).slice(0, -1), lote)) saida.push(linha);
  }
  return saida;
}

/* O ECO QUE VIROU CÓPIA (29/09/2026). A mensagem que o CRM enviou voltava pelo
   webhook e entrava uma segunda vez, sem autor ("Enviada pelo WhatsApp") — o
   conserto está em services/marca-disparo.js → ecoDoCrm. Aqui saem, uma vez
   só, as cópias que já estavam na conversa.

   É cópia a linha sem autor que tem, na mesma conversa, uma mensagem ENVIADA
   PELO CRM (com autor, ou do robô/disparo) de 30 segundos antes a 2 minutos
   depois dela, e que é a mesma coisa: o mesmo id do WhatsApp (nos dois
   formatos), o mesmo texto (com ou sem a assinatura "*Nome:*" na frente), a
   mesma espécie de arquivo, ou o eco das fotos/localização de um imóvel
   enviado (o registro do imóvel é gravado depois de todos os envios). Só a partir de 28/09/2026, quando o problema começou —
   o que o corretor digitou no celular antes disso não é tocado. */
if (!db.prepare("SELECT 1 FROM config_plataforma WHERE chave = 'limpeza_ecos_do_crm'").get()) {
  const desde = Date.parse("2026-09-28T00:00:00-03:00");
  const suf = (c) => `substr(${c}.wa_id, instr(${c}.wa_id, ':') + 1)`;
  const copias = db.prepare(`SELECT e.id, (
      SELECT c.id FROM messages c
      WHERE c.lead_id = e.lead_id AND c.id != e.id AND c.direction = 'out'
        AND (c.from_user_id IS NOT NULL OR COALESCE(c.from_name, '') != '')
        AND c.created_at BETWEEN e.created_at - 30000 AND e.created_at + 120000
        AND (
          (e.wa_id IS NOT NULL AND c.wa_id IS NOT NULL AND ${suf("e")} = ${suf("c")})
          OR e.body = c.body
          OR e.body = '*' || c.from_name || ':*' || char(10) || c.body
          OR (e.media_mime IS NOT NULL AND c.media_mime IS NOT NULL AND substr(e.media_mime, 1, 5) = substr(c.media_mime, 1, 5))
          OR c.body LIKE '[Imóvel enviado]%'
          OR c.body LIKE '📍 Localização enviada%'
        )
      ORDER BY abs(c.created_at - e.created_at) LIMIT 1) AS original
    FROM messages e
    WHERE e.direction = 'out' AND e.from_user_id IS NULL AND COALESCE(e.from_name, '') = ''
      AND e.created_at >= ?`).all(desde).filter(x => x.original);
  /* E a mesma mensagem enviada gravada duas vezes com o id em formatos
     diferentes ("3EB0…" e "5587…:3EB0…") — o índice único de `wa_id` só
     pega o id escrito igual. Fica a com autor; sem autor em nenhuma, a mais
     antiga. */
  const chaveOut = "substr(wa_id, instr(wa_id, ':') + 1)";
  for (const g of db.prepare(`SELECT lead_id, ${chaveOut} AS k FROM messages
      WHERE wa_id IS NOT NULL AND direction = 'out' AND created_at >= ? GROUP BY lead_id, k HAVING COUNT(*) > 1`).all(desde)) {
    const [fica, ...sai] = db.prepare(`SELECT id FROM messages WHERE lead_id = ? AND direction = 'out' AND wa_id IS NOT NULL
      AND ${chaveOut} = ? ORDER BY (from_user_id IS NULL AND COALESCE(from_name, '') = '') ASC, created_at ASC, rowid ASC`)
      .all(g.lead_id, g.k).map(l => l.id);
    for (const id of sai) if (!copias.some(x => x.id === id)) copias.push({ id, original: fica });
  }
  let apagadas = 0;
  db.transaction(() => {
    for (const x of copias) {
      db.prepare("UPDATE messages SET reply_to = ? WHERE reply_to = ?").run(x.original, x.id);
      apagadas += db.prepare("DELETE FROM messages WHERE id = ?").run(x.id).changes;
    }
    db.prepare("INSERT OR REPLACE INTO config_plataforma (chave, valor, atualizado_em) VALUES ('limpeza_ecos_do_crm', ?, ?)")
      .run(String(apagadas), Date.now());
  })();
  if (apagadas) console.log(`[messages] ${apagadas} cópia(s) de mensagem enviada pelo CRM apagada(s) (o eco do WhatsApp que tinha entrado de novo).`);
}

/* AS FERRAMENTAS DE CADA CONTA (29/09/2026) — ver services/recursos.js.
   Uma linha por conta e ferramenta, só quando existe algo a dizer: o master
   decidiu, ou o cliente contratou avulso. Sem linha, vale o plano. */
db.exec(`CREATE TABLE IF NOT EXISTS org_recursos (
  org_id TEXT NOT NULL,
  recurso TEXT NOT NULL,
  master TEXT,                    -- 'liberado' | 'retirado' | NULL = segue o plano
  master_em INTEGER,
  master_por TEXT,
  avulso_status TEXT,             -- 'aguardando' | 'ativo' | 'cancelado' | 'estornado' | NULL
  avulso_sub_id TEXT,             -- a assinatura PRÓPRIA da ferramenta no Asaas
  avulso_link TEXT,
  avulso_desde INTEGER,
  avulso_pago_ate INTEGER,
  avulso_ultimo_pagamento TEXT,
  avulso_cancelado_em INTEGER,
  PRIMARY KEY (org_id, recurso)
)`);
db.exec("CREATE INDEX IF NOT EXISTS idx_org_recursos_sub ON org_recursos(avulso_sub_id)");
/* O Marketing liberado pelo master em `orgs.marketing_liberado` passa a ser
   uma liberação do master aqui, uma vez só. A coluna antiga fica, sem uso. */
if (!db.prepare("SELECT 1 FROM config_plataforma WHERE chave = 'recursos_marketing_migrado'").get()) {
  db.transaction(() => {
    for (const o of db.prepare("SELECT id, marketing_liberado_em, marketing_liberado_por FROM orgs WHERE marketing_liberado = 1").all())
      db.prepare(`INSERT OR IGNORE INTO org_recursos (org_id, recurso, master, master_em, master_por)
        VALUES (?, 'marketing', 'liberado', ?, ?)`).run(o.id, o.marketing_liberado_em || Date.now(), o.marketing_liberado_por || null);
    db.prepare("INSERT OR REPLACE INTO config_plataforma (chave, valor, atualizado_em) VALUES ('recursos_marketing_migrado', '1', ?)").run(Date.now());
  })();
}

/* ===== FUNIL DE CONVERSÃO POR ID (01/10/2026) =====

   O histórico de etapas guardava só o NOME (`de`/`para`). Renomear uma etapa
   apagava a passagem dos leads por ela, e duas etapas de mesmo nome em funis
   diferentes ("Visita" no Comercial e na Locação) eram a mesma coisa para o
   relatório. Agora cada mudança grava também o ID das duas etapas.

   `etapa_fonte` diz de onde veio o id: 'gravado' (a mudança já gravou) ou
   'nome' (recuperado do nome de uma linha antiga, só quando a evidência é
   segura — ver `services/conversao.js`) ou 'desconhecida' (não deu para
   saber, e a linha fica fora da conta em vez de virar palpite). Nulo = ainda
   não conferida. Só acrescenta coluna: nada é apagado nem reescrito.

   `entrada_comercial` marca a etapa em que o processo comercial começa — o
   que fica antes dela (Inbox, triagem) não entra na base da conversão. */
const etapaHistCols = db.prepare("PRAGMA table_info(lead_etapas)").all().map(c => c.name);
for (const [col, ddl] of [["de_stage_id", "TEXT"], ["para_stage_id", "TEXT"], ["etapa_fonte", "TEXT"]])
  if (!etapaHistCols.includes(col)) db.exec(`ALTER TABLE lead_etapas ADD COLUMN ${col} ${ddl}`);
if (!db.prepare("PRAGMA table_info(pipeline_stages)").all().some(c => c.name === "entrada_comercial"))
  db.exec("ALTER TABLE pipeline_stages ADD COLUMN entrada_comercial INTEGER DEFAULT 0");
db.exec(`
-- A coorte procura quem chegou às etapas do funil analisado DENTRO do período.
CREATE INDEX IF NOT EXISTS idx_etapas_org_para_id ON lead_etapas(org_id, para_stage_id, created_at);
-- As linhas antigas ainda não conferidas: some depois da primeira leitura.
CREATE INDEX IF NOT EXISTS idx_etapas_pendentes ON lead_etapas(org_id) WHERE etapa_fonte IS NULL;
`);

export default db;
