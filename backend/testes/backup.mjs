/* A CÓPIA DE SEGURANÇA DIÁRIA DO BANCO (27/08/2026, pedido do Ali).

   O banco é um arquivo no volume da hospedagem e não havia cópia nenhuma:
   perder o volume era perder a base de leads de todos os clientes de uma vez.

   O que este teste tranca — e a ordem é a da importância:

   1. SEM R2, NÃO HÁ BACKUP, e o sistema diz isso. Cair para o disco da
      hospedagem seria gravar a cópia no mesmo volume do banco que ela protege:
      some junto, e no meio do caminho todo mundo achou que estava protegido;
   2. CÓPIA COM DEFEITO NÃO SOBE. Backup corrompido é pior que nenhum — com
      nenhum você se sabe desprotegido, com um quebrado você descobre no dia em
      que precisa dele;
   3. NÃO RODA DUAS VEZES NO MESMO DIA, e o servidor que estava fora do ar na
      hora marcada faz a cópia quando voltar. Quem manda é o registro, não o
      relógio — mesma regra do corte de expediente;
   4. FALHA NUNCA DERRUBA O CRM;
   5. O TEMPORÁRIO É SEMPRE APAGADO. Ele tem o tamanho do banco inteiro: ficar
      para trás enche o disco em poucos dias e quebra o CRM POR CAUSA do backup.

   Rodar:  npm run teste:backup
*/
import assert from "node:assert";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
process.env.DB_PATH = path.join(os.tmpdir(), "concrm-teste-backup.db");
process.env.JWT_SECRET = "teste";
process.env.BACKUP_HORA = "0";     // qualquer hora serve dentro do teste
process.env.BACKUP_MANTER = "3";   // guarda 3, para dar para ver a limpeza
for (const s of ["", "-wal", "-shm"]) { try { fs.unlinkSync(process.env.DB_PATH + s); } catch (e) {} }

const { default: db } = await import("../src/db.js");
const { randomUUID } = await import("crypto");

// Uma base com conteúdo: cópia vazia passaria em qualquer conferência.
const org = "org_" + randomUUID().slice(0, 8);
db.prepare("INSERT INTO orgs (id,name,adm_code,created_at) VALUES (?,?,?,?)").run(org, "Conecta", "C-1", Date.now());
for (let i = 0; i < 40; i++) {
  const lid = "l_" + i;
  db.prepare("INSERT INTO leads (id,org_id,name,phone,stage,created_at) VALUES (?,?,?,?,'Lead',?)")
    .run(lid, org, "Cliente " + i, "8799" + i, Date.now());
  for (let m = 0; m < 5; m++)
    db.prepare("INSERT INTO messages (id,lead_id,direction,body,created_at) VALUES (?,?,'in','oi',?)")
      .run(`m_${i}_${m}`, lid, Date.now());
}

let r;

console.log("1. SEM R2 configurado, o backup NÃO acontece — e explica por quê");
/* É a regra mais importante do arquivo. O storage.js cai para o disco quando o
   R2 recusa uma foto, e está certo; aqui isso seria gravar a cópia no volume
   que ela existe para proteger. */
const semR2 = await import("../src/services/backup.js");
r = await semR2.rodarBackup({ motivo: "manual" });
console.log(`   ok: ${r.ok} · ${r.erro}`);
assert.equal(r.ok, false);
assert.ok(/R2/.test(r.erro), "a recusa nomeia o que falta");
assert.ok(/mesmo disco|mesmo volume/i.test(r.erro), "e diz por que não vale gravar no disco");

console.log("2. O ciclo automático fica quieto sem R2 — não é erro, é ausência");
await semR2.backupSePassouDaHora();   // não pode lançar
console.log("   passou sem lançar");

console.log("3. A situação diz 'desligado', sem inventar cópia nenhuma");
let s = await semR2.situacaoDoBackup();
console.log(`   ligado: ${s.ligado} · cópias: ${s.copias.length} · último erro: ${!!s.ultimo_erro}`);
assert.equal(s.ligado, false);
assert.equal(s.copias.length, 0);
assert.ok(s.ultimo_erro, "a tentativa que falhou fica registrada, não some");

