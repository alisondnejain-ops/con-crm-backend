/* O dono cria a própria imobiliária e sai daqui com o código dela.

   Este teste guarda três coisas que já deram errado ou dariam:
   - o código nasce da imobiliária de quem cadastrou, e nunca é o de outra;
   - o fundador entra DIRETO, sem fila de aprovação (não há quem aprove);
   - o corretor que usa o link do fundador cai na casa dele, não na Conecta.

   Rodar:  npm run teste:dono
*/
import assert from "node:assert";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
process.env.DB_PATH=path.join(os.tmpdir(),"concrm-teste-dono.db");
process.env.JWT_SECRET="teste";
process.env.SITE_URL="https://www.exemplo.com.br";
try{fs.unlinkSync(process.env.DB_PATH);}catch(e){}

const {default:db}=await import("../src/db.js");
const {randomUUID}=await import("crypto");
const express=(await import("express")).default;
const authRoutes=(await import("../src/routes/auth.routes.js")).default;
const app=express(); app.use(express.json()); app.use("/auth",authRoutes);
const srv=app.listen(0); const base=`http://localhost:${srv.address().port}`;
const post=async(u,b)=>{const r=await fetch(base+u,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(b)});
  return {status:r.status, body:await r.json()};};

// A Conecta já existe na plataforma — é a vizinha que não pode ser confundida.
const orgConecta="org_"+randomUUID().slice(0,8);
db.prepare("INSERT INTO orgs (id,name,adm_code,created_at) VALUES (?,?,?,?)")
  .run(orgConecta,"Conecta Imóveis","CONECTA-JAZ-2026",Date.now());

console.log("1. O dono cadastra a imobiliária dele");
const criou=await post("/auth/criar-imobiliaria",{imobiliaria:"Vale Verde Imóveis",
  name:"Joana Ribeiro",email:"joana@valeverde.com.br",phone:"(87) 9 8888-1122"});
assert.equal(criou.status,200,JSON.stringify(criou.body));
const {codigo,link_equipe,link}=criou.body;
console.log("   código gerado:",codigo);
console.log("   link da equipe:",link_equipe);
assert.equal(codigo,"VALE-VERDE-"+new Date().getFullYear());
assert.ok(!codigo.includes("CONECTA"),"o código não pode ser o da vizinha");
assert.equal(link_equipe,`https://www.exemplo.com.br/cadastro?c=${codigo}`);

console.log("2. Ela é dona da conta e ainda não entrou (sem senha)");
const orgNova=db.prepare("SELECT * FROM orgs WHERE adm_code=?").get(codigo);
const dona=db.prepare("SELECT * FROM users WHERE email=?").get("joana@valeverde.com.br");
assert.equal(orgNova.dono_user_id,dona.id);
assert.equal(dona.role,"adm");
assert.equal(dona.status,"pendente");
const semSenha=await post("/auth/login",{email:"joana@valeverde.com.br",password:"123456"});
assert.equal(semSenha.status,403);

console.log("3. Ela cria a senha e entra DIRETO — sem fila de aprovação");
const token=link.split("token=")[1];
const senha=await post("/auth/set-password",{token,password:"senha-forte"});
assert.equal(senha.status,200,JSON.stringify(senha.body));
assert.ok(!senha.body.aguandandoAprovacao&&!senha.body.aguardandoAprovacao,"o fundador não espera aprovação");
assert.ok(senha.body.token,"tem que sair logada");
assert.equal(senha.body.org.codigo,codigo);
assert.equal(senha.body.link_equipe,link_equipe);
console.log("   entrou como:",senha.body.user.role,"| status:",db.prepare("SELECT status FROM users WHERE id=?").get(dona.id).status);

console.log("4. O corretor usa o link dela e cai na casa DELA");
const corretor=await post("/auth/register",{name:"Pedro Lima",email:"pedro@valeverde.com.br",
  phone:"(87) 9 7777-3344",adm_code:codigo,funcao:"corretor"});
assert.equal(corretor.status,200,JSON.stringify(corretor.body));
const p=db.prepare("SELECT * FROM users WHERE email=?").get("pedro@valeverde.com.br");
assert.equal(p.org_id,orgNova.id);
assert.notEqual(p.org_id,orgConecta);
console.log("   Pedro entrou em:",db.prepare("SELECT name FROM orgs WHERE id=?").get(p.org_id).name);

console.log("5. Tentar de novo com o mesmo e-mail NÃO cria outra imobiliária");
const antes=db.prepare("SELECT COUNT(*) n FROM orgs").get().n;
const dedoDuplo=await post("/auth/criar-imobiliaria",{imobiliaria:"Vale Verde Imóveis",
  name:"Joana Ribeiro",email:"joana@valeverde.com.br",phone:"(87) 9 8888-1122"});
assert.equal(dedoDuplo.status,409,"conta já ativa tem que ser barrada");
assert.equal(db.prepare("SELECT COUNT(*) n FROM orgs").get().n,antes);
console.log("   barrado:",dedoDuplo.body.error);

console.log("6. Quem fechou a aba antes de criar a senha volta para a MESMA imobiliária");
await post("/auth/criar-imobiliaria",{imobiliaria:"Sol Nascente",name:"Caio",email:"caio@sol.com.br",phone:"(87) 9 1111-2222"});
const orgsAntes=db.prepare("SELECT COUNT(*) n FROM orgs").get().n;
const denovo=await post("/auth/criar-imobiliaria",{imobiliaria:"Sol Nascente Imóveis",name:"Caio",email:"caio@sol.com.br",phone:"(87) 9 1111-2222"});
assert.equal(denovo.status,200);
assert.equal(db.prepare("SELECT COUNT(*) n FROM orgs").get().n,orgsAntes,"não pode nascer imobiliária fantasma");
console.log("   segue com uma só:",denovo.body.imobiliaria,"·",denovo.body.codigo);

console.log("\nTudo certo ✅");
srv.close();
