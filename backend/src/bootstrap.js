import bcrypt from "bcryptjs";
import { randomUUID } from "crypto";
import db from "./db.js";
import { garantirPipelinePadrao } from "./services/pipelines.js";
import { migrarCanais } from "./services/canais.js";

// Roda a cada start do servidor. Garante que a organização existe e que o código
// da imobiliária é o do .env — assim, ao hospedar, o link de cadastro já funciona
// sem ninguém precisar rodar comando nenhum no servidor.
export function bootstrap() {
  const code = String(process.env.ADM_CODE || "CONECTA-JAZ-2026").trim().toUpperCase();
  const name = process.env.ORG_NAME || "Conecta Imóveis";

  /* Com o hub de contas, o servidor deixou de ter "a" imobiliária. O ADM_CODE
     continua valendo, mas agora ele APONTA para uma: procura pelo código antes
     de mexer em qualquer coisa.

     A regra de renomear o código só vale enquanto existe uma imobiliária só —
     era o comportamento de sempre e ele continua. Com várias, o servidor não
     adivinha qual delas o ADM_CODE queria renomear: ele avisa e não toca em
     nada, porque trocar o código da imobiliária errada derruba os links de
     cadastro que já foram enviados para a equipe dela. */
  let org = db.prepare("SELECT * FROM orgs WHERE adm_code = ?").get(code);
  if (!org) {
    const total = db.prepare("SELECT COUNT(*) n FROM orgs").get().n;
    if (total === 0) {
      org = { id: "org_conecta", name, adm_code: code, wa_number: "", wa_connected: 0, distribution_ptr: 0, created_at: Date.now() };
      db.prepare(`INSERT INTO orgs (id,name,adm_code,wa_number,wa_connected,distribution_ptr,created_at)
        VALUES (@id,@name,@adm_code,@wa_number,@wa_connected,@distribution_ptr,@created_at)`).run(org);
      console.log(`Organização criada: ${org.name}`);
    } else if (total === 1) {
      org = db.prepare("SELECT * FROM orgs LIMIT 1").get();
      db.prepare("UPDATE orgs SET adm_code = ? WHERE id = ?").run(code, org.id);
      console.log(`Código da imobiliária atualizado para ${code} (links antigos param de valer).`);
      org.adm_code = code;
    } else {
      org = db.prepare("SELECT * FROM orgs ORDER BY created_at, name LIMIT 1").get();
      console.log(`Atenção: ADM_CODE=${code} não corresponde a nenhuma imobiliária. Nenhum código foi alterado.`);
    }
  }

  /* WhatsApp da imobiliária apontada pelo ADM_CODE.

     A conexão saiu das variáveis de ambiente e passou a ser de cada
     imobiliária (ver services/uazapi.js). Esta cópia existe para que a
     instalação que já rodava não perca o WhatsApp na atualização: as
     variáveis antigas viram a conexão DESTA imobiliária, uma vez só.

     Depois disso as variáveis viram só herança — quem conecta é a tela. */
  const uHost = String(process.env.UAZAPI_HOST || "").trim();
  const uToken = String(process.env.UAZAPI_TOKEN || "").trim();
  if (uHost && uToken) {
    const atual = db.prepare("SELECT uazapi_token FROM orgs WHERE id = ?").get(org.id);
    const jaUsado = db.prepare("SELECT id FROM orgs WHERE uazapi_token = ?").get(uToken);
    if (!atual?.uazapi_token && !jaUsado) {
      db.prepare("UPDATE orgs SET uazapi_host = ?, uazapi_token = ? WHERE id = ?")
        .run(uHost.replace(/\/$/, ""), uToken, org.id);
      console.log(`WhatsApp de ${org.name} migrado das variáveis do servidor para a conta da imobiliária.`);
    }
  }

  // Conta da ADM, se informada no .env e ainda não existir. Sem isso, ninguém
  // consegue entrar como administração num banco novo.
  const admEmail = String(process.env.ADM_EMAIL || "").trim().toLowerCase();
  const admPass = process.env.ADM_PASSWORD;
  if (admEmail && admPass) {
    const exists = db.prepare("SELECT 1 FROM users WHERE email = ?").get(admEmail);
    if (!exists) {
      db.prepare(`INSERT INTO users (id,org_id,name,email,pass_hash,role,available,created_at,status)
        VALUES (?,?,?,?,?,'adm',0,?,'ativo')`)
        .run("u_" + randomUUID(), org.id, process.env.ADM_NAME || "Administração", admEmail,
             bcrypt.hashSync(String(admPass), 10), Date.now());
      console.log(`Conta ADM criada: ${admEmail}`);
    }
  }

  /* Titular da conta — quem enxerga a mensalidade. Como o CRM pode ter mais de
     um gestor, isso precisa ser uma pessoa, não o papel. Na falta de escolha,
     o gestor mais antigo: é quem montou a operação. A troca é feita na tela,
     por ele mesmo (POST /assinatura/dono). */
  const semDono = db.prepare("SELECT dono_user_id FROM orgs WHERE id = ?").get(org.id);
  if (!semDono || !semDono.dono_user_id) {
    const primeiro = db.prepare(
      "SELECT id,name FROM users WHERE org_id = ? AND role = 'adm' ORDER BY created_at LIMIT 1").get(org.id);
    if (primeiro) {
      db.prepare("UPDATE orgs SET dono_user_id = ? WHERE id = ?").run(primeiro.id, org.id);
      console.log(`Titular da mensalidade: ${primeiro.name}`);
    }
  }

  /* Gestor MASTER — quem mantém o ConHub, não quem trabalha na imobiliária.

     Definido por MASTER_EMAIL. Sem essa variável, promove o gestor mais antigo
     (que é quem montou o sistema) na primeira vez, e nunca mais mexe: assim a
     conta que já existe vira master sozinha, sem ninguém precisar configurar
     nada no painel da hospedagem.

     ATENÇÃO ao abrir para várias imobiliárias: este "gestor mais antigo" só
     faz sentido enquanto existe uma org. Quando a segunda entrar, o master tem
     que vir de MASTER_EMAIL — senão o gestor da imobiliária nova viraria
     master dela. */
  const masterEmail = String(process.env.MASTER_EMAIL || "").trim().toLowerCase();
  if (masterEmail) {
    const alvo = db.prepare("SELECT id,name,master FROM users WHERE email = ?").get(masterEmail);
    if (alvo && !alvo.master) {
      db.prepare("UPDATE users SET master = 1 WHERE id = ?").run(alvo.id);
      console.log(`Gestor master: ${alvo.name} (${masterEmail})`);
    } else if (!alvo) {
      console.log(`Atenção: MASTER_EMAIL=${masterEmail} não corresponde a nenhuma conta.`);
    }
  } else {
    const jaTem = db.prepare("SELECT COUNT(*) n FROM users WHERE org_id = ? AND master = 1").get(org.id).n;
    if (!jaTem) {
      const primeiro = db.prepare(
        "SELECT id,name FROM users WHERE org_id = ? AND role = 'adm' ORDER BY created_at LIMIT 1").get(org.id);
      if (primeiro) {
        db.prepare("UPDATE users SET master = 1 WHERE id = ?").run(primeiro.id);
        console.log(`Gestor master: ${primeiro.name} (defina MASTER_EMAIL para fixar).`);
      }
    }
  }
  /* ===== O FUNIL DE CADA IMOBILIARIA VIRA DADO =====

     Roda para TODAS as contas, e nao so para a que o bootstrap acabou de
     criar: quando esta versao sobe, cada imobiliaria que ja existe precisa
     ganhar o pipeline padrao com as etapas que ela ja usava, e cada lead
     precisa ser ligado a etapa dele pelo nome.

     Idempotente nos dois sentidos — conta que ja tem pipeline nao ganha outro,
     lead que ja esta ligado nao e mexido —, entao reiniciar o servidor dez
     vezes faz o trabalho uma. Mesma regra do corte de expediente e do backup:
     quem manda e o estado, nao o evento.

     Falha de UMA imobiliaria nao pode parar as outras nem derrubar o start: um
     funil que nao converteu e um problema daquela conta, e o CRM parado e um
     problema de todas. */
  let convertidas = 0, ligados = 0;
  for (const { id } of db.prepare("SELECT id FROM orgs").all()) {
    try {
      const r = garantirPipelinePadrao(id);
      if (r.criado) convertidas++;
      ligados += r.ligados || 0;
    } catch (e) {
      console.error(`[pipelines] não consegui preparar o funil da imobiliária ${id}:`, e.message);
    }
  }
  if (convertidas || ligados)
    console.log(`Funil configurável: ${convertidas} imobiliária(s) convertida(s), ${ligados} lead(s) ligado(s) às etapas.`);

  /* As LINHAS de WhatsApp. Cada imobiliária ganha a linha da casa com a mesma
     conexão que ela já usava — ninguém reconecta nada, e quem nunca ligou o
     WhatsApp ganha a linha vazia, pronta para quando ligar. Idempotente. */
  try { migrarCanais(); }
  catch (e) { console.error("[canais] não consegui preparar as linhas de WhatsApp:", e.message); }

  return org;
}