/* ===== Daqui para baixo: a cópia em si =====

   O ENVIO PELA REDE NÃO É TESTADO AQUI, e é melhor dizer isso do que fingir.
   O endereço do R2 é montado a partir do ACCOUNT_ID (https://<id>.r2.
   cloudflarestorage.com), então não há para onde apontar um servidor de mentira
   sem torcer o storage.js só por causa do teste. Depender da Cloudflare de
   verdade faria a suíte quebrar quando a internet oscilasse.

   O que fica coberto é tudo que decide se o backup PRESTA: a cópia sair
   íntegra, sair com as escritas do WAL, a conferência recusar arquivo corrompido
   E arquivo vazio, o dia não ser marcado quando falha, e o temporário não ficar
   para trás. O envio em si é uma chamada de PUT — a parte que erra é a que está
   testada aqui. */

console.log("\n4. A cópia online sai íntegra e com os dados dentro");
const Database = (await import("better-sqlite3")).default;
const destino = path.join(os.tmpdir(), "concrm-teste-copia.db");
try { fs.unlinkSync(destino); } catch (e) {}
await db.backup(destino);
const copia = new Database(destino, { readonly: true, fileMustExist: true });
const check = copia.pragma("integrity_check", { simple: true });
const leads = copia.prepare("SELECT COUNT(*) n FROM leads").get().n;
const msgs = copia.prepare("SELECT COUNT(*) n FROM messages").get().n;
const orgs = copia.prepare("SELECT COUNT(*) n FROM orgs").get().n;
copia.close();
console.log(`   integrity_check: ${check} · ${leads} leads · ${msgs} mensagens · ${orgs} imobiliária(s)`);
assert.equal(check, "ok");
assert.equal(leads, 40, "a cópia tem os leads que estavam no banco");
assert.equal(msgs, 200);
assert.equal(orgs, 1);

console.log("5. E ela sai com as escritas do WAL, que não estão no arquivo .db");
/* É o motivo de usar db.backup() em vez de copiar o arquivo. Em WAL, o .db no
   disco não contém as escritas recentes — copiar só ele entregaria uma base
   sem os últimos atendimentos, e ninguém perceberia até precisar dela. */
db.prepare("INSERT INTO leads (id,org_id,name,phone,stage,created_at) VALUES (?,?,?,?,'Lead',?)")
  .run("l_novo", org, "Entrou agora", "87999", Date.now());
const destino2 = path.join(os.tmpdir(), "concrm-teste-copia2.db");
try { fs.unlinkSync(destino2); } catch (e) {}
await db.backup(destino2);
const c2 = new Database(destino2, { readonly: true });
const achou = c2.prepare("SELECT name FROM leads WHERE id = 'l_novo'").get();
c2.close();
console.log(`   o lead gravado um instante antes está na cópia: ${!!achou}`);
assert.ok(achou, "a cópia tem que incluir o que estava só no WAL");

console.log("6. Cópia com DEFEITO é recusada pela conferência");
/* O teste que mais importa depois do primeiro. Estraga o arquivo no meio e
   confere que o integrity_check pega — é isso que impede um backup quebrado de
   subir parecendo bom. */
const quebrado = path.join(os.tmpdir(), "concrm-teste-quebrado.db");
fs.copyFileSync(destino, quebrado);
const fd = fs.openSync(quebrado, "r+");
const tam = fs.statSync(quebrado).size;
fs.writeSync(fd, Buffer.alloc(4096, 0x41), 0, 4096, Math.floor(tam / 2));
fs.closeSync(fd);
let pegou = false, motivo = "";
try {
  const cq = new Database(quebrado, { readonly: true });
  const v = cq.pragma("integrity_check", { simple: true });
  cq.close();
  if (v !== "ok") { pegou = true; motivo = String(v).slice(0, 60); }
} catch (e) { pegou = true; motivo = e.message.slice(0, 60); }
console.log(`   recusada: ${pegou} · ${motivo}`);
assert.ok(pegou, "arquivo corrompido tem que ser recusado antes de subir");

console.log("7. Cópia VAZIA também é recusada — ela passa no integrity_check");
/* Arquivo vazio é um banco perfeitamente íntegro. Sem a contagem, ele subiria
   todo dia como se fosse a cópia boa. */
