/* Uma imobiliária não enxerga a outra.

   Este teste existe porque a conta do ConHub é multi-imobiliária: o mesmo
   servidor atende a Conecta e quem vier depois. As rotas de mensagem já
   deixaram passar uma vez — conferiam se quem pedia era da supervisão, mas
   não DE QUAL imobiliária, então a gestão de uma escrevia na conversa da
   outra sabendo o id do lead. Rodar isto antes de subir evita o pior erro
   possível num CRM: cliente de um aparecer para o outro.

   Rodar:  npm run teste:imobiliarias
*/
/* Duas imobiliárias na mesma instalação: uma NÃO pode alcançar a outra. */
import assert from "node:assert";
import os from "node:os";
import path from "node:path";
process.env.DB_PATH=path.join(os.tmpdir(),"concrm-teste-imobiliarias.db");
process.env.JWT_SECRET="teste";
process.env.ADM_CODE="A-1";
import fs from "node:fs";
try{fs.unlinkSync(process.env.DB_PATH);}catch(e){}
const {default:db}=await import("../src/db.js");
const {randomUUID}=await import("crypto");
const bcrypt=(await import("bcryptjs")).default;
const express=(await import("express")).default;
const authRoutes=(await import("../src/routes/auth.routes.js")).default;
const leadsRoutes=(await import("../src/routes/leads.routes.js")).default;
const msgRoutes=(await import("../src/routes/messages.routes.js")).default;
const app=express();
app.use(express.json());
app.use("/auth",authRoutes);
app.use("/leads",leadsRoutes);
app.use("/leads",msgRoutes);

const criarOrg=(nome,code)=>{const id="o_"+randomUUID();
  db.prepare("INSERT INTO orgs (id,name,adm_code,created_at) VALUES (?,?,?,?)").run(id,nome,code,Date.now());return id;};
const criarUser=(org,nome,email,role)=>{const id="u_"+randomUUID();
  db.prepare(`INSERT INTO users (id,org_id,name,email,pass_hash,role,available,created_at,status)
    VALUES (?,?,?,?,?,?,1,?,'ativo')`).run(id,org,nome,email,bcrypt.hashSync("123456",8),role,Date.now());return id;};
const criarLead=(org,nome,dono)=>{const id="l_"+randomUUID();
  db.prepare(`INSERT INTO leads (id,org_id,name,phone,origem,priority,stage,assigned_to,created_at)
    VALUES (?,?,?,?, 'manual','QUENTE','Atendimento',?,?)`).run(id,org,nome,"55879"+Math.floor(Math.random()*1e7),dono,Date.now());return id;};

const orgA=criarOrg("Conecta","A-1"), orgB=criarOrg("Outra Imobiliária","B-1");
criarUser(orgA,"Ali","ali@a.com","adm"); const marinaA=criarUser(orgA,"Marina","marina@a.com","corretor");
criarUser(orgB,"Bruno","bruno@b.com","adm");
const leadA=criarLead(orgA,"Cliente da Conecta",marinaA);
db.prepare("INSERT INTO messages (id,lead_id,direction,body,created_at) VALUES (?,?,?,?,?)")
  .run("m_"+randomUUID(),leadA,"in","oi, quero saber do apartamento",Date.now());
criarLead(orgB,"Cliente da Outra",null);

const srv=app.listen(0); const base=`http://localhost:${srv.address().port}`;
const login=async(email)=>{const r=await fetch(base+"/auth/login",{method:"POST",headers:{"content-type":"application/json"},
  body:JSON.stringify({email,password:"123456"})}); return (await r.json()).token;};
const comoB=await login("bruno@b.com");
const h={authorization:"Bearer "+comoB,"content-type":"application/json"};
const st=async(m,u,b)=>(await fetch(base+u,{method:m,headers:h,body:b&&JSON.stringify(b)})).status;

console.log("Bruno (gestor da OUTRA imobiliária) tentando alcançar a Conecta:");
const casos=[
  ["ver a lista de leads",     "GET",  "/leads", null],
  ["abrir o lead da Conecta",  "GET",  `/leads/${leadA}`, null],
  ["escrever na conversa",     "POST", `/leads/${leadA}/messages`, {text:"invadindo"}],
  ["mudar a etapa do funil",   "PATCH",`/leads/${leadA}/stage`, {stage:"Perdido"}],
  ["registrar venda",          "PATCH",`/leads/${leadA}/venda`, {sale_value:1}],
  ["marcar como lida",         "POST", `/leads/${leadA}/read`, null],
  ["ver a equipe",             "GET",  "/auth/users", null],
];
for(const [rot,m,u,b] of casos){
  const s=await st(m,u,b);
  if(u==="/leads"||u==="/auth/users"){
    const r=await (await fetch(base+u,{headers:h})).json();
    const lista=Array.isArray(r)?r:(r.leads||r.users||[]);
    const vazou=JSON.stringify(lista).includes("Conecta");
    console.log(`  ${rot}: ${s} — ${lista.length} item(ns), dados da Conecta no meio? ${vazou?"SIM ❌":"não ✅"}`);
    assert.equal(vazou,false);
  }else{
    console.log(`  ${rot}: ${s} ${s===403||s===404?"✅ barrado":"❌ PASSOU"}`);
    assert.ok(s===403||s===404,`${rot} devia barrar, veio ${s}`);
  }
}
const msgs=db.prepare("SELECT COUNT(*) n FROM messages WHERE lead_id=?").get(leadA).n;
assert.equal(msgs,1,"nenhuma mensagem nova podia ter entrado");
console.log("\nMensagens do lead da Conecta continuam:",msgs,"(nenhuma escrita de fora) ✅");
srv.close();
