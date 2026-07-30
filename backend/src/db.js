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
if (!orgCols.includes("atendente_ptr")) db.exec("ALTER TABLE orgs ADD COLUMN atendente_ptr INTEGER DEFAULT 0");

const leadCols = db.prepare("PRAGMA table_info(leads)").all().map(c => c.name);
const addLeadCol = (name, ddl) => { if (!leadCols.includes(name)) db.exec(`ALTER TABLE leads ADD COLUMN ${name} ${ddl}`); };
addLeadCol("last_read_at", "INTEGER");   // até quando o atendente já leu a conversa
addLeadCol("sale_value", "REAL");        // registro da venda: valor do imóvel
addLeadCol("sale_date", "INTEGER");      // data da venda
addLeadCol("sale_property", "TEXT");     // qual imóvel/unidade foi vendido
addLeadCol("produto_id", "TEXT");        // imóvel de interesse do lead (opcional)
addLeadCol("closed_at", "INTEGER");      // atendimento finalizado: sai da caixa de entrada, fica no funil

// Foto, áudio e documento que o cliente manda pelo WhatsApp. Antes o arquivo era
// descartado e a conversa guardava só um marcador de texto tipo "[ImageMessage]".
const msgCols = db.prepare("PRAGMA table_info(messages)").all().map(c => c.name);
const addMsgCol = (name, ddl) => { if (!msgCols.includes(name)) db.exec(`ALTER TABLE messages ADD COLUMN ${name} ${ddl}`); };
addMsgCol("media_url", "TEXT");   // endereço público do arquivo guardado
addMsgCol("media_mime", "TEXT");  // image/jpeg, audio/ogg, application/pdf...
addMsgCol("media_name", "TEXT");  // nome original, quando é documento

export default db;
