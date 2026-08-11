/* O WhatsApp é de cada imobiliária.

   O defeito que este teste guarda: a conexão vinha de variável de ambiente,
   valendo para o servidor inteiro. Ao cadastrar a segunda imobiliária, ela
   abria Configurações → Conexão e via o número da PRIMEIRA como se fosse dela
   — podia mandar mensagem por ele e o botão Desconectar derrubava o
   atendimento da casa vizinha. E a mensagem que chegava caía sempre na
   imobiliária mais antiga.

   Rodar:  npm run teste:whatsapp
*/
import assert from "node:assert";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
process.env.DB_PATH=path.join(os.tmpdir(),"concrm-teste-whats.db");
process.env.JWT_SECRET="teste";
try{fs.unlinkSync(process.env.DB_PATH);}catch(e){}

const {default:db}=await import("../src/db.js");
const {randomUUID}=await import("crypto");
const uaz=await import("../src/services/uazapi.js");

const org=(nome,code)=>{const id="org_"+randomUUID().slice(0,8);
  db.prepare("INSERT INTO orgs (id,name,adm_code,wa_number,created_at) VALUES (?,?,?,?,?)")
    .run(id,nome,code,"",Date.now());return id;};
const conecta=org("Conecta Imóveis","CONECTA-JAZ-2026");
const place=org("Place Imóveis","PLACE-2026");

console.log("1. A Conecta conecta o WhatsApp dela");
uaz.salvarCredenciais(conecta,{host:"https://conectaimoveis.uazapi.com",token:"token-da-conecta"});
assert.equal(uaz.uazapiConfigured(conecta),true);

console.log("2. A Place NÃO enxerga o WhatsApp da Conecta");
assert.equal(uaz.uazapiConfigured(place),false,"a Place não pode aparecer conectada");
const st=await uaz.instanceStatus(place);
assert.equal(st.configurado,false);
console.log("   status da Place:",JSON.stringify(st.dica).slice(0,80)+"…");

console.log("3. Enviar pela Place não sai pelo número da Conecta");
const envio=await uaz.sendText({orgId:place,toPhone:"5587999990000",text:"oi"});
assert.equal(envio.simulated,true,"sem conexão própria, não pode sair mensagem nenhuma");
assert.equal(envio.ok,false);

console.log("4. Desconectar pela Place não derruba a Conecta");
await assert.rejects(()=>uaz.desconectarInstancia(place),/não tem WhatsApp conectado/);
assert.equal(uaz.uazapiConfigured(conecta),true,"a Conecta continua conectada");

console.log("5. A mensagem que chega vai para a dona do número");
assert.equal(uaz.orgDoWhatsapp({token:"token-da-conecta"}),conecta);
uaz.salvarCredenciais(place,{host:"https://place.uazapi.com",token:"token-da-place"});
assert.equal(uaz.orgDoWhatsapp({token:"token-da-place"}),place);
assert.equal(uaz.orgDoWhatsapp({token:"token-de-ninguem"}),null,"token desconhecido não pode cair em ninguém");

console.log("6. Com o número (owner) em vez do token, também acha");
db.prepare("UPDATE orgs SET wa_number = ? WHERE id = ?").run("5587996546848",conecta);
assert.equal(uaz.orgDoWhatsapp({numero:"5587996546848@s.whatsapp.net"}),conecta);

console.log("7. Cliente com o mesmo telefone nas duas casas não mistura conversa");
const lead=(o,nome)=>{const id="l_"+randomUUID();
  db.prepare(`INSERT INTO leads (id,org_id,name,phone,origem,priority,stage,created_at)
    VALUES (?,?,?,?,'WhatsApp','MORNO','Lead',?)`).run(id,o,nome,"5587911112222",Date.now());return id;};
const naConecta=lead(conecta,"João (cliente da Conecta)");
const naPlace=lead(place,"João (cliente da Place)");
const achado=(o)=>db.prepare("SELECT id,name FROM leads WHERE phone=? AND org_id=? ORDER BY created_at DESC LIMIT 1")
  .get("5587911112222",o);
assert.equal(achado(conecta).id,naConecta);
assert.equal(achado(place).id,naPlace);
console.log("   mesmo telefone, dois donos:",achado(conecta).name,"|",achado(place).name);

console.log("\nTudo certo ✅");
