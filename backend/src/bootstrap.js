import bcrypt from "bcryptjs";
import { randomUUID } from "crypto";
import db from "./db.js";

// Roda a cada start do servidor. Garante que a organização existe e que o código
// da imobiliária é o do .env — assim, ao hospedar, o link de cadastro já funciona
// sem ninguém precisar rodar comando nenhum no servidor.
export function bootstrap() {
  const code = String(process.env.ADM_CODE || "CONECTA-JAZ-2026").trim().toUpperCase();
  const name = process.env.ORG_NAME || "Conecta Imóveis";

  let org = db.prepare("SELECT * FROM orgs LIMIT 1").get();
  if (!org) {
    org = { id: "org_conecta", name, adm_code: code, wa_number: "", wa_connected: 0, distribution_ptr: 0 };
    db.prepare(`INSERT INTO orgs (id,name,adm_code,wa_number,wa_connected,distribution_ptr)
      VALUES (@id,@name,@adm_code,@wa_number,@wa_connected,@distribution_ptr)`).run(org);
    console.log(`Organização criada: ${org.name}`);
  } else if (org.adm_code !== code) {
    // Trocar ADM_CODE no painel da hospedagem passa a valer no próximo start.
    db.prepare("UPDATE orgs SET adm_code = ? WHERE id = ?").run(code, org.id);
    console.log(`Código da imobiliária atualizado para ${code} (links antigos param de valer).`);
    org.adm_code = code;
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
  return org;
}