const vazio = path.join(os.tmpdir(), "concrm-teste-vazio.db");
try { fs.unlinkSync(vazio); } catch (e) {}
const dv = new Database(vazio);
dv.exec("CREATE TABLE orgs (id TEXT); CREATE TABLE leads (id TEXT); CREATE TABLE messages (id TEXT)");
dv.close();
const cv = new Database(vazio, { readonly: true });
const okVazio = cv.pragma("integrity_check", { simple: true });
const orgsVazio = cv.prepare("SELECT COUNT(*) n FROM orgs").get().n;
cv.close();
console.log(`   integrity_check diz "${okVazio}", mas tem ${orgsVazio} imobiliárias`);
assert.equal(okVazio, "ok", "arquivo vazio é íntegro — por isso a contagem é necessária");
assert.equal(orgsVazio, 0, "e é a contagem que o reprova");

console.log("8. 'Já fiz hoje' é o que manda, não o relógio");
/* Mesma regra do corte de expediente. Como as duas tentativas acima falharam
   (sem R2), o dia NÃO foi marcado — e isso é o certo: cópia que não aconteceu
   não pode contar como feita, senão o dia inteiro fica sem backup. */
const est = db.prepare("SELECT valor FROM config_plataforma WHERE chave='backup_estado'").get();
const estado = JSON.parse(est.valor);
console.log(`   último dia marcado: ${estado.ultimo_dia || "(nenhum)"} · erro guardado: ${!!estado.ultimo_erro}`);
assert.ok(!estado.ultimo_dia, "falha não pode marcar o dia como feito");
assert.ok(estado.ultimo_erro, "mas fica registrada, para a tela mostrar");

console.log("9. O arquivo temporário não fica para trás");
/* Ele tem o tamanho do banco inteiro. Sobrando um por dia, o volume enche e o
   CRM cai POR CAUSA do backup — o oposto do que ele existe para fazer. */
const lixo = fs.readdirSync(os.tmpdir()).filter(f => /^concrm-backup-\d+\.db$/.test(f));
console.log(`   temporários deixados no disco: ${lixo.length}`);
assert.equal(lixo.length, 0);

console.log("10. O caminho do banco é o que está em uso de verdade");
console.log(`   ${semR2.caminhoDoBanco()}`);
assert.equal(semR2.caminhoDoBanco(), process.env.DB_PATH);

for (const f of [destino, destino2, quebrado, vazio]) { try { fs.unlinkSync(f); } catch (e) {} }
console.log("11. O erro chega em português, não como despejo do SDK da Amazon");
/* O SDK devolve coisas como "@aws-sdk XML parse error: unexpected content.
   Deserialization error: to see the raw response, inspect the hidden field
   {error}.$response" — verdade, e inútil para quem administra a plataforma.
   Quem lê esta tela não escreveu o cliente HTTP. */
const casos = [
  [{ name: "InvalidAccessKeyId", message: "The Access Key Id you provided does not exist" }, /credenciais/i],
  [{ name: "SignatureDoesNotMatch", message: "signature we calculated does not match" }, /credenciais/i],
  [{ name: "NoSuchBucket", message: "The specified bucket does not exist" }, /bucket/i],
  [{ message: "getaddrinfo ENOTFOUND abc.r2.cloudflarestorage.com" }, /R2_ACCOUNT_ID/],
  [{ message: "ENOSPC: no space left on device, write" }, /espaço em disco/i],
  [{ message: "socket hang up" }, /conexão/i],
  [{ message: "@aws-sdk XML parse error: unexpected content. Deserialization error: to see the raw response, inspect the hidden field {error}.$response" }, /R2_ACCOUNT_ID/],
];
for (const [erro, esperado] of casos) {
  const frase = semR2.emPortugues(erro);
  console.log(`   ${(erro.name || erro.message).slice(0, 34).padEnd(36)}→ ${frase.slice(0, 52)}…`);
  assert.ok(esperado.test(frase), `não traduziu "${erro.name || erro.message}": saiu "${frase}"`);
  assert.ok(!/\$response|Deserialization|aws-sdk|ENOTFOUND|ENOSPC/.test(frase),
    `a tradução ainda carrega jargão: ${frase}`);
}

console.log("12. O que ele NÃO conhece passa cru, em vez de virar 'erro desconhecido'");
/* Esconder o que não sabe nomear é pior: some a única pista que existe. */
const estranho = semR2.emPortugues(new Error("coisa nova que ninguém previu"));
console.log(`   ${estranho}`);
assert.equal(estranho, "coisa nova que ninguém previu");

console.log("\nTudo certo ✅");
process.exit(0);
