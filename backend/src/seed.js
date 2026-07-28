import "dotenv/config";
import bcrypt from "bcryptjs";
import { randomUUID } from "crypto";
import db from "./db.js";
import { bootstrap } from "./bootstrap.js";

// Usuários FICTÍCIOS para testar o CRM. Não rode isso em produção — lá a org é
// criada sozinha no start do servidor e os corretores entram pelo link de cadastro.
const org = bootstrap();

const people = [
  { name: "Ali", email: "ali@conecta.com", role: "adm", available: 0 },
  { name: "Camila Rocha", email: "camila@conecta.com", role: "sdr", available: 1 },
  { name: "Marina Alves", email: "marina@conecta.com", role: "corretor", available: 1 },
  { name: "Rafael Nunes", email: "rafael@conecta.com", role: "corretor", available: 1 },
  { name: "Juliana Prado", email: "juliana@conecta.com", role: "corretor", available: 0 },
  { name: "Diego Matos", email: "diego@conecta.com", role: "corretor", available: 1 },
];
const pass = bcrypt.hashSync("123456", 10); // senha padrão de teste — troque em produção

for (const p of people) {
  const exists = db.prepare("SELECT 1 FROM users WHERE email = ?").get(p.email);
  if (exists) continue;
  db.prepare(`INSERT INTO users (id,org_id,name,email,pass_hash,role,available,created_at,status)
    VALUES (?,?,?,?,?,?,?,?,'ativo')`).run("u_" + randomUUID(), org.id, p.name, p.email, pass, p.role, p.available, Date.now());
  console.log("Usuário criado:", p.email, `(${p.role})`);
}
console.log("Seed concluído. Senha padrão de todos: 123456");
