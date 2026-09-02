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

console.log("6. Só o NÚMERO não abre mais a porta — e o modo de emergência abre");
/* MUDOU EM 02/09/2026, na auditoria de segurança, e é a correção mais séria
   dela. Este caso testava que a mensagem entrava quando reconhecida pelo
   NÚMERO da imobiliária. O problema: o número de uma imobiliária é PÚBLICO —
   está no site, no anúncio, na fachada. Quem soubesse o número podia mandar um
   POST para /webhooks/uazapi e criar lead falso, escrever na conversa de um
   cliente real e, com o atendimento automático ligado, fazer a IA da casa
   mandar WhatsApp para um número escolhido por ele.

   O token é a credencial de verdade (é o segredo da instância na Uazapi) e
   passou a ser o único caminho. O reconhecimento pelo número continua como
   SAÍDA DE EMERGÊNCIA atrás de UAZAPI_ACEITAR_POR_NUMERO=1, porque a falha que
   este sistema mais teme é "parou de entrar lead" — e religar tem que custar
   trinta segundos no painel da hospedagem, não uma publicação.

   Os dois lados são testados de propósito: sem o par, uma versão que ignorasse
   a variável passaria em metade do teste e ninguém saberia qual metade. */
db.prepare("UPDATE orgs SET wa_number = ? WHERE id = ?").run("5587996546848",conecta);
delete process.env.UAZAPI_ACEITAR_POR_NUMERO;
console.log("   só com o número, no padrão:",uaz.orgDoWhatsapp({numero:"5587996546848@s.whatsapp.net"}));
assert.equal(uaz.orgDoWhatsapp({numero:"5587996546848@s.whatsapp.net"}),null,
  "o número da imobiliária é público — sozinho ele não pode identificar a casa");

process.env.UAZAPI_ACEITAR_POR_NUMERO="1";
assert.equal(uaz.orgDoWhatsapp({numero:"5587996546848@s.whatsapp.net"}),conecta,
  "com o modo de emergência ligado, o caminho antigo volta");
delete process.env.UAZAPI_ACEITAR_POR_NUMERO;

console.log("6b. E o token continua sendo o caminho normal");
assert.equal(uaz.orgDoWhatsapp({token:"token-da-conecta"}),conecta);
/* Token ERRADO acompanhado do número certo também não entra. Era o furo
   dentro do furo: a conferência do token não RECUSAVA, ela só "não achava", e
   a execução seguia para o número logo abaixo. Trava que não recusa não é
   trava. */
assert.equal(uaz.orgDoWhatsapp({token:"token-inventado",numero:"5587996546848@s.whatsapp.net"}),null,
  "token errado não pode ser salvo pelo número");

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
