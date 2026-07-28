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
  return org;
}
