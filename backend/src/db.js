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
addUserCol("avatar_url", "TEXT");                       // foto de perfil
addUserCol("avatar_key", "TEXT");                       // caminho no armazenamento
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
/* Data do vencimento ANTES de qualquer pagamento. O vencimento em vigor é
   vence_base + (um mês por pagamento registrado), o que faz apagar pagamento
   voltar a data sozinho. Ver services/assinatura.js. */
addOrgCol("vence_base", "INTEGER");

const leadCols = db.prepare("PRAGMA table_info(leads)").all().map(c => c.name);
const addLeadCol = (name, ddl) => { if (!leadCols.includes(name)) db.exec(`ALTER TABLE leads ADD COLUMN ${name} ${ddl}`); };
addLeadCol("last_read_at", "INTEGER");   // até quando o atendente já leu a conversa
addLeadCol("sale_value", "REAL");        // registro da venda: valor do imóvel
addLeadCol("sale_date", "INTEGER");      // data da venda
addLeadCol("sale_property", "TEXT");     // qual imóvel/unidade foi vendido
addLeadCol("produto_id", "TEXT");        // imóvel de interesse do lead (opcional)
addLeadCol("closed_at", "INTEGER");      // atendimento finalizado: sai da caixa de entrada, fica no funil
addLeadCol("import_id", "TEXT");         // de qual planilha veio, para dar para desfazer a importação
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
const msgCols = db.prepare("PRAGMA table_info(messages)").all().map(c => c.name);
const addMsgCol = (name, ddl) => { if (!msgCols.includes(name)) db.exec(`ALTER TABLE messages ADD COLUMN ${name} ${ddl}`); };
addMsgCol("media_url", "TEXT");   // endereço público do arquivo guardado
addMsgCol("media_mime", "TEXT");  // image/jpeg, audio/ogg, application/pdf...
addMsgCol("media_name", "TEXT");  // nome original, quando é documento

export default db;
