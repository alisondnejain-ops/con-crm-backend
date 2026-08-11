/* Apagar uma imobiliária tem que levar tudo dela — e nada dos outros.

   Rodar:  npm run teste:apagar
*/
import assert from "node:assert";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
process.env.DB_PATH=path.join(os.tmpdir(),"concrm-teste-apagar.db");
process.env.JWT_SECRET="teste";
try{fs.unlinkSync(process.env.DB_PATH);}catch(e){}

const {default:db}=await import("../src/db.js");
const {randomUUID}=await import("crypto");
const {sign}=await import("../src/auth.js");
const express=(await import("express")).default;
const orgsRoutes=(await import("../src/routes/orgs.routes.js")).default;
const app=express(); app.use(express.json()); app.use("/orgs",orgsRoutes);
const srv=app.listen(0); const base=`http://localhost:${srv.address().port}`;

const criarOrg=(nome,code)=>{const id="org_"+randomUUID().slice(0,8);
  db.prepare("INSERT INTO orgs (id,name,adm_code,created_at) VALUES (?,?,?,?)").run(id,nome,code,Date.now());return id;};
const criarUser=(org,nome,role,master=0)=>{const id="u_"+randomUUID();
  db.prepare(`INSERT INTO users (id,org_id,name,email,pass_hash,role,available,created_at,status,master)
    VALUES (?,?,?,?,'x',?,0,?,'ativo',?)`).run(id,org,nome,nome.toLowerCase()+"@x.com",role,Date.now(),master);return id;};
const conecta=criarOrg("Conecta Imóveis","CONECTA-JAZ-2026");
const place=criarOrg("Place Imóveis","PLACE-2026");
const ali=criarUser(conecta,"Ali","adm",1);         // master
criarUser(conecta,"Marina","corretor");
const donoPlace=criarUser(place,"Bruno","adm");

// Dados dos dois lados, para provar que só um some.
const semear=(org,dono,quantos)=>{ for(let i=0;i<quantos;i++){
  const l="l_"+randomUUID();
  db.prepare(`INSERT INTO leads (id,org_id,name,phone,origem,priority,stage,assigned_to,created_at)
    VALUES (?,?,?,?,'manual','QUENTE','Lead',?,?)`).run(l,org,"Lead "+i,"55879"+i,dono,Date.now());
  db.prepare("INSERT INTO messages (id,lead_id,direction,body,created_at) VALUES (?,?,?,?,?)")
    .run("m_"+randomUUID(),l,"in","oi",Date.now());
}};
semear(conecta,null,3); semear(place,donoPlace,2);
db.prepare("INSERT INTO mensagens_rapidas (id,org_id,titulo,corpo,ordem,ativo,created_at) VALUES (?,?,?,?,0,1,?)")
  .run("mr_"+randomUUID(),place,"Oi","Oi {nome}",Date.now());
db.prepare("INSERT INTO plantoes (id,org_id,user_id,dia,turno,created_at) VALUES (?,?,?,?,?,?)")
  .run("p_"+randomUUID(),place,donoPlace,"2026-08-12","manha",Date.now());

const h={authorization:"Bearer "+sign(db.prepare("SELECT * FROM users WHERE id=?").get(ali)),"content-type":"application/json"};
const pedir=async(m,u,b)=>{const r=await fetch(base+u,{method:m,headers:h,body:b&&JSON.stringify(b)});
  return {s:r.status,b:await r.json()};};

console.log("1. O resumo diz o que vai sumir");
const resumo=await pedir("GET",`/orgs/${place}/apagar`);
console.log("  ",JSON.stringify(resumo.b));
assert.equal(resumo.b.leads,2); assert.equal(resumo.b.mensagens,2); assert.equal(resumo.b.equipe,1);

console.log("2. Nome errado não apaga");
const errado=await pedir("DELETE",`/orgs/${place}`,{confirmar:"place imoveis"});
assert.equal(errado.s,400);
assert.ok(db.prepare("SELECT 1 FROM orgs WHERE id=?").get(place));

console.log("3. Nome exato apaga");
const ok=await pedir("DELETE",`/orgs/${place}`,{confirmar:"Place Imóveis"});
assert.equal(ok.s,200,JSON.stringify(ok.b));
console.log("  ",JSON.stringify(ok.b));

console.log("4. Não sobrou nada da Place");
const conta=(sql,...a)=>db.prepare(sql).get(...a).n;
assert.equal(conta("SELECT COUNT(*) n FROM orgs WHERE id=?",place),0);
assert.equal(conta("SELECT COUNT(*) n FROM users WHERE org_id=?",place),0);
assert.equal(conta("SELECT COUNT(*) n FROM leads WHERE org_id=?",place),0);
assert.equal(conta("SELECT COUNT(*) n FROM mensagens_rapidas WHERE org_id=?",place),0);
assert.equal(conta("SELECT COUNT(*) n FROM plantoes WHERE org_id=?",place),0);
assert.equal(conta(`SELECT COUNT(*) n FROM messages m LEFT JOIN leads l ON l.id=m.lead_id WHERE l.id IS NULL`),0,
  "não pode sobrar mensagem órfã");

console.log("5. A Conecta ficou intacta");
assert.equal(conta("SELECT COUNT(*) n FROM leads WHERE org_id=?",conecta),3);
assert.equal(conta("SELECT COUNT(*) n FROM users WHERE org_id=?",conecta),2);
assert.ok(db.prepare("SELECT master FROM users WHERE id=?").get(ali).master,"o master não pode sumir");

console.log("6. A última imobiliária não pode ser apagada");
const ultima=await pedir("DELETE",`/orgs/${conecta}`,{confirmar:"Conecta Imóveis"});
assert.equal(ultima.s,409);
console.log("  ",ultima.b.error);

console.log("\nTudo certo ✅");
srv.close();
