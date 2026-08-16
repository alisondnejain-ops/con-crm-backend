const { useState, useEffect, useMemo, useRef } = React;

/* ===== IDENTIDADE ===== */
const C = {
  ink:"#14181F", sub:"#5A6472", faint:"#8A93A0", line:"#E6E9E7", surface:"#F4F6F5", card:"#FFFFFF",
  green:"#0E8F6E", greenDeep:"#0A3D30", greenMid:"#0C6B52", greenSoft:"#E5F2EC",
  hot:"#E1553A", hotSoft:"#FBE7E1", amber:"#C8912B", amberSoft:"#F7EFD9", cool:"#5C6B7A", coolSoft:"#ECEFF2", white:"#FFF",
};
const DISPLAY="'Sora',sans-serif", FONT="'Inter',sans-serif", MONO="'IBM Plex Mono',monospace";

/* ===== API (backend hospedado) =====
   Para apontar para outro servidor sem recompilar, defina window.CON_CRM_API no index.html. */
// Registra o service worker: é ele que recebe a notificação push com o CRM
// fechado. Falhar aqui não pode derrubar o app — sem ele, só não há push.
if(typeof navigator!=="undefined"&&"serviceWorker" in navigator)
  window.addEventListener("load",()=>navigator.serviceWorker.register("/sw.js").catch(e=>console.warn("service worker:",e.message)));

const API=(typeof window!=="undefined"&&window.CON_CRM_API||"https://con-crm-backend-production.up.railway.app").replace(/\/$/,"");
/* O link de cadastro sai no endereço do PRÓPRIO SITE, não no da hospedagem:
   é ele que a gestão manda no grupo, e "con-crm-backend-production.up.railway.app"
   não passa confiança para o corretor que vai digitar os dados dele.
   As páginas são copiadas para cá no build (ver build.mjs).

   O código vem da imobiliária de quem está logado — nunca fixo no código-fonte.
   Enquanto foi fixo, a plataforma tinha uma imobiliária só; com duas, o gestor
   da segunda mandaria para a equipe dele o código da PRIMEIRA, e os corretores
   dele cairiam na casa errada. */
const linkDeCadastro=(codigo)=>(typeof window!=="undefined"?window.location.origin:"")+`/cadastro?c=${codigo||""}`;

// Token guardado no navegador para o corretor não ter que logar toda vez (importante no celular).
const STORE="concrm_token";
let TOKEN=null;
try{ TOKEN=localStorage.getItem(STORE); }catch(e){}
function setToken(t){ TOKEN=t; try{ t?localStorage.setItem(STORE,t):localStorage.removeItem(STORE); }catch(e){} }

/* Marca de que o master JÁ escolheu uma imobiliária no hub.
   Sem ela, recarregar a página levaria direto para a imobiliária do crachá —
   que logo depois do login ainda é a de origem dele, e o hub nunca apareceria.
   Com ela, recarregar mantém onde ele estava trabalhando. */
const STORE_ORG="conhub_org";
const orgEscolhida=()=>{ try{ return localStorage.getItem(STORE_ORG); }catch(e){ return null; } };
const marcarOrg=(id)=>{ try{ id?localStorage.setItem(STORE_ORG,id):localStorage.removeItem(STORE_ORG); }catch(e){} };

async function api(path,{method="GET",body}={}){
  let res;
  try{
    res=await fetch(API+path,{method,
      headers:{...(body?{"Content-Type":"application/json"}:{}),...(TOKEN?{Authorization:"Bearer "+TOKEN}:{})},
      body:body?JSON.stringify(body):undefined});
  }catch(e){ throw new Error("Sem conexão com o servidor. Confira sua internet e tente de novo."); }
  const data=await res.json().catch(()=>({}));
  /* O `detail` junto, e não só o `error`.
     "Falha ao enviar pelo WhatsApp" sozinho não diz nada a quem está na tela
     nem a quem vai consertar — o motivo de verdade vinha no `detail` e era
     jogado fora aqui. Um dia inteiro se perdeu por causa disso. */
  if(!res.ok) throw new Error([data.error||`Erro ${res.status} ao falar com o servidor.`,data.detail].filter(Boolean).join(" — "));
  return data;
}

/* ===== tradução backend -> telas =====
   O backend fala em name/phone/stage; as telas nasceram falando nome/tel/status.
   Traduzimos aqui, num lugar só, em vez de espalhar a mudança por tudo. */
const QUAL_VAZIA={renda:"—",entrada:"—",situacao:"—",cpf:"—",prazo:"—"};
function adaptLead(l,anterior){
  return {
    id:l.id, nome:l.name||"Sem nome", tel:l.phone||"", email:l.email||"",
    // Sem temperatura fica SEM. Antes o app preenchia "MORNO" por conta própria
    // quando o campo vinha vazio — e aí a tela mostrava uma marcação que
    // ninguém tinha feito.
    prio:l.priority||null, origem:l.origem||"WhatsApp",
    createdAt:l.created_at, firstRespAt:l.first_resp_at,
    assignedTo:l.assigned_to, assignedName:l.assigned_name,
    status:l.stage||"Lead",
    qual:{...QUAL_VAZIA,...(l.qual||{})},
    unread:l.unread||0, lastBody:l.last_body, lastDirection:l.last_direction, lastAt:l.last_at,
    finalizado:!!l.closed_at, finalizadoEm:l.closed_at||null,
    // Pedido de atenção da gestão. Fica na ficha até o corretor dar o "vi".
    cutucadoEm:l.cutucado_em||null, cutucadoRecado:l.cutucado_recado||null,
    // Quando este lead caiu na mão de quem está com ele. Diferente da data de
    // entrada: o lead pode ter chegado em junho e ter sido repassado hoje.
    assignedAt:l.assigned_at!==undefined?l.assigned_at:(anterior?anterior.assignedAt:null),
    venda:l.sale_value?{valor:l.sale_value,data:l.sale_date,imovel:l.sale_property}:null,
    // As mensagens só chegam ao abrir a conversa; preservamos as já carregadas.
    msgs:l.messages?l.messages.map(adaptMsg):(anterior?anterior.msgs:[]),
    carregado:!!l.messages||(anterior?anterior.carregado:false),
    // Resumo da conversa feito pela IA (vem só ao abrir a conversa).
    resumo:l.resumo||(anterior?anterior.resumo:null),
    etapaIA:l.etapa_ia||(anterior?anterior.etapaIA:null),
    // Desde quando está nesta etapa. null = nunca mudou desde que o histórico
    // existe; a tela mostra "—" em vez de inventar uma data.
    etapaDesde:l.etapa_desde!==undefined?l.etapa_desde:(anterior?anterior.etapaDesde:null),
    // Resumo das tarefas em aberto, para o card do funil: {abertas, proxima, titulo, atrasada}.
    tarefas:l.tarefas!==undefined?l.tarefas:(anterior?anterior.tarefas:null),
    // A lista inteira, que só vem ao abrir a ficha.
    listaTarefas:l.lista_tarefas||(anterior?anterior.listaTarefas:null),
  };
}
const RESULTADO_LIGACAO={falou:"Falei com o cliente",nao_atendeu:"Não atendeu",
  caixa_postal:"Caiu na caixa postal",numero_errado:"Número errado"};
const adaptMsg=(m)=>m.tipo==="ligacao"?{
  id:m.id, from:"system", at:m.created_at, ligacao:true,
  // Sem resultado é a ligação que o corretor não voltou para responder. Dizer
  // isso é melhor do que fingir que ela não existiu.
  text:`📞 ${first(m.quem||"Alguém")} ligou — ${RESULTADO_LIGACAO[m.resultado]||"sem resposta registrada"}`
    +(m.obs?`: ${m.obs}`:""),
}:({
  id:m.id,
  from:m.direction==="in"?"lead":"corretor",
  text:m.body, at:m.created_at, by:m.from_user_id, byName:m.from_name,
  midia:m.media_url?{url:m.media_url,mime:m.media_mime||"",nome:m.media_name||""}:null,
  // A mensagem citada já vem resolvida do servidor: texto, de quem era e se
  // era mídia. Basta desenhar.
  citada:m.reply_to?{
    texto:m.reply_body||"", deLead:m.reply_direction==="in",
    autor:m.reply_from_name||"", midia:m.reply_media_mime||"",
  }:null,
  // Só dá para citar no WhatsApp mensagem que tem id de lá. As anteriores a
  // 08/08/2026 não têm — a citação delas vale só dentro do CRM, e a tela
  // avisa em vez de deixar o corretor achar que o cliente vai ver.
  citavel:!!m.wa_id,
  editadaEm:m.edited_at||null, textoOriginal:m.body_original||null,
  // "Foto"/"Vídeo"/"Áudio" existem para a prévia da lista de conversas. Dentro
  // do balão seriam redundantes — a mídia já está à vista.
  rotuloAuto:!!m.media_url&&["Foto","Vídeo","Áudio"].includes(m.body),
});
/* Temperatura do lead. `SEM` é um estado de verdade, não um erro.

   A marcação vinha de um chute do sistema — todo lead do WhatsApp nascia
   "MORNO" — e não descrevia nada. Lead sem temperatura é mais honesto do que
   lead com temperatura inventada, e é o que permite a gestão marcar de verdade
   o que importa.

   `prioDe(l.prio)` era acesso direto: com `prio` nulo o app quebrava a tela
   inteira. `prioDe()` sempre devolve algo. */
const PRIO={QUENTE:{c:C.hot,bg:C.hotSoft,label:"Quente"},MORNO:{c:C.amber,bg:C.amberSoft,label:"Morno"},FRIO:{c:C.cool,bg:C.coolSoft,label:"Frio"},
  SEM:{c:C.faint,bg:C.surface,label:"Sem temperatura"}};
const prioDe=(p)=>PRIO[p]||PRIO.SEM;
// As três modalidades de financiamento com que a Conecta trabalha.
const MODALIDADES=["Morar Bem PE","Minha Casa Minha Vida","SBPE"];

/* Ferramentas oficiais da Caixa. Abrimos o site dela, não recriamos a conta
   aqui: as regras de faixa, subsídio e juros mudam sem aviso, e simulação nossa
   desatualizada daria número errado ao cliente — erro caro numa negociação.

   São duas, e a ordem é a que a própria Caixa recomenda: a calculadora primeiro,
   para ter uma ideia em um minuto, e a simulação completa quando o cliente já
   sabe o que quer. Se a Caixa mudar os endereços, são estas duas linhas. */
const CALCULADORA_CAIXA="https://simuladorhabitacao.caixa.gov.br/calculadora";
const SIMULADOR_CAIXA="https://simuladorhabitacao.caixa.gov.br/simulacao";
const STAGES=["Lead","Atendimento","Pasta","Aprovação","Agendamento","Visita","Proposta","Venda","Perdido","Recaptação","Transferido por ligação"];
const LINEAR=["Lead","Atendimento","Pasta","Aprovação","Agendamento","Visita","Proposta","Venda"];
const STAGE_C={"Lead":"#64748B","Atendimento":"#0E8F6E","Pasta":"#0C6B52","Aprovação":"#2F80C4","Agendamento":"#7A5AD6","Visita":"#C8912B","Proposta":"#D97706","Venda":"#0A3D30","Perdido":"#B0463A","Recaptação":"#B07C1F","Transferido por ligação":"#5C6B7A"};

/* A palavra que faz o lead subir para cada etapa. Só para MOSTRAR na tela —
   quem decide é o backend (GATILHOS em services/stages.js). Mudou a palavra
   lá, muda o texto aqui; é a mesma regra da inferStage de antes. */
const PALAVRA_ETAPA={"Atendimento":"atendimento","Pasta":"documentação","Aprovação":"aprovação",
  "Agendamento":"visita","Visita":"o que achou do imóvel","Proposta":"fechar","Venda":"contrato"};

/* A etapa só anda quando a palavra é dita na conversa. Se o corretor não sabe
   qual é a palavra, a regra não existe na prática — então ela fica escrita
   embaixo do seletor de etapa, na ficha do lead. */
function DicaEtapa({etapa}){
  const i=LINEAR.indexOf(etapa);
  const prox=i>=0&&i<LINEAR.length-1?LINEAR[i+1]:null;
  return <div style={{color:C.faint,fontSize:10.5,marginBottom:12,lineHeight:1.5}}>
    {prox
      ?<React.Fragment>Para ir para <b style={{color:STAGE_C[prox]}}>{prox}</b>, diga <b style={{color:C.ink}}>“{PALAVRA_ETAPA[prox]}”</b> na conversa. Ou mude aqui na mão.</React.Fragment>
      :i>=0?"Última etapa do funil. Dá para mudar aqui na mão."
      :"Etapa marcada na mão — a conversa não mexe mais nela."}
  </div>;
}

/* O avanço automático de etapa agora acontece no backend (services/stages.js).
   O frontend só exibe a etapa que o servidor devolve — uma fonte da verdade só. */


const TEMPLATES=[
  // "atendimento" aqui não é enfeite: é a palavra que tira o lead da etapa
  // Lead. O primeiro contato é justamente o momento em que isso acontece.
  {t:"Primeiro contato (forte)",body:"Oi {nome}! Aqui é o time da Conecta Imóveis e vou dar continuidade ao seu atendimento. Você se cadastrou pra realizar o sonho da casa própria no Jardim Amazonas e eu não quero que você perca as condições dessa fase. Posso te mostrar agora quanto ficaria a sua entrada e a parcela que cabe no seu bolso?"},
  {t:"Follow-up",body:"Oi {nome}, passando aqui rapidinho 🙂 As unidades dessa fase estão saindo. Quer que eu segure uma simulação no seu nome hoje?"},
  {t:"Agendar visita",body:"{nome}, que tal conhecer o imóvel de pertinho? Consigo te agendar essa semana. Prefere durante a semana ou no sábado?"},
  {t:"Pedir documentação",body:"{nome}, pra eu já adiantar a sua pasta e a simulação de crédito, consegue me enviar seus documentos (RG, CPF e comprovante de renda)?"},
];

/* ===== helpers ===== */
// Dois cortes de largura:
//  - até 760px  (celular): uma tela por vez + navegação inferior;
//  - até 1024px (tablet/janela estreita): lista + conversa lado a lado, e a ficha
//    passa a abrir por botão — senão a conversa fica espremida entre os dois painéis.
const MOBILE_BP=760, COMPACT_BP=1024;
function useMedia(query){
  const [m,setM]=useState(()=>typeof window!=="undefined"&&window.matchMedia(query).matches);
  useEffect(()=>{
    const mq=window.matchMedia(query);
    const sincronizar=()=>setM(mq.matches);
    mq.addEventListener("change",sincronizar);
    // O evento de resize é a rede de segurança: em alguns navegadores (e ao virar
    // o celular de lado) o "change" do matchMedia não dispara de forma confiável.
    window.addEventListener("resize",sincronizar);
    window.addEventListener("orientationchange",sincronizar);
    sincronizar();
    return()=>{mq.removeEventListener("change",sincronizar);
      window.removeEventListener("resize",sincronizar);
      window.removeEventListener("orientationchange",sincronizar);};
  },[query]);
  return m;
}
const useIsMobile=()=>useMedia(`(max-width:${MOBILE_BP}px)`);
const useIsCompact=()=>useMedia(`(max-width:${COMPACT_BP}px)`);

/* Altura da barra de navegação de baixo, medida de verdade.

   Ela muda de tamanho no iPhone por causa da faixa do indicador de início
   (`env(safe-area-inset-bottom)`), então chutar um número erra em metade dos
   aparelhos. Serve para as folhas que abrem por cima não encostarem o botão
   principal na barra — botão colado na barra é botão que o dedo erra, e no
   iPhone chega a ficar por baixo dela. */
function usarAlturaDaBarra(){
  const [h,setH]=useState(0);
  useEffect(()=>{
    const medir=()=>{ const n=document.querySelector("nav"); setH(n?Math.round(n.getBoundingClientRect().height):0); };
    medir();
    window.addEventListener("resize",medir);
    const t=setInterval(medir,1000);   // a barra some e volta conforme o papel de quem entrou
    return()=>{window.removeEventListener("resize",medir);clearInterval(t);};
  },[]);
  return h;
}

/* ===== ESCOLHA QUE NÃO SE PERDE =====

   Igual ao useState, só que a escolha volta se a tela for montada de novo.

   O CRM vive instalado na tela de início do celular, e o sistema do telefone
   descarta a página quando ela passa um tempo em segundo plano. Ao voltar, o
   React remonta tudo do zero: o filtro que a pessoa tinha ligado aparecia
   desligado, sem ninguém ter tocado nele. Do lado de quem usa isso é bug, não
   importa de quem seja a culpa.

   Fica em sessionStorage, não em localStorage, e a diferença é de propósito: a
   escolha sobrevive ao recarregamento e à volta do segundo plano, e some quando
   o app é fechado de verdade — que é quando começar limpo faz sentido. */
function usarEscolha(chave,inicial){
  const nome="conhub:"+chave;
  const [v,setV]=useState(()=>{
    try{ const s=sessionStorage.getItem(nome); return s===null?inicial:JSON.parse(s); }
    catch(e){ return inicial; }
  });
  useEffect(()=>{ try{ sessionStorage.setItem(nome,JSON.stringify(v)); }catch(e){} },[nome,v]);
  return [v,setV];
}
/* Tempo de resposta nos relatórios. O backend devolve minutos crus; passando de
   uma hora, "95 min" não diz nada a ninguém — vira "1h 35min". */
const fmtMin=(min)=>{
  const m=Math.max(0,Math.round(Number(min)||0));
  if(m<60) return m+" min";
  const h=Math.floor(m/60), r=m%60;
  if(h<24) return r?`${h}h ${r}min`:`${h}h`;
  // Passando de um dia, "31h" não comunica nada: vira "1 dia 7h".
  const d=Math.floor(h/24), hr=h%24;
  const dias=`${d} dia${d>1?"s":""}`;
  return hr?`${dias} ${hr}h`:dias;
};
const fmtAge=(ms)=>{const s=Math.max(0,Math.floor(ms/1000));if(s<60)return s+"s";const m=Math.floor(s/60);if(m<60)return m+" min";return Math.floor(m/60)+"h "+(m%60)+"min";};
const ageColor=(ms)=>{const m=ms/60000;return m<2?C.green:m<10?C.amber:C.hot;};
/* "Acabou de cair na minha mão". Um dia, e não uma hora: o lead repassado no
   fim da tarde tem que continuar em destaque na manhã seguinte, que é quando o
   corretor senta para atender. */
const NOVO_NA_MAO=24*3600000;
const chegouAgora=(l)=>!!l.assignedAt&&(Date.now()-l.assignedAt)<NOVO_NA_MAO;
const fmtClock=(at)=>new Date(at).toLocaleTimeString("pt-BR",{hour:"2-digit",minute:"2-digit"});
const initials=(n)=>String(n||"?").trim().split(/\s+/).map(x=>x[0]).slice(0,2).join("").toUpperCase();
const first=(n)=>String(n||"").split(" ")[0];
// O backend guarda 5587991234567; aqui mostramos legível.
function fmtTel(t){
  const d=String(t||"").replace(/\D/g,"");
  if(d.length===13) return `+55 (${d.slice(2,4)}) ${d.slice(4,9)}-${d.slice(9)}`;
  if(d.length===12) return `+55 (${d.slice(2,4)}) ${d.slice(4,8)}-${d.slice(8)}`;
  return t||"—";
}
const fmtMoeda=(v)=>(v||0).toLocaleString("pt-BR",{style:"currency",currency:"BRL",maximumFractionDigits:0});
const fmtData=(ms)=>ms?new Date(ms).toLocaleDateString("pt-BR"):"—";
const SEMANA=["domingo","segunda-feira","terça-feira","quarta-feira","quinta-feira","sexta-feira","sábado"];
/* Data/hora da última mensagem na LISTA de conversas, na régua do WhatsApp:
   hoje mostra a hora, ontem diz "Ontem", dentro da semana o dia da semana e,
   passando disso, a data.

   É a régua certa porque responde à pergunta que se faz olhando a lista —
   "isso é de agora ou de quando?" — com o mínimo de leitura. "14/08/2026
   15:06" obriga a comparar com a data de hoje toda vez. */
function fmtQuando(ts){
  if(!ts) return "";
  const d=new Date(ts);
  const dias=Math.round((new Date().setHours(0,0,0,0)-new Date(ts).setHours(0,0,0,0))/86400000);
  if(dias<=0) return d.toLocaleTimeString("pt-BR",{hour:"2-digit",minute:"2-digit"});
  if(dias===1) return "Ontem";
  if(dias<7) return SEMANA[d.getDay()];
  return d.toLocaleDateString("pt-BR",{day:"2-digit",month:"2-digit",
    ...(d.getFullYear()!==new Date().getFullYear()?{year:"2-digit"}:{})});
}
// Abre o discador do celular com o número já preenchido.
/* Ligar para o lead e, na volta, dizer o que aconteceu.

   O clique abre o discador do celular e a página fica para trás. Por isso a
   tentativa é gravada NA HORA do clique: se o corretor não voltar, ela não se
   perde. Quando ele volta, o popup está esperando com uma pergunta só.

   Sem essa resposta o relatório contava toques no botão. "Fez 20 ligações" e
   "falou com 3 pessoas" são conversas muito diferentes com o corretor, e só a
   segunda diz alguma coisa sobre o atendimento. */
const RESULTADOS_LIGACAO=[
  ["falou","Falei com o cliente",C.green],
  ["nao_atendeu","Não atendeu",C.amber],
  ["caixa_postal","Caiu na caixa postal",C.cool],
  ["numero_errado","Número errado",C.hot],
];

function BotaoLigar({tel,compacto,leadId,acoes,nome}){
  const [pergunta,setPergunta]=useState(null);   // id da ligação em aberto
  const [escolha,setEscolha]=useState("");
  const [obs,setObs]=useState("");
  const [salvando,setSalvando]=useState(false);
  const [erro,setErro]=useState("");
  if(!tel) return null;

  async function aoLigar(){
    if(!leadId||!acoes||!acoes.registrarLigacao) return;
    const r=await acoes.registrarLigacao(leadId);
    // Sem id (servidor antigo ou falha de rede) não abrimos o popup: melhor
    // não perguntar do que perguntar e não conseguir gravar a resposta.
    if(r&&r.ligacao_id){ setPergunta(r.ligacao_id); setEscolha(""); setObs(""); setErro(""); }
  }
  async function salvar(){
    if(!escolha||salvando) return;
    setSalvando(true); setErro("");
    try{ await acoes.resultadoLigacao(leadId,pergunta,escolha,obs); setPergunta(null); }
    catch(e){ setErro(e.message); }
    finally{ setSalvando(false); }
  }

  return <React.Fragment>
    <a href={"tel:+"+String(tel).replace(/\D/g,"")} title="Ligar para o lead" aria-label="Ligar"
      onClick={aoLigar}
      style={{display:"flex",alignItems:"center",gap:6,textDecoration:"none",border:`1px solid ${C.line}`,background:C.surface,color:C.greenMid,fontSize:12,fontWeight:600,padding:compacto?"8px":"7px 12px",borderRadius:10}}>
      <Icon n="phone" size={14}/>{!compacto&&"Ligar"}
    </a>

    {/* position:fixed em vez de portal: o React embutido aqui é a versão
        enxuta e não tem createPortal — já derrubou a tela uma vez. */}
    {pergunta&&<div style={{position:"fixed",inset:0,background:"rgba(10,61,48,.45)",zIndex:60,
      display:"flex",alignItems:"flex-end",justifyContent:"center",padding:14}}>
      <div style={{background:C.card,borderRadius:16,padding:16,width:"100%",maxWidth:420,
        boxShadow:"0 12px 40px rgba(0,0,0,.25)"}}>
        <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:3}}>
          <Icon n="phone" size={15} color={C.greenMid}/>
          <span style={{color:C.ink,fontSize:14,fontWeight:700,flex:1}}>Como foi a ligação?</span>
        </div>
        <div style={{color:C.faint,fontSize:11.5,lineHeight:1.5,marginBottom:11}}>
          {nome?<React.Fragment>Você ligou para <b style={{color:C.sub}}>{first(nome)}</b>. </React.Fragment>:null}
          Isso fica no histórico do lead e no seu relatório.
        </div>

        <div style={{display:"flex",flexDirection:"column",gap:6,marginBottom:11}}>
          {RESULTADOS_LIGACAO.map(([k,rotulo,cor])=>
            <button key={k} onClick={()=>setEscolha(k)}
              style={{display:"flex",alignItems:"center",gap:8,border:`1px solid ${escolha===k?cor:C.line}`,
                background:escolha===k?cor+"14":C.surface,borderRadius:10,padding:"10px 12px",
                cursor:"pointer",textAlign:"left"}}>
              <span style={{width:9,height:9,borderRadius:99,background:cor,flexShrink:0}}/>
              <span style={{color:C.ink,fontSize:13,fontWeight:escolha===k?700:500}}>{rotulo}</span>
            </button>)}
        </div>

        <input value={obs} onChange={e=>setObs(e.target.value)} maxLength={300}
          placeholder="O que ficou combinado? (opcional)"
          style={{width:"100%",boxSizing:"border-box",fontSize:16,border:`1px solid ${C.line}`,
            background:C.surface,borderRadius:10,padding:"10px 12px",color:C.ink,outline:"none",marginBottom:10}}/>

        {erro&&<div style={{background:C.hotSoft,color:C.hot,fontSize:11.5,borderRadius:9,padding:"8px 10px",marginBottom:9}}>{erro}</div>}

        <div style={{display:"flex",gap:7,flexWrap:"wrap"}}>
          <button onClick={salvar} disabled={!escolha||salvando}
            style={{flex:1,background:escolha?C.greenDeep:C.faint,color:"#fff",border:"none",borderRadius:10,
              padding:"11px 16px",fontSize:13,fontWeight:700,cursor:escolha?"pointer":"default"}}>
            {salvando?"Salvando…":"Salvar"}</button>
          <button onClick={()=>setPergunta(null)} disabled={salvando}
            style={{background:C.card,color:C.sub,border:`1px solid ${C.line}`,borderRadius:10,
              padding:"11px 16px",fontSize:13,fontWeight:600,cursor:"pointer"}}>Agora não</button>
        </div>
        <div style={{color:C.faint,fontSize:10.5,marginTop:8,lineHeight:1.4}}>
          A ligação já foi registrada. Sem a resposta, ela fica no histórico como tentativa.
        </div>
      </div>
    </div>}
  </React.Fragment>;
}

/* ===== ícones (SVG inline) ===== */
const ICO={
  /* WhatsApp: o balão com o fone dentro, desenhado com traço como os outros
     ícones da casa. Não é a logo oficial (que é sólida e tem cor própria) —
     é a forma que a equipe reconhece, no mesmo traço do resto da tela. */
  whatsapp:<React.Fragment><path d="M21 11.5a8.4 8.4 0 0 1-9 8.4 8.5 8.5 0 0 1-3.9-.9L3 20.5l1.5-4.9A8.4 8.4 0 0 1 3.6 11 8.4 8.4 0 0 1 12 3a8.4 8.4 0 0 1 9 8.5z"/><path d="M9.2 8.4c.2-.4.4-.4.6-.4h.5c.2 0 .4 0 .6.5l.7 1.7c.1.2 0 .4-.1.5l-.4.5c-.1.2-.3.3-.1.6a7 7 0 0 0 3 2.6c.3.1.5.1.6 0l.6-.7c.2-.2.3-.2.5-.1l1.6.8c.2.1.4.2.4.4s0 .9-.3 1.2c-.3.4-1 .8-1.5.8a7 7 0 0 1-3.2-1 11 11 0 0 1-3.7-3.9 4 4 0 0 1-.8-2.2c0-.8.4-1.2.6-1.4z"/></React.Fragment>,
  // Sino: a atendente cutuca o corretor sem sair da lista de conversas.
  bell:<React.Fragment><path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.7 21a2 2 0 0 1-3.4 0"/></React.Fragment>,
  send:<React.Fragment><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></React.Fragment>,
  search:<React.Fragment><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></React.Fragment>,
  phone:<path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.8 19.8 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.11 4.18 2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.81.36 1.6.7 2.34a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.74-1.74a2 2 0 0 1 2.11-.45c.74.34 1.53.57 2.34.7A2 2 0 0 1 22 16.92z"/>,
  clock:<React.Fragment><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></React.Fragment>,
  timer:<React.Fragment><line x1="10" y1="2" x2="14" y2="2"/><line x1="12" y1="14" x2="15" y2="11"/><circle cx="12" cy="14" r="8"/></React.Fragment>,
  flame:<path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.07-2.14-.22-4.05 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.15.43-2.29 1-3a2.5 2.5 0 0 0 2.5 2.5z"/>,
  check:<React.Fragment><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></React.Fragment>,
  calendar:<React.Fragment><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></React.Fragment>,
  zap:<polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>,
  sparkles:<React.Fragment><path d="M12 3l1.9 4.6L18.5 9.5l-4.6 1.9L12 16l-1.9-4.6L5.5 9.5l4.6-1.9L12 3z"/><path d="M19 15l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8.8-2z"/></React.Fragment>,
  star:<polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>,
  chevron:<polyline points="9 18 15 12 9 6"/>,
  arrow:<React.Fragment><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></React.Fragment>,
  users:<React.Fragment><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></React.Fragment>,
  chart:<React.Fragment><line x1="12" y1="20" x2="12" y2="10"/><line x1="18" y1="20" x2="18" y2="4"/><line x1="6" y1="20" x2="6" y2="16"/></React.Fragment>,
  trend:<React.Fragment><polyline points="23 6 13.5 15.5 8.5 10.5 1 18"/><polyline points="17 6 23 6 23 12"/></React.Fragment>,
  grid:<React.Fragment><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/></React.Fragment>,
  phone2:<React.Fragment><rect x="5" y="2" width="14" height="20" rx="2"/><line x1="12" y1="18" x2="12.01" y2="18"/></React.Fragment>,
  wifi:<React.Fragment><path d="M5 12.55a11 11 0 0 1 14 0"/><path d="M1.42 9a16 16 0 0 1 21.16 0"/><path d="M8.53 16.11a6 6 0 0 1 6.95 0"/><line x1="12" y1="20" x2="12.01" y2="20"/></React.Fragment>,
  wifioff:<React.Fragment><line x1="1" y1="1" x2="23" y2="23"/><path d="M16.72 11.06A10.94 10.94 0 0 1 19 12.55"/><path d="M5 12.55a10.94 10.94 0 0 1 5.17-2.39"/><path d="M10.71 5.05A16 16 0 0 1 22.58 9"/><path d="M1.42 9a15.9 15.9 0 0 1 4.7-2.88"/><path d="M8.53 16.11a6 6 0 0 1 6.95 0"/><line x1="12" y1="20" x2="12.01" y2="20"/></React.Fragment>,
  key:<React.Fragment><circle cx="7.5" cy="15.5" r="5.5"/><path d="M11.4 11.6 21 2"/><path d="m16 7 3 3"/></React.Fragment>,
  loader:<path d="M21 12a9 9 0 1 1-6.219-8.56"/>,
  columns:<React.Fragment><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="12" y1="3" x2="12" y2="21"/></React.Fragment>,
  mail:<React.Fragment><rect x="2" y="4" width="20" height="16" rx="2"/><polyline points="22 6 12 13 2 6"/></React.Fragment>,
  target:<React.Fragment><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/></React.Fragment>,
  award:<React.Fragment><circle cx="12" cy="8" r="7"/><polyline points="8.21 13.89 7 23 12 20 17 23 15.79 13.88"/></React.Fragment>,
  spark:<path d="M12 3l1.9 5.8L20 10l-6.1 1.2L12 17l-1.9-5.8L4 10l6.1-1.2L12 3z"/>,
  mais:<React.Fragment><circle cx="5" cy="12" r="1.9" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.9" fill="currentColor" stroke="none"/><circle cx="19" cy="12" r="1.9" fill="currentColor" stroke="none"/></React.Fragment>,
  logout:<React.Fragment><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></React.Fragment>,
  lock:<React.Fragment><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></React.Fragment>,
  dot:<React.Fragment><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="3" fill="currentColor"/></React.Fragment>,
  userplus:<React.Fragment><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><line x1="19" y1="8" x2="19" y2="14"/><line x1="22" y1="11" x2="16" y2="11"/></React.Fragment>,
  toggleOn:<React.Fragment><rect x="1" y="5" width="22" height="14" rx="7"/><circle cx="16" cy="12" r="3" fill="currentColor"/></React.Fragment>,
  toggleOff:<React.Fragment><rect x="1" y="5" width="22" height="14" rx="7"/><circle cx="8" cy="12" r="3" fill="currentColor"/></React.Fragment>,
  transfer:<React.Fragment><polyline points="17 3 21 7 17 11"/><line x1="21" y1="7" x2="9" y2="7"/><polyline points="7 21 3 17 7 13"/><line x1="3" y1="17" x2="15" y2="17"/></React.Fragment>,
  // Seta de responder: a mesma forma que o WhatsApp usa, para não ter dúvida.
  reply:<React.Fragment><polyline points="9 17 4 12 9 7"/><path d="M20 18v-2a4 4 0 0 0-4-4H4"/></React.Fragment>,
  msg:<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>,
  pin:<React.Fragment><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></React.Fragment>,
  link:<React.Fragment><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></React.Fragment>,
  edit:<React.Fragment><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4z"/></React.Fragment>,
  trash:<React.Fragment><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></React.Fragment>,
  undo:<React.Fragment><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></React.Fragment>,
};
function Icon({n,size=18,color,fill="none",spin}){
  return <svg width={size} height={size} viewBox="0 0 24 24" fill={fill} stroke={color||"currentColor"} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={spin?"spin":""} style={{display:"block"}}>{ICO[n]}</svg>;
}

/* ===== átomos ===== */
function Avatar({ini,color,size=34,foto}){
  const base={width:size,height:size,borderRadius:"50%",flexShrink:0};
  if(foto) return <img src={foto} alt="" style={{...base,objectFit:"cover",background:C.surface}}/>;
  return <div style={{...base,background:color,color:"#fff",fontFamily:DISPLAY,fontWeight:600,fontSize:size*0.4,display:"flex",alignItems:"center",justifyContent:"center"}}>{ini}</div>;
}
function Pill({children,c,bg}){return <span style={{color:c,background:bg,fontSize:11,fontWeight:600,padding:"3px 8px",borderRadius:999,whiteSpace:"nowrap"}}>{children}</span>;}
/* Cartão de número. O valor É o conteúdo — cortá-lo esvazia o cartão.

   "R$ 400.000" em 26px ocupa 157px, e no celular a caixa tem 134: o número
   aparecia como "R$ 400.00" com o zero comido. Pior que ilegível, é errado —
   quem bate o olho lê quatrocentos mil como quarenta mil.

   A régua encolhe conforme o texto: valor curto continua grande, valor longo
   diminui até caber. Melhor um número menor e inteiro do que um número grande
   pela metade. */
function Metric({n,label,value,sub,accent=C.green}){
  const txt=String(value ?? "");
  const tamanho=txt.length<=6?26:txt.length<=9?22:txt.length<=12?18:16;
  return <div style={{background:C.card,border:`1px solid ${C.line}`,borderRadius:16,padding:16,flex:"1 1 150px",minWidth:0}}>
    <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:12}}>
      <div style={{background:accent+"18",color:accent,width:32,height:32,borderRadius:8,display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}><Icon n={n} size={16}/></div>
      <span style={{color:C.sub,fontSize:12,fontWeight:500,minWidth:0,overflow:"hidden",textOverflow:"ellipsis"}}>{label}</span>
    </div>
    <div style={{color:C.ink,fontFamily:MONO,fontSize:tamanho,fontWeight:600,lineHeight:1.1,overflowWrap:"anywhere"}}>{txt}</div>
    {sub&&<div style={{color:C.faint,fontSize:11,marginTop:4,overflowWrap:"anywhere"}}>{sub}</div>}
  </div>;
}
/* `noEscuro` inverte as cores do texto. Sem isso, o "Con" saía em tinta escura
   sobre o verde profundo do painel de login — praticamente ilegível. */
function Brand({size=44,noEscuro}){
  return <div style={{display:"flex",alignItems:"center",gap:10}}>
    <div style={{background:C.green,width:size,height:size,borderRadius:12,display:"flex",alignItems:"center",justifyContent:"center",color:"#fff"}}><Icon n="dot" size={size*0.5}/></div>
    <div style={{fontFamily:DISPLAY,lineHeight:1}}>
      <div style={{color:noEscuro?"#fff":C.ink,fontSize:20,fontWeight:700}}>Con<span style={{color:noEscuro?"#8FE3C6":C.green}}>Hub</span></div>
      {/* Era "CONECTA IMÓVEIS". A marca da tela de entrada é a da plataforma;
          o nome da imobiliária aparece depois do login, dentro do sistema. */}
      <div style={{color:noEscuro?"rgba(255,255,255,.55)":C.faint,fontSize:10,fontWeight:500,letterSpacing:.5}}>CRM IMOBILIÁRIO</div>
    </div>
  </div>;
}

/* ===== LOGIN (contas reais, via backend) ===== */
function Auth({onLogin}){
  const [f,setF]=useState({email:"",pass:""});
  const [err,setErr]=useState("");
  const [busy,setBusy]=useState(false);
  const isMobile=useIsMobile();
  const set=(k)=>(e)=>setF({...f,[k]:e.target.value});
  async function entrar(){
    if(!f.email.trim()||!f.pass) return setErr("Preencha e-mail e senha.");
    setErr(""); setBusy(true);
    try{
      const d=await api("/auth/login",{method:"POST",body:{email:f.email.trim(),password:f.pass}});
      setToken(d.token); onLogin(d.user,d.org);
    }catch(e){ setErr(e.message); }
    finally{ setBusy(false); }
  }
  const onEnter=(e)=>{ if(e.key==="Enter") entrar(); };
  return <div style={{fontFamily:FONT,background:C.surface,width:"100%",minHeight:"100dvh",display:"flex",alignItems:isMobile?"stretch":"center",justifyContent:"center",padding:isMobile?0:24}}>
    <div style={{width:"100%",maxWidth:isMobile?"none":860,display:"grid",gridTemplateColumns:"1fr 1fr",borderRadius:isMobile?0:24,overflow:"hidden",boxShadow:isMobile?"none":"0 20px 60px rgba(0,0,0,.12)",border:isMobile?"none":`1px solid ${C.line}`}} className="authgrid">
      <div style={{background:C.greenDeep,padding:isMobile?"24px 22px":32,color:"#fff",display:"flex",flexDirection:"column",justifyContent:"space-between",gap:isMobile?16:0,minHeight:isMobile?0:460}}>
        <Brand size={isMobile?38:44} noEscuro/>
        {/* Nada de Conecta aqui: esta tela é a porta do ConHub, e a partir de
            agora ela abre para qualquer imobiliária. O nome de quem opera
            aparece depois de entrar, dentro do sistema. */}
        <div><div style={{fontFamily:DISPLAY,fontSize:isMobile?21:26,fontWeight:700,lineHeight:1.15,marginBottom:isMobile?8:12}}>Nenhum lead esquecido. Nenhuma venda no acaso.</div>
          {!isMobile&&<p style={{color:"rgba(255,255,255,.75)",fontSize:13,lineHeight:1.6}}>O CRM de atendimento das imobiliárias: um só WhatsApp para a equipe inteira, cada mensagem assinada pelo corretor, distribuição automática e funil que anda sozinho conforme a conversa evolui.</p>}</div>
        {/* A versão fica visível ANTES do login de propósito: quando alguém
            diz "aqui está diferente", este número responde na hora, sem
            precisar entrar no sistema nem procurar menu. */}
        {!isMobile&&<div style={{color:"rgba(255,255,255,.5)",fontSize:11}}>
          ConHub · plataforma de atendimento imobiliário
          {typeof window!=="undefined"&&window.CONHUB_BUILD?<React.Fragment><br/>versão {window.CONHUB_BUILD}</React.Fragment>:null}
        </div>}
      </div>
      <div style={{background:C.card,padding:isMobile?"24px 22px 40px":32,display:"flex",flexDirection:"column",justifyContent:"center"}}>
        <div style={{fontFamily:DISPLAY,color:C.ink,fontSize:20,fontWeight:700,marginBottom:4}}>Entrar</div>
        <div style={{color:C.sub,fontSize:13,marginBottom:22,lineHeight:1.5}}>Use o e-mail e a senha que você criou no seu cadastro.</div>
        <div style={{display:"flex",flexDirection:"column",gap:12}}>
          <Field n="mail" type="email" autoComplete="email" inputMode="email" placeholder="E-mail" value={f.email} onChange={set("email")} onKeyDown={onEnter}/>
          <Field n="lock" type="password" autoComplete="current-password" placeholder="Senha" value={f.pass} onChange={set("pass")} onKeyDown={onEnter}/>
          {err&&<div style={{color:C.hot,background:C.hotSoft,fontSize:12.5,borderRadius:8,padding:"10px 12px",lineHeight:1.45}}>{err}</div>}
          <button onClick={entrar} disabled={busy} style={{background:busy?C.faint:C.green,color:"#fff",fontSize:15,fontWeight:600,padding:"13px",borderRadius:12,border:"none",cursor:busy?"default":"pointer",display:"flex",alignItems:"center",justifyContent:"center",gap:8}}>
            {busy?<React.Fragment><Icon n="loader" size={16} spin/> Entrando…</React.Fragment>:<React.Fragment>Entrar <Icon n="arrow" size={16}/></React.Fragment>}
          </button>
        </div>
        {/* Duas portas, e a diferença importa: o corretor SEMPRE entra pelo link
            da imobiliária dele, que já traz o código embutido. Antes este botão
            levava para o cadastro com o código da Conecta escrito no link —
            quem quisesse abrir a própria imobiliária virava corretor da
            Conecta sem perceber. */}
        <div style={{borderTop:`1px solid ${C.line}`,marginTop:22,paddingTop:18,textAlign:"center"}}>
          <div style={{color:C.sub,fontSize:12.5,marginBottom:10}}>Ainda não tem conta?</div>
          <a href="/criar-imobiliaria" style={{display:"inline-flex",alignItems:"center",gap:7,textDecoration:"none",border:`1px solid ${C.line}`,background:C.surface,color:C.greenMid,fontSize:13.5,fontWeight:600,padding:"11px 18px",borderRadius:12}}>
            <Icon n="userplus" size={15}/> Cadastrar minha imobiliária
          </a>
          <div style={{color:C.faint,fontSize:11,marginTop:10,lineHeight:1.5}}>
            É <b style={{color:C.sub}}>corretor(a)</b>? Peça o link de cadastro à gestão da sua imobiliária —
            ele já vem com o código da casa.
          </div>
        </div>
      </div>
    </div>
  </div>;
}
function Field({n,...p}){return <div style={{display:"flex",alignItems:"center",gap:8,border:`1px solid ${C.line}`,background:C.surface,borderRadius:12,padding:"0 12px"}}><Icon n={n} size={16} color={C.faint}/><input {...p} style={{flex:1,fontSize:13.5,padding:"10px 0",outline:"none",border:"none",background:"transparent",color:C.ink,width:"100%"}}/></div>;}

/* ===== APP ===== */
const COLORS=["#0E8F6E","#3B7BC4","#C8912B","#7A5AD6","#B0463A","#0C6B52"];
// Converte o usuário que veio do backend no formato que as telas usam (inicial, cor).
function toSession(u){
  const h=[...(u.id||u.email||"")].reduce((a,c)=>a+c.charCodeAt(0),0);
  return {id:u.id,name:u.name,email:u.email,phone:u.phone,role:u.role,funcao:u.funcao,
          // Sem copiar `master` aqui, o backend marcava a conta certinho e o
          // app continuava tratando o master como um gestor qualquer — o hub
          // nunca aparecia.
          master:!!u.master, available:!!u.available,
          avatar:u.avatar_url||null,ini:initials(u.name),
          color:u.role==="adm"?C.greenDeep:COLORS[h%COLORS.length]};
}
const INTERVALO_ATUALIZACAO=10000; // busca novidades a cada 10s

function ConCRM(){
  const [session,setSession]=useState(null);
  // Em qual imobiliária o crachá está valendo agora. Para quem não é master é
  // sempre a própria; para o master é a que ele escolheu no hub.
  const [org,setOrg]=useState(null);
  const isMobileRaiz=useIsMobile();
  const [carregando,setCarregando]=useState(!!TOKEN);
  const [leads,setLeads]=useState([]);
  const [fila,setFila]=useState([]);
  const [equipe,setEquipe]=useState([]);
  const [conecta,setConecta]=useState({connected:false,number:""});
  const [erro,setErro]=useState("");
  // Recado âmbar: aconteceu, mas tem um porém que a pessoa precisa saber.
  const [recado,setRecado]=useState("");
  const [selId,setSelId]=useState(null);
  // Sobe a cada recarga. Telas que fazem a própria busca (Conversas) observam este
  // número para se atualizarem depois de uma ação, em vez de mostrar dado velho.
  const [versao,setVersao]=useState(0);
  const selRef=useRef(null); selRef.current=selId;
  /* Situação da mensalidade. Consultada no login e de hora em hora: se o
     pagamento cair enquanto a equipe está trabalhando, o sistema destrava
     sozinho, sem ninguém precisar sair e entrar de novo. */
  const [assinatura,setAssinatura]=useState(null);
  /* Plantão de hoje e o próximo da pessoa. Consultado no login e de hora em
     hora: a escala do dia não muda de minuto em minuto, e é o que desenha o
     lembrete no alto do sistema. */
  const [plantao,setPlantao]=useState(null);
  useEffect(()=>{
    if(!session) return;
    let vivo=true;
    const ver=()=>acoes.assinatura().then(a=>vivo&&setAssinatura(a)).catch(()=>{});
    ver();
    const t=setInterval(ver,60*60*1000);
    const verPlantao=()=>acoes.plantaoDeHoje().then(p=>vivo&&setPlantao(p)).catch(()=>{});
    verPlantao();
    const t2=setInterval(verPlantao,60*60*1000);
    return()=>{vivo=false;clearInterval(t);clearInterval(t2);};
  },[session]);

  useEffect(()=>{
    if(!TOKEN){setCarregando(false);return;}
    api("/auth/me").then(d=>{
      setSession(toSession(d.user));
      // O master só volta direto para uma imobiliária se já tinha escolhido uma;
      // senão cai no hub. Para os demais, é sempre a casa deles.
      if(d.org&&(!d.user.master||orgEscolhida()===d.org.id)) setOrg(d.org);
    }).catch(()=>setToken(null)).finally(()=>setCarregando(false));
  },[]);

  // Mescla a lista nova preservando as conversas já baixadas, para não piscar a tela.
  const mesclar=(novos)=>setLeads(ant=>{
    const antes=new Map(ant.map(l=>[l.id,l]));
    return novos.map(l=>adaptLead(l,antes.get(l.id)));
  });

  const supervisiona=session&&(session.role==="adm"||session.role==="sdr");

  async function recarregar(){
    if(!session) return;
    try{
      // /auth/users já traz papel, status e disponibilidade — serve tanto para a
      // catraca quanto para o contador de aprovações pendentes.
      const [ls,eq,eu]=await Promise.all([
        // Traz os finalizados também: eles somem da caixa de entrada, mas
        // continuam no funil e nos contadores. Quem esconde é a tela, não a busca.
        api("/leads?finalizados=1"),
        supervisiona?api("/auth/users"):Promise.resolve(null),
        /* O corretor não pode ler /auth/users, então a disponibilidade DELE só
           chega por aqui. Sem isto a tela dele dizia "indisponível" para sempre,
           mesmo depois de ele se prontificar — e não havia como desligar. */
        supervisiona?Promise.resolve(null):api("/auth/me"),
      ]);
      mesclar(ls);
      if(eq) setEquipe(eq);
      if(eu&&eu.user) setSession(s=>s&&s.available!==!!eu.user.available?{...s,available:!!eu.user.available}:s);
      if(supervisiona) setFila((await api("/leads/queue")).map(l=>adaptLead(l)));
      setErro(""); setVersao(v=>v+1);
    }catch(e){ setErro(e.message); }
  }

  /* Recarrega ao entrar E ao trocar de imobiliária.

     Faltava o `org`: o master escolhia a imobiliária no hub, o crachá era
     trocado, mas esta busca não rodava de novo — a sessão não tinha mudado.
     Resultado: por dez segundos a catraca dele aparecia vazia ("ninguém
     cadastrado"), porque a equipe tinha sido buscada antes de existir
     imobiliária escolhida. Passava sozinho no ciclo seguinte, o que é pior:
     dava para achar que a equipe tinha sumido. */
  useEffect(()=>{ if(!session) return; recarregar();
    api("/integracoes").then(d=>setConecta({connected:!!(d.whatsapp&&d.whatsapp.ok),number:d.whatsapp&&d.whatsapp.numero||""})).catch(()=>{});
    const t=setInterval(()=>{ recarregar(); if(selRef.current) abrir(selRef.current,true); },INTERVALO_ATUALIZACAO);
    return ()=>clearInterval(t);
  },[session,org&&org.id]);

  // Abre a conversa: baixa as mensagens e marca como lida (o backend ignora a marcação
  // quando é a ADM supervisionando lead de outra pessoa).
  async function abrir(id,silencioso){
    if(!silencioso) setSelId(id);
    try{
      const full=await api(`/leads/${id}`);
      setLeads(ant=>{
        const achou=ant.some(l=>l.id===id);
        const atualizado=ant.map(l=>l.id===id?adaptLead(full,l):l);
        return achou?atualizado:[adaptLead(full),...ant];
      });
      if(!silencioso) api(`/leads/${id}/read`,{method:"POST"}).then(()=>recarregar()).catch(()=>{});
    }catch(e){ if(!silencioso) setErro(e.message); }
  }

  const acao=(fn)=>async(...a)=>{ try{ await fn(...a); await recarregar(); if(selRef.current) await abrir(selRef.current,true); }
                                  catch(e){ setErro(e.message); } };

  /* Repasse: igual ao `acao()`, mas olhando a resposta.

     Antes o repasse dizia "ok" tanto para o corretor que recebe aviso no
     celular quanto para o que não recebe nada, e a atendente passava o lead
     achando que alguém tinha sido chamado. Lead entregue a quem não sabe que
     recebeu fica parado exatamente como se não tivesse sido entregue.

     Não é erro — a transferência aconteceu —, então vai numa tarja âmbar, não
     vermelha: é um aviso de que falta combinar por outro canal. */
  const atribuir=(fn)=>async(...a)=>{
    try{
      const r=await fn(...a);
      await recarregar(); if(selRef.current) await abrir(selRef.current,true);
      if(r&&r.aviso&&r.aviso.push===false){
        const quem=(equipe.find(u=>u.id===r.assigned_to)||{}).name;
        setRecado(r.aviso.motivo==="sem_push_no_servidor"
          ?`Lead repassado${quem?" para "+first(quem):""}. O aviso no celular não está ligado nesta instalação — avise por outro canal.`
          :`Lead repassado${quem?" para "+first(quem):""}, mas ${quem?first(quem):"o corretor"} não tem notificação ligada no celular. Ele só vai ver ao abrir o CRM.`);
      } else setRecado("");
    }catch(e){ setErro(e.message); }
  };

  const acoes={
    enviar:acao((leadId,text,replyTo)=>api(`/leads/${leadId}/messages`,{method:"POST",body:{text,reply_to:replyTo||undefined}})),
    /* Editar NÃO passa pelo `acao()`: aquele envelope engole o erro e recarrega
       como se tivesse dado certo. Aqui o erro é a informação mais importante —
       é ele que diz que a mensagem do cliente continua a antiga. */
    editarMensagem:async(leadId,msgId,text)=>{
      await api(`/leads/${leadId}/messages/${msgId}`,{method:"PATCH",body:{text}});
      await recarregar(); await abrir(leadId,true);
    },
    mudarEtapa:acao((leadId,stage)=>api(`/leads/${leadId}/stage`,{method:"PATCH",body:{stage}})),
    renomearLead:acao((leadId,nome)=>api(`/leads/${leadId}/nome`,{method:"PATCH",body:{nome}})),
    /* Tarefas: NÃO passam pelo `acao()`. Aquele envelope engole o erro e
       recarrega a tela inteira; aqui a resposta já traz a lista nova, e o erro
       precisa chegar ao popup para dizer o que faltou preencher. */
    criarTarefa:(leadId,dados)=>api(`/leads/${leadId}/tarefas`,{method:"POST",body:dados}).then(r=>{recarregar();return r;}),
    marcarTarefa:(id,feito)=>api(`/tarefas/${id}`,{method:"PATCH",body:{feito}}).then(r=>{recarregar();return r;}),
    apagarTarefa:(id)=>api(`/tarefas/${id}`,{method:"DELETE"}).then(r=>{recarregar();return r;}),
    registrarVenda:acao((leadId,dados)=>api(`/leads/${leadId}/venda`,{method:"PATCH",body:dados})),
    transferir:atribuir((leadId,userId)=>api("/distribution/transfer",{method:"POST",body:{lead_id:leadId,user_id:userId}})),
    proximo:atribuir((leadId)=>api("/distribution/next",{method:"POST",body:{lead_id:leadId}})),
    repassar:atribuir((leadId,userId)=>api("/distribution/handoff",{method:"POST",body:{lead_id:leadId,...(userId?{user_id:userId}:{})}})),
    assumir:acao((leadId)=>api("/distribution/assumir",{method:"POST",body:{lead_id:leadId}})),
    devolver:acao((leadId,userId)=>api("/distribution/devolver",{method:"POST",body:{lead_id:leadId,...(userId?{user_id:userId}:{})}})),
    /* `extra` leva o ponto da atendente: local e, quando ela está fora, o motivo.

       Não usa o `acao()` comum porque ele engole o erro, e aqui o erro é a
       regra funcionando: se o servidor recusa o ponto sem local, a tela precisa
       dizer isso em vez de fechar o popup como se tivesse dado certo. */
    disponibilidade:async(userId,available,extra)=>{
      try{
        const r=await api("/distribution/availability",{method:"POST",body:{user_id:userId,available,...(extra||{})}});
        await recarregar();
        return r;
      }catch(e){ setErro(e.message); throw e; }
    },
    buscar:(params)=>api("/leads?"+new URLSearchParams(params)).then(r=>r.map(l=>adaptLead(l))),
    // Controle da conversa: encerrar o atendimento e o vai-e-vem do "lida".
    // Aceita {de,ate} — o MESMO intervalo da tela — ou um número de dias.
    score:(p)=>api("/reports/score"+(p&&p.de?`?${new URLSearchParams(p)}`:p?`?dias=${p}`:"")),
    recomendacoes:()=>api("/reports/recomendacoes"),
    assinatura:()=>api("/assinatura"),
    configurarAssinatura:(dados)=>api("/assinatura",{method:"PATCH",body:dados}),
    marcarMensalidadePaga:(dados)=>api("/assinatura/pagar",{method:"POST",body:dados||{}}),
    criarAssinaturaAsaas:(dados)=>api("/assinatura/asaas",{method:"POST",body:dados}),
    pagamentos:()=>api("/assinatura/pagamentos"),
    apagarPagamento:(id)=>api("/assinatura/pagamentos/"+id,{method:"DELETE"}),
    editarPagamento:(id,dados)=>api("/assinatura/pagamentos/"+id,{method:"PATCH",body:dados}),
    reorganizarCobrancas:()=>api("/assinatura/reorganizar",{method:"POST"}),
    gestores:()=>api("/assinatura/gestores"),
    trocarTitular:(user_id)=>api("/assinatura/dono",{method:"POST",body:{user_id}}),
    importarLeads:(dados)=>api("/leads/import",{method:"POST",body:dados}),
    importacoes:()=>api("/leads/importacoes"),
    apagarImportacao:(id,tudo)=>api("/leads/importacoes/"+id+(tudo?"?tudo=1":""),{method:"DELETE"}),
    gruposAntigos:()=>api("/leads/grupos-antigos"),
    apagarGrupoAntigo:(origem,tudo)=>api("/leads/grupos-antigos?origem="+encodeURIComponent(origem)+(tudo?"&tudo=1":""),{method:"DELETE"}),
    // Simulação de financiamento e qualificação do lead.
    simulacoes:(leadId)=>api(`/leads/${leadId}/simulacoes`),
    lerPrint:(leadId,base64,mime)=>api(`/leads/${leadId}/simulacao/ler`,{method:"POST",body:{base64,mime}}),
    salvarSimulacao:acao((leadId,dados)=>api(`/leads/${leadId}/simulacao`,{method:"POST",body:dados})),
    enviarSimulacao:acao((leadId,simId)=>api(`/leads/${leadId}/simulacao/${simId}/enviar`,{method:"POST"})),
    apagarSimulacao:acao((leadId,simId)=>api(`/leads/${leadId}/simulacao/${simId}`,{method:"DELETE"})),
    salvarQualificacao:acao((leadId,campos)=>api(`/leads/${leadId}/qualificacao`,{method:"PATCH",body:campos})),
    /* O CSV precisa do cabeçalho de autenticação, então não dá para usar um
       link simples: baixamos com o token e entregamos o arquivo ao navegador. */
    baixarLeads:async()=>{
      const res=await fetch(API+"/leads/export",{headers:TOKEN?{Authorization:"Bearer "+TOKEN}:{}});
      if(!res.ok) throw new Error("Não consegui gerar a lista.");
      const blob=await res.blob();
      const url=URL.createObjectURL(blob), a=document.createElement("a");
      a.href=url; a.download=`leads-conecta-${new Date().toISOString().slice(0,10)}.csv`;
      document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
    },
    recomendacao:(leadId)=>api(`/reports/recomendacao/${leadId}`),
    // Tentativa de ligação: o discador é do aparelho, então o CRM só consegue
    // registrar que o corretor tentou. Falhar aqui não pode impedir a ligação.
    registrarLigacao:(leadId)=>api(`/leads/${leadId}/ligacao`,{method:"POST"}).catch(()=>null),
    resultadoLigacao:(leadId,ligId,resultado,obs)=>
      api(`/leads/${leadId}/ligacao/${ligId}`,{method:"PATCH",body:{resultado,obs}}),
    pushChave:()=>api("/push/chave"),
    pushSituacao:()=>api("/push/situacao"),
    pushInscrever:(subscription)=>api("/push/inscrever",{method:"POST",body:{subscription}}),
    pushCancelar:(endpoint)=>api("/push/cancelar",{method:"POST",body:{endpoint}}),
    pushTeste:()=>api("/push/teste",{method:"POST"}),
    // Anexos e localização saem pelo número da Conecta, como qualquer mensagem.
    anexar:acao((leadId,arquivos,texto)=>api(`/leads/${leadId}/anexo`,{method:"POST",body:{arquivos,texto}})),
    mandarLocal:acao((leadId,latitude,longitude)=>api(`/leads/${leadId}/localizacao`,{method:"POST",body:{latitude,longitude}})),
    finalizar:acao((leadId)=>api(`/leads/${leadId}/finalizar`,{method:"POST"})),
    reabrir:acao((leadId)=>api(`/leads/${leadId}/reabrir`,{method:"POST"})),
    marcarLida:acao((leadId)=>api(`/leads/${leadId}/read`,{method:"POST"})),
    marcarNaoLida:acao((leadId)=>api(`/leads/${leadId}/nao-lida`,{method:"POST"})),
    equipe:()=>api("/auth/users"),
    decidirCadastro:acao((userId,decisao)=>api(`/auth/users/${userId}/${decisao}`,{method:"POST"})),
    removerDaEquipe:acao((userId,destinoLeads)=>api(`/auth/users/${userId}/remover`,{method:"POST",body:{destino_leads:destinoLeads||null}})),
    mudarFuncao:acao((userId,funcao)=>api(`/auth/users/${userId}/funcao`,{method:"POST",body:{funcao}})),
    /* Fora do `acao()`: aqui a RESPOSTA é o produto — é o link que a gestão vai
       mandar. O envelope descarta o retorno e só recarrega a tela. */
    linkNovaSenha:(userId)=>api(`/auth/users/${userId}/redefinir-senha`,{method:"POST"}),
    produtos:(params)=>api("/produtos?"+new URLSearchParams(params||{})),
    produtoOpcoes:()=>api("/produtos/opcoes"),
    salvarProduto:(dados,id)=>api(id?`/produtos/${id}`:"/produtos",{method:id?"PATCH":"POST",body:dados}),
    situacaoProduto:(id,status)=>api(`/produtos/${id}/status`,{method:"POST",body:{status}}),
    apagarProduto:(id)=>api(`/produtos/${id}`,{method:"DELETE"}),
    subirMidia:(id,mime,base64)=>api(`/produtos/${id}/midias`,{method:"POST",body:{mime,base64}}),
    apagarMidia:(id,midiaId)=>api(`/produtos/${id}/midias/${midiaId}`,{method:"DELETE"}),
    enviarProduto:acao((leadId,corpo)=>api(`/leads/${leadId}/produto`,{method:"POST",body:corpo})),
    // Minha conta: qualquer alteração precisa refletir na sessão na hora — é o
    // nome e a foto que aparecem no topo e assinam as mensagens.
    salvarPerfil:async(dados)=>{
      const d=await api("/auth/me",{method:"PATCH",body:dados});
      if(d.token) setToken(d.token);
      setSession(toSession(d.user));
    },
    trocarSenha:(atual,nova)=>api("/auth/me/senha",{method:"POST",body:{atual,nova}}),
    enviarFoto:async(mime,base64)=>{
      await api("/auth/me/foto",{method:"POST",body:{mime,base64}});
      setSession(toSession((await api("/auth/me")).user));
    },
    removerFoto:async()=>{
      await api("/auth/me/foto",{method:"DELETE"});
      setSession(toSession((await api("/auth/me")).user));
    },
    apagarCadastro:acao((userId)=>api(`/auth/users/${userId}`,{method:"DELETE"})),
    relatorio:(params)=>api("/reports?"+new URLSearchParams(params||{})),
    expediente:()=>api("/distribution/expediente"),
    definirExpediente:(fim)=>api("/distribution/expediente",{method:"PATCH",body:{fim}}),
    historicoDisponibilidade:(params)=>api("/distribution/disponibilidade/historico?"+new URLSearchParams(params||{})),
    ponto:(params)=>api("/reports/ponto?"+new URLSearchParams(params||{})),
    plantoes:(params)=>api("/plantoes?"+new URLSearchParams(params||{})),
    plantaoDeHoje:()=>api("/plantoes/hoje"),
    definirPlantao:(dados)=>api("/plantoes",{method:"PUT",body:dados}),
    importarEscala:(linhas)=>api("/plantoes/importar",{method:"POST",body:{linhas}}),
    subirEscala:(base64,nome)=>api("/plantoes/importar-arquivo",{method:"POST",body:{base64,nome}}),
    apagarEscala:(params)=>api("/plantoes?"+new URLSearchParams(params||{}),{method:"DELETE"}),
    mensagensRapidas:(todas)=>api("/config/mensagens"+(todas?"?todas=1":"")),
    criarMensagem:(dados)=>api("/config/mensagens",{method:"POST",body:dados}),
    editarMensagem2:(id,dados)=>api(`/config/mensagens/${id}`,{method:"PATCH",body:dados}),
    apagarMensagem:(id)=>api(`/config/mensagens/${id}`,{method:"DELETE"}),
    moverMensagem:(id,direcao)=>api(`/config/mensagens/${id}/mover`,{method:"POST",body:{direcao}}),
    conexao:()=>api("/config/conexao"),
    usoDaIA:(dias)=>api(`/config/ia?dias=${dias||30}`),
    desconectarWhats:(confirmar)=>api("/config/conexao/desconectar",{method:"POST",body:{confirmar}}),
    conectarWhats:(host,token)=>api("/config/conexao/credenciais",{method:"POST",body:{host,token}}),
    semResposta:()=>api("/distribution/sem-resposta"),
    definirEspera:(minutos)=>api("/distribution/sem-resposta",{method:"PATCH",body:{minutos}}),
    // Não passa pelo `acao()`: quem chama precisa da RESPOSTA (se o push saiu
    // ou se ficou só marcado no CRM). Mas recarrega assim mesmo, senão o
    // pedido só apareceria na tela no ciclo seguinte.
    cutucar:(id,recado)=>api(`/leads/${id}/cutucar`,{method:"POST",body:{recado}}).then(r=>{recarregar();return r;}),
    viCutucada:(id)=>api(`/leads/${id}/cutucar/vi`,{method:"POST"}),
    reanalise:()=>api("/leads/reanalise"),
    previaTemperatura:(t)=>api("/leads/lote/temperatura?t="+t),
    limparTemperatura:(t)=>api("/leads/lote/temperatura",{method:"POST",body:{temperatura:t}}),
    previaEtapaIA:()=>api("/leads/lote/etapa-ia"),
    rodarEtapaIA:(limite)=>api("/leads/lote/etapa-ia",{method:"POST",body:{limite}}),
    aplicarReanalise:()=>api("/leads/reanalise",{method:"POST"}),
    // Hub de contas (só o master)
    listarContas:()=>api("/orgs"),
    entrarNaConta:(id)=>api(`/orgs/${id}/entrar`,{method:"POST"}),
    criarConta:(dados)=>api("/orgs",{method:"POST",body:dados}),
    renomearConta:(id,dados)=>api(`/orgs/${id}`,{method:"PATCH",body:dados}),
    apagarConta:(id,confirmar)=>api(`/orgs/${id}`,{method:"DELETE",body:{confirmar}}),
    resumoParaApagar:(id)=>api(`/orgs/${id}/apagar`),
    resumirConversa:(id)=>api(`/leads/${id}/resumo`,{method:"POST"}),
    lerEtapaIA:(id)=>api(`/leads/${id}/etapa-ia`,{method:"POST"}),
    abrir,
  };

  function sair(){ setToken(null); marcarOrg(null); setSession(null); setOrg(null); setLeads([]); setFila([]); }

  /* Entra numa imobiliária: o servidor devolve um crachá novo, valendo para
     ela. Recarrega tudo do zero — leads, equipe e conversa aberta são de outra
     casa e não podem sobrar na tela. */
  async function entrarNaConta(id){
    const d=await acoes.entrarNaConta(id);
    setToken(d.token);
    setLeads([]); setFila([]); setEquipe([]); setSelId(null); setAssinatura(null);
    setOrg(d.org); marcarOrg(d.org.id);
    setVersao(v=>v+1);
  }
  const voltarAoHub=()=>{ marcarOrg(null); setOrg(null); setLeads([]); setFila([]); setEquipe([]); setSelId(null); };

  if(carregando) return <Splash/>;
  /* A imobiliária vem junto do login: é dela que sai o código do link de
     cadastro na tela Equipe. O master é a exceção — ele escolhe a casa no hub,
     então continua entrando sem nenhuma. */
  if(!session) return <Auth onLogin={(u,o)=>{setSession(toSession(u));setOrg(u.master?null:(o||null));}}/>;
  /* O master entra pelo hub: ele atende várias imobiliárias e precisa dizer em
     qual vai trabalhar antes de qualquer tela aparecer. Para todo mundo mais
     esta camada não existe. */
  if(session.master&&!org)
    return <HubContas acoes={acoes} session={session} aoEntrar={entrarNaConta} aoSair={sair} isMobile={isMobileRaiz}/>;
  // Bloqueado: o trabalho para, mas a saída (sair, exportar, pagar) continua.
  if(assinatura&&assinatura.status==="bloqueado")
    return <Bloqueado assinatura={assinatura} session={session} acoes={acoes} aoSair={sair}
      aoRever={()=>acoes.assinatura().then(setAssinatura).catch(()=>{})}/>;

  return <Workspace {...{session,setSession:sair,equipe,conecta,leads,fila,acoes,selId,setSelId,erro,setErro,recado,setRecado,versao,assinatura,org,voltarAoHub,plantao}}/>;
}

/* ===== PLANTÃO =====

   Três leituras da mesma escala, porque são três perguntas diferentes:
   HOJE (quem está de sobreaviso agora), SEMANA (o que vem pela frente) e MÊS
   (a lista geral, que é a planilha que a gestão já monta).

   Todo mundo VÊ. Só gestor e atendente MEXEM — montar escala é trabalho de
   gestão, mas saber quem está de plantão amanhã é da operação inteira. */
const TURNOS_ROT = { manha: "Manhã", tarde: "Tarde" };
const DIA_SEMANA = ["Domingo","Segunda","Terça","Quarta","Quinta","Sexta","Sábado"];

function Plantao({acoes,session,pessoas,isMobile,podeEditar}){
  const hoje=new Date(); hoje.setHours(0,0,0,0);
  const [mes,setMes]=useState(()=>({ano:hoje.getFullYear(),mes:hoje.getMonth()}));
  const [aba,setAba]=useState("hoje");
  const [d,setD]=useState(null);
  const [erro,setErro]=useState("");
  const [editando,setEditando]=useState(null);   // {dia, turno}
  const [salvando,setSalvando]=useState(false);
  const arquivo=useRef(null);
  const [importando,setImportando]=useState(false);
  const [resultado,setResultado]=useState(null);
  const [confirmando,setConfirmando]=useState(false);
  const [apagando,setApagando]=useState(false);
  const [recado,setRecado]=useState("");

  const iso=(dt)=>new Date(dt-new Date(dt).getTimezoneOffset()*60000).toISOString().slice(0,10);
  const primeiro=new Date(mes.ano,mes.mes,1).getTime();
  const ultimo=new Date(mes.ano,mes.mes+1,0).getTime();

  const rever=()=>acoes.plantoes({de:iso(primeiro),ate:iso(ultimo)}).then(setD).catch(e=>setErro(e.message));
  useEffect(()=>{rever();},[mes.ano,mes.mes]);

  if(!d) return <div style={{height:"100%",display:"flex",alignItems:"center",justifyContent:"center",color:C.faint,fontSize:13,gap:8}}><Icon n="loader" size={16} spin/> Carregando a escala…</div>;

  /* A escala é indexada pela DATA (dia/mês/ano), não pelo carimbo de tempo.

     O servidor manda a meia-noite no fuso da operação; o aparelho pode estar
     em outro fuso, e aí os dois números nunca batem — a tela mostrava "ninguém
     escalado" num dia que tinha gente. Comparando a data, o dia 04 é o dia 04
     em qualquer relógio. */
  const ymd=(ms)=>{const x=new Date(ms);return `${x.getFullYear()}-${x.getMonth()}-${x.getDate()}`;};
  const porDia=new Map(d.dias.map(x=>[ymd(x.dia),x]));
  const doDia=(ms)=>porDia.get(ymd(ms))||{dia:ms,manha:[],tarde:[]};
  const nomeMes=new Date(mes.ano,mes.mes,1).toLocaleDateString("pt-BR",{month:"long",year:"numeric"});
  // "agosto de 2026" -> "Agosto de 2026". O capitalize do CSS deixaria "De".
  const nomeMesCap=nomeMes.charAt(0).toUpperCase()+nomeMes.slice(1);
  const dd=(ms)=>String(new Date(ms).getDate()).padStart(2,"0");

  // Os 7 dias a partir de hoje — a leitura "o que vem pela frente".
  const semana=Array.from({length:7},(_,i)=>hoje.getTime()+i*86400000);

  async function salvarTurno(dia,turno,ids){
    setSalvando(true); setErro("");
    try{ await acoes.definirPlantao({dia:iso(dia),turno,user_ids:ids}); await rever(); setEditando(null); }
    catch(e){ setErro(e.message); } finally{ setSalvando(false); }
  }

  /* Sobe a planilha da escala — .xlsx direto, do jeito que a gestão monta.

     O arquivo vai cru para o servidor, que sabe abrir os dois formatos. Ler
     .xlsx aqui exigiria embutir uma biblioteca no HTML, e o CRM é um arquivo
     só, sem rede; no servidor o Node já tem o descompactador. */
  async function importar(ev){
    const f=ev.target.files[0]; ev.target.value=""; if(!f) return;
    setErro(""); setResultado(null); setImportando(true);
    try{
      const base64=await new Promise((ok,falhou)=>{const fr=new FileReader();
        fr.onload=()=>ok(String(fr.result).split(",")[1]);fr.onerror=falhou;fr.readAsDataURL(f);});
      const r=await acoes.subirEscala(base64,f.name);
      setResultado(r); await rever();
    }catch(e){ setErro(e.message); }
    finally{ setImportando(false); }
  }

  /* Apaga a escala do mês que está na tela.

     Um mês inteiro de uma vez porque é assim que a escala entra — a planilha é
     mensal. Apagar dia a dia para refazer o mês seria trinta cliques.

     Sempre o mês, mesmo estando na aba Hoje ou Semana: o botão diz qual mês vai
     apagar, e a confirmação repete o número de dias que serão perdidos. */
  async function apagarMes(){
    setApagando(true); setErro("");
    try{
      const r=await acoes.apagarEscala({de:iso(primeiro),ate:iso(ultimo)});
      setResultado(null); setConfirmando(false);
      setRecado(r.apagados?`Escala de ${nomeMes} apagada.`:`Não havia escala em ${nomeMes} para apagar.`);
      await rever();
    }catch(e){ setErro(e.message); }
    finally{ setApagando(false); }
  }

  const cartaoTurno=(dia,turno,compacto)=>{
    const lista=doDia(dia)[turno];
    const editandoEste=editando&&editando.dia===dia&&editando.turno===turno;
    return <div key={turno} style={{flex:1,minWidth:0,background:C.surface,borderRadius:10,padding:"9px 11px"}}>
      <div style={{display:"flex",alignItems:"center",gap:6,marginBottom:5}}>
        <span style={{color:C.faint,fontSize:10,fontWeight:700,textTransform:"uppercase",letterSpacing:.4,flex:1}}>{TURNOS_ROT[turno]}</span>
        {podeEditar&&<button onClick={()=>setEditando(editandoEste?null:{dia,turno})}
          style={{background:"transparent",border:"none",color:C.greenMid,cursor:"pointer",padding:0,display:"flex"}}>
          <Icon n="edit" size={13}/></button>}
      </div>
      {editandoEste
        ?<div style={{display:"flex",flexDirection:"column",gap:5}}>
          {pessoas.map(p=>{
            const marcado=lista.some(x=>x.id===p.id);
            return <button key={p.id} onClick={()=>{
              const ids=marcado?lista.filter(x=>x.id!==p.id).map(x=>x.id):[...lista.map(x=>x.id),p.id];
              salvarTurno(dia,turno,ids);
            }} disabled={salvando}
              style={{display:"flex",alignItems:"center",gap:7,border:`1px solid ${marcado?C.green:C.line}`,
                background:marcado?C.greenSoft:C.card,borderRadius:8,padding:"6px 9px",cursor:"pointer",textAlign:"left"}}>
              <Icon n={marcado?"check":"userplus"} size={12} color={marcado?C.greenDeep:C.faint}/>
              <span style={{color:C.ink,fontSize:12,fontWeight:marcado?700:500}}>{first(p.name)}</span>
            </button>;})}
          <button onClick={()=>setEditando(null)} style={{background:"transparent",border:"none",color:C.faint,fontSize:11,cursor:"pointer",marginTop:2}}>fechar</button>
        </div>
        :lista.length
        ?<div style={{display:"flex",flexWrap:"wrap",gap:5}}>
          {lista.map(x=><span key={x.id} style={{display:"flex",alignItems:"center",gap:5,background:C.card,
            border:`1px solid ${x.id===session.id?C.green:C.line}`,borderRadius:999,padding:"3px 9px 3px 3px"}}>
            <Avatar ini={initials(x.nome||"?")} color={x.id===session.id?C.greenDeep:COLORS[[...x.id].reduce((a,c)=>a+c.charCodeAt(0),0)%COLORS.length]} size={18}/>
            <span style={{color:C.ink,fontSize:11.5,fontWeight:x.id===session.id?700:500}}>{first(x.nome||"—")}</span>
          </span>)}
        </div>
        :<span style={{color:C.faint,fontSize:11.5}}>{compacto?"—":"ninguém escalado"}</span>}
    </div>;
  };

  const linhaDoDia=(ms,destaque)=>{
    const ehHoje=ms===hoje.getTime();
    const souEu=[...doDia(ms).manha,...doDia(ms).tarde].some(x=>x.id===session.id);
    return <div key={ms} style={{background:C.card,border:`1px solid ${souEu?C.green+"66":C.line}`,borderRadius:14,
      padding:isMobile?11:13,marginBottom:8,borderLeft:souEu?`3px solid ${C.green}`:undefined}}>
      <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:8,flexWrap:"wrap"}}>
        <span style={{fontFamily:MONO,color:C.ink,fontSize:14,fontWeight:700}}>{dd(ms)}/{String(new Date(ms).getMonth()+1).padStart(2,"0")}</span>
        <span style={{color:C.sub,fontSize:12.5}}>{DIA_SEMANA[new Date(ms).getDay()]}</span>
        {ehHoje&&<span style={{background:C.greenDeep,color:"#fff",fontSize:10,fontWeight:700,padding:"2px 8px",borderRadius:999}}>HOJE</span>}
        {souEu&&<span style={{background:C.greenSoft,color:C.greenDeep,fontSize:10,fontWeight:700,padding:"2px 8px",borderRadius:999}}>VOCÊ</span>}
      </div>
      <div style={{display:"flex",gap:8,flexDirection:isMobile?"column":"row"}}>
        {cartaoTurno(ms,"manha",!destaque)}{cartaoTurno(ms,"tarde",!destaque)}
      </div>
    </div>;
  };

  return <div style={{height:"100%",overflowY:"auto",padding:isMobile?14:20}}>
    <div style={{maxWidth:860,margin:"0 auto"}}>
      {erro&&<div style={{background:C.hotSoft,color:C.hot,fontSize:12.5,borderRadius:10,padding:"10px 12px",marginBottom:12}}>{erro}</div>}

      {/* O próprio plantão da pessoa, em primeiro lugar. É a informação que ela
          abriu a tela para ver. */}
      <AvisoPlantao meu={d.meu} isMobile={isMobile}/>

      <div style={{display:"flex",gap:6,marginBottom:14,flexWrap:"wrap",alignItems:"center"}}>
        {[["hoje","Hoje"],["semana","Semana"],["mes","Mês"]].map(([k,t])=>
          <button key={k} onClick={()=>setAba(k)}
            style={{fontSize:12.5,fontWeight:600,padding:"7px 14px",borderRadius:999,border:"none",cursor:"pointer",
              background:aba===k?C.greenDeep:C.card,color:aba===k?"#fff":C.sub}}>{t}</button>)}
        {podeEditar&&<React.Fragment>
          <span style={{flex:1}}/>
          <input ref={arquivo} type="file" accept=".xlsx,.xls,.csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv" onChange={importar} style={{display:"none"}}/>
          <button onClick={()=>arquivo.current.click()} disabled={importando}
            style={{display:"flex",alignItems:"center",gap:6,background:C.card,color:C.greenDeep,border:`1px solid ${C.green}55`,
              borderRadius:10,padding:"7px 13px",fontSize:12.5,fontWeight:600,cursor:"pointer"}}>
            <Icon n={importando?"loader":"userplus"} size={14} spin={importando}/>{importando?"Importando…":"Subir escala"}</button>
          <button onClick={()=>{setConfirmando(true);setRecado("");}} disabled={apagando}
            style={{display:"flex",alignItems:"center",gap:6,background:C.card,color:C.hot,border:`1px solid ${C.hot}44`,
              borderRadius:10,padding:"7px 13px",fontSize:12.5,fontWeight:600,cursor:"pointer"}}>
            <Icon n="trash" size={14}/>Apagar escala</button>
        </React.Fragment>}
      </div>

      {/* Apagar é a única ação da tela que não dá para desfazer clicando de
          novo — daí a confirmação escrita, dizendo o mês e quantos dias vão
          embora. Subir a planilha errada e não conseguir limpar era o jeito
          mais fácil de deixar o mês inteiro bagunçado. */}
      {confirmando&&<div style={{background:C.hotSoft,border:`1px solid ${C.hot}44`,borderRadius:12,padding:12,marginBottom:12}}>
        <div style={{color:C.hot,fontSize:13,fontWeight:700,marginBottom:3}}>Apagar a escala de {nomeMes}?</div>
        <div style={{color:C.sub,fontSize:12,lineHeight:1.5,marginBottom:9}}>
          {d.dias.length
            ?<React.Fragment>São <b>{d.dias.length} dia(s)</b> escalados. Some para todo mundo, e só volta subindo a planilha de novo.</React.Fragment>
            :"Este mês está sem nenhuma escala."}
        </div>
        <div style={{display:"flex",gap:7,flexWrap:"wrap"}}>
          <button onClick={apagarMes} disabled={apagando}
            style={{background:C.hot,color:"#fff",border:"none",borderRadius:9,padding:"8px 14px",fontSize:12.5,fontWeight:700,cursor:"pointer"}}>
            {apagando?"Apagando…":"Sim, apagar"}</button>
          <button onClick={()=>setConfirmando(false)} disabled={apagando}
            style={{background:C.card,color:C.sub,border:`1px solid ${C.line}`,borderRadius:9,padding:"8px 14px",fontSize:12.5,fontWeight:600,cursor:"pointer"}}>
            Cancelar</button>
        </div>
      </div>}

      {recado&&<div style={{background:C.surface,border:`1px solid ${C.line}`,borderRadius:12,padding:"10px 12px",marginBottom:12,
        color:C.sub,fontSize:12.5,display:"flex",alignItems:"center",gap:8}}>
        <Icon n="check" size={14} color={C.greenMid}/>{recado}
      </div>}

      {resultado&&<div style={{background:C.greenSoft,border:`1px solid ${C.green}44`,borderRadius:12,padding:12,marginBottom:12}}>
        <div style={{color:C.greenDeep,fontSize:13,fontWeight:700}}>{resultado.dias} dia(s) e {resultado.escalados} escala(s) importados{resultado.arquivo?` — ${resultado.arquivo}`:""}</div>
        {resultado.nao_encontrados.length>0&&<div style={{color:C.sub,fontSize:12,marginTop:4,lineHeight:1.5}}>
          Não identifiquei na equipe: <b>{resultado.nao_encontrados.join(", ")}</b>. Cadastre essas pessoas ou ajuste o nome na planilha.
        </div>}
      </div>}

      {aba==="hoje"&&<React.Fragment>
        {linhaDoDia(hoje.getTime(),true)}
        <div style={{color:C.faint,fontSize:11.5,marginTop:10,lineHeight:1.5}}>
          Quem está escalado recebe um aviso no celular às 08:00 lembrando do plantão.
        </div>
      </React.Fragment>}

      {aba==="semana"&&semana.map(ms=>linhaDoDia(ms,false))}

      {aba==="mes"&&<React.Fragment>
        <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:12}}>
          <button onClick={()=>setMes(m=>m.mes===0?{ano:m.ano-1,mes:11}:{ano:m.ano,mes:m.mes-1})}
            style={{background:C.card,border:`1px solid ${C.line}`,borderRadius:9,padding:"6px 11px",cursor:"pointer",color:C.sub,display:"flex",transform:"scaleX(-1)"}}><Icon n="chevron" size={14}/></button>
          <span style={{color:C.ink,fontFamily:DISPLAY,fontSize:15,fontWeight:700,flex:1,textAlign:"center"}}>{nomeMesCap}</span>
          <button onClick={()=>setMes(m=>m.mes===11?{ano:m.ano+1,mes:0}:{ano:m.ano,mes:m.mes+1})}
            style={{background:C.card,border:`1px solid ${C.line}`,borderRadius:9,padding:"6px 11px",cursor:"pointer",color:C.sub,display:"flex"}}><Icon n="chevron" size={14}/></button>
        </div>
        {Array.from({length:new Date(mes.ano,mes.mes+1,0).getDate()},(_,i)=>new Date(mes.ano,mes.mes,i+1).getTime())
          .map(ms=>linhaDoDia(ms,false))}
      </React.Fragment>}
    </div>
  </div>;
}

/* Lembrete do plantão. Vai no topo do painel de quem atende e também na
   própria tela da escala: no dia, é a primeira coisa que a pessoa precisa
   saber ao abrir o sistema. */
function AvisoPlantao({meu,isMobile,compacto}){
  if(!meu) return null;
  const hoje=meu.hoje;
  const turnos=meu.turnos.map(t=>TURNOS_ROT[t].toLowerCase()).join(" e ");
  const quando=hoje?"Hoje é seu dia de plantão"
    :meu.faltam===1?"Amanhã é seu dia de plantão"
    :`Seu próximo plantão é em ${meu.faltam} dias`;
  const data=new Date(meu.dia).toLocaleDateString("pt-BR",{day:"2-digit",month:"2-digit"});
  return <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:compacto?12:14,
    background:hoje?C.greenDeep:C.greenSoft,color:hoje?"#fff":C.greenDeep,
    border:hoje?"none":`1px solid ${C.green}44`,borderRadius:13,padding:isMobile?"11px 13px":"12px 15px"}}>
    <Icon n="calendar" size={17}/>
    <div style={{flex:1,minWidth:0}}>
      <div style={{fontSize:13.5,fontWeight:700}}>{quando}</div>
      <div style={{fontSize:11.5,opacity:.85}}>{DIA_SEMANA[new Date(meu.dia).getDay()]}, {data} · turno da {turnos}</div>
    </div>
  </div>;
}

/* ===== HUB DE CONTAS =====
   A tela que abre quando o gestor master entra: em qual imobiliária ele vai
   trabalhar agora. Ninguém mais chega aqui — o servidor recusa (403) e o
   frontend nem desenha.

   Cada cartão mostra o que decide a escolha em dois segundos: tamanho da
   equipe, leads na fila, quem tem cadastro esperando aprovação e a situação da
   mensalidade. */
function HubContas({acoes,session,aoEntrar,aoSair,isMobile}){
  const [contas,setContas]=useState(null);
  const [erro,setErro]=useState("");
  const [ocupado,setOcupado]=useState("");
  const [criando,setCriando]=useState(false);
  const [nova,setNova]=useState({nome:"",codigo:""});
  const [copiado,setCopiado]=useState("");
  /* Apagar um cliente da plataforma. Fica atrás de um clique a mais, mostra o
     que vai sumir e exige o nome digitado: é a única ação daqui que destrói a
     operação inteira de alguém, e não tem desfazer. */
  const [apagando,setApagando]=useState(null);   // {id, resumo}
  const [nomeDigitado,setNomeDigitado]=useState("");
  const [apagada,setApagada]=useState("");

  const rever=()=>acoes.listarContas().then(d=>setContas(d.orgs||[])).catch(e=>{setErro(e.message);setContas([]);});

  async function abrirExclusao(c){
    setErro(""); setNomeDigitado(""); setApagada("");
    if(apagando&&apagando.id===c.id) return setApagando(null);
    try{ setApagando({id:c.id,resumo:await acoes.resumoParaApagar(c.id)}); }
    catch(e){ setErro(e.message); }
  }
  async function apagarDeVez(c){
    setOcupado("apagar"); setErro("");
    try{
      const r=await acoes.apagarConta(c.id,nomeDigitado.trim());
      setApagando(null); setNomeDigitado("");
      setApagada(`${r.apagada} foi apagada — ${r.leads} lead(s), ${r.equipe} pessoa(s) e ${r.arquivos} arquivo(s).`);
      await rever();
    }catch(e){ setErro(e.message); }
    finally{ setOcupado(""); }
  }
  useEffect(()=>{rever();},[]);

  const entrar=async(c)=>{ setErro(""); setOcupado(c.id);
    try{ await aoEntrar(c.id); }catch(e){ setErro(e.message); setOcupado(""); } };

  const criar=async()=>{ setErro(""); setOcupado("nova");
    try{ await acoes.criarConta(nova); setNova({nome:"",codigo:""}); setCriando(false); await rever(); }
    catch(e){ setErro(e.message); } finally{ setOcupado(""); } };

  const copiar=(c)=>{ try{ navigator.clipboard.writeText(c.link_cadastro);
    setCopiado(c.id); setTimeout(()=>setCopiado(""),1800); }catch(e){} };

  const CORES={ativo:C.greenMid,vence_em_breve:C.amber,atrasado:C.hot,bloqueado:C.hot};
  const ROTULOS={ativo:"Em dia",vence_em_breve:"Vence em breve",atrasado:"Em atraso",bloqueado:"Bloqueado"};
  const entrada={width:"100%",boxSizing:"border-box",fontSize:isMobile?16:13.5,border:`1px solid ${C.line}`,
    background:C.surface,borderRadius:10,padding:"11px 12px",color:C.ink,outline:"none"};

  return <div style={{fontFamily:FONT,background:C.surface,minHeight:"100dvh",padding:isMobile?"18px 14px 40px":"32px 24px"}}>
    <div style={{maxWidth:900,margin:"0 auto"}}>
      <div style={{display:"flex",alignItems:"center",gap:12,marginBottom:isMobile?18:26,flexWrap:"wrap"}}>
        <Brand size={isMobile?38:44}/>
        <div style={{flex:1}}/>
        <div style={{textAlign:"right"}}>
          <div style={{color:C.ink,fontSize:12.5,fontWeight:600,lineHeight:1}}>{session.name}</div>
          <div style={{color:C.faint,fontSize:10.5}}>ConHub · master</div>
        </div>
        <button onClick={aoSair} title="Sair" style={{width:34,height:34,borderRadius:10,border:`1px solid ${C.line}`,background:C.card,color:C.sub,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center"}}>
          <Icon n="logout" size={16}/></button>
      </div>

      <div style={{fontFamily:DISPLAY,color:C.ink,fontSize:isMobile?20:25,fontWeight:700,marginBottom:4}}>Suas imobiliárias</div>
      <div style={{color:C.sub,fontSize:13,marginBottom:18,lineHeight:1.5}}>
        Escolha em qual conta você vai trabalhar. A equipe de cada uma não enxerga esta tela — nem você dentro dela.
      </div>

      {erro&&<div style={{background:C.hotSoft,color:C.hot,fontSize:12.5,borderRadius:10,padding:"10px 12px",marginBottom:14}}>{erro}</div>}
      {apagada&&<div style={{background:C.greenSoft,color:C.greenDeep,fontSize:12.5,borderRadius:10,padding:"10px 12px",marginBottom:14}}>{apagada}</div>}

      {contas===null
        ?<div style={{color:C.faint,fontSize:13,padding:20,textAlign:"center"}}>Carregando…</div>
        :<div style={{display:"grid",gridTemplateColumns:isMobile?"1fr":"repeat(auto-fill,minmax(270px,1fr))",gap:12}}>
          {contas.map(c=><div key={c.id} style={{background:C.card,border:`1px solid ${C.line}`,borderRadius:16,padding:15,display:"flex",flexDirection:"column",gap:11}}>
            <div style={{display:"flex",alignItems:"flex-start",gap:9}}>
              <div style={{background:C.greenSoft,width:38,height:38,borderRadius:11,display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}>
                <Icon n="pin" size={18} color={C.greenDeep}/></div>
              <div style={{flex:1,minWidth:0}}>
                <div style={{fontFamily:DISPLAY,color:C.ink,fontSize:15.5,fontWeight:700,lineHeight:1.2}}>{c.nome}</div>
                <div style={{color:C.faint,fontSize:10.5,fontFamily:MONO,marginTop:2}}>{c.codigo}</div>
              </div>
              {c.assinatura.cobranca&&<span style={{background:CORES[c.assinatura.status]+"18",color:CORES[c.assinatura.status],
                fontSize:10,fontWeight:700,padding:"3px 8px",borderRadius:999,whiteSpace:"nowrap",flexShrink:0}}>
                {ROTULOS[c.assinatura.status]}</span>}
            </div>

            <div style={{display:"flex",gap:14,flexWrap:"wrap"}}>
              {[["Equipe",c.equipe],["Leads",c.leads],["Na fila",c.na_fila]].map(([t,v])=>
                <div key={t}><div style={{fontFamily:MONO,color:C.ink,fontSize:17,fontWeight:700,lineHeight:1}}>{v}</div>
                  <div style={{color:C.faint,fontSize:10}}>{t}</div></div>)}
            </div>

            {/* Cadastro parado esperando aprovação é gente sem acesso ao
                trabalho — é o que mais merece o clique agora. */}
            {c.pendentes>0&&<div style={{background:C.amberSoft,color:"#8a6d1f",fontSize:11.5,fontWeight:600,borderRadius:8,padding:"6px 9px",display:"flex",alignItems:"center",gap:6}}>
              <Icon n="clock" size={12}/>{c.pendentes} cadastro(s) aguardando aprovação</div>}

            <div style={{display:"flex",gap:7,marginTop:"auto"}}>
              <button onClick={()=>entrar(c)} disabled={!!ocupado}
                style={{flex:1,background:ocupado===c.id?C.faint:C.greenDeep,color:"#fff",border:"none",borderRadius:11,padding:"12px",
                  fontSize:13.5,fontWeight:600,cursor:ocupado?"default":"pointer",display:"flex",alignItems:"center",justifyContent:"center",gap:7}}>
                {ocupado===c.id?"Entrando…":<React.Fragment>Entrar <Icon n="arrow" size={15}/></React.Fragment>}</button>
              <button onClick={()=>copiar(c)} title="Copiar o link de cadastro da equipe"
                style={{background:copiado===c.id?C.greenSoft:C.surface,color:copiado===c.id?C.greenDeep:C.sub,
                  border:`1px solid ${copiado===c.id?C.green+"66":C.line}`,borderRadius:11,padding:"0 12px",fontSize:11.5,fontWeight:600,cursor:"pointer",whiteSpace:"nowrap"}}>
                {copiado===c.id?"copiado!":<Icon n="link" size={15}/>}</button>
              <button onClick={()=>abrirExclusao(c)} title="Apagar esta imobiliária da plataforma"
                style={{background:apagando&&apagando.id===c.id?C.hotSoft:C.surface,color:C.hot,
                  border:`1px solid ${apagando&&apagando.id===c.id?C.hot+"66":C.line}`,borderRadius:11,
                  padding:"0 12px",cursor:"pointer",display:"flex",alignItems:"center"}}>
                <Icon n="trash" size={15}/></button>
            </div>

            {apagando&&apagando.id===c.id&&<div style={{background:C.hotSoft,border:`1px solid ${C.hot}44`,borderRadius:12,padding:12}}>
              <div style={{color:C.hot,fontSize:12.5,fontWeight:700,marginBottom:5}}>Apagar {c.nome} da plataforma?</div>
              <div style={{color:C.sub,fontSize:11.5,lineHeight:1.55,marginBottom:8}}>
                Some para sempre, sem desfazer:
                <b> {apagando.resumo.leads} lead(s)</b>, <b>{apagando.resumo.mensagens} mensagem(ns)</b>,
                <b> {apagando.resumo.equipe} pessoa(s)</b>, <b>{apagando.resumo.imoveis} imóvel(is)</b> com as fotos
                e <b>{apagando.resumo.pagamentos} pagamento(s)</b> do histórico.
                {apagando.resumo.unica&&<div style={{marginTop:6,fontWeight:600}}>Esta é a única imobiliária cadastrada — o sistema não deixa apagar.</div>}
              </div>
              <div style={{color:C.sub,fontSize:11.5,marginBottom:5}}>Digite <b>{c.nome}</b> para confirmar:</div>
              <input value={nomeDigitado} onChange={e=>setNomeDigitado(e.target.value)} placeholder={c.nome}
                disabled={apagando.resumo.unica}
                style={{...entrada,marginBottom:8}}/>
              <div style={{display:"flex",gap:7,flexWrap:"wrap"}}>
                <button onClick={()=>apagarDeVez(c)} disabled={ocupado==="apagar"||apagando.resumo.unica||nomeDigitado.trim()!==c.nome}
                  style={{background:nomeDigitado.trim()===c.nome&&!apagando.resumo.unica?C.hot:C.faint,color:"#fff",border:"none",
                    borderRadius:9,padding:"9px 15px",fontSize:12.5,fontWeight:700,cursor:"pointer"}}>
                  {ocupado==="apagar"?"Apagando…":"Apagar definitivamente"}</button>
                <button onClick={()=>{setApagando(null);setNomeDigitado("");}} disabled={ocupado==="apagar"}
                  style={{background:C.card,color:C.sub,border:`1px solid ${C.line}`,borderRadius:9,padding:"9px 14px",fontSize:12.5,fontWeight:600,cursor:"pointer"}}>Cancelar</button>
              </div>
            </div>}
          </div>)}

          {/* Cadastrar cliente novo. É por aqui que a segunda imobiliária entra:
              o código gerado vira o link que a equipe dela usa para se cadastrar. */}
          {criando
            ?<div style={{background:C.card,border:`1px dashed ${C.green}66`,borderRadius:16,padding:15,display:"flex",flexDirection:"column",gap:10}}>
              <div style={{color:C.ink,fontSize:13.5,fontWeight:700}}>Nova imobiliária</div>
              <div>
                <div style={{color:C.faint,fontSize:11,fontWeight:600,marginBottom:4}}>Nome</div>
                <input value={nova.nome} onChange={e=>setNova({...nova,nome:e.target.value})} placeholder="Horizonte Imóveis" style={entrada}/>
              </div>
              <div>
                <div style={{color:C.faint,fontSize:11,fontWeight:600,marginBottom:4}}>Código (opcional)</div>
                <input value={nova.codigo} onChange={e=>setNova({...nova,codigo:e.target.value})} placeholder="deixe em branco para gerar" style={entrada}/>
                <div style={{color:C.faint,fontSize:10.5,marginTop:3,lineHeight:1.45}}>É a trava do cadastro e vai embutida no link que a equipe recebe.</div>
              </div>
              <div style={{display:"flex",gap:7}}>
                <button onClick={criar} disabled={ocupado==="nova"||nova.nome.trim().length<2}
                  style={{flex:1,background:nova.nome.trim().length<2?C.faint:C.green,color:"#fff",border:"none",borderRadius:11,padding:"11px",fontSize:13,fontWeight:600,cursor:"pointer"}}>
                  {ocupado==="nova"?"Criando…":"Criar"}</button>
                <button onClick={()=>{setCriando(false);setErro("");}}
                  style={{background:C.surface,color:C.sub,border:`1px solid ${C.line}`,borderRadius:11,padding:"11px 16px",fontSize:13,fontWeight:600,cursor:"pointer"}}>Cancelar</button>
              </div>
            </div>
            :<button onClick={()=>setCriando(true)}
              style={{background:"transparent",border:`1px dashed ${C.line}`,borderRadius:16,padding:20,cursor:"pointer",
                display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",gap:7,color:C.sub,minHeight:130}}>
              <Icon n="userplus" size={22}/>
              <span style={{fontSize:13.5,fontWeight:600}}>Cadastrar imobiliária</span>
              <span style={{fontSize:11,color:C.faint}}>um cliente novo na plataforma</span>
            </button>}
        </div>}
    </div>
  </div>;
}

/* ===== MENSALIDADE ===== */
/* Painel da assinatura, dentro de Minha conta e só para o gestor.
   Existe para você não precisar mexer no banco nem no painel do Asaas para as
   coisas do dia a dia: ver como está, dar baixa num pagamento por fora e
   ajustar o vencimento. */
/* Painel da mensalidade.

   Só aparece para o TITULAR da conta. Pode haver outro gestor com acesso total
   ao CRM — o que ele paga, quanto e quando não é assunto dele. O servidor
   recusa do mesmo jeito (403); esconder aqui é só não mostrar porta trancada. */
function PainelAssinatura({acoes,isMobile}){
  const [a,setA]=useState(null);
  const [f,setF]=useState({plano:"",valor_mensal:"",vence_em:"",dias_carencia:5});
  const [novo,setNovo]=useState({nome:"",cpfCnpj:"",email:"",telefone:"",valor:"",vencimento:""});
  const [ocupado,setOcupado]=useState("");
  const [aviso,setAviso]=useState(null);
  const [pagos,setPagos]=useState(null);
  const [lancar,setLancar]=useState(null);     // formulário de baixa manual aberto
  const [editando,setEditando]=useState(null); // id do pagamento em edição
  const [rascunho,setRascunho]=useState({pago_em:"",valor:""});
  const [confirmar,setConfirmar]=useState(null);

  const hoje=()=>new Date().toISOString().slice(0,10);
  const paraInput=(ms)=>ms?new Date(ms-new Date(ms).getTimezoneOffset()*60000).toISOString().slice(0,10):"";

  const rever=()=>acoes.assinatura().then(d=>{
    setA(d);
    if(!d.dono) return;
    setF({plano:d.plano||"",valor_mensal:d.valor||"",
      vence_em:paraInput(d.vence_em),
      dias_carencia:d.carencia==null?5:d.carencia});
    acoes.pagamentos().then(p=>setPagos(p.pagamentos||[])).catch(()=>setPagos([]));
  }).catch(()=>{});
  useEffect(()=>{rever();},[]);
  if(!a||!a.dono) return null;

  const CORES={ativo:C.green,vence_em_breve:C.amber,atrasado:C.hot,bloqueado:C.hot};
  const ROTULOS={ativo:"Em dia",vence_em_breve:"Vence em breve",atrasado:"Em atraso",bloqueado:"Bloqueado"};
  const roda=(nome,fn)=>async()=>{ setAviso(null); setOcupado(nome);
    try{ await fn(); await rever(); }catch(e){ setAviso({ok:false,txt:e.message}); } finally{ setOcupado(""); } };

  const caixa={background:C.card,border:`1px solid ${C.line}`,borderRadius:14,padding:16,display:"flex",flexDirection:"column",gap:12};
  const entrada={width:"100%",boxSizing:"border-box",fontSize:isMobile?16:13.5,border:`1px solid ${C.line}`,
    background:C.surface,borderRadius:10,padding:"11px 12px",color:C.ink,outline:"none"};
  const rot=(t)=><div style={{color:C.faint,fontSize:11,fontWeight:600,marginBottom:4}}>{t}</div>;

  return <div style={caixa}>
    <div style={{display:"flex",alignItems:"center",gap:8,flexWrap:"wrap"}}>
      <Icon n="award" size={15} color={C.greenMid}/>
      <span style={{color:C.ink,fontSize:13.5,fontWeight:700,flex:1}}>Mensalidade do sistema</span>
      {a.cobranca&&<span style={{background:CORES[a.status]+"18",color:CORES[a.status],fontSize:11,fontWeight:700,padding:"3px 10px",borderRadius:999}}>
        {ROTULOS[a.status]}</span>}
    </div>

    {!a.cobranca
      ?<div style={{color:C.sub,fontSize:12.5,lineHeight:1.5}}>Nenhuma cobrança configurada — o sistema está liberado. Defina um vencimento abaixo para ligar o controle.</div>
      :<div style={{color:C.sub,fontSize:12.5,lineHeight:1.7}}>
        <div>Vencimento: <b style={{color:C.ink}}>{fmtData(a.vence_em)}</b></div>
        {a.valor?<div>Valor: <b style={{color:C.ink}}>{fmtMoeda(a.valor)}</b></div>:null}
        {a.ultimo_pagamento_em?<div>Último pagamento: {fmtData(a.ultimo_pagamento_em)}</div>:null}
        <div style={{color:C.faint,fontSize:11.5,marginTop:3}}>Bloqueia {a.carencia} dia(s) depois do vencimento.</div>
      </div>}

    {aviso&&<div style={{fontSize:12.5,padding:"9px 11px",borderRadius:9,lineHeight:1.45,
      color:aviso.ok?C.greenDeep:C.hot,background:aviso.ok?C.greenSoft:C.hotSoft}}>{aviso.txt}</div>}

    <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
      <div style={{flex:"1 1 130px"}}>{rot("Plano")}<input value={f.plano} onChange={e=>setF({...f,plano:e.target.value})} placeholder="ConHub Mensal" style={entrada}/></div>
      <div style={{flex:"1 1 110px"}}>{rot("Valor (R$)")}<input value={f.valor_mensal} onChange={e=>setF({...f,valor_mensal:e.target.value})} inputMode="decimal" placeholder="297" style={entrada}/></div>
      <div style={{flex:"1 1 140px"}}>{rot("Próximo vencimento")}<input type="date" value={f.vence_em} onChange={e=>setF({...f,vence_em:e.target.value})} style={entrada}/></div>
      <div style={{flex:"1 1 110px"}}>{rot("Carência (dias)")}<input value={f.dias_carencia} onChange={e=>setF({...f,dias_carencia:e.target.value})} inputMode="numeric" style={entrada}/></div>
    </div>

    <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
      <button onClick={roda("salvar",()=>acoes.configurarAssinatura(f))} disabled={!!ocupado}
        style={{flex:1,background:C.greenDeep,color:"#fff",border:"none",borderRadius:10,padding:"12px",fontSize:13.5,fontWeight:600,cursor:"pointer"}}>
        {ocupado==="salvar"?"Salvando…":"Salvar"}</button>
      <button onClick={()=>{setAviso(null);setLancar(lancar?null:{pago_em:hoje(),valor:a.valor||"",obs:""});}} disabled={!!ocupado}
        style={{flex:1,background:C.surface,color:C.greenDeep,border:`1px solid ${C.green}55`,borderRadius:10,padding:"12px",fontSize:13.5,fontWeight:600,cursor:"pointer"}}>
        {lancar?"Cancelar":"Registrar pagamento"}</button>
    </div>

    {/* Baixa manual com data: dá para lançar mês antigo que ficou para trás,
        em vez de ter que corrigir o vencimento na unha depois. */}
    {lancar&&<div style={{background:C.surface,border:`1px solid ${C.line}`,borderRadius:12,padding:12,display:"flex",flexDirection:"column",gap:9}}>
      <div style={{color:C.ink,fontSize:12.5,fontWeight:700}}>Lançar pagamento</div>
      <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
        <div style={{flex:"1 1 140px"}}>{rot("Pago em")}<input type="date" value={lancar.pago_em} onChange={e=>setLancar({...lancar,pago_em:e.target.value})} style={entrada}/></div>
        <div style={{flex:"1 1 110px"}}>{rot("Valor (R$)")}<input value={lancar.valor} onChange={e=>setLancar({...lancar,valor:e.target.value})} inputMode="decimal" style={entrada}/></div>
        <div style={{flex:"1 1 160px"}}>{rot("Observação")}<input value={lancar.obs} onChange={e=>setLancar({...lancar,obs:e.target.value})} placeholder="Pix, cortesia…" style={entrada}/></div>
      </div>
      <button onClick={roda("pagar",async()=>{ await acoes.marcarMensalidadePaga(lancar); setLancar(null); })} disabled={!!ocupado}
        style={{background:C.green,color:"#fff",border:"none",borderRadius:10,padding:"11px",fontSize:13.5,fontWeight:600,cursor:"pointer"}}>
        {ocupado==="pagar"?"Registrando…":"Confirmar pagamento"}</button>
      <div style={{color:C.faint,fontSize:11,lineHeight:1.5}}>Cada pagamento vale um mês. O vencimento é recalculado sozinho.</div>
    </div>}

    {/* Histórico. É o que faltava: sem ele, um clique errado no "Registrar
        pagamento" empurrava o vencimento um mês e não havia como desfazer. */}
    <div style={{borderTop:`1px solid ${C.line}`,paddingTop:12}}>
      <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:8}}>
        <span style={{color:C.ink,fontSize:12.5,fontWeight:700,flex:1}}>Pagamentos registrados</span>
        {pagos&&pagos.length>0&&<button onClick={roda("reorg",()=>acoes.reorganizarCobrancas().then(r=>{setPagos(r.pagamentos||[]);setAviso({ok:true,txt:"Cobranças reorganizadas — vencimento recalculado a partir dos pagamentos."});}))}
          disabled={!!ocupado} title="Recalcula o vencimento a partir dos pagamentos registrados"
          style={{background:"transparent",color:C.greenMid,border:`1px solid ${C.green}44`,borderRadius:8,padding:"5px 10px",fontSize:11.5,fontWeight:600,cursor:"pointer"}}>
          {ocupado==="reorg"?"Reorganizando…":"Reorganizar"}</button>}
      </div>

      {pagos===null?<div style={{color:C.faint,fontSize:12}}>Carregando…</div>
      :pagos.length===0?<div style={{color:C.faint,fontSize:11.5,lineHeight:1.5}}>Nenhum pagamento registrado ainda.</div>
      :<div style={{display:"flex",flexDirection:"column",gap:6}}>
        {pagos.map(p=>editando===p.id
          ?<div key={p.id} style={{background:C.surface,border:`1px solid ${C.green}55`,borderRadius:10,padding:10,display:"flex",flexDirection:"column",gap:8}}>
            <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
              <div style={{flex:"1 1 130px"}}>{rot("Pago em")}<input type="date" value={rascunho.pago_em} onChange={e=>setRascunho({...rascunho,pago_em:e.target.value})} style={entrada}/></div>
              <div style={{flex:"1 1 100px"}}>{rot("Valor (R$)")}<input value={rascunho.valor} onChange={e=>setRascunho({...rascunho,valor:e.target.value})} inputMode="decimal" style={entrada}/></div>
            </div>
            <div style={{display:"flex",gap:8}}>
              <button onClick={roda("edit",async()=>{ const r=await acoes.editarPagamento(p.id,rascunho); setPagos(r.pagamentos||[]); setEditando(null); })} disabled={!!ocupado}
                style={{flex:1,background:C.greenDeep,color:"#fff",border:"none",borderRadius:9,padding:"9px",fontSize:12.5,fontWeight:600,cursor:"pointer"}}>Salvar</button>
              <button onClick={()=>setEditando(null)}
                style={{flex:1,background:"transparent",color:C.sub,border:`1px solid ${C.line}`,borderRadius:9,padding:"9px",fontSize:12.5,fontWeight:600,cursor:"pointer"}}>Cancelar</button>
            </div>
          </div>
          :<div key={p.id} style={{display:"flex",alignItems:"center",gap:9,background:C.surface,borderRadius:10,padding:"9px 11px"}}>
            <div style={{flex:1,minWidth:0}}>
              <div style={{color:C.ink,fontSize:12.5,fontWeight:600}}>
                {fmtData(p.pago_em)}{p.valor!=null?` · ${fmtMoeda(p.valor)}`:""}</div>
              <div style={{color:C.faint,fontSize:10.5}}>
                {p.origem==="asaas"?"Confirmado pelo Asaas":"Lançado manualmente"}{p.obs?` · ${p.obs}`:""}</div>
            </div>
            <button onClick={()=>{setEditando(p.id);setRascunho({pago_em:paraInput(p.pago_em),valor:p.valor??""});}}
              title="Corrigir data ou valor" style={{background:"transparent",border:"none",color:C.sub,cursor:"pointer",padding:4,display:"flex"}}>
              <Icon n="edit" size={15}/></button>
            <button onClick={()=>setConfirmar(p)} title="Apagar este pagamento"
              style={{background:"transparent",border:"none",color:C.hot,cursor:"pointer",padding:4,display:"flex"}}>
              <Icon n="trash" size={15}/></button>
          </div>)}
      </div>}

      {/* Apagar mexe na data de vencimento. Confirmar dizendo o que vai
          acontecer evita o susto de ver o sistema bloquear depois. */}
      {confirmar&&<div style={{marginTop:9,background:C.hotSoft,border:`1px solid ${C.hot}44`,borderRadius:11,padding:11}}>
        <div style={{color:C.hot,fontSize:12.5,fontWeight:700,marginBottom:4}}>Apagar o pagamento de {fmtData(confirmar.pago_em)}?</div>
        <div style={{color:C.sub,fontSize:11.5,lineHeight:1.5,marginBottom:9}}>
          O vencimento volta um mês — de {fmtData(a.vence_em)} para {fmtData(new Date(new Date(a.vence_em).setMonth(new Date(a.vence_em).getMonth()-1)).getTime())}.
        </div>
        <div style={{display:"flex",gap:8}}>
          <button onClick={roda("apagar",async()=>{ const r=await acoes.apagarPagamento(confirmar.id); setPagos(r.pagamentos||[]); setConfirmar(null); })} disabled={!!ocupado}
            style={{flex:1,background:C.hot,color:"#fff",border:"none",borderRadius:9,padding:"10px",fontSize:12.5,fontWeight:600,cursor:"pointer"}}>
            {ocupado==="apagar"?"Apagando…":"Apagar"}</button>
          <button onClick={()=>setConfirmar(null)}
            style={{flex:1,background:C.card,color:C.sub,border:`1px solid ${C.line}`,borderRadius:9,padding:"10px",fontSize:12.5,fontWeight:600,cursor:"pointer"}}>Cancelar</button>
        </div>
      </div>}
    </div>

    {/* Cobrança automática. Sem a chave no servidor, o painel diz o que falta em
        vez de mostrar um formulário que não vai funcionar. */}
    <div style={{borderTop:`1px solid ${C.line}`,paddingTop:12}}>
      <div style={{color:C.ink,fontSize:12.5,fontWeight:700,marginBottom:6}}>Cobrança automática (Asaas)</div>
      {!a.asaas
        ?<div style={{color:C.faint,fontSize:11.5,lineHeight:1.5}}>Não configurada no servidor. Falta a variável <b>ASAAS_API_KEY</b>. Enquanto isso, use o "Registrar pagamento" acima.</div>
        :a.link||a.valor&&a.vence_em&&a.ultimo_pagamento_em!==undefined&&a.status!=="bloqueado"&&false
        ?null
        :<React.Fragment>
          <div style={{color:C.faint,fontSize:11.5,marginBottom:9,lineHeight:1.5}}>
            Ambiente: <b>{a.ambiente}</b>. Cria o cliente e a assinatura mensal no Asaas — o cliente recebe a cobrança e escolhe entre Pix, boleto ou cartão.
          </div>
          <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
            <div style={{flex:"1 1 150px"}}>{rot("Nome do responsável")}<input value={novo.nome} onChange={e=>setNovo({...novo,nome:e.target.value})} style={entrada}/></div>
            <div style={{flex:"1 1 130px"}}>{rot("CPF ou CNPJ")}<input value={novo.cpfCnpj} onChange={e=>setNovo({...novo,cpfCnpj:e.target.value})} inputMode="numeric" style={entrada}/></div>
            <div style={{flex:"1 1 150px"}}>{rot("E-mail")}<input value={novo.email} onChange={e=>setNovo({...novo,email:e.target.value})} type="email" style={entrada}/></div>
            <div style={{flex:"1 1 130px"}}>{rot("WhatsApp")}<input value={novo.telefone} onChange={e=>setNovo({...novo,telefone:e.target.value})} inputMode="tel" style={entrada}/></div>
            <div style={{flex:"1 1 110px"}}>{rot("Valor (R$)")}<input value={novo.valor} onChange={e=>setNovo({...novo,valor:e.target.value})} inputMode="decimal" style={entrada}/></div>
            <div style={{flex:"1 1 140px"}}>{rot("1º vencimento")}<input type="date" value={novo.vencimento} onChange={e=>setNovo({...novo,vencimento:e.target.value})} style={entrada}/></div>
          </div>
          <button onClick={roda("asaas",()=>acoes.criarAssinaturaAsaas(novo))} disabled={!!ocupado}
            style={{width:"100%",marginTop:9,background:C.green,color:"#fff",border:"none",borderRadius:10,padding:"12px",fontSize:13.5,fontWeight:600,cursor:"pointer"}}>
            {ocupado==="asaas"?"Criando…":"Criar assinatura no Asaas"}</button>
        </React.Fragment>}
    </div>
  </div>;
}

// fmtData já existe lá em cima, junto dos outros formatadores de data.

/* Tela de bloqueio. Três cuidados que valem mais que o aviso em si:
   o corretor não pode achar que o sistema quebrou, precisa saber o que fazer,
   e a base de clientes continua acessível — prender alguém fora dos próprios
   dados é briga que não vale a pena comprar. */
function Bloqueado({assinatura,session,acoes,aoSair,aoRever}){
  const [baixando,setBaixando]=useState(false);
  const gestor=session.role==="adm";
  return <div style={{fontFamily:FONT,background:C.surface,minHeight:"100dvh",display:"flex",alignItems:"center",justifyContent:"center",padding:20}}>
    <div style={{background:C.card,border:`1px solid ${C.line}`,borderRadius:18,padding:24,maxWidth:440,width:"100%"}}>
      <div style={{width:44,height:44,borderRadius:13,background:C.hotSoft,display:"flex",alignItems:"center",justifyContent:"center",marginBottom:14}}>
        <Icon n="lock" size={21} color={C.hot}/></div>
      <div style={{fontFamily:DISPLAY,color:C.ink,fontSize:20,fontWeight:700,marginBottom:8}}>Acesso suspenso</div>
      <div style={{color:C.sub,fontSize:13.5,lineHeight:1.6,marginBottom:16}}>
        {assinatura.motivo||"Mensalidade em atraso."}{" "}
        {gestor
          ?"Assim que o pagamento for confirmado, o sistema volta sozinho — não precisa avisar ninguém."
          :"Fale com a gestão da imobiliária. Assim que a mensalidade for regularizada, tudo volta ao normal."}
      </div>
      <div style={{background:C.surface,borderRadius:11,padding:12,marginBottom:16,fontSize:12.5,color:C.sub,lineHeight:1.7}}>
        <div><b style={{color:C.ink}}>Venceu em:</b> {fmtData(assinatura.vence_em)}</div>
        {assinatura.valor?<div><b style={{color:C.ink}}>Valor:</b> {fmtMoeda(assinatura.valor)}</div>:null}
        <div style={{color:C.greenMid,marginTop:6,display:"flex",alignItems:"center",gap:5}}>
          <Icon n="check" size={12}/> Nenhum lead foi perdido — tudo continua registrado.
        </div>
      </div>

      {assinatura.link&&<a href={assinatura.link} target="_blank" rel="noreferrer"
        style={{display:"flex",alignItems:"center",justifyContent:"center",gap:7,textDecoration:"none",background:C.green,color:"#fff",
          borderRadius:12,padding:"13px",fontSize:14,fontWeight:600,marginBottom:9}}>
        <Icon n="zap" size={15}/> Pagar agora</a>}

      {gestor&&<React.Fragment>
        <button onClick={async()=>{ setBaixando(true); try{ await acoes.baixarLeads(); }catch(e){} finally{ setBaixando(false); } }}
          style={{width:"100%",background:C.surface,color:C.sub,border:`1px solid ${C.line}`,borderRadius:12,padding:"13px",
            fontSize:13.5,fontWeight:600,cursor:"pointer",marginBottom:9}}>
          {baixando?"Gerando…":"Baixar a base de leads"}</button>
        <button onClick={()=>acoes.marcarMensalidadePaga().then(aoRever).catch(()=>{})}
          style={{width:"100%",background:"transparent",color:C.faint,border:"none",fontSize:12,cursor:"pointer",marginBottom:9}}>
          já paguei — liberar acesso</button>
      </React.Fragment>}

      <div style={{display:"flex",gap:8}}>
        <button onClick={aoRever} style={{flex:1,background:C.surface,color:C.sub,border:`1px solid ${C.line}`,borderRadius:12,padding:"11px",fontSize:13,fontWeight:600,cursor:"pointer"}}>Verificar de novo</button>
        <button onClick={aoSair} style={{flex:1,background:"transparent",color:C.faint,border:`1px solid ${C.line}`,borderRadius:12,padding:"11px",fontSize:13,fontWeight:600,cursor:"pointer"}}>Sair</button>
      </div>
    </div>
  </div>;
}

/* Tarja de aviso. Aparece perto do vencimento e durante a carência — o objetivo
   é a conta nunca chegar a bloquear de surpresa. */
function TarjaMensalidade({assinatura,isMobile}){
  if(!assinatura||!assinatura.cobranca) return null;
  const {status}=assinatura;
  if(status!=="vence_em_breve"&&status!=="atrasado") return null;
  const atrasado=status==="atrasado";
  const texto=atrasado
    ?`Mensalidade vencida em ${fmtData(assinatura.vence_em)}. O acesso será suspenso em ${assinatura.restam} dia(s).`
    :`Mensalidade vence em ${assinatura.dias===0?"hoje":assinatura.dias+" dia(s)"} (${fmtData(assinatura.vence_em)}).`;
  return <div style={{background:atrasado?C.hotSoft:C.amberSoft,borderBottom:`1px solid ${atrasado?C.hot:C.amber}33`,
    color:atrasado?C.hot:"#8a6d1f",fontSize:isMobile?11.5:12.5,padding:"7px 14px",display:"flex",alignItems:"center",gap:7,flexShrink:0}}>
    <Icon n={atrasado?"lock":"clock"} size={13}/>
    <span style={{flex:1,lineHeight:1.4}}>{texto}</span>
    {assinatura.link&&<a href={assinatura.link} target="_blank" rel="noreferrer"
      style={{color:"inherit",fontWeight:700,textDecoration:"underline",whiteSpace:"nowrap"}}>pagar</a>}
  </div>;
}

function Splash(){
  return <div style={{fontFamily:FONT,background:C.surface,width:"100%",minHeight:"100dvh",display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",gap:14}}>
    <Brand/>
    <div style={{color:C.faint,fontSize:13,display:"flex",alignItems:"center",gap:8}}><Icon n="loader" size={15} spin/> Entrando…</div>
  </div>;
}

function Workspace({session,setSession,equipe,conecta,leads,fila,acoes,selId,setSelId,erro,setErro,recado,setRecado,versao,assinatura,org,voltarAoHub,plantao}){
  const role=session.role;
  const canAttend=role==="corretor"||role==="sdr";
  // Atendente tem o mesmo alcance do gestor — por isso o cadastro dele é aprovado.
  const supervisor=role==="adm"||role==="sdr";
  /* A aba aberta também é escolha da pessoa. Sem guardar, voltar do segundo
     plano no celular jogava todo mundo de volta na tela inicial do papel dele,
     no meio do atendimento. */
  const [view,setView]=usarEscolha("view",role==="adm"?"dashboard":role==="sdr"?"catraca":"atendimento");
  const [tick,setTick]=useState(0);
  const [draft,setDraft]=useState("");
  const [enviando,setEnviando]=useState(false);
  // Mensagem que está sendo respondida. Fica no pai porque é o `send()` daqui
  // que manda a citação junto — e some ao trocar de conversa, para a citação
  // de um cliente nunca vazar para a conversa de outro.
  const [citando,setCitando]=useState(null);
  // Sobe quando a configuração salva uma mensagem pronta: é o sinal para as
  // conversas abertas buscarem a lista nova sem recarregar a página.
  const [versaoMsgs,setVersaoMsgs]=useState(0);
  const chatRef=useRef(null);
  const isMobile=useIsMobile();

  // Quem atende de fato: corretor e atendente já liberados. Gestor não entra na catraca.
  const pessoas=useMemo(()=>equipe
    .filter(u=>(u.role==="corretor"||u.role==="sdr")&&u.status==="ativo")
    .map(u=>({...u,ini:initials(u.name),
      color:COLORS[[...u.id].reduce((a,c)=>a+c.charCodeAt(0),0)%COLORS.length]})),[equipe]);
  // Para captação de imóvel vale a equipe INTEIRA, gestor incluído: ele também
  // capta. `pessoas` não serve aqui porque existe para a catraca, e ali o gestor
  // fica de fora de propósito.
  const equipeToda=useMemo(()=>equipe
    .filter(u=>u.status==="ativo")
    .map(u=>({...u,ini:initials(u.name),
      color:COLORS[[...u.id].reduce((a,c)=>a+c.charCodeAt(0),0)%COLORS.length]})),[equipe]);
  const corretores=pessoas.filter(p=>p.role==="corretor");
  const disponiveis=pessoas.filter(p=>p.available);
  const availCorretores=corretores.filter(p=>p.available);
  // Para quem supervisiona vem da lista da equipe; para o corretor, da própria
  // sessão (ele não tem acesso a /auth/users).
  const euDisponivel=(pessoas.find(p=>p.id===session.id)||{available:session.available}).available;

  useEffect(()=>{const t=setInterval(()=>setTick(x=>x+1),1000);return()=>clearInterval(t);},[]);
  useEffect(()=>{setCitando(null);},[selId]);
  /* Rolagem da conversa. Antes isto rodava a cada atualização da lista de leads
     — e a lista recarrega sozinha a cada 15 segundos. Resultado: quem estava
     lendo o histórico era jogado para o fim sem parar.

     Agora só desce em duas situações: ao abrir outra conversa, e quando chega
     mensagem nova COM o leitor já perto do rodapé. Quem subiu para ler fica
     onde está — igual ao WhatsApp. */
  const ancora=useRef({id:null,qtd:0,abrindo:false,timers:[]});
  const irAoFim=()=>{ const el=chatRef.current; if(el) el.scrollTop=el.scrollHeight; };
  /* Uma rolagem só não basta. A altura da conversa muda DEPOIS que o React
     desenha: foto e áudio carregam, as fontes assentam, o separador de dia
     entra. Numa conversa de texto puro uma chamada acerta; numa com mídia, ela
     para no meio. Então insistimos por um instante, até a altura estabilizar. */
  const fixarNoFim=()=>{
    ancora.current.timers.forEach(clearTimeout);
    ancora.current.timers=[60,180,400,800].map(ms=>setTimeout(irAoFim,ms));
    irAoFim();
    requestAnimationFrame(irAoFim);
  };
  useEffect(()=>()=>ancora.current.timers.forEach(clearTimeout),[]);

  useEffect(()=>{
    const el=chatRef.current; if(!el) return;
    const atual=leads.find(l=>l.id===selId);
    const qtd=atual&&atual.msgs?atual.msgs.length:0;

    // Trocou de conversa: fica "abrindo" até as mensagens chegarem. Elas vêm de
    // outra requisição, então na primeira passada a lista ainda está vazia — sem
    // este estado, a rolagem acontecia no vazio e a conversa abria no topo.
    if(ancora.current.id!==selId) ancora.current={...ancora.current,id:selId,qtd:0,abrindo:true};

    const pertoDoFim=el.scrollHeight-el.scrollTop-el.clientHeight<140;
    const chegouMensagem=qtd>ancora.current.qtd;
    if(ancora.current.abrindo||(chegouMensagem&&pertoDoFim)){
      fixarNoFim();
      if(qtd>0) ancora.current.abrindo=false;   // só está aberta de fato com as mensagens à vista
    }
    ancora.current.qtd=qtd;
  },[selId,leads]);

  /* Ordem da caixa do corretor.

     Antes era: não lidos, temperatura, mais novo primeiro. O furo estava no
     "mais novo": ele olhava a data de ENTRADA do lead. Um lead de junho
     repassado agora afundava no fim da lista — atrás de leads antigos, só por
     ser antigo — e o corretor não via justamente o que a atendente acabou de
     passar para a mão dele.

     Agora sobe para o topo o que acabou de chegar na mão dele, junto com quem
     está esperando resposta. As duas coisas somam: lead recém-recebido COM
     mensagem do cliente sem resposta é o primeiro de todos. */
  const myLeads=useMemo(()=>leads.filter(l=>l.assignedTo===session.id)
    .sort((a,b)=>{const o={QUENTE:0,MORNO:1,FRIO:2};
      const topo=(l)=>(chegouAgora(l)?2:0)+(l.unread>0?1:0);
      return topo(b)-topo(a)
        // Entre os recém-chegados, o mais recente primeiro.
        ||(chegouAgora(a)&&chegouAgora(b)?b.assignedAt-a.assignedAt:0)
        ||o[a.prio]-o[b.prio]
        // E, no resto, a conversa mais recente — não a entrada mais recente.
        ||(b.lastAt||b.createdAt)-(a.lastAt||a.createdAt);}),[leads,session,tick]);
  const sel=leads.find(l=>l.id===selId);

  async function send(){
    if(!draft.trim()||!sel||enviando)return;
    const text=draft.replace("{nome}",first(sel.nome));
    const citada=citando;
    setEnviando(true); setDraft(""); setCitando(null);
    try{ await acoes.enviar(sel.id,text,citada&&citada.id); }finally{ setEnviando(false); }
  }
  const setStatus=(id,status)=>acoes.mudarEtapa(id,status);
  const openLead=(id)=>{acoes.abrir(id);setView("atendimento");};
  const toggleAvail=(id,estaDisponivel,extra)=>acoes.disponibilidade(id,!estaDisponivel,extra);

  // O atendente tem o mesmo alcance do gestor, somado ao que já era dele.
  const NAV={
    /* O gestor vê TUDO. A catraca faltava aqui: ela existia só no menu da
       atendente, então o dono da operação não conseguia ver a fila nem ligar e
       desligar a prontidão de ninguém — justo ele, que é quem cobra. */
    adm:[["dashboard","grid","Painel"],["funil","columns","Funil"],["atendimento","msg","Atender"],["catraca","transfer","Catraca"],["imoveis","pin","Imóveis"],["plantao","calendar","Plantão"],["relatorios","chart","Relatórios"],["base","columns","Base de leads"],["equipe","users","Equipe"],["config","key","Configurações"]],
    // "Atender" da atendente já é a tela completa de conversas — ter as duas
    // separadas só criava dúvida sobre qual usar.
    sdr:[["dashboard","grid","Painel"],["funil","columns","Funil"],["atendimento","msg","Atender"],["catraca","transfer","Catraca"],["imoveis","pin","Imóveis"],["plantao","calendar","Plantão"],["equipe","userplus","Equipe"],["disp","toggleOn","Disponib."],["relatorios","chart","Relatórios"],["config","key","Configurações"]],
    corretor:[["atendimento","msg","Atender"],["funil","columns","Funil"],["imoveis","pin","Imóveis"],["plantao","calendar","Plantão"],["disp","toggleOn","Disponib."],["produtividade","trend","Produção"]],
  }[role].concat([["conta","users","Minha conta"]]);
  const TITLES={dashboard:"Painel da equipe",conversas:"Conversas da equipe",relatorios:"Relatórios",equipe:"Equipe e aprovações",conexao:"Conexão da Conecta",config:"Configurações",base:"Base de leads",catraca:"Catraca de distribuição",atendimento:supervisor?"Atendimento da equipe":"Atendimento",imoveis:"Imóveis e terrenos",conta:"Minha conta",funil:supervisor?"Funil da equipe":"Meu funil",disp:"Minha disponibilidade",produtividade:"Minha produtividade",plantao:"Escala de plantão"};
  // O aviso na navegação conta só o que ainda está em aberto: atendimento
  // finalizado não pode ficar cobrando resposta.
  const naoLidas=myLeads.reduce((s,l)=>s+(l.unread>0&&!l.finalizado?1:0),0);
  const aprovacoesPendentes=equipe.filter(u=>u.status==="aguardando_aprovacao").length;
  const aviso=(v)=>v==="atendimento"?naoLidas:v==="catraca"?fila.length:v==="equipe"?aprovacoesPendentes:0;

  /* O master enxerga tudo, mas não é da equipe da imobiliária — e nenhuma tela
     diria isso a ele. Sem este aviso, é fácil esquecer de qual lado da conta
     você está e estranhar não se achar na lista de pessoas. */
  const ehMaster=!!session.master;
  const roleLabel=ehMaster?"ConHub · master":role==="adm"?"Gestor(a)":role==="sdr"?"Atendente":"Corretor(a)";

  return <div style={{fontFamily:FONT,background:C.surface,color:C.ink,width:"100%",height:"100dvh",display:"flex",flexDirection:isMobile?"column":"row",overflow:"hidden"}}>
    {/* A marca leva para a tela inicial de cada papel — Painel para quem
        supervisiona, Atender para o corretor. É o primeiro item do menu, o
        mesmo lugar para onde o CRM abre. */}
    {!isMobile&&<BarraLateral nav={NAV} view={view} setView={setView} aviso={aviso}
      irParaCasa={()=>setView(NAV[0][0])} sair={()=>setSession(null)}/>}
    <main style={{flex:1,display:"flex",flexDirection:"column",minWidth:0,minHeight:0}}>
      <header style={{background:C.card,borderBottom:`1px solid ${C.line}`,height:isMobile?52:58,flexShrink:0,display:"flex",alignItems:"center",justifyContent:"space-between",padding:isMobile?"0 14px":"0 20px",gap:12}}>
        <div style={{display:"flex",alignItems:"center",gap:12,minWidth:0}}>
          <h1 style={{fontFamily:DISPLAY,color:C.ink,fontSize:isMobile?15.5:17,fontWeight:700,margin:0,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{TITLES[view]}</h1>
          {/* Em qual imobiliária o master está agora, e o caminho de volta ao
              hub. Trabalhando em várias contas parecidas, saber ONDE se está é
              o que evita mandar mensagem pelo cliente errado. */}
          {ehMaster&&org&&<button onClick={voltarAoHub} title="Trocar de imobiliária"
            style={{display:"flex",alignItems:"center",gap:6,flexShrink:0,maxWidth:isMobile?150:260,
              border:`1px solid ${C.green}55`,background:C.greenSoft,color:C.greenDeep,borderRadius:999,
              padding:isMobile?"4px 9px":"4px 11px",fontSize:isMobile?11:11.5,fontWeight:700,cursor:"pointer"}}>
            <Icon n="transfer" size={12}/>
            <span style={{overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{org.nome}</span>
          </button>}
          {!isMobile&&<span style={{color:conecta.connected?C.greenMid:C.hot,background:conecta.connected?C.greenSoft:C.hotSoft,fontSize:11,fontWeight:600,padding:"3px 9px",borderRadius:999,whiteSpace:"nowrap",flexShrink:0,display:"flex",alignItems:"center",gap:5}}>
            <Icon n={conecta.connected?"wifi":"wifioff"} size={11}/>{conecta.connected?"WhatsApp conectado":"WhatsApp desconectado"}
          </span>}
        </div>
        <div style={{display:"flex",alignItems:"center",gap:isMobile?8:10,flexShrink:0}}>
          {!isMobile&&<div style={{textAlign:"right"}}><div style={{color:C.ink,fontSize:12.5,fontWeight:600,lineHeight:1}}>{session.name}</div><div style={{color:C.faint,fontSize:10.5}}>{roleLabel}</div></div>}
          <button onClick={()=>setView("conta")} title="Minha conta" style={{border:"none",background:"transparent",padding:0,cursor:"pointer",display:"flex"}}>
            <Avatar ini={session.ini} color={session.color} size={isMobile?30:34} foto={session.avatar}/>
          </button>
          {isMobile&&<button onClick={()=>setSession(null)} title="Sair" aria-label="Sair" style={{width:34,height:34,borderRadius:10,border:`1px solid ${C.line}`,background:C.surface,color:C.sub,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}><Icon n="logout" size={16}/></button>}
        </div>
      </header>
      <TarjaMensalidade assinatura={assinatura} isMobile={isMobile}/>
      {/* Lembrete do plantão no alto do sistema. Só aparece na véspera e no
          dia — antes disso é informação, não lembrete, e vive na tela da
          escala. Clicar leva para lá. */}
      {/* Na própria tela da escala a faixa já aparece lá dentro — repetir as
          duas seria dizer a mesma coisa duas vezes na mesma tela. */}
      {view!=="plantao"&&plantao&&plantao.meu&&plantao.meu.faltam<=1&&
        <button onClick={()=>setView("plantao")} style={{border:"none",padding:isMobile?"0 14px":"0 20px",
          background:"transparent",cursor:"pointer",width:"100%",textAlign:"left",flexShrink:0,marginTop:10}}>
          <AvisoPlantao meu={plantao.meu} isMobile={isMobile} compacto/>
        </button>}
      {erro&&<div style={{background:C.hotSoft,borderBottom:`1px solid ${C.hot}44`,color:C.hot,fontSize:12.5,padding:"8px 16px",display:"flex",alignItems:"center",gap:8,flexShrink:0}}>
        <Icon n="wifioff" size={14}/><span style={{flex:1}}>{erro}</span>
        <button onClick={()=>setErro("")} style={{border:"none",background:"transparent",color:C.hot,cursor:"pointer",fontWeight:700}}>×</button>
      </div>}
      {recado&&<div style={{background:C.amberSoft,borderBottom:`1px solid ${C.amber}44`,color:"#8a6d1f",fontSize:12.5,padding:"8px 16px",display:"flex",alignItems:"center",gap:8,flexShrink:0,lineHeight:1.4}}>
        <Icon n="bell" size={14}/><span style={{flex:1}}>{recado}</span>
        <button onClick={()=>setRecado("")} style={{border:"none",background:"transparent",color:"#8a6d1f",cursor:"pointer",fontWeight:700}}>×</button>
      </div>}
      <div style={{flex:1,minHeight:0}}>
        {/* O corretor tem a caixa de entrada simples; quem supervisiona usa a tela
            completa, com filtros e acesso a qualquer conversa — é a mesma aba. */}
        {role==="corretor"&&view==="atendimento"&&<Atendimento {...{myLeads,sel,abrir:acoes.abrir,draft,setDraft,send,enviando,setStatus,chatRef,conecta,session,acoes,canHandoff:false,availCorretores,isMobile,citando,setCitando,versaoMsgs}}/>}
        {/* Quem supervisiona vê o funil da equipe inteira; o corretor, só o dele. */}
        {view==="funil"&&<Funil leads={supervisor?leads:myLeads} openLead={openLead} setStatus={setStatus} isMobile={isMobile} mostrarDono={supervisor} acoes={acoes}/>}
        {canAttend&&view==="disp"&&<Disponibilidade avail={euDisponivel} toggle={(extra)=>toggleAvail(session.id,euDisponivel,extra)} name={session.name} acoes={acoes} isMobile={isMobile} ehPonto={role==="sdr"}/>}
        {canAttend&&view==="produtividade"&&<Relatorios acoes={acoes} session={session} isMobile={isMobile} abrirConversa={openLead} org={org}/>}
        {/* Gestor e atendente. Só o gestor mexe no horário de encerramento da
            prontidão — é regra da casa, não da operação do dia. */}
        {supervisor&&view==="catraca"&&<Catraca {...{fila,pessoas,disponiveis,toggleAvail,acoes,isMobile,podeConfigurarExpediente:role==="adm"}}/>}
        {/* Gestor e atendente compartilham as telas de supervisão. */}
        {supervisor&&view==="dashboard"&&<Dashboard {...{acoes,pessoas,fila,setView,openLead,isMobile}}/>}
        {supervisor&&(view==="conversas"||view==="atendimento")&&<Conversas {...{acoes,pessoas,sel,session,chatRef,isMobile,versao}}/>}
        {supervisor&&view==="relatorios"&&<Relatorios acoes={acoes} session={session} pickable isMobile={isMobile} abrirConversa={openLead} org={org}/>}
        {/* Catálogo aberto a todos: é o que tira a equipe do grupo de WhatsApp. */}
        {view==="plantao"&&<Plantao {...{acoes,session,pessoas,isMobile,podeEditar:supervisor}}/>}
        {view==="imoveis"&&<Imoveis {...{acoes,session,pessoas,equipeToda,isMobile,supervisor}}/>}
        {/* Minha conta é igual para os três papéis. */}
        {view==="conta"&&<MinhaConta {...{session,acoes,isMobile}}/>}
        {supervisor&&view==="equipe"&&<Equipe {...{acoes,session,org,isMobile,versao}}/>}
        {/* Configurações: mensagens automáticas (gestor e atendente) e conexão. */}
        {supervisor&&view==="config"&&<Configuracoes acoes={acoes} session={session} isMobile={isMobile}
          aoMudarMensagens={()=>setVersaoMsgs(v=>v+1)}/>}
        {role==="adm"&&view==="base"&&<BaseLeads acoes={acoes} isMobile={isMobile} pessoas={pessoas} abrirConversa={openLead}/>}
        {role==="adm"&&view==="conexao"&&<Conexao conecta={conecta}/>}
      </div>
    </main>
    {isMobile&&<NavCelular nav={NAV} view={view} setView={setView} aviso={aviso}/>}
  </div>;
}

/* ===== navegação =====
   Uma regra só de agrupamento, usada no celular E no PC. Acima de cinco abas
   as extras vão para "Mais": no celular porque espremer sete ícones em 375px
   torna todos difíceis de acertar com o dedo; no PC porque nove itens numa
   coluna de 74px quebram o rótulo em duas linhas, cada botão fica com uma
   altura e a barra sai do esquadro.

   Ter a mesma divisão nos dois é o ponto: o que está em "Mais" no celular está
   em "Mais" no computador, então quem usa os dois não precisa reaprender. */
/* Quantos itens ficam à vista antes de o resto ir para o "Mais".

   Eram 5 nos dois, com a mesma divisão de propósito: o que estava em "Mais" no
   celular estava em "Mais" no PC, e quem usa os dois não reaprendia.

   Só que os dois lugares não têm o mesmo espaço, e insistir no empate custava
   caro do lado do PC: a barra é uma COLUNA, com a tela inteira de altura
   sobrando, e mesmo assim o funil e o plantão viviam escondidos atrás de um
   clique. No celular a barra é uma LINHA de 375px — sete ícones ali viram
   alvos que o dedo não acerta.

   A ORDEM continua a mesma nos dois. O que muda é só onde a lista é cortada,
   então o que está à vista no celular está à vista no PC também: ninguém
   precisa procurar em dois lugares diferentes. */
const LIMITE_NAV=5;      // celular: 4 + o "Mais"
const LIMITE_NAV_PC=7;   // computador: 6 + o "Mais"
function dividirNav(nav,limite=LIMITE_NAV){
  if(nav.length<=limite) return {cabem:nav,extras:[]};
  return {cabem:nav.slice(0,limite-1),extras:nav.slice(limite-1)};
}

// Linha do menu "Mais" — mesma aparência na folha do celular e na do PC.
function ItemMais({n,label,ativo,badge,onClick,ultimo}){
  return <button onClick={onClick} style={{width:"100%",display:"flex",alignItems:"center",gap:12,padding:"13px 10px",border:"none",
    borderBottom:ultimo?"none":`1px solid ${C.line}`,background:"transparent",cursor:"pointer",
    color:ativo?C.green:C.ink,fontSize:14.5,fontWeight:ativo?700:500}}>
    <Icon n={n} size={19}/><span style={{flex:1,textAlign:"left"}}>{label}</span>
    {badge>0&&<span style={{minWidth:20,height:20,padding:"0 6px",borderRadius:999,background:C.hot,color:"#fff",fontSize:11,fontWeight:700,display:"flex",alignItems:"center",justifyContent:"center"}}>{badge}</span>}
  </button>;
}

/* Barra lateral do computador. Os quatro primeiros ficam à vista e o resto
   abre numa folha ao lado, presa ao botão "Mais".

   Sobre o esquadro: altura fixa por botão e rótulo em uma linha só. Antes a
   altura vinha do texto, então "Base de leads" empurrava o vizinho e a coluna
   ficava desalinhada. Com quatro itens os rótulos são curtos e nada corta. */
function BarraLateral({nav,view,setView,aviso,irParaCasa,sair}){
  const [maisAberto,setMaisAberto]=useState(false);
  const botaoMais=useRef(null);
  const [topo,setTopo]=useState(0);
  const {cabem,extras}=dividirNav(nav,LIMITE_NAV_PC);
  const avisoNoMais=extras.reduce((s,[v])=>s+aviso(v),0);
  const maisAtivo=extras.some(([v])=>v===view);
  const escolher=(v)=>{setView(v);setMaisAberto(false);};

  // Fecha com Esc — no computador é o reflexo de quem abriu sem querer.
  useEffect(()=>{
    if(!maisAberto) return;
    const t=(e)=>{ if(e.key==="Escape") setMaisAberto(false); };
    window.addEventListener("keydown",t);
    return()=>window.removeEventListener("keydown",t);
  },[maisAberto]);

  const alternarMais=()=>{
    if(botaoMais.current){
      const r=botaoMais.current.getBoundingClientRect();
      const alturaFolha=extras.length*47+22;
      // Nasce na altura do botão, mas nunca passa do rodapé nem do topo da janela.
      setTopo(Math.max(12,Math.min(r.top,window.innerHeight-alturaFolha-12)));
    }
    setMaisAberto(m=>!m);
  };

  const LARGURA=76;
  const botao=(v,n,label,badge,ativo,onClick,ref)=><button key={v} ref={ref} onClick={onClick} title={label}
    style={{position:"relative",width:56,height:54,flexShrink:0,borderRadius:12,border:"none",cursor:"pointer",
      display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",gap:4,padding:0,
      background:ativo?"rgba(255,255,255,.14)":"transparent",color:ativo?"#fff":"rgba(255,255,255,.55)"}}>
    <Icon n={n} size={19}/>
    <span style={{fontSize:9,fontWeight:500,lineHeight:1,maxWidth:52,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{label}</span>
    {badge>0&&<Badge n={badge} top={6} right={8}/>}
  </button>;

  return <React.Fragment>
    <aside style={{background:C.greenDeep,width:LARGURA,flexShrink:0,display:"flex",flexDirection:"column",alignItems:"center",padding:"20px 0 14px",gap:4}}>
      {/* Marca clicável: em qualquer tela, um clique aqui volta para o começo —
          é o que todo mundo já tenta fazer por hábito de site. */}
      <button onClick={irParaCasa} title="Ir para o início" style={{border:"none",background:"transparent",padding:0,cursor:"pointer",
        display:"flex",flexDirection:"column",alignItems:"center",margin:"0 0 16px"}}>
        <div style={{background:C.green,width:40,height:40,borderRadius:12,display:"flex",alignItems:"center",justifyContent:"center",color:"#fff"}}><Icon n="dot" size={20}/></div>
        <div style={{fontFamily:DISPLAY,color:"#fff",fontSize:10,fontWeight:700,textAlign:"center",lineHeight:1.1,marginTop:4}}>Con<br/>Hub</div>
      </button>
      {/* rolagem: em janela baixa (notebook com a tela dividida) os botões não
          cabem, e sem isto eles passavam por baixo do "Sair" — que ficava por
          cima e roubava o clique do "Mais". */}
      <div style={{display:"flex",flexDirection:"column",alignItems:"center",gap:4,flex:1,minHeight:0,overflowY:"auto",overflowX:"hidden",width:"100%",scrollbarWidth:"none"}}>
        {cabem.map(([v,n,label])=>botao(v,n,label,aviso(v),view===v,()=>setView(v)))}
        {extras.length>0&&botao("__mais","mais","Mais",avisoNoMais,maisAtivo||maisAberto,alternarMais,botaoMais)}
      </div>
      {botao("__sair","logout","Sair",0,false,sair)}
    </aside>
    {maisAberto&&<div onClick={()=>setMaisAberto(false)} style={{position:"fixed",inset:0,zIndex:30}}/>}
    {maisAberto&&<div style={{position:"fixed",left:LARGURA+8,top:topo,zIndex:31,width:222,background:C.card,
      border:`1px solid ${C.line}`,borderRadius:14,padding:"6px 12px",boxShadow:"0 12px 34px rgba(0,0,0,.18)"}}>
      {extras.map(([v,n,label],i)=><ItemMais key={v} n={n} label={label} ativo={view===v} badge={aviso(v)}
        ultimo={i===extras.length-1} onClick={()=>escolher(v)}/>)}
    </div>}
  </React.Fragment>;
}

// Barra inferior do celular.
function NavCelular({nav,view,setView,aviso}){
  const [maisAberto,setMaisAberto]=useState(false);
  /* A folha do "Mais" abre colada no rodapé e a barra fica por cima dela — o
     último item do menu sumia atrás. Medimos a barra em vez de chutar um valor:
     a altura muda com a área segura de cada aparelho. */
  const barra=useRef(null);
  const [alturaBarra,setAlturaBarra]=useState(64);
  useEffect(()=>{
    const medir=()=>{ if(barra.current) setAlturaBarra(barra.current.offsetHeight); };
    medir();
    window.addEventListener("resize",medir);
    return()=>window.removeEventListener("resize",medir);
  },[]);
  const {cabem,extras}=dividirNav(nav);
  const avisoNoMais=extras.reduce((s,[v])=>s+aviso(v),0);
  const escolher=(v)=>{setView(v);setMaisAberto(false);};
  const botao=(v,n,label,badge)=><button key={v} onClick={()=>escolher(v)} style={{position:"relative",flex:1,minWidth:0,padding:"14px 2px 6px",border:"none",cursor:"pointer",display:"flex",flexDirection:"column",alignItems:"center",gap:3,background:"transparent",color:view===v?"#fff":"rgba(255,255,255,.5)",borderTop:`2px solid ${view===v?C.green:"transparent"}`}}>
    <Icon n={n} size={20}/><span style={{fontSize:9.5,fontWeight:600,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",maxWidth:"100%"}}>{label}</span>
    {badge>0&&<Badge n={badge} top={4} right={"22%"}/>}
  </button>;

  return <React.Fragment>
    {maisAberto&&<div onClick={()=>setMaisAberto(false)} style={{position:"fixed",inset:0,background:"rgba(0,0,0,.35)",zIndex:20}}/>}
    {maisAberto&&<div style={{position:"fixed",left:0,right:0,bottom:0,zIndex:21,background:C.card,borderRadius:"18px 18px 0 0",paddingLeft:14,paddingRight:14,paddingTop:14,paddingBottom:alturaBarra+14,boxShadow:"0 -8px 30px rgba(0,0,0,.18)"}}>
      <div style={{width:38,height:4,borderRadius:99,background:C.line,margin:"0 auto 12px"}}/>
      {extras.map(([v,n,label],i)=><ItemMais key={v} n={n} label={label} ativo={view===v} badge={aviso(v)}
        ultimo={i===extras.length-1} onClick={()=>escolher(v)}/>)}
    </div>}
    <nav ref={barra} style={{background:C.greenDeep,flexShrink:0,display:"flex",alignItems:"stretch",justifyContent:"space-around",paddingBottom:"calc(env(safe-area-inset-bottom, 0px) + 22px)",zIndex:22}}>
      {cabem.map(([v,n,label])=>botao(v,n,label,aviso(v)))}
      {extras.length>0&&<button onClick={()=>setMaisAberto(m=>!m)} style={{position:"relative",flex:1,minWidth:0,padding:"14px 2px 6px",border:"none",cursor:"pointer",display:"flex",flexDirection:"column",alignItems:"center",gap:3,background:"transparent",color:extras.some(([v])=>v===view)?"#fff":"rgba(255,255,255,.5)",borderTop:`2px solid ${extras.some(([v])=>v===view)?C.green:"transparent"}`}}>
        <Icon n="mais" size={20}/><span style={{fontSize:9.5,fontWeight:600}}>Mais</span>
        {avisoNoMais>0&&<Badge n={avisoNoMais} top={4} right={"22%"}/>}
      </button>}
    </nav>
  </React.Fragment>;
}

function Badge({n,top,right}){
  return <span style={{position:"absolute",top,right,minWidth:16,height:16,padding:"0 4px",borderRadius:999,background:C.hot,color:"#fff",fontSize:10,fontWeight:700,display:"flex",alignItems:"center",justifyContent:"center",lineHeight:1}}>{n>9?"9+":n}</span>;
}

/* ===== item da lista de leads =====
   Não lida em destaque: nome em negrito, fundo levemente verde e contador.
   É o sinal de "o cliente está esperando" que o Ali pediu. */
/* Cada conversa na lista, no arranjo do WhatsApp — que é o que a equipe já sabe
   ler sem aprender nada:

   nome ................................ quando foi a última mensagem
   última mensagem
   etapa · corretor ..................... quantas não lidas

   A HORA subiu para a primeira linha porque é a informação que se procura
   varrendo a lista de cima a baixo ("isso é de agora ou de quando?"), e o
   contador de não lidas desceu para o canto de baixo, onde ele está no
   WhatsApp. Antes não havia hora nenhuma: dava para saber que o cliente estava
   esperando, mas não desde quando, a não ser abrindo a conversa. */
/* ===== O SININHO: chamar o corretor sem abrir a conversa =====

   A atendente varre a lista e vê o cliente parado esperando. Antes, para
   cutucar o corretor, ela precisava abrir o lead, achar o botão e voltar — três
   passos para um aviso de um segundo, repetido dez vezes por dia.

   Fica dentro do item da lista, então o clique não pode abrir a conversa
   junto: `stopPropagation` segura isso.

   Depois de chamado o sino fica verde e diz a hora, para ela não cutucar duas
   vezes o mesmo corretor pelo mesmo motivo — que é como um aviso útil vira
   barulho que a equipe aprende a ignorar. */
function SinoCutucar({lead,cutucar}){
  const [enviando,setEnviando]=useState(false);
  const [erro,setErro]=useState(false);
  /* O sino muda NA HORA do clique bem-sucedido, sem esperar a lista recarregar.
     A busca automática roda a cada 10 segundos: nesse intervalo o sino ficava
     igual, e quem clicou clicava de novo achando que não tinha pegado — que é
     exatamente como o corretor acaba recebendo três avisos do mesmo lead. */
  const [agora,setAgora]=useState(null);
  useEffect(()=>{ setAgora(null); setErro(false); },[lead.id]);
  const chamadoEm=lead.cutucadoEm||agora;
  const jaChamado=!!chamadoEm;

  async function chamar(e){
    e.stopPropagation(); e.preventDefault();
    if(enviando) return;
    setEnviando(true); setErro(false);
    try{ await cutucar(lead.id); setAgora(Date.now()); }catch(x){ setErro(true); }
    finally{ setEnviando(false); }
  }
  // Sem corretor não há quem chamar — o lead está na fila, e o caminho é
  // distribuir, não cutucar.
  if(!lead.assignedTo) return null;

  const cor=erro?C.hot:jaChamado?C.greenMid:C.faint;
  return <span onClick={chamar} role="button" tabIndex={0}
    onKeyDown={e=>{ if(e.key==="Enter"||e.key===" ") chamar(e); }}
    title={erro?"Não consegui chamar — tente de novo"
      :jaChamado?`${first(lead.assignedName)||"O corretor"} já foi chamado às ${fmtClock(chamadoEm)}`
      :`Chamar ${first(lead.assignedName)||"o corretor"} para este atendimento`}
    aria-label={jaChamado?"Corretor já chamado":"Chamar o corretor"}
    style={{display:"flex",alignItems:"center",padding:3,borderRadius:7,cursor:"pointer",
      background:jaChamado?C.greenSoft:"transparent",color:cor,flexShrink:0}}>
    <Icon n={enviando?"loader":"bell"} size={13} color={cor} spin={enviando}/>
  </span>;
}

function ItemLead({l,ativo,onClick,isMobile,mostrarDono,cutucar}){
  const naoLida=l.unread>0, quando=l.lastAt||l.createdAt, espera=Date.now()-quando;
  return <button onClick={onClick} style={{width:"100%",textAlign:"left",padding:isMobile?"13px 14px":"10px 12px",borderBottom:`1px solid ${C.line}`,borderLeft:`3px solid ${ativo?C.green:naoLida?C.hot:"transparent"}`,background:ativo?C.greenSoft:naoLida?"#FFFBFA":"transparent",border:"none",cursor:"pointer",display:"flex",flexDirection:"column",gap:4}}>
    <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",gap:8}}>
      <span style={{color:C.ink,fontSize:13.5,fontWeight:naoLida?700:600,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{l.nome}</span>
      <div style={{display:"flex",alignItems:"center",gap:6,flexShrink:0}}>
        {/* A temperatura saiu daqui a pedido do Ali: ela já aparece no card do
            funil e na ficha, e nesta lista competia com a informação que muda
            a decisão de quem supervisiona — quem está esperando, desde quando,
            e se o corretor já foi chamado.

            No lugar dela, o SININHO: a atendente vê a conversa parada e chama
            o corretor dali mesmo, sem abrir o lead. Só aparece para quem
            supervisiona, e só quando há um corretor para chamar. */}
        {cutucar&&<SinoCutucar lead={l} cutucar={cutucar}/>}
        {/* Cliente esperando tem a hora em coral, como o WhatsApp destaca a
            conversa não lida — o olho pega a linha antes de ler o nome. */}
        <span style={{color:naoLida?C.hot:C.faint,fontSize:10.5,fontWeight:naoLida?700:500,whiteSpace:"nowrap"}}
          title={quando?new Date(quando).toLocaleString("pt-BR"):undefined}>{fmtQuando(quando)}</span>
      </div>
    </div>
    <span style={{color:naoLida?C.ink:C.faint,fontWeight:naoLida?500:400,fontSize:11.5,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>
      {l.lastBody?(l.lastDirection==="in"?"":"Você: ")+l.lastBody:"Novo lead — sem contato"}
    </span>
    <div style={{display:"flex",alignItems:"center",gap:6,marginTop:2}}>
      {/* Lead que acabou de ser repassado tem que se anunciar. Sem isto ele
          entra na lista igual a todos os outros, e o corretor só descobre que
          recebeu quando abre um por um. */}
      {chegouAgora(l)&&<span style={{background:C.greenDeep,color:"#fff",fontSize:9,fontWeight:700,
        padding:"2px 7px",borderRadius:999,textTransform:"uppercase",letterSpacing:.3,flexShrink:0}}>novo com você</span>}
      {naoLida
        ?<span style={{display:"flex",alignItems:"center",gap:4,color:ageColor(espera),fontFamily:MONO,fontSize:11,fontWeight:600}}><Icon n="timer" size={12} color={ageColor(espera)}/>aguardando há {fmtAge(espera)}</span>
        :<span style={{color:STAGE_C[l.status],background:STAGE_C[l.status]+"16",fontSize:10,fontWeight:600,padding:"1px 6px",borderRadius:4}}>{l.status}</span>}
      {mostrarDono&&<span style={{color:C.faint,fontSize:10.5,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{l.assignedName||"na fila"}</span>}
      <span style={{flex:1}}/>
      {naoLida&&<span style={{minWidth:18,height:18,padding:"0 5px",borderRadius:999,background:C.hot,color:"#fff",fontSize:10.5,fontWeight:700,display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}>{l.unread}</span>}
    </div>
  </button>;
}

/* ===== DIA DA CONVERSA =====
   A faixa "Hoje / Ontem / 12 de julho" que separa os dias, como no WhatsApp.
   Sem ela a conversa vira um bloco só e não dá para saber o que foi falado hoje
   e o que é de semanas atrás. */
const soDia=(ts)=>{const d=new Date(ts);return new Date(d.getFullYear(),d.getMonth(),d.getDate()).getTime();};
const mesmoDia=(a,b)=>soDia(a)===soDia(b);
function rotuloDia(ts){
  const dias=Math.round((soDia(Date.now())-soDia(ts))/86400000);
  if(dias===0) return "Hoje";
  if(dias===1) return "Ontem";
  const d=new Date(ts);
  // Dentro da semana o dia da semana ajuda mais que a data ("terça-feira").
  if(dias<7) return SEMANA[d.getDay()].replace(/^./,c=>c.toUpperCase());
  const opcoes={day:"2-digit",month:"long"};
  if(d.getFullYear()!==new Date().getFullYear()) opcoes.year="numeric";
  return d.toLocaleDateString("pt-BR",opcoes);
}
const SeparadorDia=({ts})=><div style={{alignSelf:"center",background:C.card,border:`1px solid ${C.line}`,color:C.sub,
  fontSize:11,fontWeight:600,padding:"3px 12px",borderRadius:999,margin:"6px 0",textTransform:"none"}}>{rotuloDia(ts)}</div>;

// Fecho do atendimento finalizado: registra quando a conversa foi encerrada,
// para o histórico não terminar no vazio.
const FechoAtendimento=({lead})=><div style={{alignSelf:"center",display:"flex",alignItems:"center",gap:6,
  background:C.greenSoft,color:C.greenDeep,fontSize:11,fontWeight:600,padding:"4px 12px",borderRadius:999,margin:"8px 0"}}>
  <Icon n="check" size={12}/> Atendimento finalizado {rotuloDia(lead.finalizadoEm).toLowerCase()}
  {" · "}{fmtClock(lead.finalizadoEm)}</div>;

/* ===== ANEXAR NA CONVERSA =====
   O clipe do WhatsApp: fotos (até 10), vídeo (1), áudio gravado na hora e a
   localização de onde o corretor está. Os limites vêm do backend também — aqui
   eles existem para avisar antes de subir 40 MB à toa no 4G do corretor.

   O áudio é gravado pelo próprio navegador. No Android sai em webm, no iPhone em
   mp4; os dois são aceitos e a Uazapi manda como mensagem de voz. */
const LIMITE_FOTOS=10;
const lerArquivo=(f)=>new Promise((ok,erro)=>{
  const r=new FileReader();
  r.onload=()=>ok({mime:f.type,nome:f.name,base64:String(r.result).split(",")[1]});
  r.onerror=()=>erro(new Error(`Não consegui ler "${f.name}".`));
  r.readAsDataURL(f);
});

/* Editar a mensagem, nas regras do WhatsApp: 15 minutos, só texto, só o que
   saiu daqui. O lápis some sozinho quando a janela fecha — melhor sumir do que
   deixar o corretor tentar e levar recusa.

   O aviso de erro é a parte séria: se a Uazapi não editar, o texto no CRM NÃO
   muda, e a tela precisa dizer isso com todas as letras. Editar "só no CRM"
   seria pior do que não editar — o corretor acharia que consertou e o cliente
   continuaria com a mensagem errada no celular. */
const JANELA_EDICAO_MS=15*60000;
function BotaoEditar({m,podeEditar,aoEditar}){
  if(!podeEditar||m.from!=="corretor"||m.midia||!m.citavel) return null;
  if(Date.now()-m.at>JANELA_EDICAO_MS) return null;
  return <button onClick={()=>aoEditar(m)} title="Editar (até 15 minutos)"
    style={{background:"transparent",border:"none",cursor:"pointer",color:C.faint,padding:"4px",
      display:"flex",alignItems:"center",flexShrink:0,opacity:.6}}>
    <Icon n="edit" size={13}/>
  </button>;
}

/* A barra de "editando", logo acima do campo de mensagem.

   Antes a caixa de edição abria NO LUGAR do balão. Parecia natural, mas a
   mensagem a editar quase sempre está no meio da conversa: o corretor clicava
   no lápis e precisava rolar a tela para achar onde digitar — e no celular,
   com o teclado aberto, a caixa ficava escondida atrás dele.

   Agora é como o WhatsApp faz: o texto vai para o campo de baixo, que é onde
   o dedo já está e onde o teclado abre. A barra diz o que está sendo editado
   e some com o ×. */
function BarraEdicao({texto,erro,isMobile,aoCancelar}){
  return <div style={{background:C.surface,borderLeft:`3px solid ${C.green}`,borderRadius:8,
    padding:"7px 10px",marginBottom:8,display:"flex",alignItems:"center",gap:8}}>
    <div style={{flex:1,minWidth:0}}>
      <div style={{color:C.greenDeep,fontSize:10.5,fontWeight:700,display:"flex",alignItems:"center",gap:5}}>
        <Icon n="edit" size={11}/> Editando a mensagem
      </div>
      <div style={{color:C.sub,fontSize:11.5,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",marginTop:1}}>{texto}</div>
      {erro&&<div style={{color:C.hot,fontSize:11,marginTop:4,lineHeight:1.4,whiteSpace:"normal"}}>{erro}</div>}
    </div>
    <button onClick={aoCancelar} title="Cancelar a edição"
      style={{background:"transparent",border:"none",cursor:"pointer",color:C.faint,fontSize:17,lineHeight:1,padding:"0 2px",flexShrink:0}}>×</button>
  </div>;
}

/* A setinha de responder, ao lado do balão.

   Fica sempre visível, e não só ao passar o mouse: a equipe trabalha no
   celular, onde não existe passar o mouse. Discreta o bastante para não
   competir com a conversa. */
function BotaoResponder({m,aoResponder}){
  if(!aoResponder) return null;
  return <button onClick={()=>aoResponder({
      id:m.id, texto:m.text||"", deLead:m.from==="lead",
      autor:m.byName||"", midia:m.midia?m.midia.mime:"", citavel:m.citavel,
    })} title="Responder esta mensagem"
    style={{background:"transparent",border:"none",cursor:"pointer",color:C.faint,padding:"4px",
      display:"flex",alignItems:"center",flexShrink:0,opacity:.6}}>
    <Icon n="reply" size={14}/>
  </button>;
}

/* O trecho citado dentro do balão, e a barra de citação acima do campo.

   Mesma peça nos dois lugares para a citação ser reconhecível: barrinha
   colorida à esquerda, autor em cima, um pedaço do texto embaixo. */
function Citacao({c,claro,aoFechar}){
  if(!c) return null;
  const quem=c.deLead?"Cliente":(c.autor||"Você");
  const rotulo=c.midia?(/^image\//.test(c.midia)?"Foto":/^video\//.test(c.midia)?"Vídeo":/^audio\//.test(c.midia)?"Áudio":"Arquivo"):"";
  const texto=(c.texto||rotulo||"mensagem").replace(/\s+/g," ").trim();
  return <div style={{display:"flex",alignItems:"center",gap:8,
    background:claro?"rgba(255,255,255,.16)":C.surface,
    borderLeft:`3px solid ${claro?"rgba(255,255,255,.75)":C.green}`,
    borderRadius:6,padding:"5px 8px",marginBottom:5,maxWidth:"100%"}}>
    <div style={{flex:1,minWidth:0}}>
      <div style={{fontSize:10.5,fontWeight:700,color:claro?"rgba(255,255,255,.9)":C.greenDeep}}>{quem}</div>
      <div style={{fontSize:11.5,color:claro?"rgba(255,255,255,.8)":C.sub,
        overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>
        {rotulo&&!c.texto?<React.Fragment>{rotulo}</React.Fragment>:texto}
      </div>
    </div>
    {aoFechar&&c.citavel===false&&<span style={{color:C.amber,fontSize:10,fontWeight:600,flexShrink:0,maxWidth:110,lineHeight:1.2}}>
      só aqui no CRM (mensagem antiga)</span>}
    {aoFechar&&<button onClick={aoFechar} title="Cancelar"
      style={{background:"transparent",border:"none",cursor:"pointer",color:C.faint,fontSize:16,lineHeight:1,padding:"0 2px",flexShrink:0}}>×</button>}
  </div>;
}

/* Colar imagem no campo de mensagem (Ctrl+V), como no WhatsApp.

   Print de tela, foto copiada do WhatsApp Web, imagem do navegador: tudo que
   está na área de transferência entra direto, sem passar pelo clipe. Texto
   colado segue o caminho de sempre — só as imagens são interceptadas.

   No celular não existe Ctrl+V, mas o "Colar" do menu dispara o mesmo evento.
   Foto vinda da galeria não vem por aqui: o sistema do telefone não a coloca
   na área de transferência como arquivo. Para esse caso, o clipe continua. */
/* As mensagens prontas vêm da imobiliária, não do código.

   Antes eram uma lista fixa aqui dentro: mudar o texto de abordagem exigia um
   deploy — e o texto de abordagem é justamente o que a gestão ajusta toda
   semana conforme o que está convertendo. */
function usarMensagensRapidas(acoes,versao){
  const [lista,setLista]=useState(null);
  useEffect(()=>{let vivo=true;
    acoes.mensagensRapidas().then(r=>vivo&&setLista(r.mensagens||[])).catch(()=>vivo&&setLista([]));
    return()=>{vivo=false;};},[versao]);
  return lista||[];
}

function usarColar({lead,aoColar,aoAvisar,aoMudarEstado,quantasJa=0}){
  return async function colar(e){
    const itens=[...(e.clipboardData?.items||[])].filter(i=>i.kind==="file"&&/^image\//.test(i.type));
    if(!itens.length||!lead) return;               // colou texto: deixa passar
    e.preventDefault();
    const arqs=itens.map(i=>i.getAsFile()).filter(Boolean);
    if(!arqs.length) return;
    if(quantasJa+arqs.length>LIMITE_FOTOS)
      return aoAvisar&&aoAvisar(`Dá para mandar até ${LIMITE_FOTOS} imagens por vez.`);
    aoMudarEstado&&aoMudarEstado(true);
    try{
      // A imagem colada não tem nome de arquivo — o WhatsApp Web dá "image.png"
      // a tudo. Um nome com a hora ajuda a achar depois no armazenamento.
      const arquivos=await Promise.all(arqs.map(async(f,i)=>{
        const lido=await lerArquivo(f);
        return {...lido,
          nome:lido.nome&&lido.nome!=="image.png"?lido.nome
            :`colada-${new Date().toISOString().slice(0,19).replace(/[:T]/g,"-")}${i?"-"+(i+1):""}.png`,
          // Para desenhar a prévia sem ler o arquivo de novo.
          previa:`data:${lido.mime};base64,${lido.base64}`};
      }));
      /* NÃO envia: entrega para a tela mostrar antes.
         Colar mandava direto, e imagem errada no WhatsApp do cliente não tem
         desfazer — o corretor descobria o engano depois de o cliente já ter
         visto. Um clique a mais é barato perto disso. */
      aoColar(arquivos);
    }catch(err){ aoAvisar&&aoAvisar(err.message); }
    finally{ aoMudarEstado&&aoMudarEstado(false); }
  };
}

/* A prévia do que foi colado, antes de sair.

   Mostra as miniaturas, deixa tirar uma que veio sem querer, e usa o que
   estiver escrito no campo como legenda — igual ao WhatsApp, onde a legenda
   vai junto da foto. Só o botão Enviar dispara. */
function PreviaColagem({arquivos,legenda,enviando,onRemover,onEnviar,onCancelar,isMobile}){
  if(!arquivos.length) return null;
  // Tamanho real do arquivo a partir do base64 (que é ~1/3 maior). Arredondar
  // para baixo dava "0 KB" em print pequeno, o que parece defeito.
  const tamanho=(b64)=>{const kb=(b64.length*3/4)/1024;
    return kb>=1024?`${(kb/1024).toFixed(1)} MB`:kb<1?"menos de 1 KB":`${Math.round(kb)} KB`;};
  return <div style={{background:C.surface,border:`1px solid ${C.green}55`,borderRadius:12,
    padding:10,marginBottom:8}}>
    <div style={{display:"flex",alignItems:"center",gap:7,marginBottom:8,flexWrap:"wrap"}}>
      <Icon n="link" size={13} color={C.greenDeep}/>
      <span style={{color:C.greenDeep,fontSize:12,fontWeight:700,flex:1}}>
        {arquivos.length===1?"1 imagem colada":`${arquivos.length} imagens coladas`} — confira antes de enviar
      </span>
    </div>
    <div style={{display:"flex",gap:8,flexWrap:"wrap",marginBottom:9}}>
      {arquivos.map((a,i)=><div key={i} style={{position:"relative"}}>
        <img src={a.previa} alt={a.nome} style={{width:isMobile?76:92,height:isMobile?76:92,
          objectFit:"cover",borderRadius:9,border:`1px solid ${C.line}`,display:"block",background:C.card}}/>
        <button onClick={()=>onRemover(i)} disabled={enviando} title="Tirar esta imagem"
          style={{position:"absolute",top:-6,right:-6,width:22,height:22,borderRadius:99,border:"none",
            background:C.hot,color:"#fff",fontSize:13,lineHeight:1,cursor:"pointer",fontWeight:700,
            display:"flex",alignItems:"center",justifyContent:"center",padding:0}}>×</button>
        <div style={{color:C.faint,fontSize:9.5,textAlign:"center",marginTop:2}}>{tamanho(a.base64)}</div>
      </div>)}
    </div>
    {legenda&&legenda.trim()&&<div style={{color:C.sub,fontSize:11.5,marginBottom:8,lineHeight:1.4}}>
      Vai com a legenda: <b style={{color:C.ink}}>“{legenda.trim().slice(0,90)}{legenda.trim().length>90?"…":""}”</b>
    </div>}
    <div style={{display:"flex",gap:7,flexWrap:"wrap"}}>
      <button onClick={onEnviar} disabled={enviando}
        style={{background:C.greenDeep,color:"#fff",border:"none",borderRadius:9,padding:"8px 16px",
          fontSize:12.5,fontWeight:700,cursor:"pointer",display:"flex",alignItems:"center",gap:6}}>
        <Icon n={enviando?"loader":"send"} size={13} spin={enviando}/>{enviando?"Enviando…":"Enviar"}</button>
      <button onClick={onCancelar} disabled={enviando}
        style={{background:C.card,color:C.sub,border:`1px solid ${C.line}`,borderRadius:9,padding:"8px 14px",
          fontSize:12.5,fontWeight:600,cursor:"pointer"}}>Cancelar</button>
    </div>
  </div>;
}

function Anexar({lead,acoes,isMobile,aoAvisar}){
  const [aberto,setAberto]=useState(false);
  const [ocupado,setOcupado]=useState("");
  const [gravando,setGravando]=useState(0); // segundos
  const gravador=useRef(null), pedacos=useRef([]), cronometro=useRef(null);
  const fotos=useRef(null), video=useRef(null);

  const aviso=(m)=>aoAvisar&&aoAvisar(m);

  async function mandar(lista,rotulo){
    setAberto(false); setOcupado(rotulo);
    try{
      const arquivos=await Promise.all(lista.map(lerArquivo));
      await acoes.anexar(lead.id,arquivos);
    }catch(e){ aviso(e.message); }
    finally{ setOcupado(""); }
  }

  function escolheuFotos(e){
    const lista=[...e.target.files]; e.target.value="";
    if(!lista.length) return;
    if(lista.length>LIMITE_FOTOS) return aviso(`Dá para mandar até ${LIMITE_FOTOS} fotos por vez. Você escolheu ${lista.length}.`);
    mandar(lista,"fotos");
  }
  function escolheuVideo(e){
    const f=e.target.files[0]; e.target.value="";
    if(f) mandar([f],"vídeo");
  }

  async function local(){
    setAberto(false);
    if(!navigator.geolocation) return aviso("Este aparelho não informa a localização.");
    setOcupado("local");
    navigator.geolocation.getCurrentPosition(
      async(pos)=>{ try{ await acoes.mandarLocal(lead.id,pos.coords.latitude,pos.coords.longitude); }
                    catch(e){ aviso(e.message); } finally{ setOcupado(""); } },
      ()=>{ setOcupado(""); aviso("Não consegui pegar sua localização. Confira se o navegador tem permissão de GPS."); },
      {enableHighAccuracy:true,timeout:12000}
    );
  }

  async function gravar(){
    setAberto(false);
    try{
      const stream=await navigator.mediaDevices.getUserMedia({audio:true});
      // O tipo varia por navegador; deixamos o próprio escolher o que sabe gravar.
      const rec=new MediaRecorder(stream);
      pedacos.current=[];
      rec.ondataavailable=(e)=>e.data.size&&pedacos.current.push(e.data);
      rec.onstop=async()=>{
        stream.getTracks().forEach(t=>t.stop());
        clearInterval(cronometro.current); setGravando(0);
        const blob=new Blob(pedacos.current,{type:rec.mimeType||"audio/webm"});
        // Só o tipo base: "audio/webm;codecs=opus" não bate com a lista do servidor.
        const mime=(rec.mimeType||"audio/webm").split(";")[0];
        setOcupado("áudio");
        try{
          const base64=await new Promise(ok=>{const r=new FileReader();r.onload=()=>ok(String(r.result).split(",")[1]);r.readAsDataURL(blob);});
          await acoes.anexar(lead.id,[{mime,nome:"audio",base64}]);
        }catch(e){ aviso(e.message); } finally{ setOcupado(""); }
      };
      gravador.current=rec; rec.start();
      setGravando(1); cronometro.current=setInterval(()=>setGravando(s=>s+1),1000);
    }catch(e){ aviso("Não consegui usar o microfone. Confira a permissão no navegador."); }
  }
  const pararGravacao=()=>gravador.current&&gravador.current.state!=="inactive"&&gravador.current.stop();

  if(gravando) return <div style={{display:"flex",alignItems:"center",gap:8,flexShrink:0}}>
    <span style={{display:"flex",alignItems:"center",gap:6,color:C.hot,fontSize:12.5,fontWeight:600,whiteSpace:"nowrap"}}>
      <span style={{width:9,height:9,borderRadius:"50%",background:C.hot}}/>
      {String(Math.floor(gravando/60)).padStart(2,"0")}:{String(gravando%60).padStart(2,"0")}
    </span>
    <button onClick={pararGravacao} title="Enviar áudio"
      style={{width:40,height:40,borderRadius:12,border:"none",background:C.green,color:"#fff",cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center"}}>
      <Icon n="send" size={17}/></button>
  </div>;

  const item=(icone,texto,onClick)=><button key={texto} onClick={onClick}
    style={{display:"flex",alignItems:"center",gap:9,width:"100%",border:"none",background:"transparent",cursor:"pointer",padding:"10px 14px",fontSize:13,color:C.ink,textAlign:"left"}}>
    <span style={{width:30,height:30,borderRadius:"50%",background:C.greenSoft,display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}>
      <Icon n={icone} size={15} color={C.greenMid}/></span>{texto}</button>;

  return <div style={{position:"relative",flexShrink:0}}>
    <input ref={fotos} type="file" accept="image/*" multiple onChange={escolheuFotos} style={{display:"none"}}/>
    <input ref={video} type="file" accept="video/*" onChange={escolheuVideo} style={{display:"none"}}/>
    {aberto&&<React.Fragment>
      <div onClick={()=>setAberto(false)} style={{position:"fixed",inset:0,zIndex:20}}/>
      <div style={{position:"absolute",bottom:52,left:0,zIndex:21,background:C.card,border:`1px solid ${C.line}`,borderRadius:12,boxShadow:"0 8px 24px rgba(0,0,0,.14)",padding:"5px 0",minWidth:186}}>
        {item("star",`Fotos (até ${LIMITE_FOTOS})`,()=>fotos.current.click())}
        {item("msg","Vídeo (1)",()=>video.current.click())}
        {item("phone","Gravar áudio",gravar)}
        {item("pin","Minha localização",local)}
      </div>
    </React.Fragment>}
    <button onClick={()=>setAberto(a=>!a)} disabled={!!ocupado} title="Anexar"
      style={{width:isMobile?40:42,height:isMobile?40:42,borderRadius:12,border:`1px solid ${C.line}`,background:C.surface,
        color:ocupado?C.faint:C.sub,cursor:ocupado?"default":"pointer",display:"flex",alignItems:"center",justifyContent:"center"}}>
      <Icon n={ocupado?"loader":"link"} size={18} spin={!!ocupado}/></button>
  </div>;
}

/* ===== MÍDIA NA CONVERSA =====
   Foto, áudio e documento que o cliente manda pelo WhatsApp. Antes o arquivo era
   descartado e sobrava "[ImageMessage]" na tela; agora o backend guarda e aqui a
   gente mostra. Clicar na imagem abre o tamanho real em outra aba — é como o
   corretor confere um comprovante sem sair do CRM. */
function Midia({m,mine,isMobile}){
  const {url,mime,nome}=m.midia;
  const larguraMax=isMobile?220:260;
  if(/^image\//.test(mime))
    return <a href={url} target="_blank" rel="noreferrer" style={{display:"block",marginBottom:m.text?6:0}}>
      <img src={url} alt={nome||"Foto enviada pelo cliente"} loading="lazy"
        style={{maxWidth:larguraMax,maxHeight:300,width:"auto",borderRadius:10,display:"block",background:C.coolSoft}}/>
    </a>;
  if(/^video\//.test(mime))
    return <video src={url} controls preload="metadata"
      style={{maxWidth:larguraMax,borderRadius:10,display:"block",marginBottom:m.text?6:0,background:"#000"}}/>;
  if(/^audio\//.test(mime))
    // O áudio de voz é o formato que mais chega: o cliente responde falando.
    return <audio src={url} controls preload="metadata"
      style={{maxWidth:isMobile?200:240,display:"block",marginBottom:m.text?6:0}}/>;
  // Documento (PDF, RG, comprovante): cartão para abrir ou baixar.
  return <a href={url} target="_blank" rel="noreferrer" download={nome||undefined}
    style={{display:"flex",alignItems:"center",gap:8,textDecoration:"none",marginBottom:m.text?6:0,
      background:mine?"rgba(255,255,255,.16)":C.surface,border:`1px solid ${mine?"rgba(255,255,255,.25)":C.line}`,
      borderRadius:10,padding:"9px 11px",maxWidth:larguraMax}}>
    <Icon n="mail" size={17} color={mine?"#fff":C.greenMid}/>
    <span style={{minWidth:0}}>
      <span style={{display:"block",color:mine?"#fff":C.ink,fontSize:12.5,fontWeight:600,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{nome||"Documento"}</span>
      <span style={{color:mine?"rgba(255,255,255,.75)":C.faint,fontSize:10.5}}>Abrir arquivo</span>
    </span>
  </a>;
}

/* ===== CONTROLE DA CONVERSA =====
   Os dois comandos que o atendente e o corretor usam para organizar a própria
   caixa de entrada. Ficam numa barra fina embaixo do cabeçalho: no celular não
   sobrava largura para enfiá-los ao lado do nome do lead.

   "Finalizar" encerra o ATENDIMENTO, não o negócio — a etapa do funil não muda,
   e o lead continua nos relatórios. Se o cliente responder, reabre sozinho.
   "Marcar como lida" vira "não lida" quando já está lida: abrir a conversa já
   marca sozinho, então sem o caminho de volta o botão não faria nada. */
function ControleConversa({lead,acoes,isMobile}){
  const [ocupado,setOcupado]=useState("");
  const roda=(nome,fn)=>async()=>{ setOcupado(nome); try{ await fn(lead.id); } finally{ setOcupado(""); } };
  const pill=(chave,icone,texto,onClick,cor)=><button key={chave} onClick={onClick} disabled={!!ocupado}
    style={{display:"flex",alignItems:"center",gap:5,border:`1px solid ${cor?cor+"55":C.line}`,background:cor?cor+"12":C.card,
      color:ocupado?C.faint:(cor||C.sub),fontSize:isMobile?12:11.5,fontWeight:600,padding:isMobile?"7px 12px":"5px 11px",
      borderRadius:999,cursor:ocupado?"default":"pointer",whiteSpace:"nowrap"}}>
    <Icon n={ocupado===chave?"loader":icone} size={12} spin={ocupado===chave}/>{texto}</button>;

  return <div style={{background:C.surface,borderBottom:`1px solid ${C.line}`,padding:isMobile?"8px 10px":"7px 16px",
    display:"flex",alignItems:"center",gap:7,flexShrink:0,overflowX:"auto"}}>
    {lead.unread>0
      ?pill("lida","check","Marcar como lida",roda("lida",acoes.marcarLida))
      :pill("naolida","msg","Marcar como não lida",roda("naolida",acoes.marcarNaoLida))}
    {lead.finalizado
      ?pill("reabrir","spark","Reabrir atendimento",roda("reabrir",acoes.reabrir),C.green)
      :pill("finalizar","check","Finalizar",roda("finalizar",acoes.finalizar),C.greenDeep)}
    {lead.finalizado&&<span style={{color:C.faint,fontSize:11,whiteSpace:"nowrap"}}>Atendimento encerrado · segue no funil em <b style={{color:C.sub}}>{lead.status}</b></span>}
  </div>;
}

/* ===== ATENDIMENTO ===== */
function Atendimento({myLeads,sel,abrir,draft,setDraft,send,enviando,setStatus,chatRef,conecta,session,acoes,canHandoff,availCorretores,isMobile,citando,setCitando,versaoMsgs}){
  const [filter,setFilter]=usarEscolha("atendimento.filtro","Todos");
  // No celular só cabe um painel por vez: lista → conversa → ficha.
  const [pane,setPane]=useState(()=>sel?"chat":"lista");
  const [enviandoImovel,setEnviandoImovel]=useState(false);
  // Avisos do anexo (limite de fotos, microfone negado, GPS bloqueado). Falha de
  // envio já é tratada pelo aviso geral do topo; aqui é o que acontece antes de sair.
  const [erroAnexo,setErroAnexo]=useState("");
  const [colando,setColando]=useState(false);
  /* Mensagem em edição: {id, texto}. O texto vai para o campo de baixo, então
     guardamos o rascunho de antes para devolver se a pessoa desistir. */
  const [editando,setEditando]=useState(null);
  const [erroEdicao,setErroEdicao]=useState("");
  const [salvandoEdicao,setSalvandoEdicao]=useState(false);
  const rascunhoAntes=useRef("");
  // Imagens coladas esperando confirmação. Só saem no botão Enviar.
  const [colados,setColados]=useState([]);
  const [mandandoColados,setMandandoColados]=useState(false);
  const mensagensProntas=usarMensagensRapidas(acoes,versaoMsgs);
  const podeSupervisionar=session.role==="adm"||session.role==="sdr";
  const colar=usarColar({lead:sel,aoAvisar:setErroAnexo,aoMudarEstado:setColando,
    quantasJa:colados.length, aoColar:(novas)=>setColados(a=>[...a,...novas])});
  // Trocar de conversa descarta o que estava para enviar: imagem colada na
  // conversa de um cliente não pode ir parar na de outro.
  useEffect(()=>{setColados([]);},[sel&&sel.id]);
  async function enviarColados(){
    if(!colados.length||mandandoColados) return;
    setMandandoColados(true); setErroAnexo("");
    const legenda=draft.trim();
    try{
      await acoes.anexar(sel.id,colados.map(({previa,...a})=>a),legenda||undefined);
      setColados([]); if(legenda) setDraft("");
    }catch(e){ setErroAnexo(e.message); }
    finally{ setMandandoColados(false); }
  }

  function abrirEdicao(m){
    rascunhoAntes.current=draft;
    setEditando({id:m.id,texto:m.text||""});
    setDraft(m.text||"");
    // Editar, citar e colar disputam o mesmo campo: entrar em um cancela os
    // outros, senão o botão de enviar teria três significados ao mesmo tempo.
    setCitando(null); setColados([]); setErroEdicao("");
  }
  function cancelarEdicao(){ setDraft(rascunhoAntes.current); setEditando(null); setErroEdicao(""); }
  async function salvarEdicao(){
    if(!draft.trim()||salvandoEdicao) return;
    setSalvandoEdicao(true); setErroEdicao("");
    try{ await acoes.editarMensagem(sel.id,editando.id,draft.trim()); setDraft(rascunhoAntes.current); setEditando(null); }
    catch(e){ setErroEdicao(e.message); }
    finally{ setSalvandoEdicao(false); }
  }
  // Trocar de conversa cancela a edição em aberto.
  useEffect(()=>{setEditando(null);setErroEdicao("");},[sel&&sel.id]);
  const isCompact=useIsCompact();
  const fichaPorBotao=isMobile||isCompact; // ficha não cabe fixa ao lado
  // Finalizado sai da caixa de entrada, mas continua acessível pelo filtro —
  // é assim que o corretor reabre um atendimento que encerrou sem querer.
  const list=myLeads.filter(l=>filter==="Finalizados"?l.finalizado:!l.finalizado)
    .filter(l=>["Todos","Finalizados"].includes(filter)?true:filter==="Aguardando"?l.unread>0:l.prio===filter.toUpperCase());
  const openChat=(id)=>{abrir(id);setPane("chat");};
  // Se o lead sai da conta (repasse da SDR), volta sozinho para a lista.
  useEffect(()=>{if(!sel&&pane!=="lista")setPane("lista");},[sel,pane]);
  const showList=!isMobile||pane==="lista";
  const showChat=!!sel&&(isMobile?pane==="chat":(fichaPorBotao?pane!=="ficha":true));
  const showFicha=!!sel&&(fichaPorBotao?pane==="ficha":true);
  const backBtn=(onClick,label)=><button onClick={onClick} aria-label={label} style={{width:34,height:34,marginRight:2,borderRadius:10,border:"none",background:C.surface,color:C.sub,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0,transform:"scaleX(-1)"}}><Icon n="chevron" size={17}/></button>;

  return <div style={{height:"100%",display:"flex",minHeight:0}}>
    {showList&&<div style={{width:isMobile?"100%":isCompact?250:300,flexShrink:0,borderRight:isMobile?"none":`1px solid ${C.line}`,background:C.card,display:"flex",flexDirection:"column",minHeight:0}}>
      <div style={{padding:12,borderBottom:`1px solid ${C.line}`}}>
        <div style={{display:"flex",gap:6,flexWrap:"wrap"}}>{["Todos","Aguardando","Quente","Morno","Finalizados"].map(f=><button key={f} onClick={()=>setFilter(f)} style={{fontSize:isMobile?12.5:11,fontWeight:500,padding:isMobile?"7px 14px":"4px 10px",borderRadius:999,border:"none",cursor:"pointer",background:filter===f?C.greenDeep:C.surface,color:filter===f?"#fff":C.sub}}>{f}</button>)}</div>
      </div>
      <div style={{flex:1,overflowY:"auto"}}>
        {list.length===0&&<div style={{color:C.faint,fontSize:13,textAlign:"center",padding:32}}>Nenhum lead aqui 🎉</div>}
        {list.map(l=><ItemLead key={l.id} l={l} ativo={!isMobile&&sel&&sel.id===l.id} onClick={()=>openChat(l.id)} isMobile={isMobile}/>)}
      </div>
    </div>}
    {showChat&&<div style={{flex:1,display:"flex",flexDirection:"column",minWidth:0,minHeight:0,background:C.surface}}>
      <div style={{background:C.card,borderBottom:`1px solid ${C.line}`,height:56,display:"flex",alignItems:"center",justifyContent:"space-between",padding:isMobile?"0 10px":"0 16px",gap:8,flexShrink:0}}>
        <div style={{display:"flex",alignItems:"center",gap:isMobile?8:12,minWidth:0}}>
          {isMobile&&backBtn(()=>setPane("lista"),"Voltar para a lista")}
          <Avatar ini={initials(sel.nome)} color={prioDe(sel.prio).c} size={36}/>
          <div style={{minWidth:0}}><div style={{color:C.ink,fontSize:14,fontWeight:600,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{sel.nome}</div><div style={{color:C.faint,fontSize:11.5,display:"flex",alignItems:"center",gap:4}}><Icon n="phone" size={11}/>{fmtTel(sel.tel)}</div></div>
        </div>
        <div style={{display:"flex",alignItems:"center",gap:7,flexShrink:0}}>
          <BotaoLigar tel={sel.tel} compacto={isMobile} leadId={sel.id} acoes={acoes} nome={sel.nome}/>
          {fichaPorBotao
            ?<button onClick={()=>setPane("ficha")} style={{display:"flex",alignItems:"center",gap:5,border:`1px solid ${C.line}`,background:C.surface,color:C.sub,fontSize:12,fontWeight:600,padding:"7px 12px",borderRadius:10,cursor:"pointer"}}><Icon n="star" size={13} color={prioDe(sel.prio).c} fill={prioDe(sel.prio).c}/> Ficha</button>
            :<div style={{color:conecta.connected?C.green:C.faint,background:conecta.connected?C.greenSoft:C.coolSoft,fontSize:11,fontWeight:600,padding:"4px 10px",borderRadius:999,display:"flex",alignItems:"center",gap:4}}><Icon n={conecta.connected?"wifi":"wifioff"} size={12}/>Número da Conecta</div>}
        </div>
      </div>
      <ControleConversa lead={sel} acoes={acoes} isMobile={isMobile}/>
      <div ref={chatRef} style={{flex:1,overflowY:"auto",padding:isMobile?"14px 12px":"16px 20px",display:"flex",flexDirection:"column",gap:8,minHeight:0}}>
        {sel.msgs.length===0&&<div style={{color:C.faint,margin:"auto",textAlign:"center",maxWidth:280}}><Icon n="spark" size={22} color={C.green}/><div style={{fontSize:13,marginTop:8}}>Lead ainda não contatado.<br/>Use um modelo e fale agora — quanto mais rápido, maior a chance.</div></div>}
        {sel.msgs.map((m,i)=>{
          const abreDia=i===0||!mesmoDia(m.at,sel.msgs[i-1].at);
          /* Aviso central (hoje: as ligações). `maxWidth` e a quebra de palavra
             não são enfeite: a observação da ligação vai até 300 caracteres e
             sem isso ela estourava a largura da conversa. */
          if(m.from==="system")return <div key={i} style={{alignSelf:"center",background:C.amberSoft,color:"#8a6d1f",fontSize:11,fontWeight:600,padding:"4px 12px",borderRadius:14,margin:"2px 0",maxWidth:"92%",textAlign:"center",lineHeight:1.45,overflowWrap:"anywhere"}}>{m.text}</div>;
          const mine=m.from==="corretor";
          /* Sem assinatura significa que saiu do celular, e nao do CRM: o
             numero e compartilhado e o WhatsApp nao diz quem digitou. Dizer
             isso e melhor do que assinar com o nome de quem esta olhando. */
          const peloCelular=mine&&!m.byName;
          const senderName=peloCelular?"Enviada pelo WhatsApp":`${m.byName} · Conecta`;
          return <React.Fragment key={i}>
            {abreDia&&<SeparadorDia ts={m.at}/>}
            <div style={{display:"flex",justifyContent:mine?"flex-end":"flex-start",alignItems:"center",gap:6,
              opacity:editando&&editando.id===m.id?.45:1}}>
            {mine&&<BotaoEditar m={m} podeEditar={!m.byName||m.by===session.id||podeSupervisionar} aoEditar={()=>abrirEdicao(m)}/>}
            {mine&&<BotaoResponder m={m} aoResponder={setCitando}/>}
            <div style={{maxWidth:isMobile?"86%":"74%",padding:"8px 12px",fontSize:13.5,lineHeight:1.35,borderRadius:16,background:mine?C.green:C.card,color:mine?"#fff":C.ink,border:mine?"none":`1px solid ${C.line}`,boxShadow:"0 1px 2px rgba(0,0,0,.04)",borderBottomRightRadius:mine?4:16,borderBottomLeftRadius:mine?16:4}}>
              {mine&&<div style={{fontSize:10.5,fontWeight:700,color:"rgba(255,255,255,.85)",marginBottom:2,fontStyle:peloCelular?"italic":"normal"}}>{senderName}</div>}
              <Citacao c={m.citada} claro={mine}/>
              {m.midia&&<Midia m={m} mine={mine} isMobile={isMobile}/>}
              {!m.rotuloAuto&&m.text}<div style={{color:mine?"rgba(255,255,255,.7)":C.faint,fontSize:10,marginTop:2,textAlign:"right"}}>
                {m.editadaEm?<span style={{fontStyle:"italic",marginRight:5}}>editada</span>:null}{fmtClock(m.at)}</div>
            </div>
            {!mine&&<BotaoResponder m={m} aoResponder={setCitando}/>}
            </div>
          </React.Fragment>;})}
        {sel.cutucadoEm&&<AvisoCutucada lead={sel} acoes={acoes}/>}
        {sel.finalizado&&sel.finalizadoEm&&<FechoAtendimento lead={sel}/>}
      </div>
      <div style={{background:C.card,borderTop:`1px solid ${C.line}`,padding:12,flexShrink:0}}>
        <div style={{display:"flex",gap:6,marginBottom:8,overflowX:"auto",paddingBottom:4}}>
          <button onClick={()=>setEnviandoImovel(true)} style={{fontSize:11,fontWeight:600,padding:"4px 10px",borderRadius:999,border:`1px solid ${C.green}55`,cursor:"pointer",whiteSpace:"nowrap",display:"flex",alignItems:"center",gap:4,color:C.greenDeep,background:C.card,flexShrink:0}}><Icon n="pin" size={11}/> Enviar imóvel</button>
          {mensagensProntas.map(tp=><button key={tp.id} onClick={()=>setDraft(tp.corpo)} style={{fontSize:11,fontWeight:500,padding:"4px 10px",borderRadius:999,border:"none",cursor:"pointer",whiteSpace:"nowrap",display:"flex",alignItems:"center",gap:4,color:C.greenMid,background:C.greenSoft,flexShrink:0}}><Icon n="zap" size={11}/> {tp.titulo}</button>)}
        </div>
        {enviandoImovel&&<EnviarImovel lead={sel} acoes={acoes} isMobile={isMobile} aoFechar={()=>setEnviandoImovel(false)}/>}
        <PreviaColagem arquivos={colados} legenda={draft} enviando={mandandoColados} isMobile={isMobile}
          onRemover={(i)=>setColados(a=>a.filter((_,k)=>k!==i))}
          onEnviar={enviarColados} onCancelar={()=>setColados([])}/>
        {editando&&<BarraEdicao texto={editando.texto} erro={erroEdicao} isMobile={isMobile} aoCancelar={cancelarEdicao}/>}
        {citando&&<Citacao c={citando} aoFechar={()=>setCitando(null)}/>}
        <div style={{display:"flex",alignItems:"flex-end",gap:8}}>
          <Anexar lead={sel} acoes={acoes} isMobile={isMobile} aoAvisar={setErroAnexo}/>
          {/* 16px no celular evita o zoom automático do iOS ao focar o campo */}
          <textarea value={draft} onChange={e=>setDraft(e.target.value)} onPaste={colar} onKeyDown={e=>{
            if(e.key==="Escape"&&editando){e.preventDefault();cancelarEdicao();return;}
            if(e.key==="Enter"&&!e.shiftKey&&!isMobile){e.preventDefault();editando?salvarEdicao():colados.length?enviarColados():send();}}} rows={2} placeholder={colando?"Colando a imagem…":isMobile?"Escreva a mensagem…":"Escreva a mensagem…  (cole uma imagem com Ctrl+V)"} style={{flex:1,minWidth:0,fontSize:isMobile?16:13.5,borderRadius:12,border:`1px solid ${C.line}`,padding:"8px 12px",outline:"none",resize:"none",color:C.ink,background:C.surface,fontFamily:FONT}}/>
          {/* Com imagem colada esperando, o botão manda a imagem (com a legenda
              digitada) em vez de mandar só o texto e deixar a foto para trás. */}
          {/* Durante a edição o mesmo botão SALVA — dois botões de ação no mesmo
              canto seria o jeito mais fácil de mandar a mensagem sem querer. */}
          <button onClick={()=>editando?salvarEdicao():colados.length?enviarColados():send()}
            title={editando?"Salvar a edição":"Enviar"}
            disabled={enviando||mandandoColados||salvandoEdicao||(!draft.trim()&&!colados.length)}
            style={{width:44,height:44,borderRadius:12,border:"none",cursor:enviando?"default":"pointer",background:enviando||mandandoColados||salvandoEdicao||(!draft.trim()&&!colados.length)?C.faint:(editando?C.greenDeep:C.green),color:"#fff",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}><Icon n={enviando||mandandoColados||salvandoEdicao?"loader":editando?"check":"send"} size={18} spin={enviando||mandandoColados||salvandoEdicao}/></button>
        </div>
        {erroAnexo&&<div onClick={()=>setErroAnexo("")} style={{color:C.hot,background:C.hotSoft,fontSize:11.5,marginTop:6,padding:"6px 9px",borderRadius:8,cursor:"pointer"}}>{erroAnexo}</div>}
        <div style={{color:C.faint,fontSize:10.5,marginTop:6,display:"flex",alignItems:"center",gap:5}}><Icon n="msg" size={11} color={C.faint}/> Sai pelo número da Conecta, assinada como <b style={{color:C.sub}}>&nbsp;{first(session.name)}</b>.</div>
      </div>
    </div>}
    {!isMobile&&!sel&&<div style={{flex:1,background:C.surface}}/>}
    {showFicha&&<div style={{width:fichaPorBotao?"100%":264,flex:fichaPorBotao?1:"none",flexShrink:0,borderLeft:fichaPorBotao?"none":`1px solid ${C.line}`,background:C.card,overflowY:"auto",minHeight:0}}>
      <div style={{padding:16}}>
        <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:12}}>
          {fichaPorBotao&&backBtn(()=>setPane("chat"),"Voltar para a conversa")}
          <Icon n="star" size={14} color={prioDe(sel.prio).c} fill={prioDe(sel.prio).c}/><span style={{color:C.ink,fontSize:13,fontWeight:700}}>Ficha do lead</span>
        </div>

        <NomeDoLead lead={sel} acoes={acoes}/>

        {/* O corretor que acabou de receber o lead é quem mais precisa do
            resumo — foi ele que não acompanhou a conversa até aqui. */}
        <ResumoIA lead={sel} acoes={acoes} isMobile={isMobile}/>
        <EtapaIA lead={sel} acoes={acoes} isMobile={isMobile}/>
        <TarefasDoLead lead={sel} acoes={acoes} isMobile={isMobile}/>
        {canHandoff&&<div style={{background:C.greenSoft,border:`1px solid ${C.green}33`,borderRadius:12,padding:12,marginBottom:14}}>
          <div style={{color:C.greenDeep,fontSize:11.5,fontWeight:600,display:"flex",alignItems:"center",gap:5,marginBottom:6}}><Icon n="transfer" size={13} color={C.greenMid}/> Primeiro atendimento da SDR</div>
          <div style={{color:C.sub,fontSize:11.5,lineHeight:1.4,marginBottom:8}}>Faça o contato inicial e repasse — o lead sai da sua conta e vai para o corretor.</div>
          <button onClick={()=>acoes.repassar(sel.id)} disabled={!availCorretores.length} style={{width:"100%",background:availCorretores.length?C.green:C.coolSoft,color:availCorretores.length?"#fff":C.faint,border:"none",cursor:availCorretores.length?"pointer":"default",fontSize:12.5,fontWeight:600,padding:"9px",borderRadius:9,display:"flex",alignItems:"center",justifyContent:"center",gap:6}}><Icon n="transfer" size={14}/> Passar para o corretor da vez</button>
          <div style={{color:C.faint,fontSize:10.5,margin:"8px 0 5px"}}>ou escolher um corretor:</div>
          <div style={{display:"flex",flexWrap:"wrap",gap:5}}>
            {availCorretores.length?availCorretores.map(b=><button key={b.id} onClick={()=>acoes.repassar(sel.id,b.id)} title={b.name} style={{display:"flex",alignItems:"center",gap:5,border:`1px solid ${C.line}`,background:C.card,borderRadius:999,padding:"3px 9px 3px 3px",cursor:"pointer"}}><Avatar ini={b.ini} color={b.color} size={20}/><span style={{color:C.ink,fontSize:11.5,fontWeight:500}}>{first(b.name)}</span></button>):<span style={{color:C.hot,fontSize:11}}>Nenhum corretor disponível agora.</span>}
          </div>
        </div>}
        <label style={{color:C.faint,fontSize:10.5,fontWeight:600,textTransform:"uppercase",letterSpacing:.5}}>Etapa do funil</label>
        <select value={sel.status} onChange={e=>setStatus(sel.id,e.target.value)} style={{width:"100%",marginTop:4,marginBottom:8,fontSize:isMobile?16:13,fontWeight:600,borderRadius:8,border:`1px solid ${C.line}`,padding:"8px 10px",outline:"none",color:STAGE_C[sel.status],background:C.surface}}>{STAGES.map(s=><option key={s} value={s}>{s}</option>)}</select>
        <DicaEtapa etapa={sel.status}/>
        <div style={{display:"flex",flexDirection:"column",gap:10}}>
          {[["Renda familiar",sel.qual.renda,"target"],["Entrada",sel.qual.entrada,"check"],["Situação",sel.qual.situacao,"users"],["Restrição CPF",sel.qual.cpf,"award"],["Prazo p/ comprar",sel.qual.prazo,"calendar"]].map(([k,v,n])=><div key={k}><div style={{color:C.faint,fontSize:10.5,fontWeight:600,display:"flex",alignItems:"center",gap:4,marginBottom:2}}><Icon n={n} size={11}/>{k}</div><div style={{color:C.ink,fontSize:12.5,fontWeight:500}}>{v}</div></div>)}
        </div>
        <FichaVenda lead={sel} onSalvar={(d)=>acoes.registrarVenda(sel.id,d)}/>
        <div style={{borderTop:`1px solid ${C.line}`,marginTop:16,paddingTop:12,display:"flex",flexDirection:"column",gap:6}}>
          <div style={{color:C.sub,fontSize:11.5,display:"flex",alignItems:"center",gap:6}}><Icon n="mail" size={12} color={C.faint}/> via {sel.origem}</div>
          <div style={{color:C.sub,fontSize:11.5,display:"flex",alignItems:"center",gap:6}}><Icon n="clock" size={12} color={C.faint}/> entrou há {fmtAge(Date.now()-sel.createdAt)}</div>
        </div>
      </div>
    </div>}
  </div>;
}

/* ===== REGISTRO DE VENDA (pedido do Ali: valor, data e qual imóvel) ===== */
function FichaVenda({lead,onSalvar}){
  const v=lead.venda;
  const [aberto,setAberto]=useState(false);
  const [f,setF]=useState({valor:"",data:new Date().toISOString().slice(0,10),imovel:""});
  const [erro,setErro]=useState("");
  useEffect(()=>{ setAberto(false); setErro("");
    setF({valor:v?String(v.valor):"",data:v&&v.data?new Date(v.data).toISOString().slice(0,10):new Date().toISOString().slice(0,10),imovel:v&&v.imovel||""});
  },[lead.id]);

  async function salvar(){
    const valor=numeroBR(f.valor);
    if(!valor||valor<=0) return setErro("Informe o valor da venda.");
    setErro(""); await onSalvar({valor,data:f.data,imovel:f.imovel}); setAberto(false);
  }

  if(v&&!aberto) return <div style={{background:C.greenSoft,border:`1px solid ${C.green}33`,borderRadius:12,padding:12,marginTop:14}}>
    <div style={{color:C.greenDeep,fontSize:11.5,fontWeight:700,display:"flex",alignItems:"center",gap:5,marginBottom:8}}><Icon n="check" size={13} color={C.greenMid}/> Venda registrada</div>
    <div style={{color:C.greenDeep,fontFamily:MONO,fontSize:19,fontWeight:700}}>{fmtMoeda(v.valor)}</div>
    <div style={{color:C.sub,fontSize:11.5,marginTop:4}}>{v.imovel||"Imóvel não informado"} · {fmtData(v.data)}</div>
    <button onClick={()=>setAberto(true)} style={{marginTop:8,border:"none",background:"transparent",color:C.greenMid,fontSize:11.5,fontWeight:600,cursor:"pointer",padding:0}}>Editar registro</button>
  </div>;

  if(!aberto) return <button onClick={()=>setAberto(true)} style={{width:"100%",marginTop:14,display:"flex",alignItems:"center",justifyContent:"center",gap:6,border:`1px dashed ${C.green}66`,background:C.greenSoft,color:C.greenMid,fontSize:12.5,fontWeight:600,padding:"10px",borderRadius:12,cursor:"pointer"}}><Icon n="award" size={14}/> Registrar venda</button>;

  return <div style={{background:C.card,border:`1px solid ${C.green}55`,borderRadius:12,padding:12,marginTop:14}}>
    <div style={{color:C.ink,fontSize:12,fontWeight:700,marginBottom:8}}>Registrar venda</div>
    <label style={{color:C.faint,fontSize:10.5,fontWeight:600}}>Valor do imóvel</label>
    <div style={{margin:"3px 0 8px"}}><CampoMoeda valor={f.valor} onChange={v=>setF({...f,valor:v})} placeholder="285.000,00"/></div>
    <label style={{color:C.faint,fontSize:10.5,fontWeight:600}}>Data da venda</label>
    <input type="date" value={f.data} onChange={e=>setF({...f,data:e.target.value})}
      style={{width:"100%",margin:"3px 0 8px",fontSize:16,border:`1px solid ${C.line}`,borderRadius:8,padding:"8px 10px",outline:"none",background:C.surface,color:C.ink}}/>
    <label style={{color:C.faint,fontSize:10.5,fontWeight:600}}>Qual imóvel</label>
    <input value={f.imovel} onChange={e=>setF({...f,imovel:e.target.value})} placeholder="Ex.: Jardim Amazonas — Casa 14"
      style={{width:"100%",margin:"3px 0 8px",fontSize:16,border:`1px solid ${C.line}`,borderRadius:8,padding:"8px 10px",outline:"none",background:C.surface,color:C.ink}}/>
    {erro&&<div style={{color:C.hot,fontSize:11.5,marginBottom:8}}>{erro}</div>}
    <div style={{display:"flex",gap:6}}>
      <button onClick={salvar} style={{flex:1,background:C.green,color:"#fff",border:"none",borderRadius:9,padding:"9px",fontSize:12.5,fontWeight:600,cursor:"pointer"}}>Salvar</button>
      <button onClick={()=>setAberto(false)} style={{border:`1px solid ${C.line}`,background:C.card,color:C.sub,borderRadius:9,padding:"9px 12px",fontSize:12.5,cursor:"pointer"}}>Cancelar</button>
    </div>
    <div style={{color:C.faint,fontSize:10.5,marginTop:7,lineHeight:1.4}}>Ao salvar, o lead vai para a etapa <b>Venda</b> e entra no seu relatório.</div>
  </div>;
}

/* ===== FUNIL ===== */
/* ===== FUNIL (kanban) =====
   Arrastar o lead de uma etapa para outra: segurar, arrastar, soltar.

   Feito com Pointer Events em vez do arrastar nativo do HTML porque o nativo
   não funciona em celular — e é no celular que o corretor usa. O mesmo código
   atende dedo e mouse.

   No celular precisa SEGURAR um instante antes de arrastar (250ms). Sem essa
   espera, qualquer rolagem lateral entre as colunas viraria um arrasto sem
   querer, e o lead mudava de etapa sozinho. */
function Funil({leads,openLead,setStatus,isMobile,mostrarDono,acoes}){
  // Lead aberto no popup. Fica aqui, e não dentro do card, porque só um abre
  // por vez e o fundo escuro é da tela inteira.
  const [aberto,setAberto]=useState(null);
  const abrirCard=(l)=>setAberto(l.id);
  const colW=isMobile?"82vw":164;
  const [arrasto,setArrasto]=useState(null);   // {id,nome,de,x,y}
  const [alvo,setAlvo]=useState(null);         // etapa sob o dedo
  const colunas=useRef({});                    // etapa -> elemento, para medir onde soltou
  const espera=useRef(null);
  const moveu=useRef(false);

  const cancelarEspera=()=>{ if(espera.current){clearTimeout(espera.current);espera.current=null;} };

  const etapaEm=(x,y)=>{
    for(const [etapa,el] of Object.entries(colunas.current)){
      if(!el) continue;
      const r=el.getBoundingClientRect();
      if(x>=r.left&&x<=r.right&&y>=r.top&&y<=r.bottom) return etapa;
    }
    return null;
  };

  const aoPressionar=(e,lead)=>{
    if(e.pointerType==="mouse"&&e.button!==0) return;
    moveu.current=false;
    const {clientX:x,clientY:y}=e;
    espera.current=setTimeout(()=>{
      espera.current=null;
      setArrasto({id:lead.id,nome:lead.nome,de:lead.status,x,y});
      setAlvo(lead.status);
      if(navigator.vibrate) navigator.vibrate(12);   // confirma que pegou
    },250);
  };

  const aoMover=(e)=>{
    if(!arrasto){
      // Mexeu antes dos 250ms: é rolagem, não arrasto.
      if(espera.current) cancelarEspera();
      return;
    }
    e.preventDefault();
    moveu.current=true;
    setArrasto(a=>a&&{...a,x:e.clientX,y:e.clientY});
    setAlvo(etapaEm(e.clientX,e.clientY));
  };

  const aoSoltar=()=>{
    cancelarEspera();
    if(arrasto&&alvo&&alvo!==arrasto.de) setStatus(arrasto.id,alvo);
    setArrasto(null); setAlvo(null);
  };
  return <div onPointerMove={aoMover} onPointerUp={aoSoltar} onPointerCancel={aoSoltar}
    style={{height:"100%",overflowX:"auto",overflowY:"hidden",padding:isMobile?12:16,
      // Durante o arrasto a rolagem trava: senão a tela corre junto com o dedo.
      scrollSnapType:isMobile&&!arrasto?"x mandatory":"none",touchAction:arrasto?"none":"auto"}}>
    <div style={{display:"flex",gap:12,height:"100%",minWidth:isMobile?"auto":STAGES.length*172}}>
      {STAGES.map(st=>{const items=leads.filter(l=>l.status===st);
        const destacada=arrasto&&alvo===st&&alvo!==arrasto.de;
        return <div key={st} style={{width:colW,flexShrink:0,scrollSnapAlign:isMobile&&!arrasto?"start":"none",display:"flex",flexDirection:"column",minHeight:0}}>
          <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:8,padding:"0 4px"}}><div style={{display:"flex",alignItems:"center",gap:6,minWidth:0}}><span style={{background:STAGE_C[st],width:8,height:8,borderRadius:"50%",flexShrink:0}}/><span style={{color:C.ink,fontSize:12,fontWeight:700,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{st}</span></div><span style={{color:C.faint,fontFamily:MONO,fontSize:11,fontWeight:600}}>{items.length}</span></div>
          <div ref={el=>{colunas.current[st]=el;}}
            style={{flex:1,borderRadius:12,border:`1px solid ${destacada?STAGE_C[st]:C.line}`,
              background:destacada?STAGE_C[st]+"14":C.surface,padding:6,overflowY:arrasto?"hidden":"auto",
              display:"flex",flexDirection:"column",gap:6,transition:"background .12s,border-color .12s"}}>
            {items.map(l=>{
              const sendoArrastado=arrasto&&arrasto.id===l.id;
              return <CardFunil key={l.id} l={l} mostrarDono={mostrarDono} arrastando={!!arrasto}
                opaco={sendoArrastado} aoPressionar={aoPressionar} moveu={moveu}
                aoAbrir={()=>{ if(!moveu.current) abrirCard(l); }}/>;})}
            {items.length===0&&<div style={{color:C.faint,fontSize:10.5,textAlign:"center",padding:"12px 0"}}>—</div>}
          </div>
        </div>;})}
    </div>
    {/* O cartao fantasma segue o dedo: sem ele, arrastar no celular vira um
        gesto as cegas — nada indica que o lead esta na mao. */}
    {arrasto&&<div style={{position:"fixed",left:arrasto.x,top:arrasto.y,transform:"translate(-50%,-50%) rotate(-2deg)",
      pointerEvents:"none",zIndex:60,background:C.card,border:`1px solid ${C.green}`,borderRadius:8,
      padding:"8px 12px",boxShadow:"0 10px 24px rgba(0,0,0,.22)",maxWidth:200}}>
      <div style={{color:C.ink,fontSize:12,fontWeight:700,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{arrasto.nome}</div>
      <div style={{color:alvo&&alvo!==arrasto.de?STAGE_C[alvo]:C.faint,fontSize:10.5,fontWeight:600,marginTop:2}}>
        {alvo&&alvo!==arrasto.de?"soltar em "+alvo:"arraste até uma etapa"}</div>
    </div>}
    {aberto&&<PopupLead leadId={aberto} leads={leads} acoes={acoes} isMobile={isMobile}
      abrirConversa={openLead} aoFechar={()=>setAberto(null)}/>}
  </div>;
}

/* ===== O QUE A IA DIZ SOBRE ESTE LEAD, SEM SAIR DO FUNIL =====

   Clicar num card jogava direto na conversa. Para decidir o que fazer com um
   lead parado, porém, ler 40 mensagens não ajuda — o que ajuda é o resumo e a
   etapa que a IA leu. Eram os dois cartões da ficha, e ficavam a dois cliques
   e uma troca de tela de distância.

   Agora o card abre este popup: as mesmas leituras da ficha, mais as tarefas
   marcadas, e um botão do WhatsApp para ir à conversa quando a decisão for
   falar com o cliente. Sem sair do quadro é possível olhar dez leads parados
   em sequência — que é justamente o que se faz no funil. */
function PopupLead({leadId,leads,acoes,abrirConversa,aoFechar,isMobile}){
  const alturaBarra=usarAlturaDaBarra();
  const l=leads.find(x=>x.id===leadId);
  useEffect(()=>{ if(leadId) acoes.abrir(leadId,true); },[leadId]);
  if(!l) return null;

  /* `maxHeight:100%` em vez de 90vh: a caixa de fora JÁ tem a altura certa da
     tela (classe `tela-cheia`), então o rodapé com o botão do WhatsApp fica no
     fim do que se vê — e não no fim de uma tela imaginária maior que a real. */
  return <div onClick={aoFechar} className="tela-cheia" style={{zIndex:70,background:"rgba(10,20,16,.5)",
    display:"flex",alignItems:isMobile?"flex-end":"center",justifyContent:"center",
    padding:isMobile?0:20,
    /* A folha para ACIMA da barra de navegação. Ela cobriria a barra sem
       problema — é um popup —, mas o botão do WhatsApp ficava exatamente na
       faixa dela, e no iPhone acabava por baixo. Parando antes, o botão fica
       no lugar certo em qualquer aparelho, sem depender de quem desenha por
       cima de quem. */
    paddingBottom:isMobile?alturaBarra:20}}>
    <div onClick={e=>e.stopPropagation()} style={{background:C.card,borderRadius:isMobile?"16px 16px 0 0":16,
      width:"100%",maxWidth:520,maxHeight:"100%",display:"flex",flexDirection:"column",minHeight:0}}>

      <div style={{padding:isMobile?"14px 15px 10px":"16px 18px 12px",borderBottom:`1px solid ${C.line}`,
        display:"flex",alignItems:"center",gap:10,flexShrink:0}}>
        <Avatar ini={initials(l.nome)} color={prioDe(l.prio).c} size={38}/>
        <div style={{minWidth:0,flex:1}}>
          <div style={{color:C.ink,fontSize:14.5,fontWeight:700,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{l.nome}</div>
          <div style={{color:C.faint,fontSize:11.5}}>
            <span style={{color:STAGE_C[l.status],fontWeight:600}}>{l.status}</span>
            {l.etapaDesde?` há ${fmtCurto(Date.now()-l.etapaDesde)}`:""} · {fmtTel(l.tel)}
          </div>
        </div>
        <button onClick={aoFechar} aria-label="Fechar" style={{border:"none",background:C.surface,color:C.sub,
          width:32,height:32,borderRadius:9,cursor:"pointer",fontSize:16,flexShrink:0}}>×</button>
      </div>

      <div style={{flex:1,overflowY:"auto",padding:isMobile?"12px 15px":"14px 18px",minHeight:0}}>
        {!l.carregado&&<div style={{color:C.faint,fontSize:12.5,padding:"10px 0",display:"flex",alignItems:"center",gap:7}}>
          <Icon n="loader" size={14} spin/> Buscando a conversa…</div>}
        {/* A etapa lida pela IA NÃO entra aqui, a pedido do Ali: ela mora na
            ficha do lead. Aqui o popup responde "o que está acontecendo com
            este cliente"; mudar a etapa dele é decisão de quem está atendendo,
            no lugar onde se atende. Duas telas oferecendo a mesma decisão é
            como o mesmo lead acaba movido duas vezes. */}
        <ResumoIA lead={l} acoes={acoes} isMobile={isMobile}/>
        <TarefasDoLead lead={l} acoes={acoes} isMobile={isMobile}/>
      </div>

      {/* O botão do WhatsApp é a saída para a ação: li o que a IA disse, agora
          vou falar com o cliente. Fica fixo no rodapé para não depender de
          rolar até o fim do popup. */}
      <div style={{padding:isMobile?"10px 15px calc(env(safe-area-inset-bottom, 0px) + 12px)":"12px 18px",
        borderTop:`1px solid ${C.line}`,flexShrink:0}}>
        <button onClick={()=>{aoFechar();abrirConversa(l.id);}}
          style={{width:"100%",background:"#25D366",color:"#fff",border:"none",borderRadius:11,padding:"12px",
            fontSize:14,fontWeight:700,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",gap:8}}>
          <Icon n="whatsapp" size={17}/> Abrir a conversa
        </button>
      </div>
    </div>
  </div>;
}

/* Tarefas marcadas com este cliente. Pequeno de propósito: o que precisa ser
   feito, quando, e um risco para dizer que já foi. Tarefa vencida fica em
   coral — é a única que muda alguma coisa em quem está olhando. */
function TarefasDoLead({lead,acoes,isMobile}){
  const [lista,setLista]=useState(lead.listaTarefas||[]);
  const [titulo,setTitulo]=useState("");
  const [quando,setQuando]=useState("");
  const [abrindo,setAbrindo]=useState(false);
  const [erro,setErro]=useState("");
  const [ocupado,setOcupado]=useState("");

  useEffect(()=>{ setLista(lead.listaTarefas||[]); },[lead.id,lead.listaTarefas]);
  useEffect(()=>{ setAbrindo(false); setTitulo(""); setQuando(""); setErro(""); },[lead.id]);

  const roda=async(nome,fn)=>{ setOcupado(nome); setErro("");
    try{ const r=await fn(); if(r&&r.tarefas) setLista(r.tarefas); }
    catch(e){ setErro(e.message); } finally{ setOcupado(""); } };

  async function criar(){
    if(!titulo.trim()) return setErro("Escreva o que precisa ser feito.");
    if(!quando) return setErro("Escolha o dia e a hora.");
    await roda("nova",()=>acoes.criarTarefa(lead.id,{titulo,quando:new Date(quando).toISOString()}));
    setTitulo(""); setQuando(""); setAbrindo(false);
  }

  const abertas=lista.filter(t=>!t.feito_em), feitas=lista.filter(t=>t.feito_em);

  return <div style={{background:C.card,border:`1px solid ${C.line}`,borderRadius:12,padding:12,marginBottom:14}}>
    <div style={{display:"flex",alignItems:"center",gap:7,marginBottom:abertas.length?8:5}}>
      <Icon n="calendar" size={14} color={C.greenMid}/>
      <span style={{color:C.ink,fontSize:12.5,fontWeight:700,flex:1}}>Tarefas com este cliente</span>
      {!abrindo&&<button onClick={()=>setAbrindo(true)}
        style={{border:"none",background:"transparent",color:C.greenDeep,fontSize:11.5,fontWeight:700,cursor:"pointer",padding:2}}>
        + marcar</button>}
    </div>

    {abertas.length===0&&!abrindo&&<div style={{color:C.faint,fontSize:11.5,lineHeight:1.5}}>
      Nada marcado. Ligar terça, levar a pasta na Caixa, confirmar a visita — o que ficar combinado some se não for anotado.
    </div>}

    <div style={{display:"flex",flexDirection:"column",gap:5}}>
      {abertas.map(t=>{const atrasada=t.quando<Date.now();
        return <div key={t.id} style={{display:"flex",alignItems:"center",gap:8,background:C.surface,borderRadius:9,padding:"7px 9px"}}>
          <button onClick={()=>roda(t.id,()=>acoes.marcarTarefa(t.id,true))} disabled={!!ocupado}
            aria-label="Marcar como feita" title="Marcar como feita"
            style={{width:19,height:19,borderRadius:6,border:`1.5px solid ${atrasada?C.hot:C.faint}`,background:"transparent",
              cursor:"pointer",flexShrink:0}}/>
          <div style={{minWidth:0,flex:1}}>
            <div style={{color:C.ink,fontSize:12,lineHeight:1.35}}>{t.titulo}</div>
            <div style={{color:atrasada?C.hot:C.faint,fontSize:10.5,fontWeight:atrasada?700:400,marginTop:1}}>
              {atrasada?"venceu ":""}{fmtQuando(t.quando)} · {fmtClock(t.quando)}
              {t.de_quem?` · ${first(t.de_quem)}`:""}
            </div>
          </div>
          <button onClick={()=>roda(t.id,()=>acoes.apagarTarefa(t.id))} disabled={!!ocupado}
            aria-label="Apagar a tarefa" style={{border:"none",background:"transparent",color:C.faint,cursor:"pointer",padding:2,flexShrink:0,fontSize:14}}>×</button>
        </div>;})}
    </div>

    {abrindo&&<div style={{marginTop:8,display:"flex",flexDirection:"column",gap:6}}>
      <input value={titulo} onChange={e=>setTitulo(e.target.value)} maxLength={120} autoFocus
        placeholder="O que precisa ser feito?"
        style={{fontSize:isMobile?16:12.5,border:`1px solid ${C.line}`,background:C.surface,borderRadius:9,padding:"8px 10px",color:C.ink,outline:"none"}}/>
      <div style={{display:"flex",gap:6,flexWrap:"wrap"}}>
        <input type="datetime-local" value={quando} onChange={e=>setQuando(e.target.value)}
          style={{flex:"1 1 160px",minWidth:0,fontSize:isMobile?16:12.5,border:`1px solid ${C.line}`,background:C.surface,borderRadius:9,padding:"8px 10px",color:C.ink,outline:"none"}}/>
        <button onClick={criar} disabled={ocupado==="nova"}
          style={{background:C.greenDeep,color:"#fff",border:"none",borderRadius:9,padding:"9px 15px",fontSize:12.5,fontWeight:700,cursor:"pointer"}}>
          {ocupado==="nova"?"…":"Marcar"}</button>
        <button onClick={()=>{setAbrindo(false);setErro("");}}
          style={{border:"none",background:"transparent",color:C.faint,fontSize:12,cursor:"pointer",padding:4}}>cancelar</button>
      </div>
    </div>}

    {feitas.length>0&&<div style={{color:C.faint,fontSize:10.5,marginTop:8,paddingTop:7,borderTop:`1px solid ${C.line}`}}>
      {feitas.length} tarefa(s) já feita(s){feitas[0]?`, a última: ${feitas[feitas.length-1].titulo}`:""}
    </div>}

    {erro&&<div style={{color:C.hot,background:C.hotSoft,fontSize:11.5,borderRadius:8,padding:"7px 9px",marginTop:8}}>{erro}</div>}
  </div>;
}

/* ===== O CARD DO FUNIL =====

   O funil é a tela que a gestão deixa aberta o dia todo, e o card estava mudo:
   nome, uma bolinha de temperatura e nada mais. Para saber se um lead estava
   parado era preciso abrir um por um.

   Agora o card responde, sem clique, às perguntas que se faz olhando o quadro:

   - qual a temperatura                      → pastilha com o nome escrito
   - desde quando está NESTA etapa           → "nesta etapa há 3d"
   - quando foi a última conversa            → "falou 14:32" / "falou 09/07"
   - está demorando?                         → a barra de cima esquenta
   - tem algo marcado com esse cliente?      → linha da tarefa, vermelha se venceu

   A COR DE URGÊNCIA olha a última interação, não a idade do lead: lead que
   entrou há um mês e conversou hoje está saudável, e lead que entrou hoje e
   ninguém respondeu está em chamas. Verde some de propósito — quadro cheio de
   verde vira enfeite e o olho para de ver a cor. Só aparece âmbar (esfriando)
   e vermelho (parado), que são os dois estados que pedem ação. */
const URGENCIA_AMBAR=24*3600000;    // um dia sem falar: esfriando
const URGENCIA_VERMELHA=72*3600000; // três dias: parado

function corDeUrgencia(l){
  if(l.finalizado||l.status==="Venda"||l.status==="Perdido") return null;
  const desde=Date.now()-(l.lastAt||l.createdAt);
  if(desde>=URGENCIA_VERMELHA) return C.hot;
  if(desde>=URGENCIA_AMBAR) return C.amber;
  return null;
}

// "3d", "5h", "12min" — o mais curto que ainda diz a verdade, para caber no card.
function fmtCurto(ms){
  const min=Math.max(0,Math.round(ms/60000));
  if(min<60) return min+"min";
  const h=Math.round(min/60);
  if(h<48) return h+"h";
  return Math.round(h/24)+"d";
}

function CardFunil({l,mostrarDono,arrastando,opaco,aoPressionar,moveu,aoAbrir}){
  const urgencia=corDeUrgencia(l);
  const tar=l.tarefas;
  const linha=(icone,texto,cor)=><div style={{display:"flex",alignItems:"center",gap:4,marginTop:3}}>
    <Icon n={icone} size={9} color={cor||C.faint}/>
    <span style={{color:cor||C.faint,fontSize:9.5,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{texto}</span>
  </div>;

  return <div
    onPointerDown={(e)=>aoPressionar(e,l)}
    onContextMenu={(e)=>e.preventDefault()}   /* segurar no celular abriria o menu do sistema */
    /* `flexShrink:0` NÃO é ajuste fino — sem ele o funil quebra.

       A coluna é um flex em coluna. Normalmente um item de flex não encolhe
       abaixo do tamanho do próprio conteúdo (`min-height:auto`), e a coluna
       rola. Mas a regra do CSS tem uma exceção: quando o item tem `overflow`
       diferente de `visible`, esse mínimo automático passa a ser ZERO.

       O `overflow:hidden` entrou aqui só para a faixa de urgência respeitar o
       canto arredondado — e levou junto a proteção contra encolher. Com 96
       leads numa etapa, os 96 cards viraram tiras de 3px empilhadas. */
    style={{background:C.card,border:`1px solid ${C.line}`,borderRadius:8,overflow:"hidden",flexShrink:0,
      opacity:opaco?.35:1,cursor:arrastando?"grabbing":"grab",touchAction:"pan-x",userSelect:"none"}}>
    {/* A faixa de urgência no topo: some quando está tudo bem. */}
    {urgencia&&<div style={{height:3,background:urgencia}}/>}
    <button onClick={aoAbrir} style={{width:"100%",textAlign:"left",border:"none",background:"transparent",cursor:"inherit",padding:8}}>
      <div style={{display:"flex",alignItems:"center",gap:5,marginBottom:4}}>
        <span style={{color:C.ink,fontSize:12,fontWeight:600,flex:1,minWidth:0,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{l.nome}</span>
        <span style={{background:prioDe(l.prio).bg,color:prioDe(l.prio).c,fontSize:8.5,fontWeight:700,
          borderRadius:999,padding:"1px 6px",flexShrink:0,textTransform:"uppercase",letterSpacing:.3}}>{prioDe(l.prio).label}</span>
      </div>

      {/* Desde quando está NESTA etapa. Sem histórico ainda, diz "—" em vez de
          usar a data de entrada do lead, que quase nunca é a mesma coisa. */}
      {linha("target", l.etapaDesde?`nesta etapa há ${fmtCurto(Date.now()-l.etapaDesde)}`:"nesta etapa há —")}

      {linha("msg", l.lastAt?`falou ${fmtQuando(l.lastAt)}`:"sem conversa", urgencia)}

      {tar&&tar.abertas>0&&linha(tar.atrasada?"flame":"calendar",
        `${tar.titulo}${tar.abertas>1?` +${tar.abertas-1}`:""} · ${fmtQuando(tar.proxima)}`,
        tar.atrasada?C.hot:C.greenMid)}

      {mostrarDono&&<div style={{color:C.faint,fontSize:9.5,marginTop:4,paddingTop:4,borderTop:`1px solid ${C.line}`,
        overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{l.assignedName||"na fila"}</div>}
    </button>
  </div>;
}

/* ===== DISPONIBILIDADE (corretor) ===== */
function Disponibilidade({avail,toggle,name,acoes,isMobile,ehPonto}){
  const [exp,setExp]=useState(null);
  const [meu,setMeu]=useState(null);
  const [perguntando,setPerguntando]=useState(false);
  const [local,setLocal]=useState(null);
  const [motivo,setMotivo]=useState("");
  const [enviando,setEnviando]=useState(false);
  const [erro,setErro]=useState("");
  useEffect(()=>{
    acoes.expediente().then(setExp).catch(()=>{});
    acoes.historicoDisponibilidade({dias:7}).then(d=>setMeu(d.eventos||[])).catch(()=>setMeu([]));
  },[avail]);

  const hhmm=(ms)=>new Date(ms).toLocaleTimeString("pt-BR",{hour:"2-digit",minute:"2-digit"});

  /* A atendente não escolhe se vai atender — ela atende o expediente inteiro.
     O que a chave dela registra é PRESENÇA, então a entrada passa pelo ponto:
     de onde está começando e, se está fora, por quê. */
  const clicou=()=>{
    setErro("");
    if(ehPonto&&!avail){ setLocal(null); setMotivo(""); setPerguntando(true); return; }
    toggle().catch(e=>setErro(e.message));
  };
  const baterPonto=async(escolha)=>{
    if(escolha==="fora"&&motivo.trim().length<3){ setErro("Escreva o motivo para registrar."); return; }
    setEnviando(true); setErro("");
    try{ await toggle({local:escolha,observacao:escolha==="fora"?motivo.trim():undefined});
      setPerguntando(false); }
    catch(e){ setErro(e.message); }
    finally{ setEnviando(false); }
  };

  const titulo=ehPonto?(avail?"Atendimento iniciado":"Atendimento não iniciado")
    :(avail?"Você está disponível hoje":"Você está indisponível");
  const rotuloBotao=ehPonto?(avail?"Encerrar meu atendimento":"Iniciar meu atendimento")
    :(avail?"Ficar indisponível":"Me prontificar para atendimento");

  return <div style={{height:"100%",overflowY:"auto",padding:16}}>
    <div style={{maxWidth:520,margin:"0 auto"}}>
      <div style={{background:C.card,border:`1px solid ${C.line}`,borderRadius:16,padding:24,textAlign:"center"}}>
        <div style={{background:avail?C.greenSoft:C.coolSoft,width:64,height:64,borderRadius:16,display:"flex",alignItems:"center",justifyContent:"center",margin:"0 auto 16px",color:avail?C.green:C.cool}}><Icon n={ehPonto?"clock":(avail?"toggleOn":"toggleOff")} size={30}/></div>
        <div style={{color:C.ink,fontFamily:DISPLAY,fontSize:18,fontWeight:700}}>{titulo}</div>
        <div style={{color:C.sub,fontSize:13,marginTop:6,lineHeight:1.5}}>
          {ehPonto
            ?(avail?"Seu ponto de hoje está aberto. A gestão acompanha o registro nos relatórios."
                   :"Marque o início do seu atendimento. O registro fica no relatório de ponto.")
            :(avail?"A SDR pode te transferir novos leads da campanha na catraca de hoje."
                   :"Enquanto indisponível, você não entra na catraca e não recebe leads novos. Fale com a SDR e ative aqui.")}
        </div>
        {/* Dizer a hora do corte ANTES de ele acontecer é o que evita achar que
            o sistema desligou por conta própria. */}
        {exp&&exp.fim&&<div style={{color:avail?C.greenDeep:C.faint,background:avail?C.greenSoft:"transparent",
          fontSize:12,fontWeight:600,borderRadius:9,padding:avail?"7px 11px":0,marginTop:12,display:"inline-flex",alignItems:"center",gap:6}}>
          <Icon n="clock" size={13}/>
          {ehPonto
            ?(avail?`Fecha sozinho às ${exp.fim} se você não encerrar`:`O ponto fecha às ${exp.fim} todos os dias`)
            :(avail?`Vale até as ${exp.fim} de hoje`:`A prontidão vale até as ${exp.fim} de cada dia`)}</div>}
        {erro&&!perguntando&&<div style={{color:C.hot,background:C.hotSoft,fontSize:12.5,borderRadius:9,padding:"9px 11px",marginTop:12,lineHeight:1.45}}>{erro}</div>}
        <div><button onClick={clicou} style={{marginTop:18,background:avail?C.coolSoft:C.green,color:avail?C.sub:"#fff",border:"none",cursor:"pointer",fontSize:14,fontWeight:600,padding:"10px 22px",borderRadius:12}}>{rotuloBotao}</button></div>
      </div>

      {/* Popup do ponto. Em fluxo fixo, sem portal: o ReactDOM embutido não tem
          createPortal — foi o que causou a tela branca da simulação. */}
      {perguntando&&<React.Fragment>
        <div onClick={()=>!enviando&&setPerguntando(false)} style={{position:"fixed",inset:0,background:"rgba(0,0,0,.4)",zIndex:40}}/>
        <div style={{position:"fixed",left:"50%",top:"50%",transform:"translate(-50%,-50%)",zIndex:41,
          width:"min(420px, calc(100vw - 32px))",background:C.card,borderRadius:18,padding:20,boxShadow:"0 20px 60px rgba(0,0,0,.28)"}}>
          <div style={{fontFamily:DISPLAY,color:C.ink,fontSize:17,fontWeight:700,marginBottom:6}}>Você já está na imobiliária?</div>
          <div style={{color:C.sub,fontSize:12.5,lineHeight:1.55,marginBottom:16}}>
            Esta resposta fica registrada no seu ponto, com o horário.
          </div>

          <button onClick={()=>baterPonto("imobiliaria")} disabled={enviando}
            style={{width:"100%",display:"flex",alignItems:"center",gap:10,textAlign:"left",
              background:C.greenSoft,border:`1px solid ${C.green}55`,borderRadius:12,padding:"13px 14px",cursor:"pointer",marginBottom:9}}>
            <Icon n="check" size={17} color={C.greenDeep}/>
            <span style={{flex:1}}>
              <span style={{display:"block",color:C.greenDeep,fontSize:13.5,fontWeight:700}}>Sim, iniciei o atendimento</span>
              <span style={{display:"block",color:C.sub,fontSize:11.5}}>Estou na imobiliária agora</span>
            </span>
          </button>

          <button onClick={()=>setLocal("fora")} disabled={enviando}
            style={{width:"100%",display:"flex",alignItems:"center",gap:10,textAlign:"left",
              background:local==="fora"?C.amberSoft:C.surface,border:`1px solid ${local==="fora"?C.amber+"66":C.line}`,
              borderRadius:12,padding:"13px 14px",cursor:"pointer"}}>
            <Icon n="pin" size={17} color={local==="fora"?"#8a6d1f":C.sub}/>
            <span style={{flex:1}}>
              <span style={{display:"block",color:local==="fora"?"#8a6d1f":C.ink,fontSize:13.5,fontWeight:700}}>Ainda estou fora da imobiliária</span>
              <span style={{display:"block",color:C.sub,fontSize:11.5}}>Preciso explicar o motivo</span>
            </span>
          </button>

          {local==="fora"&&<div style={{marginTop:12}}>
            <div style={{color:C.faint,fontSize:11,fontWeight:600,marginBottom:5}}>Motivo</div>
            <textarea value={motivo} onChange={e=>setMotivo(e.target.value)} rows={3} autoFocus
              placeholder="Ex.: a caminho, atendendo cliente na rua, consulta médica…"
              style={{width:"100%",boxSizing:"border-box",fontSize:isMobile?16:13.5,border:`1px solid ${C.line}`,
                background:C.surface,borderRadius:10,padding:"11px 12px",color:C.ink,outline:"none",resize:"vertical",fontFamily:FONT}}/>
            <button onClick={()=>baterPonto("fora")} disabled={enviando||motivo.trim().length<3}
              style={{width:"100%",marginTop:9,background:motivo.trim().length<3?C.faint:C.greenDeep,color:"#fff",border:"none",
                borderRadius:11,padding:"12px",fontSize:13.5,fontWeight:600,cursor:motivo.trim().length<3?"default":"pointer"}}>
              {enviando?"Enviando…":"Enviar e iniciar atendimento"}</button>
          </div>}

          {erro&&<div style={{color:C.hot,background:C.hotSoft,fontSize:12.5,borderRadius:9,padding:"9px 11px",marginTop:11,lineHeight:1.45}}>{erro}</div>}
          <button onClick={()=>setPerguntando(false)} disabled={enviando}
            style={{width:"100%",marginTop:10,background:"transparent",color:C.faint,border:"none",fontSize:12.5,cursor:"pointer"}}>Cancelar</button>
        </div>
      </React.Fragment>}

      <div style={{background:C.card,border:`1px solid ${C.line}`,borderRadius:16,padding:20,marginTop:16}}>
        <div style={{color:C.ink,fontSize:13,fontWeight:700,marginBottom:8,display:"flex",alignItems:"center",gap:8}}>
          <Icon n={ehPonto?"clock":"transfer"} size={15} color={C.green}/> {ehPonto?"Como funciona o seu ponto":"Como funciona a catraca"}</div>
        <div style={{color:C.sub,fontSize:12.5,lineHeight:1.6}}>
          {ehPonto
            ?<React.Fragment>Você atende o expediente inteiro, então aqui não é prontidão e sim <b style={{color:C.ink}}>registro de ponto</b>: a que horas começou, de onde, e a que horas encerrou. A gestão acompanha o diário, o semanal e o mensal nos relatórios.</React.Fragment>
            :"Só recebe lead quem se prontifica no dia. A SDR confirma a sua disponibilidade e transfere os leads manualmente, um a um, apenas para quem está ativo — mantendo a fila justa."}
          {exp&&exp.fim&&<React.Fragment><br/><br/>
            {ehPonto
              ?<React.Fragment>Se você esquecer de encerrar, o sistema fecha às <b style={{color:C.ink}}>{exp.fim}</b> — e o relatório mostra que foi fechamento automático, não saída marcada por você.</React.Fragment>
              :<React.Fragment>Todo dia às <b style={{color:C.ink}}>{exp.fim}</b> a prontidão de todo mundo é encerrada. No dia seguinte é preciso se prontificar de novo — o que vale é você dizer que está pronto, não o sistema lembrar por você.</React.Fragment>}
          </React.Fragment>}
        </div>
      </div>

      {/* O corretor vê o próprio histórico. Ele é cobrado por isso, então tem
          que conseguir conferir o que foi registrado no nome dele. */}
      {meu&&meu.length>0&&<div style={{background:C.card,border:`1px solid ${C.line}`,borderRadius:16,padding:20,marginTop:16}}>
        <div style={{color:C.ink,fontSize:13,fontWeight:700,marginBottom:10}}>Seus últimos 7 dias</div>
        <div style={{display:"flex",flexDirection:"column",gap:2}}>
          {meu.slice(0,20).map(e=><LinhaDisponibilidade key={e.id} e={e} hhmm={hhmm}/>)}
        </div>
      </div>}
    </div>
  </div>;
}

/* Uma linha do histórico. O "quem" é o ponto: a gestão precisa distinguir
   "ele se prontificou" de "o sistema encerrou no fim do dia". */
function LinhaDisponibilidade({e,hhmm,mostrarNome}){
  const dia=new Date(e.created_at).toLocaleDateString("pt-BR",{day:"2-digit",month:"2-digit"});
  const porQuem=e.origem==="sistema"?"encerrado pelo sistema"
    :e.origem==="gestor"?`por ${first(e.autor_nome||"gestão")}`:"por ele mesmo";
  return <div style={{display:"flex",alignItems:"center",gap:9,padding:"7px 0",borderBottom:`1px solid ${C.line}`}}>
    <span style={{width:7,height:7,borderRadius:99,background:e.ativo?C.green:e.origem==="sistema"?C.faint:C.hot,flexShrink:0}}/>
    <span style={{fontFamily:MONO,color:C.sub,fontSize:11.5,flexShrink:0}}>{dia} {hhmm(e.created_at)}</span>
    {mostrarNome&&<span style={{color:C.ink,fontSize:12.5,fontWeight:600,flexShrink:0,maxWidth:110,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{e.pessoa||"—"}</span>}
    <span style={{color:e.ativo?C.greenDeep:C.sub,fontSize:12.5,fontWeight:600}}>{e.ativo?"disponível":"indisponível"}</span>
    <span style={{color:C.faint,fontSize:11,marginLeft:"auto",textAlign:"right"}}>{porQuem}</span>
  </div>;
}

/* Histórico da equipe — atendente e gestão. Duas leituras:
   o resumo de hoje (quem se prontificou, quanto tempo somou, quem foi
   encerrado pelo sistema) e a lista crua de liga/desliga. */
function HistoricoDisponibilidade({acoes,isMobile,podeConfigurar}){
  const [d,setD]=useState(null);
  const [dias,setDias]=useState(7);
  const [aberto,setAberto]=useState(false);
  const [exp,setExp]=useState(null);
  const [salvando,setSalvando]=useState(false);
  const [rascunho,setRascunho]=useState("");

  const rever=()=>acoes.historicoDisponibilidade({dias}).then(setD).catch(()=>setD({eventos:[],resumo:[]}));
  useEffect(()=>{rever();},[dias]);
  useEffect(()=>{ if(podeConfigurar) acoes.expediente().then(x=>{setExp(x);setRascunho(x.fim||"");}).catch(()=>{}); },[]);

  const hhmm=(ms)=>new Date(ms).toLocaleTimeString("pt-BR",{hour:"2-digit",minute:"2-digit"});
  const dataCurta=(ms)=>new Date(ms).toLocaleDateString("pt-BR",{day:"2-digit",month:"2-digit"});
  const tempo=(min)=>min<60?`${min} min`:`${Math.floor(min/60)}h${String(min%60).padStart(2,"0")}`;
  const salvarExp=async()=>{ setSalvando(true);
    try{ const x=await acoes.definirExpediente(rascunho.trim()); setExp(x); }catch(e){} finally{ setSalvando(false); } };

  if(!d) return null;
  const resumo=d.resumo||[];
  const naoProntificaram=resumo.filter(p=>!p.prontificou);

  return <div style={{background:C.card,border:`1px solid ${C.line}`,borderRadius:16,padding:isMobile?14:18}}>
    <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:4,flexWrap:"wrap"}}>
      <Icon n="clock" size={15} color={C.greenMid}/>
      <span style={{color:C.ink,fontSize:13.5,fontWeight:700,flex:1}}>Disponibilidade da equipe</span>
      {d.expediente_fim&&<span style={{color:C.faint,fontSize:11}}>encerra às {d.expediente_fim}</span>}
    </div>
    <div style={{color:C.faint,fontSize:11.5,lineHeight:1.5,marginBottom:12}}>
      Quem se prontificou hoje, a que horas, e se foi a própria pessoa ou o encerramento automático do fim do dia.
    </div>

    {/* Quem não se prontificou é a informação acionável do dia: são os que
        estão fora da catraca sem ninguém ter percebido. */}
    {naoProntificaram.length>0&&<div style={{background:C.amberSoft,color:"#8a6d1f",fontSize:12,borderRadius:10,padding:"9px 11px",marginBottom:12,lineHeight:1.5}}>
      <b>{naoProntificaram.length} não se prontificou hoje:</b> {naoProntificaram.map(p=>first(p.nome)).join(", ")}.
    </div>}

    <div style={{display:"flex",flexDirection:"column",gap:6,marginBottom:12}}>
      {resumo.map(p=><div key={p.id} style={{display:"flex",alignItems:"center",gap:9,background:C.surface,borderRadius:10,padding:"9px 11px",flexWrap:"wrap"}}>
        <span style={{width:8,height:8,borderRadius:99,background:p.disponivel_agora?C.green:C.line,flexShrink:0}}/>
        <div style={{flex:"1 1 120px",minWidth:0}}>
          <div style={{color:C.ink,fontSize:12.5,fontWeight:600,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{p.nome}</div>
          <div style={{color:C.faint,fontSize:10.5}}>
            {p.prontificou
              ?<React.Fragment>ativou {hhmm(p.primeira_ativacao)}
                {p.ultimo_desligamento?` · saiu ${hhmm(p.ultimo_desligamento)}${p.desligado_pelo_sistema?" (sistema)":""}`:" · ainda disponível"}</React.Fragment>
              :"não se prontificou hoje"}
          </div>
        </div>
        <div style={{textAlign:"right",flexShrink:0}}>
          <div style={{fontFamily:MONO,color:p.minutos_disponivel?C.ink:C.faint,fontSize:13,fontWeight:700,lineHeight:1}}>{tempo(p.minutos_disponivel)}</div>
          <div style={{color:C.faint,fontSize:10}}>disponível hoje</div>
        </div>
      </div>)}
      {resumo.length===0&&<div style={{color:C.faint,fontSize:12}}>Ninguém na catraca ainda.</div>}
    </div>

    <button onClick={()=>setAberto(a=>!a)}
      style={{display:"flex",alignItems:"center",gap:6,background:"transparent",border:"none",padding:0,cursor:"pointer",color:C.greenMid,fontSize:12,fontWeight:600}}>
      <span style={{display:"inline-flex",transform:aberto?"rotate(90deg)":"none",transition:"transform .15s"}}><Icon n="chevron" size={13}/></span>
      {aberto?"Ocultar":"Ver"} o histórico completo
    </button>

    {aberto&&<React.Fragment>
      <div style={{display:"flex",gap:6,margin:"10px 0"}}>
        {[1,7,30].map(n=><button key={n} onClick={()=>setDias(n)}
          style={{fontSize:11.5,fontWeight:600,padding:"5px 11px",borderRadius:999,border:"none",cursor:"pointer",
            background:dias===n?C.greenDeep:C.surface,color:dias===n?"#fff":C.sub}}>
          {n===1?"hoje":`${n} dias`}</button>)}
      </div>
      {/* Diz em voz alta qual janela está valendo. O filtro conta dias de
          calendário: "hoje" é da meia-noite para cá, não as últimas 24 horas —
          antes o de hoje ainda trazia a tarde de ontem e parecia quebrado. */}
      <div style={{color:C.faint,fontSize:11,marginBottom:6}}>
        {dias===1?`mostrando só ${dataCurta(Date.now())}`
          :`mostrando de ${dataCurta(Date.now()-(dias-1)*86400000)} até ${dataCurta(Date.now())}`}
      </div>
      <div style={{display:"flex",flexDirection:"column"}}>
        {d.eventos.map(e=><LinhaDisponibilidade key={e.id} e={e} hhmm={hhmm} mostrarNome/>)}
        {d.eventos.length===0&&<div style={{color:C.faint,fontSize:12,padding:"8px 0"}}>Nada registrado neste período.</div>}
      </div>
    </React.Fragment>}

    {podeConfigurar&&exp&&<div style={{borderTop:`1px solid ${C.line}`,marginTop:12,paddingTop:12}}>
      <div style={{color:C.faint,fontSize:11,fontWeight:600,marginBottom:5}}>Encerrar a prontidão de todos às</div>
      <div style={{display:"flex",gap:7,alignItems:"center",flexWrap:"wrap"}}>
        <input value={rascunho} onChange={e=>setRascunho(e.target.value)} placeholder="18:00"
          style={{width:90,fontSize:isMobile?16:13,border:`1px solid ${C.line}`,background:C.surface,borderRadius:9,padding:"8px 10px",color:C.ink,outline:"none"}}/>
        <button onClick={salvarExp} disabled={salvando}
          style={{background:C.greenDeep,color:"#fff",border:"none",borderRadius:9,padding:"8px 14px",fontSize:12.5,fontWeight:600,cursor:"pointer"}}>
          {salvando?"Salvando…":"Salvar"}</button>
        <span style={{color:C.faint,fontSize:11}}>em branco desliga o encerramento automático</span>
      </div>
    </div>}
  </div>;
}

/* O pedido da gestão dentro da conversa.

   Fica aqui, e não só na notificação, porque metade da equipe não recebe push
   — todo iPhone que não adicionou o site à tela de início. Sem isto, "chamar o
   corretor" não chegaria a essas pessoas e o gestor não teria como saber.

   O "vi" é do corretor: some da conversa dele e some da tela da gestão. */
function AvisoCutucada({lead,acoes}){
  const [sumindo,setSumindo]=useState(false);
  if(sumindo) return null;
  const quando=new Date(lead.cutucadoEm).toLocaleTimeString("pt-BR",{hour:"2-digit",minute:"2-digit"});
  return <div style={{alignSelf:"center",maxWidth:"92%",background:C.hotSoft,border:`1px solid ${C.hot}44`,
    borderRadius:12,padding:"9px 12px",margin:"4px 0",display:"flex",alignItems:"center",gap:9,flexWrap:"wrap"}}>
    <Icon n="zap" size={14} color={C.hot}/>
    <div style={{flex:"1 1 160px",minWidth:0}}>
      <div style={{color:C.hot,fontSize:12,fontWeight:700}}>A gestão pediu atenção neste atendimento · {quando}</div>
      {lead.cutucadoRecado&&<div style={{color:C.sub,fontSize:12,marginTop:2,lineHeight:1.4}}>“{lead.cutucadoRecado}”</div>}
    </div>
    <button onClick={()=>{setSumindo(true);acoes.viCutucada(lead.id).catch(()=>setSumindo(false));}}
      style={{background:C.card,color:C.sub,border:`1px solid ${C.line}`,borderRadius:8,padding:"5px 12px",fontSize:11.5,fontWeight:600,cursor:"pointer"}}>
      Vi</button>
  </div>;
}

/* Clientes esperando resposta — a lista que a gestão cobra.

   O CRM já mostrava o tempo de espera dentro de cada conversa, mas ninguém
   fica abrindo trinta conversas para descobrir quais pararam. Aqui vêm todos
   de uma vez, do mais parado para o menos, com o botão de chamar o corretor.

   O aviso automático já saiu antes desta tela abrir (o servidor dispara
   sozinho); este botão é para quando a gestão quer insistir com nome, hora e
   recado. */
function SemResposta({acoes,isMobile,podeConfigurar}){
  const [d,setD]=useState(null);
  const [enviando,setEnviando]=useState("");
  const [feito,setFeito]=useState({});
  const [erro,setErro]=useState("");
  const [abrindoRecado,setAbrindoRecado]=useState("");
  const [recado,setRecado]=useState("");
  const [rascunho,setRascunho]=useState("");

  /* O campo dos minutos é preenchido UMA vez, na primeira leitura. Depois disso
     ele é de quem está digitando.

     Esta lista se relê sozinha de minuto em minuto, e a releitura reescrevia o
     campo com o valor que está gravado no servidor: quem estivesse trocando 30
     por 45 via o número apagado e voltar ao antigo no meio da digitação. */
  const jaPreencheu=useRef(false);
  const rever=()=>acoes.semResposta().then(x=>{
    setD(x);
    if(!jaPreencheu.current){ jaPreencheu.current=true; setRascunho(String(x.minutos)); }
  }).catch(()=>setD({leads:[],minutos:0}));
  useEffect(()=>{rever();const t=setInterval(rever,60000);return()=>clearInterval(t);},[]);

  async function chamar(l){
    setEnviando(l.id); setErro("");
    try{
      const r=await acoes.cutucar(l.id,recado);
      setFeito(f=>({...f,[l.id]:r.push?"avisado no celular":"marcado no CRM (o corretor não tem notificação ligada)"}));
      setAbrindoRecado(""); setRecado("");
    }catch(e){ setErro(e.message); }
    finally{ setEnviando(""); }
  }
  const salvarMin=async()=>{ try{ const r=await acoes.definirEspera(rascunho); setD(x=>({...x,minutos:r.minutos})); }catch(e){ setErro(e.message); } };

  if(!d) return null;
  const tempo=(min)=>min<60?`${min} min`:`${Math.floor(min/60)}h${String(min%60).padStart(2,"0")}`;

  return <div style={{background:C.card,border:`1px solid ${C.line}`,borderRadius:16,padding:isMobile?14:18,marginBottom:16}}>
    <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:4,flexWrap:"wrap"}}>
      <Icon n="timer" size={15} color={d.leads.length?C.hot:C.greenMid}/>
      <span style={{color:C.ink,fontSize:13.5,fontWeight:700,flex:1}}>Clientes esperando resposta</span>
      {d.minutos>0&&<span style={{color:C.faint,fontSize:11}}>aviso automático em {d.minutos} min</span>}
    </div>

    {erro&&<div style={{background:C.hotSoft,color:C.hot,fontSize:12,borderRadius:9,padding:"8px 10px",marginBottom:9}}>{erro}</div>}

    {d.leads.length===0
      ?<div style={{color:C.faint,fontSize:12.5,marginBottom:4}}>
        {d.minutos?"Ninguém esperando além do tempo combinado.":"Aviso automático desligado."}
      </div>
      :<div style={{display:"flex",flexDirection:"column",gap:6,marginBottom:6}}>
        {d.leads.map(l=><div key={l.id} style={{background:C.surface,borderRadius:11,padding:"9px 11px"}}>
          <div style={{display:"flex",alignItems:"center",gap:9,flexWrap:"wrap"}}>
            <div style={{flex:"1 1 130px",minWidth:0}}>
              <div style={{color:C.ink,fontSize:12.5,fontWeight:600,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{l.name}</div>
              <div style={{color:C.faint,fontSize:10.5}}>
                {l.alerta_em?"corretor já avisado":"aguardando"} · <span style={{color:ageColor(l.esperando_min*60000),fontWeight:700,fontFamily:MONO}}>{tempo(l.esperando_min)}</span>
              </div>
            </div>
            {feito[l.id]
              ?<span style={{color:C.greenMid,fontSize:11,fontWeight:600,display:"flex",alignItems:"center",gap:4}}><Icon n="check" size={12}/>{feito[l.id]}</span>
              :<button onClick={()=>{setAbrindoRecado(abrindoRecado===l.id?"":l.id);setRecado("");}} disabled={enviando===l.id}
                style={{background:C.card,color:C.hot,border:`1px solid ${C.hot}44`,borderRadius:9,padding:"6px 12px",
                  fontSize:12,fontWeight:600,cursor:"pointer",flexShrink:0,display:"flex",alignItems:"center",gap:5}}>
                <Icon n={enviando===l.id?"loader":"zap"} size={12} spin={enviando===l.id}/>Chamar o corretor</button>}
          </div>
          {abrindoRecado===l.id&&<div style={{display:"flex",gap:6,marginTop:8,flexWrap:"wrap"}}>
            <input value={recado} onChange={e=>setRecado(e.target.value)} placeholder="Recado (opcional)" maxLength={200}
              style={{flex:"1 1 150px",minWidth:0,fontSize:isMobile?16:12.5,border:`1px solid ${C.line}`,background:C.card,borderRadius:9,padding:"7px 10px",color:C.ink,outline:"none"}}/>
            <button onClick={()=>chamar(l)} disabled={enviando===l.id}
              style={{background:C.greenDeep,color:"#fff",border:"none",borderRadius:9,padding:"7px 14px",fontSize:12.5,fontWeight:600,cursor:"pointer"}}>
              {enviando===l.id?"Enviando…":"Enviar"}</button>
          </div>}
        </div>)}
      </div>}

    {podeConfigurar&&<div style={{borderTop:`1px solid ${C.line}`,marginTop:10,paddingTop:10}}>
      <div style={{color:C.faint,fontSize:11,fontWeight:600,marginBottom:5}}>Avisar o corretor depois de quantos minutos sem resposta</div>
      <div style={{display:"flex",gap:7,alignItems:"center",flexWrap:"wrap"}}>
        <input value={rascunho} onChange={e=>setRascunho(e.target.value.replace(/\D/g,""))} placeholder="30" inputMode="numeric"
          style={{width:80,fontSize:isMobile?16:13,border:`1px solid ${C.line}`,background:C.surface,borderRadius:9,padding:"8px 10px",color:C.ink,outline:"none",fontFamily:MONO}}/>
        <button onClick={salvarMin}
          style={{background:C.greenDeep,color:"#fff",border:"none",borderRadius:9,padding:"8px 14px",fontSize:12.5,fontWeight:600,cursor:"pointer"}}>Salvar</button>
        <span style={{color:C.faint,fontSize:11}}>0 desliga o aviso automático</span>
      </div>
    </div>}
  </div>;
}

/* ===== CATRACA (SDR) ===== */
function Catraca({fila,pessoas,disponiveis,toggleAvail,acoes,isMobile,podeConfigurarExpediente}){
  const novos=[...fila].sort((a,b)=>({QUENTE:0,MORNO:1,FRIO:2}[a.prio]-{QUENTE:0,MORNO:1,FRIO:2}[b.prio]));
  const brokers=pessoas, disp=disponiveis;
  const transfer=(leadId,uid)=>acoes.transferir(leadId,uid);
  const catracaNext=(leadId)=>acoes.proximo(leadId);
  return <div style={{height:"100%",overflowY:"auto",padding:isMobile?14:20}}>
    <div style={{maxWidth:860,margin:"0 auto"}}>
      {/* Antes da fila e do roster: cliente parado é o que custa venda, e é a
          primeira coisa que a gestão precisa ver ao abrir esta tela. */}
      <SemResposta acoes={acoes} isMobile={isMobile} podeConfigurar={podeConfigurarExpediente}/>
      {/* roster de disponibilidade */}
      <div style={{background:C.card,border:`1px solid ${C.line}`,borderRadius:16,padding:16,marginBottom:16}}>
        <div style={{color:C.ink,fontSize:13,fontWeight:700,marginBottom:10,display:"flex",alignItems:"center",gap:8}}><Icon n="users" size={15} color={C.green}/> Disponíveis hoje ({disp.length}/{brokers.length})</div>
        <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
          {brokers.length===0&&<span style={{color:C.faint,fontSize:12}}>Ninguém cadastrado ainda — mande o link de cadastro para a equipe.</span>}
          {brokers.map(b=>{const on=b.available;return <button key={b.id} onClick={()=>toggleAvail(b.id,on).catch(()=>{})} style={{display:"flex",alignItems:"center",gap:8,border:`1px solid ${on?C.green:C.line}`,background:on?C.greenSoft:C.card,borderRadius:999,padding:"5px 12px 5px 5px",cursor:"pointer"}}>
            <Avatar ini={b.ini} color={b.color} size={26}/><span style={{color:C.ink,fontSize:12.5,fontWeight:600}}>{first(b.name)}</span><Icon n={on?"toggleOn":"toggleOff"} size={18} color={on?C.green:C.faint}/></button>;})}
        </div>
        <div style={{color:C.faint,fontSize:11,marginTop:8}}>Clique para marcar quem falou com você e está pronto para atender. Só quem está verde entra na catraca.</div>
      </div>

      {/* Histórico logo abaixo do roster: é aqui que a atendente confere se
          quem está verde se prontificou hoje ou ficou de ontem. */}
      <div style={{marginBottom:16}}>
        <HistoricoDisponibilidade acoes={acoes} isMobile={isMobile} podeConfigurar={podeConfigurarExpediente}/>
      </div>

      <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:12}}>
        <div><div style={{color:C.ink,fontFamily:DISPLAY,fontSize:16,fontWeight:700}}>{novos.length} lead(s) na fila</div><div style={{color:C.faint,fontSize:12}}>Transfira manualmente para quem está disponível.</div></div>
      </div>
      {novos.length===0&&<div style={{background:C.card,border:`1px solid ${C.line}`,borderRadius:16,padding:40,textAlign:"center"}}><Icon n="check" size={30} color={C.green}/><div style={{color:C.ink,fontSize:14,fontWeight:600,marginTop:8}}>Fila zerada</div><div style={{color:C.faint,fontSize:12,marginTop:4}}>Novos leads da campanha caem aqui automaticamente.</div></div>}
      <div style={{display:"flex",flexDirection:"column",gap:10}}>
        {novos.map(l=>{const age=Date.now()-l.createdAt;
          return <div key={l.id} style={{background:C.card,border:`1px solid ${C.line}`,borderRadius:16,padding:12}}>
            <div style={{display:"flex",alignItems:"center",gap:12}}>
              <Avatar ini={initials(l.nome)} color={prioDe(l.prio).c} size={38}/>
              <div style={{minWidth:0,flex:1}}><div style={{display:"flex",alignItems:"center",gap:8,flexWrap:"wrap"}}><span style={{color:C.ink,fontSize:13.5,fontWeight:600}}>{l.nome}</span><Pill c={prioDe(l.prio).c} bg={prioDe(l.prio).bg}>{prioDe(l.prio).label}</Pill></div><div style={{color:C.faint,fontSize:11.5,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{fmtTel(l.tel)} · {l.lastBody||"sem mensagem"}</div></div>
              <div style={{display:"flex",alignItems:"center",gap:4,marginRight:4,flexShrink:0}}><Icon n="timer" size={13} color={ageColor(age)}/><span style={{color:ageColor(age),fontFamily:MONO,fontSize:12,fontWeight:600}}>{fmtAge(age)}</span></div>
              {/* no celular o botão desce para a linha de baixo, em largura total */}
              {!isMobile&&<button onClick={()=>catracaNext(l.id)} disabled={!disp.length} style={{background:disp.length?C.greenDeep:C.coolSoft,color:disp.length?"#fff":C.faint,border:"none",cursor:disp.length?"pointer":"default",fontSize:12,fontWeight:600,padding:"8px 12px",borderRadius:10,display:"flex",alignItems:"center",gap:6,whiteSpace:"nowrap"}}><Icon n="transfer" size={14}/> Próximo</button>}
            </div>
            {isMobile&&<button onClick={()=>catracaNext(l.id)} disabled={!disp.length} style={{width:"100%",marginTop:10,background:disp.length?C.greenDeep:C.coolSoft,color:disp.length?"#fff":C.faint,border:"none",cursor:disp.length?"pointer":"default",fontSize:13,fontWeight:600,padding:"11px",borderRadius:10,display:"flex",alignItems:"center",justifyContent:"center",gap:6}}><Icon n="transfer" size={14}/> Passar para o próximo</button>}
            <div style={{display:"flex",alignItems:"center",gap:6,marginTop:10,paddingTop:10,borderTop:`1px solid ${C.line}`,flexWrap:"wrap"}}>
              <span style={{color:C.faint,fontSize:11,fontWeight:600}}>Transferir para:</span>
              {disp.length?disp.map(b=><button key={b.id} onClick={()=>transfer(l.id,b.id)} title={b.name} style={{display:"flex",alignItems:"center",gap:6,border:`1px solid ${C.line}`,background:C.surface,borderRadius:999,padding:"3px 10px 3px 3px",cursor:"pointer"}}><Avatar ini={b.ini} color={b.color} size={22}/><span style={{color:C.ink,fontSize:12,fontWeight:500}}>{first(b.name)}</span></button>):<span style={{color:C.hot,fontSize:11.5}}>Ninguém disponível — marque um atendente acima.</span>}
            </div>
          </div>;})}
      </div>
    </div>
  </div>;
}

/* ===== CONVERSAS (ADM) =====
   Acesso irrestrito: a ADM abre a conversa de qualquer corretor, com filtros
   para analisar atendimento por atendimento. Somente leitura — supervisionar
   não marca a conversa como lida, para não apagar o aviso do corretor. */
function Conversas({acoes,pessoas,sel,session,chatRef,isMobile,versao}){
  // A atendente abre na PRÓPRIA caixa (o que está com ela + a fila): ela também
  // atende, e ver a imobiliária inteira misturava o trabalho dela com a
  // supervisão — o lead repassado ao corretor continuava aparecendo. A visão
  // geral fica a um clique. O gestor abre já na equipe inteira, como antes.
  const [escopo,setEscopo]=usarEscolha("conversas.escopo",session.role==="sdr"?"meus":"todos");
  const [f,setF]=usarEscolha("conversas.filtros",{atendente:"",etapa:"",prioridade:"",q:"",de:"",ate:""});
  /* Só "Todos" e "Meus" ficam à vista. Temperatura e "aguardando" desceram para
     a gaveta: cinco pastilhas numa coluna de 340px quebravam em duas linhas e
     comiam o espaço da lista de conversas, que é o que interessa. */
  const [rapido,setRapido]=usarEscolha("conversas.rapido","Todos");
  const [esperando,setEsperando]=usarEscolha("conversas.esperando",false);   // só quem está sem resposta
  const [filtrosAbertos,setFiltrosAbertos]=usarEscolha("conversas.gaveta",false);
  // Quantos filtros detalhados estão ligados. A busca não conta: ela fica sempre à vista.
  const filtrosAtivos=[f.atendente,f.etapa,f.prioridade,f.de,f.ate].filter(Boolean).length+(esperando?1:0);
  const [verFinalizados,setVerFinalizados]=usarEscolha("conversas.finalizados",false);
  const [lista,setLista]=useState([]);
  const [carregando,setCarregando]=useState(true);
  const [pane,setPane]=useState("lista");
  // Guardada junto com os filtros: restaurar um sem o outro deixaria a lista
  // filtrada por um texto que não aparece em lugar nenhum da tela.
  const [busca,setBusca]=usarEscolha("conversas.busca","");
  // Mensagem citada, aqui no mesmo lugar em que os balões são desenhados.
  const [citando,setCitando]=useState(null);
  const [editando,setEditando]=useState(null);

  useEffect(()=>{const t=setTimeout(()=>setF(p=>({...p,q:busca})),350);return()=>clearTimeout(t);},[busca]);
  useEffect(()=>{
    let vivo=true; setCarregando(true);
    const params={}; Object.entries(f).forEach(([k,v])=>{if(v)params[k]=v;});
    if(escopo==="meus")params.escopo="meus";
    if(verFinalizados)params.finalizados="1";
    acoes.buscar(params).then(r=>{if(vivo){setLista(r);setCarregando(false);}}).catch(()=>vivo&&setCarregando(false));
    return()=>{vivo=false;};
  },[f.atendente,f.etapa,f.prioridade,f.q,f.de,f.ate,escopo,verFinalizados,versao]);

  const isCompact=useIsCompact();
  const fichaPorBotao=isMobile||isCompact;
  const corretoresDisponiveis=pessoas.filter(p=>p.role==="corretor"&&p.available);
  // Aplicados sobre o resultado já filtrado pelo servidor. "Aguardando" é o
  // cliente esperando resposta — o mesmo sinal vermelho da caixa de entrada.
  const visiveis=useMemo(()=>lista
    .filter(l=>rapido==="Meus"?l.assignedTo===session.id:true)
    .filter(l=>esperando?l.unread>0:true)
    .sort((a,b)=>(b.unread>0)-(a.unread>0)||(b.lastAt||b.createdAt)-(a.lastAt||a.createdAt)),[lista,rapido,esperando,session.id]);

  const abrir=(id)=>{acoes.abrir(id);setPane("chat");setCitando(null);setEditando(null);};
  const mostrarLista=!isMobile||pane==="lista";
  const mostrarChat=sel&&(isMobile?pane==="chat":(fichaPorBotao?pane!=="ficha":true));
  const mostrarFicha=sel&&(fichaPorBotao?pane==="ficha":true);
  const selo=(label,valor,campo,opcoes)=><select value={valor} onChange={e=>setF({...f,[campo]:e.target.value})}
    style={{fontSize:isMobile?16:12.5,fontWeight:500,color:valor?C.ink:C.sub,background:valor?C.greenSoft:C.surface,border:`1px solid ${valor?C.green+"66":C.line}`,borderRadius:9,padding:"7px 10px",outline:"none",maxWidth:"100%"}}>
    <option value="">{label}</option>
    {opcoes.map(o=><option key={o.v} value={o.v}>{o.t}</option>)}
  </select>;

  return <div style={{height:"100%",display:"flex",minHeight:0}}>
    {mostrarLista&&<div style={{width:isMobile?"100%":340,flexShrink:0,borderRight:isMobile?"none":`1px solid ${C.line}`,background:C.card,display:"flex",flexDirection:"column",minHeight:0}}>
      <div style={{padding:12,borderBottom:`1px solid ${C.line}`,display:"flex",flexDirection:"column",gap:8}}>
        <div style={{display:"flex",alignItems:"center",gap:8,border:`1px solid ${C.line}`,background:C.surface,borderRadius:10,padding:"0 10px"}}>
          <Icon n="search" size={15} color={C.faint}/>
          <input value={busca} onChange={e=>setBusca(e.target.value)} placeholder="Buscar por nome ou telefone"
            style={{flex:1,border:"none",outline:"none",background:"transparent",fontSize:isMobile?16:13,padding:"9px 0",color:C.ink,minWidth:0}}/>
        </div>
        {/* Só a atendente vê esta chave: ela atende e supervisiona, e precisa
            separar as duas coisas. O gestor já enxerga tudo por padrão. */}
        {session.role==="sdr"&&<div style={{display:"flex",gap:0,background:C.surface,borderRadius:10,padding:3}}>
          {[["meus","Minha caixa"],["todos","Toda a equipe"]].map(([v,t])=><button key={v} onClick={()=>setEscopo(v)}
            style={{flex:1,fontSize:isMobile?12.5:11.5,fontWeight:600,padding:isMobile?"8px 0":"6px 0",borderRadius:8,border:"none",cursor:"pointer",
              background:escopo===v?C.card:"transparent",color:escopo===v?C.greenDeep:C.sub,
              boxShadow:escopo===v?"0 1px 2px rgba(0,0,0,.06)":"none"}}>{t}</button>)}
        </div>}
        <div style={{display:"flex",gap:6}}>
          {["Todos","Meus"].map(a=><button key={a} onClick={()=>setRapido(a)}
            style={{flex:1,fontSize:isMobile?12.5:11.5,fontWeight:600,padding:isMobile?"8px 0":"6px 0",borderRadius:999,border:"none",cursor:"pointer",
              background:rapido===a?C.greenDeep:C.surface,color:rapido===a?"#fff":C.sub}}>{a}</button>)}
        </div>
        {/* Os filtros detalhados ficam recolhidos: abertos, empurravam a lista de
            conversas para baixo e sobravam duas visíveis. O contador ao lado do
            botão avisa quando algum está ativo, para ninguém esquecer ligado. */}
        <div style={{display:"flex",alignItems:"center",gap:8}}>
          <button onClick={()=>setFiltrosAbertos(a=>!a)}
            style={{display:"flex",alignItems:"center",gap:6,border:`1px solid ${filtrosAtivos?C.green+"66":C.line}`,background:filtrosAtivos?C.greenSoft:C.surface,color:filtrosAtivos?C.greenDeep:C.sub,borderRadius:9,padding:isMobile?"10px 13px":"6px 11px",fontSize:isMobile?13:12,fontWeight:600,cursor:"pointer"}}>
            <Icon n="columns" size={13}/>Filtros
            {filtrosAtivos>0&&<span style={{minWidth:17,height:17,padding:"0 5px",borderRadius:999,background:C.green,color:"#fff",fontSize:10.5,fontWeight:700,display:"flex",alignItems:"center",justifyContent:"center"}}>{filtrosAtivos}</span>}
            <span style={{display:"inline-flex",transform:filtrosAbertos?"rotate(90deg)":"none",transition:"transform .15s"}}><Icon n="chevron" size={13}/></span>
          </button>
          {/* Atendimento finalizado sai da lista; este é o caminho de volta,
              para consultar ou reabrir sem precisar caçar no funil. */}
          <button onClick={()=>setVerFinalizados(v=>!v)} title="Mostrar também os atendimentos finalizados"
            style={{border:`1px solid ${verFinalizados?C.green+"66":C.line}`,background:verFinalizados?C.greenSoft:C.surface,
              color:verFinalizados?C.greenDeep:C.sub,borderRadius:9,padding:isMobile?"10px 13px":"6px 10px",fontSize:isMobile?13:11.5,fontWeight:600,cursor:"pointer",whiteSpace:"nowrap"}}>
            Finalizados</button>
          <span style={{marginLeft:"auto",color:C.faint,fontSize:11}}>{carregando?"Buscando…":`${visiveis.length} conversa(s)`}</span>
        </div>

        {filtrosAbertos&&<React.Fragment>
          {/* "Aguardando resposta" era pastilha lá em cima. Aqui embaixo ele
              soma com os outros filtros em vez de substituí-los: dá para ver
              quem está esperando DENTRO de uma etapa ou de um corretor. */}
          {/* O "limpar" morava lá em cima, colado no botão Filtros — dois alvos
              a poucos pixels um do outro no celular. Errar o dedo apagava tudo
              de uma vez, e do lado de quem usa isso é o filtro se desmarcando
              sozinho. Aqui embaixo ele só existe com a gaveta aberta, longe do
              botão que se aperta o tempo todo. */}
          <div style={{display:"flex",alignItems:"center",gap:10,flexWrap:"wrap"}}>
            <button onClick={()=>setEsperando(v=>!v)}
              style={{display:"flex",alignItems:"center",gap:6,
                border:`1px solid ${esperando?C.hot+"66":C.line}`,background:esperando?C.hotSoft:C.surface,
                color:esperando?C.hot:C.sub,borderRadius:9,padding:isMobile?"11px 13px":"7px 11px",fontSize:isMobile?13:12,fontWeight:600,cursor:"pointer"}}>
              <Icon n="timer" size={13}/>Só quem está aguardando resposta</button>
            {filtrosAtivos>0&&<button onClick={()=>{setF({atendente:"",etapa:"",prioridade:"",q:f.q,de:"",ate:""});setEsperando(false);}}
              style={{marginLeft:"auto",border:"none",background:"transparent",color:C.faint,fontSize:11.5,cursor:"pointer",textDecoration:"underline"}}>limpar filtros</button>}
          </div>
          <div style={{display:"flex",gap:6,flexWrap:"wrap"}}>
            {selo("Todo mundo",f.atendente,"atendente",[{v:session.id,t:"Comigo"},{v:"fila",t:"Na fila (sem dono)"},...pessoas.map(p=>({v:p.id,t:p.name}))])}
            {selo("Etapa",f.etapa,"etapa",STAGES.map(s=>({v:s,t:s})))}
            {selo("Temperatura",f.prioridade,"prioridade",[{v:"QUENTE",t:"Quente"},{v:"MORNO",t:"Morno"},{v:"FRIO",t:"Frio"}])}
          </div>
          <div style={{display:"flex",gap:6,alignItems:"center",flexWrap:"wrap"}}>
            <span style={{color:C.faint,fontSize:11,fontWeight:600}}>Entraram de</span>
            <input type="date" value={f.de} onChange={e=>setF({...f,de:e.target.value})}
              style={{fontSize:isMobile?16:12,border:`1px solid ${f.de?C.green+"66":C.line}`,background:f.de?C.greenSoft:C.surface,borderRadius:8,padding:"6px 8px",color:C.ink,outline:"none",minWidth:0}}/>
            <span style={{color:C.faint,fontSize:11,fontWeight:600}}>até</span>
            <input type="date" value={f.ate} onChange={e=>setF({...f,ate:e.target.value})}
              style={{fontSize:isMobile?16:12,border:`1px solid ${f.ate?C.green+"66":C.line}`,background:f.ate?C.greenSoft:C.surface,borderRadius:8,padding:"6px 8px",color:C.ink,outline:"none",minWidth:0}}/>
          </div>
        </React.Fragment>}
      </div>
      <div style={{flex:1,overflowY:"auto"}}>
        {!carregando&&visiveis.length===0&&<div style={{color:C.faint,fontSize:13,textAlign:"center",padding:32}}>Nada encontrado com esses filtros.</div>}
        {visiveis.map(l=><ItemLead key={l.id} l={l} ativo={!isMobile&&sel&&sel.id===l.id} onClick={()=>abrir(l.id)} isMobile={isMobile} mostrarDono cutucar={acoes.cutucar}/>)}
      </div>
    </div>}

    {mostrarChat?<div style={{flex:1,display:"flex",flexDirection:"column",minWidth:0,minHeight:0,background:C.surface}}>
      <div style={{background:C.card,borderBottom:`1px solid ${C.line}`,padding:"10px 14px",display:"flex",alignItems:"center",gap:10,flexShrink:0}}>
        {isMobile&&<button onClick={()=>setPane("lista")} aria-label="Voltar" style={{width:34,height:34,borderRadius:10,border:"none",background:C.surface,color:C.sub,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",transform:"scaleX(-1)",flexShrink:0}}><Icon n="chevron" size={17}/></button>}
        <Avatar ini={initials(sel.nome)} color={prioDe(sel.prio).c} size={36}/>
        <div style={{minWidth:0,flex:1}}>
          <div style={{color:C.ink,fontSize:14,fontWeight:600,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{sel.nome}</div>
          <div style={{color:C.faint,fontSize:11.5}}>{fmtTel(sel.tel)} · {sel.assignedName?"com "+first(sel.assignedName):"na fila"}</div>
        </div>
        <BotaoLigar tel={sel.tel} compacto leadId={sel.id} acoes={acoes} nome={sel.nome}/>
        {fichaPorBotao&&<button onClick={()=>setPane("ficha")} style={{display:"flex",alignItems:"center",gap:5,border:`1px solid ${C.line}`,background:C.surface,color:C.sub,fontSize:12,fontWeight:600,padding:"7px 12px",borderRadius:10,cursor:"pointer",flexShrink:0}}><Icon n="star" size={13} color={prioDe(sel.prio).c} fill={prioDe(sel.prio).c}/> Ficha</button>}
      </div>
      {/* A supervisão não mexe na caixa alheia: quem está olhando controla o que
          é dele. Lead na fila também entra — não é de ninguém, então não há aviso
          de corretor para apagar, e alguém precisa poder encerrar. */}
      {(sel.assignedTo===session.id||!sel.assignedTo)&&<ControleConversa lead={sel} acoes={acoes} isMobile={isMobile}/>}
      <BarraControleADM lead={sel} session={session} pessoas={pessoas} acoes={acoes} isMobile={isMobile}/>
      <div ref={chatRef} style={{flex:1,overflowY:"auto",padding:isMobile?"14px 12px":"16px 20px",display:"flex",flexDirection:"column",gap:8,minHeight:0}}>
        {sel.msgs.length===0&&<div style={{color:C.faint,margin:"auto",fontSize:13}}>Nenhuma mensagem trocada ainda.</div>}
        {sel.msgs.map((m,i)=>{
          const abreDia=i===0||!mesmoDia(m.at,sel.msgs[i-1].at);
          // Ligação entra na mesma linha do tempo, como aviso central.
          if(m.from==="system")return <div key={i} style={{alignSelf:"center",background:C.amberSoft,color:"#8a6d1f",fontSize:11,fontWeight:600,padding:"4px 12px",borderRadius:14,margin:"2px 0",maxWidth:"92%",textAlign:"center",lineHeight:1.45,overflowWrap:"anywhere"}}>{m.text}</div>;
          const meu=m.from==="corretor";
          return <React.Fragment key={i}>
            {abreDia&&<SeparadorDia ts={m.at}/>}
            <div style={{display:"flex",justifyContent:meu?"flex-end":"flex-start",alignItems:"center",gap:6,
              /* apagada enquanto está sendo editada lá embaixo, para a pessoa
                 saber qual balão vai mudar */
              opacity:editando&&editando.id===m.id?.45:1}}>
            {meu&&<BotaoEditar m={m} podeEditar aoEditar={()=>setEditando({id:m.id,texto:m.text||""})}/>}
            {meu&&<BotaoResponder m={m} aoResponder={setCitando}/>}
            <div style={{maxWidth:isMobile?"86%":"74%",padding:"8px 12px",fontSize:13.5,lineHeight:1.35,borderRadius:16,background:meu?C.green:C.card,color:meu?"#fff":C.ink,border:meu?"none":`1px solid ${C.line}`,borderBottomRightRadius:meu?4:16,borderBottomLeftRadius:meu?16:4}}>
              {meu&&<div style={{fontSize:10.5,fontWeight:700,color:"rgba(255,255,255,.85)",marginBottom:2,fontStyle:m.byName?"normal":"italic"}}>{m.byName||"Enviada pelo WhatsApp"}</div>}
              <Citacao c={m.citada} claro={meu}/>
              {m.midia&&<Midia m={m} mine={meu} isMobile={isMobile}/>}
              {!m.rotuloAuto&&m.text}<div style={{color:meu?"rgba(255,255,255,.7)":C.faint,fontSize:10,marginTop:2,textAlign:"right"}}>
                {m.editadaEm?<span style={{fontStyle:"italic",marginRight:5}}>editada</span>:null}{fmtClock(m.at)}</div>
            </div>
            {!meu&&<BotaoResponder m={m} aoResponder={setCitando}/>}
            </div>
          </React.Fragment>;})}
        {sel.cutucadoEm&&<AvisoCutucada lead={sel} acoes={acoes}/>}
        {sel.finalizado&&sel.finalizadoEm&&<FechoAtendimento lead={sel}/>}
      </div>
      <ComporADM lead={sel} session={session} acoes={acoes} isMobile={isMobile} citando={citando} setCitando={setCitando}
        editando={editando} setEditando={setEditando} versaoMsgs={versao}/>
    </div>:(!isMobile&&!mostrarFicha&&<div style={{flex:1,background:C.surface,display:"flex",alignItems:"center",justifyContent:"center"}}>
      <div style={{color:C.faint,textAlign:"center",maxWidth:280}}><Icon n="msg" size={26} color={C.faint}/><div style={{fontSize:13,marginTop:10,lineHeight:1.5}}>Escolha uma conversa à esquerda para acompanhar o atendimento.</div></div>
    </div>)}

    {mostrarFicha&&<FichaLead lead={sel} acoes={acoes} corretoresDisponiveis={corretoresDisponiveis}
      aoVoltar={fichaPorBotao?()=>setPane("chat"):null} largura={fichaPorBotao?"100%":300}/>}
  </div>;
}

/* ===== FICHA DO LEAD (supervisão) =====
   A mesma ficha que o corretor vê no Atendimento: qualificação, etapa, venda —
   mais o direcionamento para um corretor, como a SDR faz na catraca. */

/* ===== RESUMO DA CONVERSA (IA) =====

   Para o corretor que acabou de receber um lead com 40 mensagens. Em vez de
   rolar a conversa inteira — o que na prática ninguém faz, e por isso se
   pergunta de novo o que o cliente já respondeu —, ele lê seis linhas.

   Três cuidados que aparecem na tela, não só no código:

   - o resumo é ASSINADO como automático. Quem lê precisa saber que aquilo foi
     escrito por máquina lendo a conversa, e que a conversa continua ali do
     lado para conferir;
   - resumo velho se anuncia: entrando mensagem nova depois dele, a tela diz
     quantas e oferece atualizar. Retrato antigo passando por atual faz o
     corretor agir sobre algo que já mudou;
   - só sai no clique. O texto da conversa vai para o provedor de IA, e isso
     não pode acontecer sozinho em toda conversa que alguém abre. */
function ResumoIA({lead,acoes,isMobile}){
  const [dados,setDados]=useState(lead.resumo&&lead.resumo.gerado||null);
  const [novas,setNovas]=useState(lead.resumo?lead.resumo.novas||0:0);
  const [carregando,setCarregando]=useState(false);
  const [erro,setErro]=useState("");
  const [aberto,setAberto]=useState(false);

  /* Duas coisas diferentes, que estavam no mesmo lugar e por isso brigavam.

     1) Trocar de lead fecha e limpa: o resumo da conversa anterior não diz nada
        sobre esta.
     2) O conteúdo se atualiza sozinho quando o servidor traz resumo mais novo
        (outra pessoa gerou o dela) — mas ATUALIZAR NÃO PODE FECHAR.

     Estava tudo num efeito só, e a lista de dependências olhava o objeto
     `lead.resumo`. A conversa aberta é rebuscada a cada 10 segundos, e cada
     resposta do servidor devolve um objeto NOVO — igual por dentro, diferente
     por fora. Para o React isso é mudança: o efeito rodava, o `aberto` voltava
     para falso e o resumo se fechava sozinho poucos segundos depois do clique.

     Agora o que dispara a sincronia é a HORA do resumo e o número de mensagens
     novas — dois números. Objeto novo com o mesmo conteúdo não mexe em nada. */
  const carimbo=lead.resumo&&lead.resumo.gerado&&lead.resumo.gerado.em||0;
  const novasDoServidor=lead.resumo&&lead.resumo.novas||0;

  useEffect(()=>{ setAberto(false); setErro(""); },[lead.id]);
  useEffect(()=>{
    setDados(lead.resumo&&lead.resumo.gerado||null);
    setNovas(novasDoServidor);
  },[lead.id,carimbo,novasDoServidor]);

  if(!lead.resumo||!lead.resumo.disponivel) return null;

  async function gerar(){
    setCarregando(true); setErro("");
    try{ const r=await acoes.resumirConversa(lead.id); setDados(r.resumo); setNovas(0); setAberto(true); }
    catch(e){ setErro(e.message); }
    finally{ setCarregando(false); }
  }

  const linha=(rotulo,valor)=>valor?<div style={{marginTop:7}}>
    <div style={{color:C.faint,fontSize:10,fontWeight:700,textTransform:"uppercase",letterSpacing:.5}}>{rotulo}</div>
    <div style={{color:C.ink,fontSize:12.5,lineHeight:1.5,marginTop:1}}>{valor}</div>
  </div>:null;

  return <div style={{background:C.card,border:`1px solid ${C.line}`,borderRadius:12,padding:12,marginBottom:14}}>
    <div style={{display:"flex",alignItems:"center",gap:7,flexWrap:"wrap"}}>
      <Icon n="sparkles" size={14} color={C.greenMid}/>
      <span style={{color:C.ink,fontSize:12.5,fontWeight:700,flex:1,minWidth:0}}>Resumo da conversa</span>
      {dados&&<button onClick={()=>setAberto(a=>!a)}
        style={{background:"transparent",border:"none",color:C.sub,fontSize:11.5,fontWeight:600,cursor:"pointer",padding:2}}>
        {aberto?"ocultar":"ver"}</button>}
    </div>

    {!dados&&<React.Fragment>
      <div style={{color:C.sub,fontSize:11.5,lineHeight:1.5,margin:"5px 0 9px"}}>
        A IA lê a conversa e conta em poucas linhas o que o cliente quer, quanto pode pagar e o que ficou combinado.
      </div>
      <button onClick={gerar} disabled={carregando}
        style={{width:"100%",background:carregando?C.faint:C.greenDeep,color:"#fff",border:"none",borderRadius:9,
          padding:"10px",fontSize:12.5,fontWeight:600,cursor:carregando?"default":"pointer",
          display:"flex",alignItems:"center",justifyContent:"center",gap:7}}>
        {carregando?<React.Fragment><Icon n="loader" size={14} spin/> Lendo a conversa…</React.Fragment>
          :<React.Fragment><Icon n="sparkles" size={14}/> Resumir a conversa</React.Fragment>}
      </button>
    </React.Fragment>}

    {dados&&<React.Fragment>
      <div style={{color:C.ink,fontSize:12.5,lineHeight:1.5,marginTop:6}}>{dados.situacao}</div>
      {dados.atencao&&<div style={{background:C.hotSoft,color:C.hot,fontSize:11.5,fontWeight:600,lineHeight:1.45,
        borderRadius:9,padding:"8px 10px",marginTop:8,display:"flex",gap:6}}>
        <Icon n="flame" size={13}/><span>{dados.atencao}</span></div>}
      {dados.proximo_passo&&<div style={{background:C.greenSoft,color:C.greenDeep,fontSize:12,fontWeight:600,
        lineHeight:1.45,borderRadius:9,padding:"8px 10px",marginTop:8}}>Próximo passo: {dados.proximo_passo}</div>}

      {aberto&&<React.Fragment>
        {linha("O que procura",dados.quer)}
        {linha("Quanto pode pagar",dados.pode_pagar)}
        {linha("Já combinado",dados.combinado)}
        {dados.faltando&&dados.faltando.length>0&&<div style={{marginTop:7}}>
          <div style={{color:C.faint,fontSize:10,fontWeight:700,textTransform:"uppercase",letterSpacing:.5}}>Falta perguntar</div>
          <ul style={{margin:"3px 0 0",paddingLeft:16,color:C.ink,fontSize:12.5,lineHeight:1.6}}>
            {dados.faltando.map((f,i)=><li key={i}>{f}</li>)}
          </ul>
        </div>}
      </React.Fragment>}

      {novas>0&&<div style={{background:C.amberSoft,color:"#8a6d1f",fontSize:11.5,borderRadius:9,padding:"7px 9px",marginTop:9,lineHeight:1.45}}>
        {novas} mensagem(ns) nova(s) depois deste resumo.</div>}

      <div style={{display:"flex",alignItems:"center",gap:8,marginTop:9,flexWrap:"wrap"}}>
        <button onClick={gerar} disabled={carregando}
          style={{background:C.surface,color:C.greenDeep,border:`1px solid ${C.green}55`,borderRadius:8,
            padding:"6px 12px",fontSize:11.5,fontWeight:600,cursor:carregando?"default":"pointer",display:"flex",alignItems:"center",gap:6}}>
          {carregando?<React.Fragment><Icon n="loader" size={12} spin/> lendo…</React.Fragment>:"Atualizar"}</button>
        <span style={{color:C.faint,fontSize:10.5,lineHeight:1.4,flex:1,minWidth:120}}>
          Escrito por IA lendo {dados.mensagens_lidas||0} mensagem(ns){dados.em?` · ${fmtClock(dados.em)}`:""}. Confira na conversa antes de agir.
        </span>
      </div>
    </React.Fragment>}

    {erro&&<div style={{color:C.hot,background:C.hotSoft,fontSize:11.5,borderRadius:8,padding:"7px 9px",marginTop:8,lineHeight:1.45}}>{erro}</div>}
  </div>;
}

/* ===== O NOME DO CLIENTE, CORRIGÍVEL =====

   O nome que entra pelo WhatsApp é o que a PESSOA escolheu no aparelho dela:
   às vezes é "Jr 🏡", às vezes é o número puro, às vezes é o nome do marido.
   O CRM guardava aquilo e não havia como arrumar — e é esse nome que aparece
   na lista de conversas, no relatório e na hora de chamar o cliente pelo nome.

   Quem atende corrige, porque é quem descobre o nome verdadeiro na conversa.
   Some do jeito que apareceu: um lápis discreto, e o campo abre no lugar — sem
   popup e sem rolar a tela até outro canto. */
function NomeDoLead({lead,acoes}){
  const [editando,setEditando]=useState(false);
  const [nome,setNome]=useState(lead.nome||"");
  const [salvando,setSalvando]=useState(false);
  const [erro,setErro]=useState("");
  const campo=useRef(null);

  // Trocar de lead fecha a edição — e a atualização de 10 em 10 segundos não
  // pode apagar o que está sendo digitado, então quem manda aqui é o id.
  useEffect(()=>{ setEditando(false); setErro(""); setNome(lead.nome||""); },[lead.id]);
  useEffect(()=>{ if(editando&&campo.current){ campo.current.focus(); campo.current.select(); } },[editando]);

  async function salvar(){
    const novo=nome.replace(/\s+/g," ").trim();
    if(!novo) return setErro("Escreva o nome do cliente.");
    if(novo===lead.nome) return setEditando(false);
    setSalvando(true); setErro("");
    try{ await acoes.renomearLead(lead.id,novo); setEditando(false); }
    catch(e){ setErro(e.message); }
    finally{ setSalvando(false); }
  }

  if(!editando) return <div style={{display:"flex",alignItems:"center",gap:6,marginBottom:12}}>
    <span style={{color:C.ink,fontFamily:DISPLAY,fontSize:15,fontWeight:700,minWidth:0,
      overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{lead.nome}</span>
    <button onClick={()=>{setNome(lead.nome||"");setEditando(true);}} title="Corrigir o nome do cliente"
      aria-label="Corrigir o nome do cliente"
      style={{border:"none",background:"transparent",color:C.faint,cursor:"pointer",padding:2,display:"flex",flexShrink:0}}>
      <Icon n="edit" size={13}/></button>
  </div>;

  return <div style={{marginBottom:12}}>
    <div style={{display:"flex",gap:6,alignItems:"center"}}>
      <input ref={campo} value={nome} onChange={e=>setNome(e.target.value)} maxLength={80}
        onKeyDown={e=>{ if(e.key==="Enter") salvar(); if(e.key==="Escape") setEditando(false); }}
        placeholder="Nome do cliente"
        style={{flex:1,minWidth:0,fontSize:16,fontWeight:600,border:`1px solid ${C.green}66`,background:C.surface,
          borderRadius:9,padding:"8px 10px",color:C.ink,outline:"none"}}/>
      <button onClick={salvar} disabled={salvando}
        style={{background:C.greenDeep,color:"#fff",border:"none",borderRadius:9,padding:"9px 13px",
          fontSize:12.5,fontWeight:700,cursor:salvando?"default":"pointer",flexShrink:0}}>
        {salvando?"…":"Salvar"}</button>
      <button onClick={()=>setEditando(false)} disabled={salvando}
        style={{background:"transparent",border:"none",color:C.faint,fontSize:12.5,cursor:"pointer",padding:4,flexShrink:0}}>
        cancelar</button>
    </div>
    {erro&&<div style={{color:C.hot,fontSize:11.5,marginTop:5}}>{erro}</div>}
  </div>;
}

/* ===== A IA LÊ A CONVERSA E DIZ A ETAPA (SUGESTÃO) =====

   A palavra-chave só pega quando a palavra é dita. "Me manda seus
   comprovantes" é Pasta e nenhum gatilho alcança. Aqui a IA lê a conversa
   inteira e diz onde o atendimento está.

   Sugestão, nunca decisão. O botão que muda a etapa é o mesmo de sempre e
   quem aperta é o corretor — a IA no CRM lê, não escreve. E a sugestão vem
   sempre com o MOTIVO e o TRECHO da conversa: sem a frase que sustenta, é
   palpite, e ninguém confirma palpite sobre o próprio trabalho.

   Não aparece quando a IA concorda com a etapa atual: confirmar o que já está
   feito é ruído. */
function EtapaIA({lead,acoes,isMobile}){
  const [sug,setSug]=useState(lead.etapaIA&&lead.etapaIA.sugestao||null);
  const [novas,setNovas]=useState(lead.etapaIA&&lead.etapaIA.novas||0);
  const [carregando,setCarregando]=useState(false);
  const [aplicando,setAplicando]=useState(false);
  const [erro,setErro]=useState("");

  // Mesmo cuidado do resumo: a conversa aberta é rebuscada de 10 em 10
  // segundos e cada resposta traz um objeto novo. Quem manda aqui são os
  // números, não a identidade do objeto — senão o cartão se refaz sozinho.
  const carimbo=lead.etapaIA&&lead.etapaIA.sugestao&&lead.etapaIA.sugestao.em||0;
  const novasDoServidor=lead.etapaIA&&lead.etapaIA.novas||0;
  useEffect(()=>{ setErro(""); },[lead.id]);
  useEffect(()=>{
    setSug(lead.etapaIA&&lead.etapaIA.sugestao||null);
    setNovas(novasDoServidor);
  },[lead.id,carimbo,novasDoServidor]);

  if(!lead.etapaIA||!lead.etapaIA.disponivel) return null;

  async function ler(){
    setCarregando(true); setErro("");
    try{ const r=await acoes.lerEtapaIA(lead.id); setSug(r.sugestao); setNovas(0); }
    catch(e){ setErro(e.message); }
    finally{ setCarregando(false); }
  }
  async function aplicar(){
    setAplicando(true); setErro("");
    try{ await acoes.mudarEtapa(lead.id,sug.etapa); }
    catch(e){ setErro(e.message); }
    finally{ setAplicando(false); }
  }

  const concorda=sug&&sug.etapa===lead.status;
  const CONF={alta:{t:"confiança alta",c:C.greenDeep,bg:C.greenSoft},
              media:{t:"confiança média",c:"#8a6d1f",bg:C.amberSoft},
              baixa:{t:"confiança baixa",c:C.hot,bg:C.hotSoft}};

  return <div style={{background:C.card,border:`1px solid ${C.line}`,borderRadius:12,padding:12,marginBottom:14}}>
    <div style={{display:"flex",alignItems:"center",gap:7,flexWrap:"wrap",marginBottom:sug?7:5}}>
      <Icon n="target" size={14} color={C.greenMid}/>
      <span style={{color:C.ink,fontSize:12.5,fontWeight:700,flex:1,minWidth:0}}>Etapa lida pela IA</span>
      {sug&&<button onClick={ler} disabled={carregando}
        style={{background:"transparent",border:"none",color:C.sub,fontSize:11.5,fontWeight:600,cursor:carregando?"default":"pointer",padding:2}}>
        {carregando?"lendo…":"reler"}</button>}
    </div>

    {!sug&&<React.Fragment>
      <div style={{color:C.sub,fontSize:11.5,lineHeight:1.5,marginBottom:9}}>
        A palavra-chave só move o funil quando a palavra é dita. A IA lê a conversa toda e sugere a etapa — você confirma.
      </div>
      <button onClick={ler} disabled={carregando}
        style={{width:"100%",background:carregando?C.faint:C.greenDeep,color:"#fff",border:"none",borderRadius:9,
          padding:"10px",fontSize:12.5,fontWeight:600,cursor:carregando?"default":"pointer",
          display:"flex",alignItems:"center",justifyContent:"center",gap:7}}>
        {carregando?<React.Fragment><Icon n="loader" size={14} spin/> Lendo a conversa…</React.Fragment>
          :<React.Fragment><Icon n="sparkles" size={14}/> Ler a etapa na conversa</React.Fragment>}
      </button>
    </React.Fragment>}

    {sug&&<React.Fragment>
      <div style={{display:"flex",alignItems:"center",gap:8,flexWrap:"wrap",marginBottom:7}}>
        <span style={{color:C.faint,fontSize:11.5}}>está em</span>
        <span style={{color:STAGE_C[lead.status]||C.ink,fontSize:12.5,fontWeight:700}}>{lead.status}</span>
        {!concorda&&<React.Fragment>
          <Icon n="chevron" size={12} color={C.faint}/>
          <span style={{color:STAGE_C[sug.etapa]||C.ink,fontSize:13,fontWeight:800}}>{sug.etapa}</span>
        </React.Fragment>}
        <span style={{marginLeft:"auto",background:CONF[sug.confianca].bg,color:CONF[sug.confianca].c,
          fontSize:10,fontWeight:700,borderRadius:999,padding:"2px 8px"}}>{CONF[sug.confianca].t}</span>
      </div>

      {concorda
        ?<div style={{background:C.greenSoft,color:C.greenDeep,fontSize:11.5,fontWeight:600,lineHeight:1.45,borderRadius:9,padding:"8px 10px"}}>
          A IA concorda com a etapa atual. Nada a mudar.</div>
        :<div style={{color:C.ink,fontSize:12,lineHeight:1.5}}>{sug.porque}</div>}

      {/* O trecho é o que transforma sugestão em conferível: dá para bater o
          olho e ver se a IA leu a conversa certa. */}
      {sug.trecho&&<div style={{background:C.surface,borderLeft:`3px solid ${C.green}66`,borderRadius:"0 9px 9px 0",
        padding:"7px 10px",marginTop:8,color:C.sub,fontSize:11.5,lineHeight:1.45,fontStyle:"italic"}}>
        “{sug.trecho}”</div>}

      {novas>0&&<div style={{background:C.amberSoft,color:"#8a6d1f",fontSize:11.5,borderRadius:9,padding:"7px 9px",marginTop:8,lineHeight:1.45}}>
        {novas} mensagem(ns) nova(s) depois desta leitura.</div>}

      {erro&&<div style={{color:C.hot,background:C.hotSoft,fontSize:11.5,borderRadius:8,padding:"7px 9px",marginTop:8,lineHeight:1.45}}>{erro}</div>}

      {!concorda&&<div style={{display:"flex",alignItems:"center",gap:8,marginTop:10,flexWrap:"wrap"}}>
        <button onClick={aplicar} disabled={aplicando}
          style={{background:C.greenDeep,color:"#fff",border:"none",borderRadius:9,padding:"8px 14px",
            fontSize:12.5,fontWeight:700,cursor:aplicando?"default":"pointer",display:"flex",alignItems:"center",gap:6}}>
          {aplicando?<React.Fragment><Icon n="loader" size={12} spin/> movendo…</React.Fragment>
            :<React.Fragment><Icon n="check" size={13}/> Mover para {sug.etapa}</React.Fragment>}</button>
        <span style={{color:C.faint,fontSize:10.5,lineHeight:1.4,flex:1,minWidth:120}}>
          Só muda se você confirmar. A IA não mexe no funil sozinha.</span>
      </div>}

      <div style={{color:C.faint,fontSize:10.5,lineHeight:1.4,marginTop:8}}>
        Lido por IA em {sug.mensagens_lidas||0} mensagem(ns){sug.em?` · ${fmtClock(sug.em)}`:""}.
      </div>
    </React.Fragment>}
  </div>;
}

function FichaLead({lead,acoes,corretoresDisponiveis,aoVoltar,largura}){
  const [simulando,setSimulando]=useState(false);
  // Ocupa o lugar da ficha, como o cadastro de imóveis faz. Sem sobreposição,
  // não há barra do celular por cima nem disputa de camada.
  if(simulando) return <div style={{width:largura,flex:aoVoltar?1:"none",flexShrink:0,borderLeft:aoVoltar?"none":`1px solid ${C.line}`,background:C.card,minHeight:0,height:"100%"}}>
    <Simulacao lead={lead} acoes={acoes} isMobile={largura==="100%"} aoFechar={()=>setSimulando(false)}/>
  </div>;
  return <div style={{width:largura,flex:aoVoltar?1:"none",flexShrink:0,borderLeft:aoVoltar?"none":`1px solid ${C.line}`,background:C.card,overflowY:"auto",minHeight:0}}>
    <div style={{padding:16}}>
      <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:12}}>
        {aoVoltar&&<button onClick={aoVoltar} aria-label="Voltar para a conversa" style={{width:34,height:34,borderRadius:10,border:"none",background:C.surface,color:C.sub,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",transform:"scaleX(-1)",flexShrink:0}}><Icon n="chevron" size={17}/></button>}
        <Icon n="star" size={14} color={prioDe(lead.prio).c} fill={prioDe(lead.prio).c}/>
        <span style={{color:C.ink,fontSize:13,fontWeight:700}}>Ficha do lead</span>
      </div>

      <NomeDoLead lead={lead} acoes={acoes}/>
      <ResumoIA lead={lead} acoes={acoes} isMobile={largura==="100%"}/>
      <EtapaIA lead={lead} acoes={acoes} isMobile={largura==="100%"}/>
      <TarefasDoLead lead={lead} acoes={acoes} isMobile={largura==="100%"}/>

      <div style={{background:C.greenSoft,border:`1px solid ${C.green}33`,borderRadius:12,padding:12,marginBottom:14}}>
        <Recomendacao leadId={lead.id} acoes={acoes} onDirecionar={(id)=>acoes.repassar(lead.id,id)}/>
        <div style={{color:C.greenDeep,fontSize:11.5,fontWeight:700,display:"flex",alignItems:"center",gap:5,marginBottom:6}}><Icon n="transfer" size={13} color={C.greenMid}/> Direcionar para um corretor</div>
        <div style={{color:C.sub,fontSize:11.5,lineHeight:1.4,marginBottom:8}}>O lead sai da conta atual e passa para o corretor escolhido.</div>
        <button onClick={()=>acoes.repassar(lead.id)} disabled={!corretoresDisponiveis.length}
          style={{width:"100%",background:corretoresDisponiveis.length?C.green:C.coolSoft,color:corretoresDisponiveis.length?"#fff":C.faint,border:"none",cursor:corretoresDisponiveis.length?"pointer":"default",fontSize:12.5,fontWeight:600,padding:"9px",borderRadius:9,display:"flex",alignItems:"center",justifyContent:"center",gap:6}}>
          <Icon n="transfer" size={14}/> Corretor da vez (rodízio)
        </button>
        <div style={{color:C.faint,fontSize:10.5,margin:"8px 0 5px"}}>ou escolher:</div>
        <div style={{display:"flex",flexWrap:"wrap",gap:5}}>
          {corretoresDisponiveis.length
            ?corretoresDisponiveis.map(b=><button key={b.id} onClick={()=>acoes.repassar(lead.id,b.id)} title={b.name} style={{display:"flex",alignItems:"center",gap:5,border:`1px solid ${C.line}`,background:C.card,borderRadius:999,padding:"3px 9px 3px 3px",cursor:"pointer"}}><Avatar ini={b.ini} color={b.color} size={20}/><span style={{color:C.ink,fontSize:11.5,fontWeight:500}}>{first(b.name)}</span></button>)
            :<span style={{color:C.hot,fontSize:11}}>Nenhum corretor disponível agora — marque alguém na catraca.</span>}
        </div>
      </div>

      <label style={{color:C.faint,fontSize:10.5,fontWeight:600,textTransform:"uppercase",letterSpacing:.5}}>Etapa do funil</label>
      <select value={lead.status} onChange={e=>acoes.mudarEtapa(lead.id,e.target.value)}
        style={{width:"100%",marginTop:4,marginBottom:8,fontSize:16,fontWeight:600,borderRadius:8,border:`1px solid ${C.line}`,padding:"8px 10px",outline:"none",color:STAGE_C[lead.status],background:C.surface}}>
        {STAGES.map(s=><option key={s} value={s}>{s}</option>)}
      </select>
      <DicaEtapa etapa={lead.status}/>

      <div style={{display:"flex",flexDirection:"column",gap:10}}>
        {[["Renda familiar",lead.qual.renda,"target","renda"],["Entrada",lead.qual.entrada,"check","entrada"],["Situação",lead.qual.situacao,"users","situacao"],["Restrição CPF",lead.qual.cpf,"award","cpf"],["Prazo p/ comprar",lead.qual.prazo,"calendar","prazo"]].map(([k,v,n,campo])=>
          <CampoQual key={k} rotulo={k} valor={v} icone={n} onSalvar={(novo)=>acoes.salvarQualificacao(lead.id,{[campo]:novo})}/>)}
      </div>

      {/* A simulação é do LEAD, não do imóvel: os números dependem da renda e do
          subsídio de quem vai comprar. Por isso o botão mora aqui na ficha. */}
      <button onClick={()=>setSimulando(true)}
        style={{width:"100%",marginTop:14,border:`1px solid ${C.green}55`,background:C.greenSoft,color:C.greenDeep,
          borderRadius:11,padding:"12px",fontSize:13.5,fontWeight:600,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",gap:7}}>
        <Icon n="chart" size={15}/> Registrar simulação
      </button>

      <FichaVenda lead={lead} onSalvar={(d)=>acoes.registrarVenda(lead.id,d)}/>

      <div style={{borderTop:`1px solid ${C.line}`,marginTop:16,paddingTop:12,display:"flex",flexDirection:"column",gap:6}}>
        <div style={{color:C.sub,fontSize:11.5,display:"flex",alignItems:"center",gap:6}}><Icon n="users" size={12} color={C.faint}/> {lead.assignedName?"com "+lead.assignedName:"na fila da catraca"}</div>
        <div style={{color:C.sub,fontSize:11.5,display:"flex",alignItems:"center",gap:6}}><Icon n="mail" size={12} color={C.faint}/> via {lead.origem}</div>
        <div style={{color:C.sub,fontSize:11.5,display:"flex",alignItems:"center",gap:6}}><Icon n="clock" size={12} color={C.faint}/> entrou há {fmtAge(Date.now()-lead.createdAt)}</div>
      </div>
    </div>
  </div>;
}

/* ===== BARRA DE CONTROLE DA ADM =====
   Mostra de quem é o lead e permite assumir a negociação ou devolver. */
function BarraControleADM({lead,session,pessoas,acoes,isMobile}){
  const [devolvendo,setDevolvendo]=useState(false);
  const meu=lead.assignedTo===session.id;
  useEffect(()=>setDevolvendo(false),[lead.id]);

  // Fecha o painel assim que a devolução acontece — senão ele fica aberto
  // sugerindo que a ação não foi concluída.
  const devolverPara=async(userId)=>{ await acoes.devolver(lead.id,userId); setDevolvendo(false); };

  if(devolvendo) return <div style={{background:C.surface,borderBottom:`1px solid ${C.line}`,padding:"10px 14px",flexShrink:0}}>
    <div style={{color:C.sub,fontSize:11.5,fontWeight:600,marginBottom:7}}>Devolver este atendimento para:</div>
    <div style={{display:"flex",gap:6,flexWrap:"wrap"}}>
      <button onClick={()=>devolverPara()} style={{display:"flex",alignItems:"center",gap:5,border:`1px solid ${C.line}`,background:C.card,color:C.sub,borderRadius:999,padding:"5px 12px",fontSize:12,fontWeight:600,cursor:"pointer"}}><Icon n="transfer" size={13}/> Fila da catraca</button>
      {pessoas.map(p=><button key={p.id} onClick={()=>devolverPara(p.id)} style={{display:"flex",alignItems:"center",gap:5,border:`1px solid ${C.line}`,background:C.card,borderRadius:999,padding:"3px 10px 3px 3px",cursor:"pointer"}}>
        <Avatar ini={p.ini} color={p.color} size={20}/><span style={{color:C.ink,fontSize:12,fontWeight:500}}>{first(p.name)}</span></button>)}
      <button onClick={()=>setDevolvendo(false)} style={{border:"none",background:"transparent",color:C.faint,fontSize:12,cursor:"pointer"}}>cancelar</button>
    </div>
  </div>;

  return <div style={{background:meu?C.greenSoft:C.amberSoft,borderBottom:`1px solid ${meu?C.green+"33":C.amber+"33"}`,color:meu?C.greenDeep:"#8a6d1f",fontSize:11.5,padding:"7px 14px",display:"flex",alignItems:"center",gap:8,flexWrap:"wrap",flexShrink:0}}>
    <Icon n={meu?"star":"users"} size={13}/>
    <span style={{flex:1,minWidth:isMobile?"100%":160,lineHeight:1.4}}>
      {meu?"Você assumiu esta negociação — o lead está na sua mão."
          :lead.assignedName?`Em atendimento por ${lead.assignedName}. Você pode responder assim mesmo; para tomar a frente, assuma.`
          :"Este lead está na fila, sem atendente."}
    </span>
    {meu
      ?<button onClick={()=>setDevolvendo(true)} style={{border:`1px solid ${C.green}55`,background:C.card,color:C.greenMid,fontSize:11.5,fontWeight:700,padding:"5px 11px",borderRadius:8,cursor:"pointer",flexShrink:0}}>Devolver</button>
      :<button onClick={()=>acoes.assumir(lead.id)} style={{border:"none",background:C.greenDeep,color:"#fff",fontSize:11.5,fontWeight:700,padding:"6px 12px",borderRadius:8,cursor:"pointer",flexShrink:0,display:"flex",alignItems:"center",gap:5}}><Icon n="zap" size={12}/> Assumir negociação</button>}
  </div>;
}

/* ===== CAMPO DE ENVIO DA ADM =====
   A mensagem sai pelo número da Conecta assinada com o nome da ADM, igual à do
   corretor — o cliente sempre sabe com quem está falando. */
function ComporADM({lead,session,acoes,isMobile,citando,setCitando,editando,setEditando,versaoMsgs}){
  const [draft,setDraft]=useState("");
  const [enviando,setEnviando]=useState(false);
  const [enviandoImovel,setEnviandoImovel]=useState(false);
  const [erroAnexo,setErroAnexo]=useState("");
  const [colando,setColando]=useState(false);
  const [colados,setColados]=useState([]);
  const [mandandoColados,setMandandoColados]=useState(false);
  const [erroEdicao,setErroEdicao]=useState("");
  const [salvandoEdicao,setSalvandoEdicao]=useState(false);
  const rascunhoAntes=useRef("");
  const mensagensProntas=usarMensagensRapidas(acoes,versaoMsgs);
  const colar=usarColar({lead,aoAvisar:setErroAnexo,aoMudarEstado:setColando,
    quantasJa:colados.length, aoColar:(novas)=>setColados(a=>[...a,...novas])});
  useEffect(()=>{setColados([]);},[lead.id]);

  /* O lápis fica lá em cima, junto do balão, mas quem digita é este campo:
     ao abrir a edição o texto desce para cá, e o rascunho que estava escrito
     fica guardado para voltar se a pessoa desistir. */
  const emEdicao=editando&&editando.id;
  useEffect(()=>{
    if(!emEdicao) return;
    rascunhoAntes.current=draft;
    setDraft(editando.texto||"");
    setCitando(null); setColados([]); setErroEdicao("");
  },[emEdicao]);
  function cancelarEdicao(){ setDraft(rascunhoAntes.current); setEditando(null); setErroEdicao(""); }
  async function salvarEdicao(){
    if(!draft.trim()||salvandoEdicao) return;
    setSalvandoEdicao(true); setErroEdicao("");
    try{ await acoes.editarMensagem(lead.id,editando.id,draft.trim()); setDraft(rascunhoAntes.current); setEditando(null); }
    catch(e){ setErroEdicao(e.message); }
    finally{ setSalvandoEdicao(false); }
  }
  // Trocar de conversa cancela a edição em aberto.
  useEffect(()=>{setEditando(null);setErroEdicao("");},[lead.id]);
  async function enviarColados(){
    if(!colados.length||mandandoColados) return;
    setMandandoColados(true); setErroAnexo("");
    const legenda=draft.trim();
    try{
      await acoes.anexar(lead.id,colados.map(({previa,...a})=>a),legenda||undefined);
      setColados([]); if(legenda) setDraft("");
    }catch(e){ setErroAnexo(e.message); }
    finally{ setMandandoColados(false); }
  }
  useEffect(()=>setDraft(""),[lead.id]);

  async function enviar(){
    if(!draft.trim()||enviando) return;
    const texto=draft.replace("{nome}",first(lead.nome));
    const citada=citando;
    setEnviando(true); setDraft(""); setCitando(null);
    try{ await acoes.enviar(lead.id,texto,citada&&citada.id); } finally{ setEnviando(false); }
  }

  return <div style={{background:C.card,borderTop:`1px solid ${C.line}`,padding:12,flexShrink:0}}>
    <div style={{display:"flex",gap:6,marginBottom:8,overflowX:"auto",paddingBottom:4}}>
      <button onClick={()=>setEnviandoImovel(true)} style={{fontSize:11,fontWeight:600,padding:"4px 10px",borderRadius:999,border:`1px solid ${C.green}55`,cursor:"pointer",whiteSpace:"nowrap",display:"flex",alignItems:"center",gap:4,color:C.greenDeep,background:C.card,flexShrink:0}}><Icon n="pin" size={11}/> Enviar imóvel</button>
      {mensagensProntas.map(tp=><button key={tp.id} onClick={()=>setDraft(tp.corpo)} style={{fontSize:11,fontWeight:500,padding:"4px 10px",borderRadius:999,border:"none",cursor:"pointer",whiteSpace:"nowrap",display:"flex",alignItems:"center",gap:4,color:C.greenMid,background:C.greenSoft,flexShrink:0}}><Icon n="zap" size={11}/> {tp.titulo}</button>)}
    </div>
    {enviandoImovel&&<EnviarImovel lead={lead} acoes={acoes} isMobile={isMobile} aoFechar={()=>setEnviandoImovel(false)}/>}
    <PreviaColagem arquivos={colados} legenda={draft} enviando={mandandoColados} isMobile={isMobile}
      onRemover={(i)=>setColados(a=>a.filter((_,k)=>k!==i))}
      onEnviar={enviarColados} onCancelar={()=>setColados([])}/>
    {editando&&<BarraEdicao texto={editando.texto} erro={erroEdicao} isMobile={isMobile} aoCancelar={cancelarEdicao}/>}
    {citando&&<Citacao c={citando} aoFechar={()=>setCitando(null)}/>}
    <div style={{display:"flex",alignItems:"flex-end",gap:8}}>
      <Anexar lead={lead} acoes={acoes} isMobile={isMobile} aoAvisar={setErroAnexo}/>
      <textarea value={draft} onChange={e=>setDraft(e.target.value)} onPaste={colar}
        onKeyDown={e=>{
          if(e.key==="Escape"&&editando){e.preventDefault();cancelarEdicao();return;}
          if(e.key==="Enter"&&!e.shiftKey&&!isMobile){e.preventDefault();editando?salvarEdicao():colados.length?enviarColados():enviar();}}}
        rows={2} placeholder={colando?"Colando a imagem…":"Responder como direção…  (Ctrl+V cola imagem)"}
        style={{flex:1,minWidth:0,fontSize:isMobile?16:13.5,borderRadius:12,border:`1px solid ${C.line}`,padding:"8px 12px",outline:"none",resize:"none",color:C.ink,background:C.surface,fontFamily:FONT}}/>
      <button onClick={()=>editando?salvarEdicao():colados.length?enviarColados():enviar()}
        title={editando?"Salvar a edição":"Enviar"}
        disabled={enviando||mandandoColados||salvandoEdicao||(!draft.trim()&&!colados.length)}
        style={{width:44,height:44,borderRadius:12,border:"none",cursor:enviando?"default":"pointer",background:enviando||mandandoColados||salvandoEdicao||(!draft.trim()&&!colados.length)?C.faint:(editando?C.greenDeep:C.green),color:"#fff",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}><Icon n={enviando||mandandoColados||salvandoEdicao?"loader":editando?"check":"send"} size={18} spin={enviando||mandandoColados||salvandoEdicao}/></button>
    </div>
    {erroAnexo&&<div onClick={()=>setErroAnexo("")} style={{color:C.hot,background:C.hotSoft,fontSize:11.5,marginTop:6,padding:"6px 9px",borderRadius:8,cursor:"pointer"}}>{erroAnexo}</div>}
    <div style={{color:C.faint,fontSize:10.5,marginTop:6,display:"flex",alignItems:"center",gap:5}}>
      <Icon n="msg" size={11} color={C.faint}/> Sai pelo número da Conecta, assinada como <b style={{color:C.sub}}>&nbsp;{first(session.name)}</b>.
    </div>
  </div>;
}

/* ===== MINHA CONTA =====
   Igual para corretor, atendente e gestor. Cada um cuida dos próprios dados. */
/* ===== QUAL VERSÃO ESTE APARELHO ESTÁ RODANDO =====

   Mostrava só a versão do aparelho. Faltava a metade que resolve a discussão:
   qual está PUBLICADA no servidor. Sem as duas lado a lado, "consertei" e
   "aqui continua igual" são duas afirmações verdadeiras que ninguém consegue
   reconciliar — e foi exatamente o que aconteceu com o card do funil.

   Iguais: o aparelho está em dia, e o problema é outro.
   Diferentes: é versão velha, e o botão resolve na hora. */
function VersaoDoApp(){
  const meu=typeof window!=="undefined"?window.CONHUB_BUILD:null;
  const [publicada,setPublicada]=useState(null);
  useEffect(()=>{ let vivo=true;
    fetch("/versao.txt?v="+Date.now(),{cache:"no-store"})
      .then(r=>r.ok?r.text():null)
      .then(t=>vivo&&setPublicada(t?t.trim():false)).catch(()=>vivo&&setPublicada(false));
    return()=>{vivo=false;};},[]);
  if(!meu) return null;

  const velha=publicada&&publicada!==meu;
  return <div style={{textAlign:"center",marginTop:6,lineHeight:1.6}}>
    <div style={{color:C.faint,fontSize:11}}>ConHub · versão {meu}</div>
    {publicada===false&&<div style={{color:C.faint,fontSize:10.5}}>não consegui conferir a versão do servidor</div>}
    {publicada&&!velha&&<div style={{color:C.greenMid,fontSize:10.5,fontWeight:600}}>este aparelho está na última versão</div>}
    {velha&&<React.Fragment>
      <div style={{color:C.hot,fontSize:11,fontWeight:600}}>o servidor já está na {publicada}</div>
      <button onClick={atualizarConHub}
        style={{marginTop:7,background:C.greenDeep,color:"#fff",border:"none",borderRadius:9,
          padding:"9px 16px",fontSize:12.5,fontWeight:700,cursor:"pointer"}}>Atualizar este aparelho</button>
    </React.Fragment>}
  </div>;
}

/* Recarrega de verdade: derruba o service worker e os caches antes.

   Só apertar F5 muitas vezes devolve o mesmo arquivo guardado — e a pessoa
   conclui que o conserto não foi feito. */
async function atualizarConHub(){
  try{
    if(navigator.serviceWorker){
      const rs=await navigator.serviceWorker.getRegistrations();
      await Promise.all(rs.map(r=>r.unregister()));
    }
    if(window.caches){ const ks=await caches.keys(); await Promise.all(ks.map(k=>caches.delete(k))); }
  }catch(e){}
  location.replace(location.pathname+"?atualizado="+Date.now());
}

function MinhaConta({session,acoes,isMobile,aoAtualizar}){
  const [f,setF]=useState({name:session.name,email:session.email,phone:session.phone||""});
  const [senha,setSenha]=useState({atual:"",nova:"",repetir:""});
  const [avisoDados,setAviso]=useState(null);
  const [avisoSenha,setAvisoSenha]=useState(null);
  const [salvando,setSalvando]=useState(false);
  const [trocando,setTrocando]=useState(false);
  const [subindo,setSubindo]=useState(false);

  const set=(k)=>(e)=>setF({...f,[k]:e.target.value});
  const setS=(k)=>(e)=>setSenha({...senha,[k]:e.target.value});
  const mudou=f.name!==session.name||f.email!==session.email||f.phone!==(session.phone||"");

  async function salvarDados(){
    setAviso(null); setSalvando(true);
    try{ await acoes.salvarPerfil(f); setAviso({ok:true,txt:"Dados atualizados."}); }
    catch(e){ setAviso({ok:false,txt:e.message}); }
    finally{ setSalvando(false); }
  }
  async function trocarSenha(){
    setAvisoSenha(null);
    if(senha.nova!==senha.repetir) return setAvisoSenha({ok:false,txt:"A nova senha e a repetição não são iguais."});
    setTrocando(true);
    try{ await acoes.trocarSenha(senha.atual,senha.nova);
      setSenha({atual:"",nova:"",repetir:""}); setAvisoSenha({ok:true,txt:"Senha alterada. Ela já vale no próximo acesso."}); }
    catch(e){ setAvisoSenha({ok:false,txt:e.message}); }
    finally{ setTrocando(false); }
  }
  async function enviarFoto(ev){
    const arq=ev.target.files&&ev.target.files[0]; ev.target.value="";
    if(!arq) return;
    setSubindo(true); setAviso(null);
    try{
      const base64=await new Promise((ok,err)=>{const fr=new FileReader();fr.onload=()=>ok(fr.result);fr.onerror=err;fr.readAsDataURL(arq);});
      await acoes.enviarFoto(arq.type,base64);
    }catch(e){ setAviso({ok:false,txt:e.message}); }
    finally{ setSubindo(false); }
  }
  const recado=(a)=>a&&<div style={{fontSize:12.5,borderRadius:9,padding:"9px 11px",lineHeight:1.45,
    color:a.ok?C.greenDeep:C.hot,background:a.ok?C.greenSoft:C.hotSoft}}>{a.txt}</div>;

  return <div style={{height:"100%",overflowY:"auto",padding:isMobile?14:20}}>
    <div style={{maxWidth:560,margin:"0 auto",display:"flex",flexDirection:"column",gap:14}}>

      <div style={{background:C.card,border:`1px solid ${C.line}`,borderRadius:14,padding:16,display:"flex",alignItems:"center",gap:14,flexWrap:"wrap"}}>
        <Avatar ini={session.ini} color={session.color} size={64} foto={session.avatar}/>
        <div style={{flex:1,minWidth:150}}>
          <div style={{color:C.ink,fontFamily:DISPLAY,fontSize:17,fontWeight:700}}>{session.name}</div>
          <div style={{color:C.faint,fontSize:12.5}}>{session.funcao||roleParaTexto(session.role)}</div>
          <div style={{display:"flex",gap:8,marginTop:9,flexWrap:"wrap"}}>
            <label style={{display:"inline-flex",alignItems:"center",gap:6,border:`1px solid ${C.line}`,background:C.surface,color:C.sub,borderRadius:9,padding:"7px 12px",fontSize:12.5,fontWeight:600,cursor:subindo?"default":"pointer"}}>
              <Icon n={subindo?"loader":"users"} size={13} spin={subindo}/>{subindo?"Enviando…":session.avatar?"Trocar foto":"Adicionar foto"}
              <input type="file" accept="image/jpeg,image/png,image/webp" onChange={enviarFoto} disabled={subindo} style={{display:"none"}}/>
            </label>
            {session.avatar&&<button onClick={()=>acoes.removerFoto()} style={{border:`1px solid ${C.line}`,background:C.card,color:C.hot,borderRadius:9,padding:"7px 12px",fontSize:12.5,fontWeight:600,cursor:"pointer"}}>Remover</button>}
          </div>
        </div>
      </div>

      <div style={{background:C.card,border:`1px solid ${C.line}`,borderRadius:14,padding:16,display:"flex",flexDirection:"column",gap:12}}>
        <div style={{color:C.ink,fontSize:13.5,fontWeight:700}}>Meus dados</div>
        <div>{rotulo("Nome completo")}<input value={f.name} onChange={set("name")} style={entrada}/></div>
        <div>
          {rotulo("E-mail")}
          <input value={f.email} onChange={set("email")} type="email" inputMode="email" style={entrada}/>
          <div style={{color:C.faint,fontSize:11,marginTop:5}}>É com ele que você entra no ConHub.</div>
        </div>
        <div>{rotulo("WhatsApp")}<input value={f.phone} onChange={set("phone")} type="tel" inputMode="tel" placeholder="(87) 9 9999-9999" style={entrada}/></div>
        {recado(avisoDados)}
        <button onClick={salvarDados} disabled={salvando||!mudou}
          style={{background:salvando||!mudou?C.faint:C.green,color:"#fff",border:"none",borderRadius:10,padding:"12px",fontSize:14,fontWeight:600,cursor:salvando||!mudou?"default":"pointer"}}>
          {salvando?"Salvando…":"Salvar dados"}
        </button>
      </div>

      <div style={{background:C.card,border:`1px solid ${C.line}`,borderRadius:14,padding:16,display:"flex",flexDirection:"column",gap:12}}>
        <div style={{color:C.ink,fontSize:13.5,fontWeight:700}}>Trocar senha</div>
        <div>{rotulo("Senha atual")}<input value={senha.atual} onChange={setS("atual")} type="password" autoComplete="current-password" style={entrada}/></div>
        <div>{rotulo("Nova senha")}<input value={senha.nova} onChange={setS("nova")} type="password" autoComplete="new-password" placeholder="Mínimo de 6 caracteres" style={entrada}/></div>
        <div>{rotulo("Repita a nova senha")}<input value={senha.repetir} onChange={setS("repetir")} type="password" autoComplete="new-password" style={entrada}/></div>
        {recado(avisoSenha)}
        <button onClick={trocarSenha} disabled={trocando||!senha.atual||!senha.nova}
          style={{background:trocando||!senha.atual||!senha.nova?C.faint:C.greenDeep,color:"#fff",border:"none",borderRadius:10,padding:"12px",fontSize:14,fontWeight:600,cursor:trocando?"default":"pointer"}}>
          {trocando?"Alterando…":"Alterar senha"}
        </button>
      </div>
      <Notificacoes acoes={acoes} isMobile={isMobile}/>
      {session.role==="adm"&&<PainelAssinatura acoes={acoes} isMobile={isMobile}/>}
      <VersaoDoApp/>
    </div>
  </div>;
}
/* ===== NOTIFICAÇÕES NO CELULAR =====
   Avisa o corretor quando um lead cai na mão dele ou quando o cliente responde,
   mesmo com o CRM fechado.

   A permissão é POR APARELHO: ativar no computador não ativa no celular. Por
   isso a tela fala em "neste aparelho" o tempo todo — sem isso o corretor ativa
   no PC, não recebe nada no celular e acha que está quebrado.

   No iPhone só funciona com o site ADICIONADO À TELA DE INÍCIO. É limitação da
   Apple: aba do Safari não recebe push. Detectamos e explicamos, em vez de
   deixar o botão falhar sem motivo aparente. */
const base64ParaBytes=(b64)=>{
  const p=(b64+"=".repeat((4-b64.length%4)%4)).replace(/-/g,"+").replace(/_/g,"/");
  const cru=atob(p); return Uint8Array.from([...cru].map(c=>c.charCodeAt(0)));
};
const ehIOS=()=>/iPad|iPhone|iPod/.test(navigator.userAgent);
const naTelaDeInicio=()=>window.matchMedia("(display-mode: standalone)").matches||window.navigator.standalone===true;

function Notificacoes({acoes,isMobile}){
  const [estado,setEstado]=useState({carregando:true,configurado:false,aparelhos:0});
  const [ativoAqui,setAtivoAqui]=useState(false);
  const [ocupado,setOcupado]=useState("");
  const [recado,setRecado]=useState(null);
  const suportado=typeof window!=="undefined"&&"serviceWorker" in navigator&&"PushManager" in window;

  useEffect(()=>{
    let vivo=true;
    (async()=>{
      try{
        const s=await acoes.pushSituacao();
        if(suportado){
          const reg=await navigator.serviceWorker.ready;
          const sub=await reg.pushManager.getSubscription();
          if(vivo) setAtivoAqui(!!sub);
        }
        if(vivo) setEstado({carregando:false,...s});
      }catch(e){ if(vivo) setEstado({carregando:false,configurado:false,aparelhos:0}); }
    })();
    return()=>{vivo=false;};
  },[]);

  async function ativar(){
    setRecado(null); setOcupado("ativar");
    try{
      const permissao=await Notification.requestPermission();
      if(permissao!=="granted"){
        setRecado({ok:false,txt:"Você recusou as notificações. Para liberar depois, use o cadeado ao lado do endereço do site."});
        return;
      }
      const {chave}=await acoes.pushChave();
      const reg=await navigator.serviceWorker.ready;
      const sub=await reg.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:base64ParaBytes(chave)});
      const r=await acoes.pushInscrever(sub.toJSON());
      setAtivoAqui(true); setEstado(e=>({...e,aparelhos:r.aparelhos}));
      setRecado({ok:true,txt:"Pronto! Este aparelho vai avisar quando chegar lead ou o cliente responder."});
    }catch(e){ setRecado({ok:false,txt:e.message||"Não consegui ativar neste aparelho."}); }
    finally{ setOcupado(""); }
  }

  async function desativar(){
    setOcupado("desativar");
    try{
      const reg=await navigator.serviceWorker.ready;
      const sub=await reg.pushManager.getSubscription();
      if(sub){ await acoes.pushCancelar(sub.endpoint); await sub.unsubscribe(); }
      setAtivoAqui(false); setRecado({ok:true,txt:"Notificações desligadas neste aparelho."});
    }catch(e){ setRecado({ok:false,txt:e.message}); }
    finally{ setOcupado(""); }
  }

  async function testar(){
    setOcupado("teste"); setRecado(null);
    try{
      const r=await acoes.pushTeste();
      setRecado(r.enviados
        ? {ok:true,txt:"Enviei uma notificação de teste. Deve aparecer em instantes."}
        : {ok:false,txt:"Nenhum aparelho ativo para receber. Ative aqui primeiro."});
    }catch(e){ setRecado({ok:false,txt:e.message}); }
    finally{ setOcupado(""); }
  }

  const caixa={background:C.card,border:`1px solid ${C.line}`,borderRadius:14,padding:16,display:"flex",flexDirection:"column",gap:12};
  const titulo=<div style={{color:C.ink,fontSize:13.5,fontWeight:700,display:"flex",alignItems:"center",gap:7}}>
    <Icon n="zap" size={15} color={C.greenMid}/> Notificações no celular</div>;
  const explica=(t)=><div style={{color:C.sub,fontSize:12.5,lineHeight:1.5}}>{t}</div>;

  if(estado.carregando) return <div style={caixa}>{titulo}{explica("Verificando…")}</div>;
  // Servidor sem as chaves configuradas: não adianta oferecer o botão.
  if(!estado.configurado) return <div style={caixa}>{titulo}
    {explica("As notificações ainda não foram ligadas no servidor. Assim que a gestão configurar, o botão de ativar aparece aqui.")}</div>;
  if(!suportado) return <div style={caixa}>{titulo}
    {explica("Este navegador não recebe notificações. Tente pelo Chrome (Android) ou pelo Safari com o site na tela de início (iPhone).")}</div>;
  // O caso que mais confunde: iPhone com o site aberto no Safari.
  if(ehIOS()&&!naTelaDeInicio()) return <div style={caixa}>{titulo}
    {explica("No iPhone, as notificações só funcionam com o ConHub adicionado à tela de início.")}
    <div style={{background:C.greenSoft,borderRadius:10,padding:12,color:C.greenDeep,fontSize:12.5,lineHeight:1.7}}>
      <b>Como fazer:</b><br/>1. Toque no botão de compartilhar (a setinha para cima)<br/>
      2. Escolha <b>Adicionar à Tela de Início</b><br/>3. Abra o ConHub por esse ícone e volte aqui
    </div></div>;

  return <div style={caixa}>
    {titulo}
    {explica("Avisa quando um lead cair na sua mão e quando o cliente responder — mesmo com o ConHub fechado.")}
    {recado&&<div style={{fontSize:12.5,padding:"9px 11px",borderRadius:9,lineHeight:1.45,
      color:recado.ok?C.greenDeep:C.hot,background:recado.ok?C.greenSoft:C.hotSoft}}>{recado.txt}</div>}
    <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
      {ativoAqui
        ?<React.Fragment>
          <span style={{display:"flex",alignItems:"center",gap:6,color:C.greenDeep,background:C.greenSoft,fontSize:12.5,fontWeight:600,padding:"10px 13px",borderRadius:10}}>
            <Icon n="check" size={14}/> Ativado neste aparelho</span>
          <button onClick={testar} disabled={!!ocupado}
            style={{border:`1px solid ${C.line}`,background:C.surface,color:C.sub,borderRadius:10,padding:"10px 13px",fontSize:12.5,fontWeight:600,cursor:"pointer"}}>
            {ocupado==="teste"?"Enviando…":"Enviar teste"}</button>
          <button onClick={desativar} disabled={!!ocupado}
            style={{border:"none",background:"transparent",color:C.faint,fontSize:12,cursor:"pointer",textDecoration:"underline"}}>
            desativar aqui</button>
        </React.Fragment>
        :<button onClick={ativar} disabled={!!ocupado}
          style={{background:ocupado?C.faint:C.green,color:"#fff",border:"none",borderRadius:10,padding:"12px 16px",fontSize:13.5,fontWeight:600,cursor:ocupado?"default":"pointer",display:"flex",alignItems:"center",gap:7}}>
          <Icon n={ocupado==="ativar"?"loader":"zap"} size={15} spin={ocupado==="ativar"}/>
          {ocupado==="ativar"?"Ativando…":"Ativar neste aparelho"}</button>}
    </div>
    {estado.aparelhos>0&&<div style={{color:C.faint,fontSize:11.5}}>
      {estado.aparelhos} aparelho(s) seu(s) recebendo notificações.</div>}
  </div>;
}

/* ===== RECOMENDAÇÃO DE DIRECIONAMENTO =====
   Aparece no lead que ainda não tem corretor. Depois de direcionado some, para
   não virar convite ao troca-troca de lead entre corretores.

   O número vem do histórico da própria equipe, não de palpite: conversão por
   temperatura, com amostra mínima. Quando não há histórico bastante, ele diz
   isso em vez de inventar percentual — gestor decidindo com número inventado é
   pior que gestor decidindo sozinho. */
/* Leitor de planilha (CSV).

   Feito à mão porque o app não usa bibliotecas externas — e porque o caso é
   simples e conhecido: arquivo exportado de outro CRM. Trata aspas, ponto e
   vírgula ou vírgula como separador, e quebra de linha dentro do campo. */
function lerCSV(texto){
  const limpo=texto.replace(/^\uFEFF/,"");           // BOM que o Excel coloca
  // Quem manda é o separador mais frequente na primeira linha.
  const cabecalho=limpo.slice(0,limpo.indexOf("\n")+1||undefined);
  const sep=(cabecalho.split(";").length>cabecalho.split(",").length)?";":",";
  const linhas=[]; let campo="",linha=[],aspas=false;
  for(let i=0;i<limpo.length;i++){
    const c=limpo[i];
    if(aspas){
      if(c==='"'&&limpo[i+1]==='"'){campo+='"';i++;}
      else if(c==='"') aspas=false;
      else campo+=c;
    }else if(c==='"') aspas=true;
    else if(c===sep){linha.push(campo);campo="";}
    else if(c==="\n"){linha.push(campo);linhas.push(linha);linha=[];campo="";}
    else if(c!=="\r") campo+=c;
  }
  if(campo||linha.length){linha.push(campo);linhas.push(linha);}
  return linhas.filter(l=>l.some(c=>String(c).trim()));
}

/* Descobre qual coluna é o quê. Cada CRM chama de um jeito, então casamos por
   pedaço do nome em vez de exigir cabeçalho exato. */
const COLUNAS={
  nome:["nome","cliente","lead","contato"],
  telefone:["telefone","celular","whatsapp","fone","tel"],
  email:["email","e-mail"],
  origem:["origem","fonte","canal"],
  temperatura:["temperatura","prioridade","interesse"],
  etapa:["etapa","status","fase","estagio","estágio"],
  corretor:["corretor","responsavel","responsável","vendedor","consultor"],
  entrou_em:["entrou","data","criado","cadastro"],
};
function mapearColunas(cabecalho){
  const mapa={};
  cabecalho.forEach((titulo,i)=>{
    const t=String(titulo).trim().toLowerCase();
    for(const [campo,apelidos] of Object.entries(COLUNAS))
      if(mapa[campo]===undefined&&apelidos.some(a=>t.includes(a))){mapa[campo]=i;break;}
  });
  return mapa;
}

/* Campo da qualificação, editável no toque.
   Antes eram só leitura: vinham do formulário da Meta e, se o cliente contasse
   a renda na conversa, o corretor não tinha onde anotar. */
function CampoQual({rotulo,valor,icone,onSalvar}){
  const [editando,setEditando]=useState(false);
  const [texto,setTexto]=useState(valor==="—"?"":valor);
  useEffect(()=>{setTexto(valor==="—"?"":valor);},[valor]);
  const confirmar=()=>{ setEditando(false); if((texto||"")!==(valor==="—"?"":valor)) onSalvar(texto); };

  return <div>
    <div style={{color:C.faint,fontSize:10.5,fontWeight:600,display:"flex",alignItems:"center",gap:4,marginBottom:2}}>
      <Icon n={icone} size={11}/>{rotulo}</div>
    {editando
      ?<input autoFocus value={texto} onChange={e=>setTexto(e.target.value)} onBlur={confirmar}
        onKeyDown={e=>{if(e.key==="Enter")confirmar();if(e.key==="Escape")setEditando(false);}}
        style={{width:"100%",boxSizing:"border-box",fontSize:12.5,border:`1px solid ${C.green}66`,background:C.card,
          borderRadius:7,padding:"5px 7px",color:C.ink,outline:"none"}}/>
      :<button onClick={()=>setEditando(true)} title="Toque para editar"
        style={{border:"none",background:"transparent",padding:0,cursor:"text",color:valor==="—"?C.faint:C.ink,
          fontSize:12.5,fontWeight:500,textAlign:"left",width:"100%"}}>{valor}</button>}
  </div>;
}

/* ===== SIMULAÇÃO DE FINANCIAMENTO =====
   O corretor simula no site da Caixa, tira print e registra aqui. A leitura
   automática do print é opcional: quando a IA não está configurada, ele digita.

   O rascunho lido da imagem SEMPRE passa pela conferência antes de ir ao
   cliente. Número de financiamento errado vira promessa que a Conecta não
   cumpre — é o tipo de erro que não se desfaz pedindo desculpa. */
const moedaBR=(v)=>v==null||v===""?"":Number(v).toLocaleString("pt-BR",{style:"currency",currency:"BRL",maximumFractionDigits:0});

function Simulacao({lead,acoes,isMobile,aoFechar}){
  const [d,setD]=useState(null);
  const [form,setForm]=useState({valor_imovel:"",entrada:"",subsidio:"",financiado:"",prazo_meses:"",parcela:"",juros_aa:"",renda:"",modalidade:"",observacoes:""});
  const [print,setPrint]=useState(null);       // {base64,mime,nome}
  const [lendo,setLendo]=useState(false);
  const [salvando,setSalvando]=useState(false);
  const [aviso,setAviso]=useState(null);
  const [confianca,setConfianca]=useState(null);
  const arq=useRef(null);

  const recarregar=()=>acoes.simulacoes(lead.id).then(setD).catch(()=>{});
  useEffect(()=>{recarregar();},[lead.id]);

  const set=(k)=>(e)=>setForm({...form,[k]:e.target.value});
  const preenchido=Object.entries(form).some(([k,v])=>v!==""&&k!=="observacoes");

  async function escolherPrint(e){
    const f=e.target.files[0]; e.target.value=""; if(!f) return;
    setAviso(null); setConfianca(null);
    const base64=await new Promise(ok=>{const r=new FileReader();r.onload=()=>ok(String(r.result).split(",")[1]);r.readAsDataURL(f);});
    setPrint({base64,mime:f.type,nome:f.name});
    if(!d||!d.ia) return;                       // sem IA, o print só fica anexado
    setLendo(true);
    try{
      const {rascunho}=await acoes.lerPrint(lead.id,base64,f.type);
      const num=(v)=>v==null?"":String(v);
      setForm(f0=>({...f0,
        valor_imovel:num(rascunho.valor_imovel)||f0.valor_imovel,
        entrada:num(rascunho.entrada)||f0.entrada,
        subsidio:num(rascunho.subsidio)||f0.subsidio,
        financiado:num(rascunho.financiado)||f0.financiado,
        prazo_meses:num(rascunho.prazo_meses)||f0.prazo_meses,
        parcela:num(rascunho.parcela)||f0.parcela,
        juros_aa:num(rascunho.juros_aa)||f0.juros_aa,
        renda:num(rascunho.renda)||f0.renda,
        modalidade:rascunho.modalidade||f0.modalidade,
      }));
      setConfianca(rascunho.confianca);
    }catch(err){ setAviso({ok:false,txt:err.message}); }
    finally{ setLendo(false); }
  }

  async function salvar(){
    setAviso(null); setSalvando(true);
    try{
      await acoes.salvarSimulacao(lead.id,{...form,
        print_base64:print?print.base64:null, print_mime:print?print.mime:null,
        origem:confianca?"print":"manual"});
      setForm({valor_imovel:"",entrada:"",subsidio:"",financiado:"",prazo_meses:"",parcela:"",juros_aa:"",renda:"",modalidade:"",observacoes:""});
      setPrint(null); setConfianca(null);
      await recarregar();
      setAviso({ok:true,txt:"Simulação registrada. Agora é só enviar para o cliente."});
    }catch(e){ setAviso({ok:false,txt:e.message}); }
    finally{ setSalvando(false); }
  }

  const campo=(rotulo,chave,dica)=><div style={{flex:"1 1 132px",minWidth:0}}>
    <div style={{color:C.faint,fontSize:10.5,fontWeight:600,marginBottom:3}}>{rotulo}</div>
    <input value={form[chave]} onChange={set(chave)} inputMode="decimal" placeholder={dica||""}
      style={{width:"100%",boxSizing:"border-box",fontSize:isMobile?16:13,border:`1px solid ${C.line}`,background:C.surface,
        borderRadius:9,padding:"9px 10px",color:C.ink,outline:"none"}}/>
  </div>;

  /* Painel comum, no fluxo da página — não é janela flutuante.
     A primeira versão usava ReactDOM.createPortal para escapar da barra do
     celular, mas o React embutido no index.html é a versão enxuta e não tem
     essa função: dava "createPortal is not a function" e tela branca.
     Este formato é o mesmo do cadastro de imóveis, que já funciona há semanas —
     ocupa a tela inteira, então não existe barra para ficar por cima. */
  return <div style={{height:"100%",overflowY:"auto",background:C.card,
    padding:16,paddingBottom:"calc(28px + env(safe-area-inset-bottom))"}}>
    <div style={{maxWidth:520,margin:"0 auto"}}>
      <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:14}}>
        <button onClick={aoFechar} aria-label="Voltar"
          style={{width:34,height:34,borderRadius:10,border:"none",background:C.surface,color:C.sub,cursor:"pointer",
            display:"flex",alignItems:"center",justifyContent:"center",transform:"scaleX(-1)",flexShrink:0}}>
          <Icon n="chevron" size={17}/></button>
        <Icon n="chart" size={17} color={C.greenMid}/>
        <span style={{color:C.ink,fontSize:15,fontWeight:700,flex:1}}>Simulação — {first(lead.nome)}</span>
      </div>

      <input ref={arq} type="file" accept="image/*" onChange={escolherPrint} style={{display:"none"}}/>
      <button onClick={()=>arq.current.click()} disabled={lendo}
        style={{width:"100%",border:`1px dashed ${C.green}66`,background:C.greenSoft,color:C.greenDeep,borderRadius:11,
          padding:"13px",fontSize:13.5,fontWeight:600,cursor:lendo?"default":"pointer",display:"flex",alignItems:"center",justifyContent:"center",gap:7}}>
        <Icon n={lendo?"loader":"star"} size={15} spin={lendo}/>
        {lendo?"Lendo o print…":print?`Print anexado: ${print.nome}`:"Anexar print da simulação"}
      </button>
      <div style={{color:C.faint,fontSize:11,margin:"6px 0 12px",lineHeight:1.45}}>
        {d&&d.ia
          ?"O sistema lê os valores do print e preenche abaixo. Confira antes de enviar — a leitura acerta quase sempre, não sempre."
          :"Anexe o print para ficar guardado no histórico e preencha os campos abaixo."}
      </div>

      {confianca&&<div style={{background:confianca==="baixa"?C.hotSoft:C.greenSoft,color:confianca==="baixa"?C.hot:C.greenDeep,
        fontSize:12,borderRadius:9,padding:"9px 11px",marginBottom:11,lineHeight:1.45}}>
        {confianca==="baixa"
          ?"Não consegui ler bem esse print. Confira cada valor com atenção — pode estar errado."
          :"Valores lidos do print. Confira antes de enviar."}
      </div>}

      <div style={{display:"flex",flexWrap:"wrap",gap:9,marginBottom:11}}>
        {campo("Valor do imóvel","valor_imovel","250000")}
        {campo("Entrada","entrada","25000")}
        {campo("Subsídio","subsidio","0")}
        {campo("Financiado","financiado","")}
        {campo("Prazo (meses)","prazo_meses","360")}
        {campo("Parcela inicial","parcela","1180")}
        {campo("Juros ao ano (%)","juros_aa","8,99")}
        {campo("Renda familiar","renda","3200")}
      </div>
      <div style={{marginBottom:11}}>
        <div style={{color:C.faint,fontSize:10.5,fontWeight:600,marginBottom:3}}>Observação para o cliente (opcional)</div>
        <textarea value={form.observacoes} onChange={set("observacoes")} rows={2} placeholder="Ex.: condição válida até o fim do mês"
          style={{width:"100%",boxSizing:"border-box",fontSize:isMobile?16:13,border:`1px solid ${C.line}`,background:C.surface,
            borderRadius:9,padding:"9px 10px",color:C.ink,outline:"none",resize:"vertical",fontFamily:FONT}}/>
      </div>

      {aviso&&<div style={{fontSize:12.5,padding:"9px 11px",borderRadius:9,marginBottom:11,lineHeight:1.45,
        color:aviso.ok?C.greenDeep:C.hot,background:aviso.ok?C.greenSoft:C.hotSoft}}>{aviso.txt}</div>}

      <button onClick={salvar} disabled={salvando||!preenchido}
        style={{width:"100%",background:salvando||!preenchido?C.faint:C.green,color:"#fff",border:"none",borderRadius:11,
          padding:"13px",fontSize:14,fontWeight:600,cursor:salvando||!preenchido?"default":"pointer"}}>
        {salvando?"Registrando…":"Registrar simulação"}
      </button>

      {d&&d.simulacoes.length>0&&<div style={{marginTop:18}}>
        <div style={{color:C.ink,fontSize:12.5,fontWeight:700,marginBottom:8}}>Simulações deste lead</div>
        {d.simulacoes.map(s=><div key={s.id} style={{border:`1px solid ${C.line}`,borderRadius:11,padding:11,marginBottom:8}}>
          <div style={{display:"flex",alignItems:"center",gap:7,marginBottom:5,flexWrap:"wrap"}}>
            <span style={{color:C.ink,fontSize:13.5,fontWeight:700,fontFamily:MONO}}>{moedaBR(s.parcela)||"—"}</span>
            <span style={{color:C.faint,fontSize:11}}>por mês</span>
            {s.enviada_em
              ?<span style={{marginLeft:"auto",color:C.greenMid,fontSize:10.5,fontWeight:600,display:"flex",alignItems:"center",gap:4}}><Icon n="check" size={11}/> enviada</span>
              :<span style={{marginLeft:"auto",color:C.faint,fontSize:10.5}}>não enviada</span>}
          </div>
          <div style={{color:C.sub,fontSize:11.5,lineHeight:1.5}}>
            {[s.valor_imovel&&`Imóvel ${moedaBR(s.valor_imovel)}`,s.entrada&&`entrada ${moedaBR(s.entrada)}`,
              s.subsidio&&`subsídio ${moedaBR(s.subsidio)}`,s.prazo_meses&&`${s.prazo_meses} meses`].filter(Boolean).join(" · ")}
          </div>
          <div style={{color:C.faint,fontSize:10.5,marginTop:4}}>
            {new Date(s.created_at).toLocaleString("pt-BR")}{s.origem==="print"?" · lida do print":""}
          </div>
          <div style={{display:"flex",gap:8,marginTop:9,flexWrap:"wrap"}}>
            <button onClick={()=>acoes.enviarSimulacao(lead.id,s.id).then(recarregar)}
              style={{background:s.enviada_em?C.surface:C.green,color:s.enviada_em?C.sub:"#fff",border:s.enviada_em?`1px solid ${C.line}`:"none",
                borderRadius:9,padding:"8px 13px",fontSize:12.5,fontWeight:600,cursor:"pointer",display:"flex",alignItems:"center",gap:5}}>
              <Icon n="send" size={12}/>{s.enviada_em?"Enviar de novo":"Enviar resumo ao cliente"}</button>
            {s.print_url&&<a href={s.print_url} target="_blank" rel="noreferrer"
              style={{textDecoration:"none",border:`1px solid ${C.line}`,color:C.sub,borderRadius:9,padding:"8px 13px",fontSize:12.5,fontWeight:600}}>ver print</a>}
            <button onClick={()=>{if(window.confirm("Apagar esta simulação?")) acoes.apagarSimulacao(lead.id,s.id).then(recarregar);}}
              style={{border:"none",background:"transparent",color:C.faint,fontSize:11.5,cursor:"pointer"}}>apagar</button>
          </div>
        </div>)}
      </div>}
    </div>
  </div>;
}

/* ===== BASE DE LEADS (gestor) =====
   Todos os leads da imobiliária num lugar só, com quem está com cada um, e o
   botão para baixar a planilha. É a visão de dono: nem a caixa de atendimento
   nem o funil mostram a base inteira de uma vez. */
/* Passa a régua nova nos leads que já existem.

   A regra de etapa mudou, mas os leads antigos ficaram onde a regra velha os
   deixou — e ela era frouxa. Sem isto, metade do funil segue uma regra e
   metade segue outra, e nenhum relatório de etapa vale.

   Dois passos de propósito: conferir e só então aplicar. É a base inteira
   mudando de etapa de uma vez; a tela mostra "de → para, quantos" antes,
   porque descer lead de etapa é certo aqui, mas assusta se aparecer sem
   aviso. */
/* ===== ARRUMAR A BASE: TEMPERATURA E ETAPA =====

   Duas operações que mexem em centenas de leads. As duas mostram a PRÉVIA
   antes — quantos leads, de quem, e (na da IA) quanto vai custar. Botão que
   mexe na base inteira sem dizer o tamanho do estrago é botão que ninguém
   aperta, ou que se aperta uma vez só e por engano. */
function ArrumarBase({acoes,isMobile,aoAplicar}){
  const [t,setT]=useState(null);          // prévia da temperatura
  const [ia,setIa]=useState(null);        // prévia da IA
  const [rodando,setRodando]=useState("");
  const [andamento,setAndamento]=useState(null);  // {feitos, restam, mudaram}
  const [erro,setErro]=useState("");
  const [feito,setFeito]=useState("");
  const parar=useRef(false);

  useEffect(()=>{ acoes.previaTemperatura("MORNO").then(setT).catch(()=>{});
    acoes.previaEtapaIA().then(setIa).catch(()=>{}); },[]);

  async function limparMornos(){
    setErro(""); setRodando("temp");
    try{
      const r=await acoes.limparTemperatura("MORNO");
      setFeito(`Temperatura removida de ${r.limpos} lead(s). Eles agora aparecem sem temperatura.`);
      setT(await acoes.previaTemperatura("MORNO"));
      aoAplicar&&aoAplicar();
    }catch(e){ setErro(e.message); } finally{ setRodando(""); }
  }

  /* Roda em pedaços e volta a chamar enquanto sobrar fila. É o que permite
     mostrar o avanço e parar no meio sem perder o que já foi feito. */
  async function rodarIA(){
    setErro(""); setRodando("ia"); parar.current=false;
    let feitos=0, mudaram=0;
    try{
      for(;;){
        const r=await acoes.rodarEtapaIA(20);
        feitos+=r.analisados; mudaram+=r.mudaram;
        setAndamento({feitos,mudaram,restam:r.restam,exemplos:r.mudancas||[]});
        if(parar.current||r.restam<=0||r.analisados===0) break;
      }
      setFeito(`A IA leu ${feitos} conversa(s) e reposicionou ${mudaram} lead(s) no funil.`);
      setIa(await acoes.previaEtapaIA());
      aoAplicar&&aoAplicar();
    }catch(e){ setErro(e.message); } finally{ setRodando(""); }
  }

  const cartao=(filhos)=><div style={{background:C.surface,borderRadius:12,padding:isMobile?12:14,marginTop:10}}>{filhos}</div>;

  return <div style={{background:C.card,border:`1px solid ${C.line}`,borderRadius:14,padding:isMobile?13:16,marginBottom:14}}>
    <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:3}}>
      <Icon n="target" size={15} color={C.greenMid}/>
      <span style={{color:C.ink,fontSize:13.5,fontWeight:700,flex:1}}>Arrumar a base</span>
    </div>
    <div style={{color:C.faint,fontSize:11.5,lineHeight:1.5}}>
      Duas correções que valem para a base inteira. As duas mostram o tamanho antes de aplicar.
    </div>

    {erro&&<div style={{background:C.hotSoft,color:C.hot,fontSize:12,borderRadius:10,padding:"9px 11px",marginTop:10}}>{erro}</div>}
    {feito&&<div style={{background:C.greenSoft,color:C.greenDeep,fontSize:12.5,fontWeight:600,borderRadius:10,padding:"10px 12px",marginTop:10}}>{feito}</div>}

    {/* ===== 1. TEMPERATURA ===== */}
    {cartao(<React.Fragment>
      <div style={{color:C.ink,fontSize:12.5,fontWeight:700,marginBottom:4}}>Tirar a marcação "Morno"</div>
      <div style={{color:C.sub,fontSize:11.5,lineHeight:1.5,marginBottom:9}}>
        Todo lead que entra pelo WhatsApp nascia marcado como <b>Morno</b> — não era leitura de ninguém,
        era o padrão do sistema. Tirando, eles passam a aparecer <b>sem temperatura</b>, que é a verdade
        até alguém avaliar o cliente. Leads marcados como Quente ou Frio não são tocados.
      </div>
      {t&&<div style={{display:"flex",gap:8,flexWrap:"wrap",marginBottom:10}}>
        {[["marcados como Morno",t.leads],["na base",t.total],
          ...t.restam.map(x=>[`ficam como ${PRIO[x.p]?PRIO[x.p].label:x.p}`,x.n])].map(([r,v])=>
          <div key={r} style={{background:C.card,borderRadius:10,padding:"7px 11px",minWidth:92}}>
            <div style={{fontFamily:MONO,color:C.ink,fontSize:16,fontWeight:700,lineHeight:1}}>{v}</div>
            <div style={{color:C.faint,fontSize:10.5,marginTop:3}}>{r}</div>
          </div>)}
      </div>}
      <button onClick={limparMornos} disabled={!!rodando||!t||!t.leads}
        style={{background:t&&t.leads?C.greenDeep:C.faint,color:"#fff",border:"none",borderRadius:10,
          padding:isMobile?"12px 16px":"9px 16px",fontSize:12.5,fontWeight:700,cursor:t&&t.leads?"pointer":"default"}}>
        {rodando==="temp"?"Tirando…":t&&t.leads?`Tirar o "Morno" de ${t.leads} lead(s)`:"Nenhum lead marcado como Morno"}</button>
    </React.Fragment>)}

    {/* ===== 2. ETAPA PELA IA ===== */}
    {cartao(<React.Fragment>
      <div style={{color:C.ink,fontSize:12.5,fontWeight:700,marginBottom:4}}>Reposicionar o funil com a IA</div>
      <div style={{color:C.sub,fontSize:11.5,lineHeight:1.5,marginBottom:9}}>
        A IA lê a conversa de cada lead e coloca na etapa que o atendimento mostra.
        Ficam <b>de fora</b>: quem está com a atendente ou sem dono (não é atendimento de corretor),
        quem não tem conversa, quem tem venda registrada e quem está em etapa marcada na mão.
      </div>
      {ia&&!ia.configurada&&<div style={{background:C.amberSoft,color:"#8a6d1f",fontSize:11.5,borderRadius:9,padding:"8px 10px"}}>
        A IA não está ligada nesta instalação.</div>}
      {ia&&ia.configurada&&<React.Fragment>
        <div style={{display:"flex",gap:8,flexWrap:"wrap",marginBottom:9}}>
          {[["conversas a ler",ia.leads],["com a atendente / sem dono",ia.fora.com_atendente_ou_sem_dono],
            ["sem conversa",ia.fora.sem_conversa],["venda registrada",ia.fora.venda_registrada],
            ["etapa manual",ia.fora.etapa_manual]].map(([r,v])=>
            <div key={r} style={{background:C.card,borderRadius:10,padding:"7px 11px",minWidth:92}}>
              <div style={{fontFamily:MONO,color:C.ink,fontSize:16,fontWeight:700,lineHeight:1}}>{v}</div>
              <div style={{color:C.faint,fontSize:10.5,marginTop:3}}>{r}</div>
            </div>)}
        </div>
        {/* O preço vem ANTES do botão. Gastar dinheiro da conta de alguém sem
            dizer quanto é o tipo de coisa que quebra a confiança de uma vez. */}
        {ia.leads>0&&<div style={{background:C.card,borderRadius:10,padding:"9px 11px",marginBottom:9,
          color:C.sub,fontSize:11.5,lineHeight:1.5}}>
          Custo estimado: <b style={{fontFamily:MONO,color:C.ink}}>US$ {ia.custo.total_usd.toFixed(2)}</b>
          {" "}(≈ R$ {(ia.custo.total_usd*5.4).toFixed(2)}) para as {ia.leads} conversas — {ia.custo.base}.
        </div>}
        {ia.por_corretor.length>0&&<div style={{display:"flex",flexWrap:"wrap",gap:5,marginBottom:10}}>
          {ia.por_corretor.map(x=><span key={x.nome} style={{background:C.card,borderRadius:999,padding:"4px 10px",color:C.sub,fontSize:11}}>
            {first(x.nome)}: <b style={{fontFamily:MONO,color:C.ink}}>{x.leads}</b></span>)}
        </div>}

        {andamento&&<div style={{background:C.card,borderRadius:10,padding:"10px 12px",marginBottom:10}}>
          <div style={{color:C.ink,fontSize:12,fontWeight:700}}>
            {andamento.feitos} lida(s) · {andamento.mudaram} reposicionado(s) · {andamento.restam} na fila</div>
          <div style={{height:7,borderRadius:999,background:C.surface,overflow:"hidden",margin:"7px 0"}}>
            <div style={{width:Math.round(andamento.feitos*100/Math.max(1,andamento.feitos+andamento.restam))+"%",
              height:"100%",background:C.green,transition:"width .3s"}}/>
          </div>
          {andamento.exemplos.slice(0,6).map((x,i)=><div key={i} style={{color:C.sub,fontSize:11,lineHeight:1.5}}>
            {first(x.nome)}: <span style={{color:STAGE_C[x.de]}}>{x.de}</span> → <b style={{color:STAGE_C[x.para]}}>{x.para}</b>
            <span style={{color:C.faint}}> ({x.confianca})</span></div>)}
        </div>}

        <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
          <button onClick={rodarIA} disabled={!!rodando||!ia.leads}
            style={{background:ia.leads?C.greenDeep:C.faint,color:"#fff",border:"none",borderRadius:10,
              padding:isMobile?"12px 16px":"9px 16px",fontSize:12.5,fontWeight:700,cursor:ia.leads?"pointer":"default",
              display:"flex",alignItems:"center",gap:7}}>
            {rodando==="ia"?<React.Fragment><Icon n="loader" size={13} spin/> Lendo as conversas…</React.Fragment>
              :ia.leads?<React.Fragment><Icon n="sparkles" size={13}/> Ler e reposicionar {ia.leads} lead(s)</React.Fragment>
              :"Nada para reanalisar"}</button>
          {rodando==="ia"&&<button onClick={()=>{parar.current=true;}}
            style={{border:`1px solid ${C.line}`,background:C.card,color:C.sub,borderRadius:10,
              padding:"9px 16px",fontSize:12.5,fontWeight:600,cursor:"pointer"}}>Parar</button>}
        </div>
        <div style={{color:C.faint,fontSize:10.5,lineHeight:1.5,marginTop:8}}>
          Roda em blocos e mostra o avanço. Dá para parar no meio — o que já foi lido fica gravado,
          e continuar depois não paga de novo pelas mesmas conversas.
        </div>
      </React.Fragment>}
    </React.Fragment>)}
  </div>;
}

/* ===== POR QUE O FUNIL NÃO ANDA =====

   "O avanço por palavra-chave não está funcionando" é um sintoma com três
   doenças possíveis, e cada uma tem outro remédio: a palavra que ninguém diz
   (treino), a conversa que acontece por áudio (nenhuma regra de palavra
   alcança) e o gatilho que não casa com o jeito da equipe escrever (código).

   Esta tela não conserta nada — ela diz qual das três é, para a gente parar de
   chutar regex. O veredito sai escrito, porque número solto quem lê é dev. */
function DiagnosticoFunil({g,comConversa,isMobile}){
  const pct=(n)=>comConversa?Math.round(n*100/comConversa):0;
  const semGatilho=pct(g.sem_gatilho), soMidia=pct(g.so_midia);
  const semTexto=g.mensagens?Math.round(g.mensagens_sem_texto*100/g.mensagens):0;

  /* O veredito é uma frase só, e a ordem importa: áudio primeiro, porque se a
     conversa não tem texto nenhuma palavra-chave resolve — e mexer no regex
     seria trabalho jogado fora. */
  const veredito=
    soMidia>=25?{cor:C.hot,fundo:C.hotSoft,t:`${soMidia}% das conversas são só áudio, foto ou documento — sem uma linha de texto. Em conversa por áudio nenhuma palavra-chave funciona, hoje ou depois de qualquer ajuste. É o caso de a IA ouvir/ler a conversa, ou de combinar com a equipe de escrever a palavra.`}
    :semGatilho>=50?{cor:C.hot,fundo:C.hotSoft,t:`${semGatilho}% das conversas não têm NENHUMA das palavras. Ou a equipe não usa esses termos, ou os gatilhos não casam com o jeito que ela escreve — o quadro abaixo mostra quais palavras aparecem e quais nunca aparecem.`}
    :semGatilho>=20?{cor:"#8a6d1f",fundo:C.amberSoft,t:`${semGatilho}% das conversas não batem em palavra nenhuma. A regra está pegando na maioria, mas esse pedaço fica parado no começo do funil.`}
    :{cor:C.greenDeep,fundo:C.greenSoft,t:`A regra está pegando: ${100-semGatilho}% das conversas batem em pelo menos uma palavra. Se o funil ainda parece errado, o problema está em QUAL palavra dispara, não em disparar.`};

  return <div style={{background:C.surface,borderRadius:12,padding:isMobile?11:13,marginBottom:12}}>
    <div style={{color:C.ink,fontSize:12.5,fontWeight:700,marginBottom:8,display:"flex",alignItems:"center",gap:6}}>
      <Icon n="search" size={13} color={C.faint}/>Por que o funil não anda</div>

    <div style={{background:veredito.fundo,color:veredito.cor,fontSize:12,lineHeight:1.5,borderRadius:10,padding:"9px 11px",marginBottom:10}}>
      {veredito.t}</div>

    <div style={{display:"flex",gap:7,flexWrap:"wrap",marginBottom:10}}>
      {[["sem palavra nenhuma",`${g.sem_gatilho}`,`${semGatilho}% das conversas`],
        ["só áudio/foto",`${g.so_midia}`,`${soMidia}% das conversas`],
        ["mensagens sem texto",`${semTexto}%`,`${g.mensagens_sem_texto} de ${g.mensagens}`]].map(([t,v,sub])=>
        <div key={t} style={{background:C.card,borderRadius:10,padding:"7px 11px",minWidth:112,flex:"1 1 112px"}}>
          <div style={{fontFamily:MONO,color:C.ink,fontSize:16,fontWeight:700,lineHeight:1}}>{v}</div>
          <div style={{color:C.sub,fontSize:10.5,marginTop:3,fontWeight:600}}>{t}</div>
          <div style={{color:C.faint,fontSize:10,marginTop:1}}>{sub}</div>
        </div>)}
    </div>

    {/* Palavra que nunca aparece é gatilho morto: ou ninguém escreve aquilo, ou
        o padrão está errado. Nos dois casos, o funil trava naquela etapa. */}
    <div style={{color:C.faint,fontSize:11,fontWeight:600,marginBottom:5}}>Em quantas conversas cada palavra aparece</div>
    <div style={{display:"flex",flexDirection:"column",gap:3}}>
      {g.gatilhos.map(x=><div key={x.etapa} style={{display:"flex",alignItems:"center",gap:8,background:C.card,borderRadius:8,padding:"6px 10px",flexWrap:"wrap"}}>
        <span style={{color:x.leads?C.ink:C.faint,fontSize:11.5,fontWeight:600,minWidth:0,flex:"1 1 120px"}}>
          “{x.palavra}”<span style={{color:C.faint,fontWeight:400}}> → {x.etapa}</span></span>
        {!x.leads&&<span style={{color:C.hot,background:C.hotSoft,fontSize:10,fontWeight:700,borderRadius:999,padding:"2px 8px"}}>nunca aparece</span>}
        <span style={{fontFamily:MONO,color:x.leads?C.ink:C.faint,fontSize:12.5,fontWeight:700,minWidth:34,textAlign:"right"}}>{x.leads}</span>
      </div>)}
    </div>
  </div>;
}

function ReanalisarFunil({acoes,isMobile,aoAplicar}){
  const [d,setD]=useState(null);
  const [carregando,setCarregando]=useState(false);
  const [aplicando,setAplicando]=useState(false);
  const [erro,setErro]=useState("");
  const [feito,setFeito]=useState(null);

  const conferir=async()=>{ setErro(""); setFeito(null); setCarregando(true);
    try{ setD(await acoes.reanalise()); }catch(e){ setErro(e.message); } finally{ setCarregando(false); } };
  const aplicar=async()=>{ setErro(""); setAplicando(true);
    try{ const r=await acoes.aplicarReanalise(); setFeito(r); setD(null); aoAplicar&&aoAplicar(); }
    catch(e){ setErro(e.message); } finally{ setAplicando(false); } };

  return <div style={{background:C.card,border:`1px solid ${C.line}`,borderRadius:14,padding:isMobile?13:15,marginBottom:14}}>
    <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:3,flexWrap:"wrap"}}>
      <Icon n="target" size={15} color={C.greenMid}/>
      <span style={{color:C.ink,fontSize:13.5,fontWeight:700,flex:1}}>Reorganizar o funil pela regra nova</span>
      <button onClick={conferir} disabled={carregando||aplicando}
        style={{background:C.surface,color:C.greenDeep,border:`1px solid ${C.green}55`,borderRadius:10,
          padding:"8px 14px",fontSize:12.5,fontWeight:600,cursor:"pointer",display:"flex",alignItems:"center",gap:6}}>
        <Icon n={carregando?"loader":"search"} size={14} spin={carregando}/>{carregando?"Analisando…":"Analisar a base"}</button>
    </div>
    <div style={{color:C.faint,fontSize:11.5,lineHeight:1.5}}>
      Relê a conversa de cada lead e recalcula a etapa pelas palavras-chave. Lead pode <b>descer</b> de etapa — é o objetivo:
      tirar da frente do funil quem a regra antiga empurrou sozinha. Fica de fora quem não tem conversa, quem tem venda
      registrada e quem está em etapa marcada na mão.
    </div>

    {erro&&<div style={{background:C.hotSoft,color:C.hot,fontSize:12,borderRadius:10,padding:"9px 11px",marginTop:10}}>{erro}</div>}

    {feito&&<div style={{background:C.greenSoft,border:`1px solid ${C.green}44`,borderRadius:11,padding:"10px 12px",marginTop:10,
      color:C.greenDeep,fontSize:12.5,fontWeight:600}}>
      Funil reorganizado: {feito.mudam} lead(s) mudaram de etapa.
    </div>}

    {d&&<div style={{marginTop:12}}>
      <div style={{display:"flex",gap:8,flexWrap:"wrap",marginBottom:10}}>
        {[["conversas lidas",d.com_conversa],["mudam de etapa",d.mudam],["sem conversa",d.fora.sem_conversa],
          ["venda registrada",d.fora.venda_registrada],["etapa manual",d.fora.etapa_manual],
          // Etapa que alguém confirmou depois da leitura da IA fica de fora: a
          // reanálise por palavra desfaria a decisão da pessoa em silêncio.
          ["confirmada na mão",d.fora.confirmado_na_mao||0]].map(([t,v])=>
          <div key={t} style={{background:C.surface,borderRadius:10,padding:"7px 11px",minWidth:96}}>
            <div style={{fontFamily:MONO,color:t==="mudam de etapa"&&v?C.greenDeep:C.ink,fontSize:16,fontWeight:700,lineHeight:1}}>{v}</div>
            <div style={{color:C.faint,fontSize:10.5,marginTop:3}}>{t}</div>
          </div>)}
      </div>

      {d.diagnostico&&<DiagnosticoFunil g={d.diagnostico} comConversa={d.com_conversa} isMobile={isMobile}/>}

      {d.mudam===0
        ?<div style={{color:C.faint,fontSize:12.5}}>Nenhum lead precisa mudar — o funil já está de acordo com a regra nova.</div>
        :<React.Fragment>
          <div style={{display:"flex",flexDirection:"column",gap:4,marginBottom:10}}>
            {d.resumo.map(x=><div key={x.de+x.para} style={{display:"flex",alignItems:"center",gap:8,background:C.surface,borderRadius:9,padding:"7px 10px",flexWrap:"wrap"}}>
              <span style={{color:STAGE_C[x.de],fontSize:12,fontWeight:600}}>{x.de}</span>
              <Icon n="chevron" size={12} color={C.faint}/>
              <span style={{color:STAGE_C[x.para],fontSize:12,fontWeight:700}}>{x.para}</span>
              <span style={{flex:1}}/>
              <span style={{fontFamily:MONO,color:C.ink,fontSize:13,fontWeight:700}}>{x.quantos}</span>
            </div>)}
          </div>
          <div style={{color:C.faint,fontSize:11,marginBottom:6}}>Alguns exemplos:</div>
          <div style={{display:"flex",flexWrap:"wrap",gap:5,marginBottom:12}}>
            {d.exemplos.map(x=><span key={x.id} style={{background:C.surface,borderRadius:999,padding:"4px 10px",color:C.sub,fontSize:11}}>
              {first(x.nome||"—")}: {x.de} → <b style={{color:STAGE_C[x.para]}}>{x.para}</b>
            </span>)}
          </div>
          <div style={{display:"flex",gap:7,flexWrap:"wrap"}}>
            <button onClick={aplicar} disabled={aplicando}
              style={{background:C.greenDeep,color:"#fff",border:"none",borderRadius:10,padding:"9px 16px",fontSize:12.5,fontWeight:700,cursor:"pointer"}}>
              {aplicando?"Aplicando…":`Aplicar nos ${d.mudam} leads`}</button>
            <button onClick={()=>setD(null)} disabled={aplicando}
              style={{background:C.card,color:C.sub,border:`1px solid ${C.line}`,borderRadius:10,padding:"9px 16px",fontSize:12.5,fontWeight:600,cursor:"pointer"}}>
              Agora não</button>
          </div>
        </React.Fragment>}
    </div>}
  </div>;
}

function BaseLeads({acoes,isMobile,pessoas,abrirConversa}){
  const [lista,setLista]=useState(null);
  const [busca,setBusca]=useState("");
  const [baixando,setBaixando]=useState(false);
  const [erro,setErro]=useState("");
  const [lotes,setLotes]=useState(null);
  const [antigos,setAntigos]=useState(null);
  const [limpeza,setLimpeza]=useState(false);   // seção dos leads sem lote aberta

  const recarregar=()=>acoes.buscar({finalizados:"1"}).then(setLista).catch(e=>setErro(e.message));
  const releituraLotes=()=>{
    acoes.importacoes().then(setLotes).catch(()=>setLotes([]));
    acoes.gruposAntigos().then(setAntigos).catch(()=>setAntigos([]));
  };
  useEffect(()=>{let vivo=true;
    acoes.buscar({finalizados:"1"}).then(r=>vivo&&setLista(r)).catch(e=>vivo&&setErro(e.message));
    acoes.importacoes().then(r=>vivo&&setLotes(r)).catch(()=>vivo&&setLotes([]));
    acoes.gruposAntigos().then(r=>vivo&&setAntigos(r)).catch(()=>vivo&&setAntigos([]));
    return()=>{vivo=false;};},[]);

  const baixar=async()=>{ setErro(""); setBaixando(true);
    try{ await acoes.baixarLeads(); }catch(e){ setErro(e.message); } finally{ setBaixando(false); } };

  const arquivo=useRef(null);
  const [subindo,setSubindo]=useState(false);
  const [resultado,setResultado]=useState(null);
  const [apagando,setApagando]=useState(null);        // lista importada em confirmação
  const [apagandoGrupo,setApagandoGrupo]=useState(null); // grupo antigo em confirmação
  /* Etapa de conferência antes de gravar. A importação anterior era um caminho
     só: escolher o arquivo já criava os leads. Com 3 mil linhas, um engano na
     coluna do corretor ou na origem virava trabalho manual de horas. */
  const [pronto,setPronto]=useState(null);

  async function escolherArquivo(e){
    const f=e.target.files[0]; e.target.value=""; if(!f) return;
    setErro(""); setResultado(null);
    try{
      const texto=await f.text();
      const linhas=lerCSV(texto);
      if(linhas.length<2) throw new Error("A planilha parece vazia — precisa ter o cabeçalho e ao menos uma linha.");
      const mapa=mapearColunas(linhas[0]);
      if(mapa.telefone===undefined)
        throw new Error("Não encontrei a coluna de telefone. Renomeie o cabeçalho para 'Telefone' e tente de novo.");
      const pegar=(l,c)=>mapa[c]===undefined?"":l[mapa[c]];
      const dados=linhas.slice(1).map(l=>({
        nome:pegar(l,"nome"), telefone:pegar(l,"telefone"), email:pegar(l,"email"),
        origem:pegar(l,"origem"),
        temperatura:pegar(l,"temperatura"), etapa:pegar(l,"etapa"),
        corretor:pegar(l,"corretor"), entrou_em:pegar(l,"entrou_em"),
      }));
      // Nomes de corretor que aparecem na planilha, cada um uma vez. É esta
      // lista que o gestor liga à equipe — "Ana C." e "ana costa" não se
      // resolvem sozinhos, e errar aqui é lead na mão errada.
      const nomes=[...new Set(dados.map(d=>String(d.corretor||"").trim()).filter(Boolean))].sort();
      const casar={};
      for(const n of nomes){
        const igual=pessoas.find(p=>p.name.trim().toLowerCase()===n.toLowerCase());
        casar[n]=igual?igual.id:"";
      }
      const semArquivo=f.name.replace(/\.[^.]+$/,"");
      setPronto({dados,nomes,mapaCorretores:casar,arquivo:f.name,
        rotulo:semArquivo, origem:"", padrao:"Importado de "+semArquivo});
    }catch(err){ setErro(err.message); }
  }

  async function confirmarImportacao(){
    if(!pronto) return;
    setErro(""); setSubindo(true);
    try{
      const r=await acoes.importarLeads({
        linhas:pronto.dados,
        origem_fixa:pronto.origem.trim()||pronto.padrao,
        corretores:pronto.mapaCorretores,
        rotulo:pronto.rotulo, arquivo:pronto.arquivo,
      });
      setResultado(r); setPronto(null);
      await recarregar(); releituraLotes();
    }catch(err){ setErro(err.message); }
    finally{ setSubindo(false); }
  }

  async function apagarLote(lote,tudo){
    setErro(""); setSubindo(true);
    try{
      const r=await acoes.apagarImportacao(lote.id,tudo);
      setApagando(null); setResultado(null);
      await recarregar(); releituraLotes();
      setErro(r.aviso||"");
    }catch(err){ setErro(err.message); }
    finally{ setSubindo(false); }
  }

  async function apagarAntigo(g,tudo){
    setErro(""); setSubindo(true);
    try{
      const r=await acoes.apagarGrupoAntigo(g.origem,tudo);
      setApagandoGrupo(null); setResultado(null);
      await recarregar(); releituraLotes();
      setErro(r.aviso||"");
    }catch(err){ setErro(err.message); }
    finally{ setSubindo(false); }
  }

  const filtrados=(lista||[]).filter(l=>{
    const t=busca.trim().toLowerCase();
    return !t||[l.nome,l.tel,l.assignedName,l.status].some(v=>String(v||"").toLowerCase().includes(t));
  });
  const cel={padding:"9px 8px",fontSize:12,color:C.sub,whiteSpace:"nowrap"};

  return <div style={{height:"100%",overflowY:"auto",padding:isMobile?14:20}}>
    <div style={{maxWidth:1100,margin:"0 auto"}}>
      {erro&&<div style={{background:C.hotSoft,color:C.hot,fontSize:12.5,borderRadius:10,padding:"10px 12px",marginBottom:12}}>{erro}</div>}
      <div style={{background:C.card,border:`1px solid ${C.line}`,borderRadius:14,padding:13,marginBottom:14,
        display:"flex",gap:8,flexDirection:isMobile?"column":"row",alignItems:isMobile?"stretch":"center"}}>
        <div style={{flex:1,display:"flex",alignItems:"center",gap:8,border:`1px solid ${C.line}`,background:C.surface,borderRadius:10,padding:"0 11px",minWidth:0}}>
          <Icon n="search" size={15} color={C.faint}/>
          <input value={busca} onChange={e=>setBusca(e.target.value)} placeholder="Buscar por nome, telefone, corretor ou etapa"
            style={{flex:1,border:"none",outline:"none",background:"transparent",fontSize:isMobile?16:13,padding:"10px 0",color:C.ink,minWidth:0}}/>
        </div>
        <div style={{display:"flex",gap:8,flexShrink:0}}>
          <input ref={arquivo} type="file" accept=".csv,text/csv" onChange={escolherArquivo} style={{display:"none"}}/>
          <button onClick={()=>arquivo.current.click()} disabled={subindo}
            style={{flex:isMobile?1:"none",background:C.surface,color:C.greenDeep,border:`1px solid ${C.green}55`,borderRadius:10,padding:"11px 16px",
              fontSize:13.5,fontWeight:600,cursor:subindo?"default":"pointer",display:"flex",alignItems:"center",justifyContent:"center",gap:6}}>
            <Icon n={subindo?"loader":"userplus"} size={15} spin={subindo}/>{subindo?"Importando…":"Importar leads"}
          </button>
          <button onClick={baixar} disabled={baixando}
            style={{flex:isMobile?1:"none",background:baixando?C.faint:C.greenDeep,color:"#fff",border:"none",borderRadius:10,padding:"11px 16px",
              fontSize:13.5,fontWeight:600,cursor:baixando?"default":"pointer",display:"flex",alignItems:"center",justifyContent:"center",gap:6}}>
            <Icon n={baixando?"loader":"chart"} size={15} spin={baixando}/>{baixando?"Gerando…":"Baixar planilha"}
          </button>
        </div>
      </div>
      <ArrumarBase acoes={acoes} isMobile={isMobile} aoAplicar={recarregar}/>
      <ReanalisarFunil acoes={acoes} isMobile={isMobile} aoAplicar={recarregar}/>

      {/* ===== conferência antes de gravar ===== */}
      {pronto&&<div style={{background:C.card,border:`1px solid ${C.green}55`,borderRadius:14,padding:14,marginBottom:14}}>
        <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:4}}>
          <Icon n="userplus" size={16} color={C.greenMid}/>
          <span style={{color:C.ink,fontSize:14,fontWeight:700,flex:1}}>Conferir antes de importar</span>
          <span style={{color:C.faint,fontSize:11.5}}>{pronto.arquivo}</span>
        </div>
        <div style={{color:C.sub,fontSize:12.5,marginBottom:12}}>
          <b style={{color:C.ink}}>{pronto.dados.length}</b> linha(s) lidas. Nada foi gravado ainda.
        </div>

        <div style={{display:"flex",gap:8,flexWrap:"wrap",marginBottom:12}}>
          <div style={{flex:"1 1 200px"}}>
            <div style={{color:C.faint,fontSize:11,fontWeight:600,marginBottom:4}}>Nome desta lista</div>
            <input value={pronto.rotulo} onChange={e=>setPronto({...pronto,rotulo:e.target.value})}
              placeholder="Base antiga do RD"
              style={{width:"100%",boxSizing:"border-box",fontSize:isMobile?16:13.5,border:`1px solid ${C.line}`,background:C.surface,borderRadius:10,padding:"11px 12px",color:C.ink,outline:"none"}}/>
            <div style={{color:C.faint,fontSize:10.5,marginTop:3}}>Só para você achar a lista depois, se precisar apagar.</div>
          </div>
          <div style={{flex:"1 1 200px"}}>
            <div style={{color:C.faint,fontSize:11,fontWeight:600,marginBottom:4}}>Origem dos leads</div>
            <input value={pronto.origem} onChange={e=>setPronto({...pronto,origem:e.target.value})}
              placeholder={pronto.padrao}
              style={{width:"100%",boxSizing:"border-box",fontSize:isMobile?16:13.5,border:`1px solid ${C.line}`,background:C.surface,borderRadius:10,padding:"11px 12px",color:C.ink,outline:"none"}}/>
            <div style={{color:C.faint,fontSize:10.5,marginTop:3}}>Vale para a lista inteira e aparece no relatório. Em branco, usa "{pronto.padrao}".</div>
          </div>
        </div>

        {/* Mapa dos corretores. O que a planilha chama de "Ana C." pode ser a
            Ana Costa da equipe — só quem conhece a operação sabe. */}
        {pronto.nomes.length>0
          ?<div style={{marginBottom:12}}>
            <div style={{color:C.ink,fontSize:12.5,fontWeight:700,marginBottom:2}}>Corretores da planilha</div>
            <div style={{color:C.faint,fontSize:11,marginBottom:8,lineHeight:1.5}}>
              Ligue cada nome ao corretor da equipe. Quem ficar em "deixar na fila" entra sem dono, para a catraca distribuir.
            </div>
            <div style={{display:"flex",flexDirection:"column",gap:6}}>
              {pronto.nomes.map(n=>{
                const quantos=pronto.dados.filter(d=>String(d.corretor||"").trim()===n).length;
                return <div key={n} style={{display:"flex",alignItems:"center",gap:9,background:C.surface,borderRadius:10,padding:"8px 11px",flexWrap:"wrap"}}>
                  <div style={{flex:"1 1 130px",minWidth:0}}>
                    <div style={{color:C.ink,fontSize:12.5,fontWeight:600,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{n}</div>
                    <div style={{color:C.faint,fontSize:10.5}}>{quantos} lead(s)</div>
                  </div>
                  <select value={pronto.mapaCorretores[n]||""}
                    onChange={e=>setPronto({...pronto,mapaCorretores:{...pronto.mapaCorretores,[n]:e.target.value}})}
                    style={{flex:"1 1 160px",fontSize:isMobile?16:13,border:`1px solid ${C.line}`,background:C.card,borderRadius:9,padding:"9px 10px",color:C.ink,outline:"none"}}>
                    <option value="">— deixar na fila —</option>
                    {pessoas.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}
                  </select>
                </div>;
              })}
            </div>
          </div>
          :<div style={{color:C.faint,fontSize:11.5,marginBottom:12,lineHeight:1.5}}>
            A planilha não tem coluna de corretor — todos os leads entram na fila da catraca.
          </div>}

        <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
          <button onClick={confirmarImportacao} disabled={subindo}
            style={{flex:1,minWidth:150,background:subindo?C.faint:C.greenDeep,color:"#fff",border:"none",borderRadius:10,padding:"12px",fontSize:13.5,fontWeight:600,cursor:subindo?"default":"pointer"}}>
            {subindo?"Importando…":`Importar ${pronto.dados.length} lead(s)`}</button>
          <button onClick={()=>setPronto(null)} disabled={subindo}
            style={{flex:"0 0 auto",background:C.surface,color:C.sub,border:`1px solid ${C.line}`,borderRadius:10,padding:"12px 18px",fontSize:13.5,fontWeight:600,cursor:"pointer"}}>
            Cancelar</button>
        </div>
      </div>}

      {/* ===== listas já importadas ===== */}
      {lotes&&lotes.length>0&&!pronto&&<div style={{background:C.card,border:`1px solid ${C.line}`,borderRadius:14,padding:13,marginBottom:14}}>
        <div style={{color:C.ink,fontSize:12.5,fontWeight:700,marginBottom:8}}>Listas importadas</div>
        <div style={{display:"flex",flexDirection:"column",gap:6}}>
          {lotes.map(l=><div key={l.id}>
            <div style={{display:"flex",alignItems:"center",gap:9,background:C.surface,borderRadius:10,padding:"9px 11px"}}>
              <div style={{flex:1,minWidth:0}}>
                <div style={{color:C.ink,fontSize:12.5,fontWeight:600,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>
                  {l.rotulo||l.arquivo||"Importação"}</div>
                <div style={{color:C.faint,fontSize:10.5}}>
                  {new Date(l.created_at).toLocaleDateString("pt-BR")} · {l.na_base} na base
                  {l.origem?` · origem: ${l.origem}`:""}
                  {l.com_conversa>0?` · ${l.com_conversa} com conversa`:""}
                </div>
              </div>
              <button onClick={()=>setApagando(apagando&&apagando.id===l.id?null:l)} disabled={subindo}
                title="Apagar esta lista" style={{background:"transparent",border:"none",color:C.hot,cursor:"pointer",padding:4,display:"flex"}}>
                <Icon n="trash" size={15}/></button>
            </div>
            {apagando&&apagando.id===l.id&&<div style={{marginTop:6,background:C.hotSoft,border:`1px solid ${C.hot}44`,borderRadius:11,padding:11}}>
              <div style={{color:C.hot,fontSize:12.5,fontWeight:700,marginBottom:4}}>Apagar "{l.rotulo||l.arquivo}"?</div>
              <div style={{color:C.sub,fontSize:11.5,lineHeight:1.55,marginBottom:9}}>
                Só os leads que vieram desta lista são apagados — o resto da base não é tocado.
                {l.com_conversa>0
                  ?<React.Fragment><br/><b style={{color:C.hot}}>{l.com_conversa} já têm conversa.</b> Eles são mantidos, a não ser que você escolha apagar tudo.</React.Fragment>
                  :null}
              </div>
              <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
                <button onClick={()=>apagarLote(l,false)} disabled={subindo}
                  style={{flex:"1 1 130px",background:C.hot,color:"#fff",border:"none",borderRadius:9,padding:"10px",fontSize:12.5,fontWeight:600,cursor:"pointer"}}>
                  {subindo?"Apagando…":l.com_conversa>0?`Apagar ${l.na_base-l.com_conversa} sem conversa`:"Apagar os leads"}</button>
                {l.com_conversa>0&&<button onClick={()=>apagarLote(l,true)} disabled={subindo}
                  style={{flex:"1 1 130px",background:C.card,color:C.hot,border:`1px solid ${C.hot}66`,borderRadius:9,padding:"10px",fontSize:12.5,fontWeight:600,cursor:"pointer"}}>
                  Apagar todos os {l.na_base}</button>}
                <button onClick={()=>setApagando(null)}
                  style={{flex:"0 0 auto",background:C.card,color:C.sub,border:`1px solid ${C.line}`,borderRadius:9,padding:"10px 16px",fontSize:12.5,fontWeight:600,cursor:"pointer"}}>Cancelar</button>
              </div>
            </div>}
          </div>)}
        </div>
      </div>}

      {/* ===== leads sem lote (entraram antes desta atualização) =====
          Aqui mora a lista velha que o Ali quer apagar. Como lead da Meta e do
          WhatsApp também não tem lote, o agrupamento é por origem: ele enxerga
          o que é planilha e o que é operação, e escolhe. */}
      {antigos&&antigos.length>0&&!pronto&&<div style={{background:C.card,border:`1px solid ${C.line}`,borderRadius:14,padding:13,marginBottom:14}}>
        <button onClick={()=>setLimpeza(v=>!v)}
          style={{width:"100%",display:"flex",alignItems:"center",gap:8,background:"transparent",border:"none",padding:0,cursor:"pointer",textAlign:"left"}}>
          <Icon n="undo" size={15} color={C.faint}/>
          <span style={{color:C.ink,fontSize:12.5,fontWeight:700,flex:1}}>Leads que entraram antes do controle de listas</span>
          <span style={{color:C.faint,fontSize:11}}>{limpeza?"ocultar":"ver"}</span>
        </button>
        {limpeza&&<React.Fragment>
          <div style={{color:C.faint,fontSize:11,lineHeight:1.55,margin:"8px 0 10px"}}>
            Estes não têm lista registrada, então estão agrupados pela origem.
            <b style={{color:C.hot}}> Confira antes de apagar</b> — os leads que chegaram pelo WhatsApp
            e pela Meta também aparecem aqui, e não são planilha.
          </div>
          <div style={{display:"flex",flexDirection:"column",gap:6}}>
            {antigos.map(g=><div key={g.origem}>
              <div style={{display:"flex",alignItems:"center",gap:9,background:C.surface,borderRadius:10,padding:"9px 11px"}}>
                <div style={{flex:1,minWidth:0}}>
                  <div style={{color:C.ink,fontSize:12.5,fontWeight:600,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{g.origem}</div>
                  <div style={{color:C.faint,fontSize:10.5}}>
                    {g.quantos} lead(s) · de {new Date(g.primeiro).toLocaleDateString("pt-BR")} a {new Date(g.ultimo).toLocaleDateString("pt-BR")}
                    {g.com_conversa>0?` · ${g.com_conversa} com conversa`:""}
                  </div>
                </div>
                <button onClick={()=>setApagandoGrupo(apagandoGrupo&&apagandoGrupo.origem===g.origem?null:g)} disabled={subindo}
                  title="Apagar este grupo" style={{background:"transparent",border:"none",color:C.hot,cursor:"pointer",padding:4,display:"flex"}}>
                  <Icon n="trash" size={15}/></button>
              </div>
              {apagandoGrupo&&apagandoGrupo.origem===g.origem&&<div style={{marginTop:6,background:C.hotSoft,border:`1px solid ${C.hot}44`,borderRadius:11,padding:11}}>
                <div style={{color:C.hot,fontSize:12.5,fontWeight:700,marginBottom:4}}>Apagar os leads de origem "{g.origem}"?</div>
                <div style={{color:C.sub,fontSize:11.5,lineHeight:1.55,marginBottom:9}}>
                  Só os {g.quantos} desta origem. Leads de outras origens e tudo que foi importado com lista não são tocados.
                  {g.com_conversa>0
                    ?<React.Fragment><br/><b style={{color:C.hot}}>{g.com_conversa} já têm conversa.</b> Eles são mantidos, a não ser que você escolha apagar tudo.</React.Fragment>
                    :null}
                </div>
                <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
                  <button onClick={()=>apagarAntigo(g,false)} disabled={subindo}
                    style={{flex:"1 1 130px",background:C.hot,color:"#fff",border:"none",borderRadius:9,padding:"10px",fontSize:12.5,fontWeight:600,cursor:"pointer"}}>
                    {subindo?"Apagando…":g.com_conversa>0?`Apagar ${g.quantos-g.com_conversa} sem conversa`:`Apagar os ${g.quantos}`}</button>
                  {g.com_conversa>0&&<button onClick={()=>apagarAntigo(g,true)} disabled={subindo}
                    style={{flex:"1 1 130px",background:C.card,color:C.hot,border:`1px solid ${C.hot}66`,borderRadius:9,padding:"10px",fontSize:12.5,fontWeight:600,cursor:"pointer"}}>
                    Apagar todos os {g.quantos}</button>}
                  <button onClick={()=>setApagandoGrupo(null)}
                    style={{flex:"0 0 auto",background:C.card,color:C.sub,border:`1px solid ${C.line}`,borderRadius:9,padding:"10px 16px",fontSize:12.5,fontWeight:600,cursor:"pointer"}}>Cancelar</button>
                </div>
              </div>}
            </div>)}
          </div>
        </React.Fragment>}
      </div>}

      {resultado&&<div style={{background:C.greenSoft,border:`1px solid ${C.green}44`,borderRadius:12,padding:12,marginBottom:12}}>
        <div style={{color:C.greenDeep,fontSize:13,fontWeight:700,marginBottom:4}}>
          {resultado.criados} lead(s) importado(s)</div>
        {resultado.ignorados>0&&<div style={{color:C.sub,fontSize:12,lineHeight:1.5}}>
          {resultado.ignorados} linha(s) fora: {Object.entries(resultado.motivos).map(([m,n])=>`${n} ${m}`).join(" · ")}.
          <div style={{color:C.faint,fontSize:11,marginTop:3}}>Telefone repetido é ignorado de propósito — o cadastro que já existe no ConHub tem histórico e não pode ser sobrescrito por planilha.</div>
        </div>}
      </div>}
      <div style={{color:C.faint,fontSize:11.5,marginBottom:10,lineHeight:1.5}}>
        {lista===null?"Carregando…":`${filtrados.length} lead(s)`} · a planilha sai em CSV e abre direto no Excel.
        <br/>Para <b>importar de outro CRM</b>: exporte em CSV com uma coluna de telefone. Nome, e-mail, origem, temperatura, etapa e corretor entram se existirem.
      </div>
      <div style={{background:C.card,border:`1px solid ${C.line}`,borderRadius:14,overflowX:"auto"}}>
        <table style={{width:"100%",borderCollapse:"collapse",minWidth:700}}>
          <thead><tr style={{borderBottom:`1px solid ${C.line}`}}>
            {["Lead","Telefone","Origem","Temp.","Etapa","Corretor","Entrou em"].map(h=>
              <th key={h} style={{...cel,fontWeight:700,color:C.faint,fontSize:10.5,textTransform:"uppercase",textAlign:"left"}}>{h}</th>)}
          </tr></thead>
          {/* A linha inteira abre a conversa. Era a pergunta natural de quem
              olha a base ("e esse aí, como está?") e não tinha resposta: só
              dava para procurar o nome de novo na tela de atendimento. */}
          <tbody>{filtrados.map(l=><tr key={l.id} onClick={()=>abrirConversa&&abrirConversa(l.id)}
            title="Abrir a conversa deste lead"
            style={{borderBottom:`1px solid ${C.line}`,cursor:abrirConversa?"pointer":"default"}}>
            <td style={{...cel,color:C.ink,fontWeight:600}}>{l.nome}</td>
            <td style={{...cel,fontFamily:MONO}}>{fmtTel(l.tel)}</td>
            <td style={cel}>{l.origem}</td>
            <td style={cel}><span style={{color:prioDe(l.prio).c,fontWeight:700,fontSize:11}}>{prioDe(l.prio).label}</span></td>
            <td style={cel}><span style={{color:STAGE_C[l.status],fontWeight:600}}>{l.status}</span></td>
            <td style={{...cel,color:l.assignedName?C.ink:C.hot}}>{l.assignedName||"na fila"}</td>
            <td style={cel}>{new Date(l.createdAt).toLocaleDateString("pt-BR")}</td>
          </tr>)}</tbody>
        </table>
        {lista!==null&&filtrados.length===0&&<div style={{color:C.faint,fontSize:12.5,textAlign:"center",padding:24}}>Nenhum lead encontrado.</div>}
      </div>
    </div>
  </div>;
}

/* ===== PAINEL DE RECOMENDAÇÕES =====
   O "gerente operacional" da tela inicial: em vez de o gestor abrir lead por
   lead, junta o que merece decisão agora — quem está sem resposta, quem está
   sem corretor e quem está com alguém que converte bem menos naquela
   temperatura.

   Só entra na lista o que passa do ganho mínimo. Sugerir troca por 2 pontos de
   diferença seria ruído estatístico com cara de conselho. */
function PainelRecomendacoes({acoes,openLead,isMobile}){
  const [d,setD]=useState(null);
  const [feito,setFeito]=useState({});
  useEffect(()=>{let vivo=true;
    acoes.recomendacoes().then(x=>vivo&&setD(x)).catch(()=>vivo&&setD({itens:[]}));
    return()=>{vivo=false;};},[]);

  if(!d) return null;
  const itens=d.itens.filter(i=>!feito[i.lead_id+i.tipo]);
  const CORES={sem_resposta:C.hot,direcionar:"#2F80C4",trocar:C.amber};
  const ROTULOS={sem_resposta:"Sem resposta",direcionar:"Direcionar",trocar:"Trocar de corretor"};

  return <div style={{background:C.card,border:`1px solid ${C.line}`,borderRadius:14,padding:isMobile?13:16,marginBottom:16}}>
    <div style={{display:"flex",alignItems:"center",gap:7,marginBottom:3}}>
      <Icon n="spark" size={16} color="#2F80C4"/>
      <span style={{color:C.ink,fontSize:13.5,fontWeight:700}}>Recomendações da IA</span>
      {d.total>itens.length&&<span style={{marginLeft:"auto",color:C.faint,fontSize:11}}>{d.total} no total</span>}
    </div>
    <div style={{color:C.faint,fontSize:11,marginBottom:11,lineHeight:1.45}}>
      Calculado do histórico da equipe: conversão por temperatura do lead e tempo de espera.
    </div>
    {itens.length===0&&<div style={{color:C.sub,fontSize:12.5,padding:"14px 0",textAlign:"center"}}>
      Nada exigindo decisão agora. 👍</div>}
    <div style={{display:"flex",flexDirection:"column",gap:8}}>
      {itens.map(i=><div key={i.lead_id+i.tipo} style={{border:`1px solid ${C.line}`,borderLeft:`3px solid ${CORES[i.tipo]}`,borderRadius:10,padding:11}}>
        <div style={{display:"flex",alignItems:"center",gap:7,marginBottom:5,flexWrap:"wrap"}}>
          <span style={{background:CORES[i.tipo]+"18",color:CORES[i.tipo],fontSize:10,fontWeight:700,padding:"2px 8px",borderRadius:999}}>{ROTULOS[i.tipo]}</span>
          <button onClick={()=>openLead&&openLead(i.lead_id)} style={{border:"none",background:"transparent",color:C.ink,fontSize:12.5,fontWeight:700,cursor:"pointer",padding:0,textDecoration:"underline"}}>{i.lead}</button>
        </div>
        <div style={{color:C.sub,fontSize:12,lineHeight:1.5}}>{i.texto}</div>
        <div style={{display:"flex",gap:8,marginTop:8}}>
          {i.sugerido&&<button onClick={async()=>{ await acoes.repassar(i.lead_id,i.sugerido.id); setFeito(f=>({...f,[i.lead_id+i.tipo]:true})); }}
            style={{background:CORES[i.tipo],color:"#fff",border:"none",borderRadius:8,padding:"7px 12px",fontSize:12,fontWeight:600,cursor:"pointer",display:"flex",alignItems:"center",gap:5}}>
            <Icon n="transfer" size={12}/> {first(i.sugerido.nome)}</button>}
          <button onClick={()=>setFeito(f=>({...f,[i.lead_id+i.tipo]:true}))}
            style={{border:"none",background:"transparent",color:C.faint,fontSize:11.5,cursor:"pointer"}}>dispensar</button>
        </div>
      </div>)}
    </div>
  </div>;
}

/* ===== SCORE DE PERFORMANCE =====
   Ranking da equipe para gestor e atendente. Quem não recebeu lead no período
   aparece como "sem dados" e não como nota baixa: não avaliar é diferente de
   avaliar mal, e a diferença importa quando o número vira conversa de gestão. */
/* O score usa o MESMO período escolhido lá em cima, e não uma janela própria.

   Antes ele tinha o próprio seletor de "últimos 90 dias" enquanto a tabela
   logo abaixo mostrava o mês que o gestor escolheu. Os dois números estavam
   certos e descreviam pedaços diferentes do tempo — que é a pior forma de
   errar, porque ninguém desconfia. */
function ScoreEquipe({acoes,isMobile,periodo,aoAbrirDetalhe}){
  const [d,setD]=useState(null);
  useEffect(()=>{let vivo=true; setD(null);
    acoes.score(periodo).then(x=>vivo&&setD(x)).catch(()=>{});
    return()=>{vivo=false;};},[periodo.de,periodo.ate]);

  const cor=(n)=>n==null?C.faint:n>=70?C.green:n>=45?C.amber:C.hot;
  const celula={padding:"9px 8px",fontSize:12,color:C.sub,whiteSpace:"nowrap"};

  return <div style={{background:C.card,border:`1px solid ${C.line}`,borderRadius:14,padding:isMobile?13:16,marginBottom:16}}>
    <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:4,flexWrap:"wrap"}}>
      <Icon n="award" size={16} color={C.greenMid}/>
      <span style={{color:C.ink,fontSize:13.5,fontWeight:700}}>Score de performance</span>
      <span style={{marginLeft:"auto",color:C.faint,fontSize:11}}>mesmo período do relatório</span>
    </div>
    <div style={{color:C.faint,fontSize:11,marginBottom:10,lineHeight:1.45}}>
      Conversão, tempo de resposta, visitas, perdas, vendas e ligações — pesados nessa ordem.
      Clique no nome para ver de onde saiu cada ponto. <b>Visitas</b> conta só o que uma pessoa confirmou;
      <b> 1ª resposta</b> conta da hora em que o lead ficou com ela, e só o que ela mesma escreveu.
    </div>
    {!d&&<div style={{color:C.faint,fontSize:12,padding:"10px 0"}}>Calculando…</div>}

    {/* NO CELULAR A TABELA VIRA CARTÃO.

        A tabela tem dez colunas e 696px de largura. Numa tela de 375 cabiam
        quatro — as outras seis (1ª resposta, atendimento, visitas, perdas,
        vendas, ligações) ficavam fora da tela, sem nada indicando que dava
        para arrastar. Ou seja: no celular, a metade do relatório que mais
        interessa simplesmente não existia.

        Rolagem lateral dentro de uma tela que já rola para baixo é o gesto que
        ninguém descobre sozinho. Um cartão por corretor mostra tudo. */}
    {d&&isMobile&&<div style={{display:"flex",flexDirection:"column",gap:8}}>
      {d.equipe.map((m,i)=><div key={m.id} style={{background:C.surface,borderRadius:12,padding:"11px 12px"}}>
        <button onClick={()=>!m.sem_dados&&aoAbrirDetalhe&&aoAbrirDetalhe(m,d.componentes)}
          disabled={m.sem_dados}
          style={{width:"100%",border:"none",background:"transparent",padding:"6px 0",textAlign:"left",
            display:"flex",alignItems:"center",gap:9,cursor:m.sem_dados?"default":"pointer"}}>
          <span style={{fontFamily:MONO,color:C.faint,fontSize:12,minWidth:16}}>{m.sem_dados?"–":i+1}</span>
          <span style={{color:C.ink,fontSize:13.5,fontWeight:700,flex:1,minWidth:0,
            overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{m.nome}</span>
          {m.sem_dados
            ?<span style={{color:C.faint,fontSize:11}}>sem dados</span>
            :<span style={{fontFamily:MONO,fontSize:19,fontWeight:700,color:cor(m.score)}}>{m.score}</span>}
        </button>
        {!m.sem_dados&&<React.Fragment>
          <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:8,marginTop:9}}>
            {[["Conversão",m.conversao+"%"],["1ª resposta",m.resposta_min==null?"—":fmtMin(m.resposta_min)],
              ["Atendimento",m.atendimento_min==null?"—":fmtMin(m.atendimento_min)],
              ["Respondeu",`${m.respondidos||0}/${m.recebidos}`],
              ["Visitas",`${m.visitas_confirmadas||0}/${m.visitas}`],["Perdas",m.perdidos],["Vendas",m.vendas],
              ["Ligações",m.ligacoes]].map(([r,v])=>
              <div key={r}>
                <div style={{fontFamily:MONO,color:C.ink,fontSize:13,fontWeight:700,lineHeight:1.1}}>{v}</div>
                <div style={{color:C.faint,fontSize:9.5,marginTop:1}}>{r}</div>
              </div>)}
          </div>
          <div style={{color:C.greenDeep,fontSize:11,fontWeight:600,marginTop:8}}>toque no nome para abrir a nota</div>
        </React.Fragment>}
      </div>)}
    </div>}

    {d&&!isMobile&&<div style={{overflowX:"auto"}}>
      <table style={{width:"100%",borderCollapse:"collapse",minWidth:520}}>
        <thead><tr style={{borderBottom:`1px solid ${C.line}`}}>
          {["#","Corretor","Score","Conversão","1ª resposta","Atendimento","Visitas conf.","Perdas","Vendas","Ligações"].map((h,i)=>
            <th key={h} style={{...celula,fontWeight:700,color:C.faint,fontSize:10.5,textTransform:"uppercase",textAlign:i<2?"left":"right"}}>{h}</th>)}
        </tr></thead>
        <tbody>{d.equipe.map((m,i)=><tr key={m.id} style={{borderBottom:`1px solid ${C.line}`}}>
          <td style={{...celula,fontFamily:MONO,color:C.faint}}>{m.sem_dados?"–":i+1}</td>
          <td style={{...celula,color:C.ink,fontWeight:600}}>
            <button onClick={()=>aoAbrirDetalhe&&aoAbrirDetalhe(m,d.componentes)} disabled={m.sem_dados}
              title={m.sem_dados?undefined:"Ver de onde saiu cada ponto"}
              style={{border:"none",background:"transparent",padding:0,color:C.ink,fontWeight:600,fontSize:12,
                cursor:m.sem_dados?"default":"pointer",textDecoration:m.sem_dados?"none":"underline",textUnderlineOffset:3}}>
              {m.nome}</button>
            {m.papel==="sdr"&&<span style={{color:C.faint,fontWeight:400}}> · atendente</span>}</td>
          <td style={{...celula,textAlign:"right"}}>
            {m.sem_dados?<span style={{color:C.faint,fontSize:11}}>sem dados</span>
              :<span style={{fontFamily:MONO,fontSize:15,fontWeight:700,color:cor(m.score)}}>{m.score}</span>}</td>
          <td style={{...celula,textAlign:"right"}}>{m.sem_dados?"—":m.conversao+"%"}</td>
          <td style={{...celula,textAlign:"right"}}>{m.resposta_min==null?"—":fmtMin(m.resposta_min)}</td>
          {/* Espera média a cada pergunta do cliente, não só a primeira. */}
          <td style={{...celula,textAlign:"right"}}>{m.atendimento_min==null?"—":fmtMin(m.atendimento_min)}</td>
          <td style={{...celula,textAlign:"right"}} title="confirmadas por uma pessoa / total no funil">
            {m.sem_dados?"—":<React.Fragment><b>{m.visitas_confirmadas||0}</b><span style={{color:C.faint}}>/{m.visitas}</span></React.Fragment>}</td>
          <td style={{...celula,textAlign:"right"}}>{m.sem_dados?"—":m.perdidos}</td>
          <td style={{...celula,textAlign:"right"}}>{m.sem_dados?"—":m.vendas}</td>
          <td style={{...celula,textAlign:"right"}}>{m.sem_dados?"—":m.ligacoes}</td>
        </tr>)}</tbody>
      </table>
    </div>}
  </div>;
}

function Recomendacao({leadId,acoes,onDirecionar,isMobile}){
  const [r,setR]=useState(null);
  useEffect(()=>{let vivo=true; setR(null);
    acoes.recomendacao(leadId).then(d=>vivo&&setR(d)).catch(()=>{});
    return()=>{vivo=false;};},[leadId]);

  if(!r||r.situacao==="ja_direcionado"||r.situacao==="sem_corretor_disponivel") return null;
  const forte=r.situacao==="ok";
  return <div style={{background:forte?"#F2F7FF":C.surface,border:`1px solid ${forte?"#2F80C433":C.line}`,
    borderRadius:12,padding:12,marginBottom:12}}>
    <div style={{display:"flex",alignItems:"center",gap:6,marginBottom:6}}>
      <Icon n="spark" size={14} color={forte?"#2F80C4":C.faint}/>
      <span style={{color:forte?"#2F80C4":C.sub,fontSize:12,fontWeight:700}}>Recomendação da IA</span>
      <span style={{marginLeft:"auto",color:C.faint,fontSize:10}}>lead {String(r.temperatura||"").toLowerCase()}</span>
    </div>
    <div style={{color:C.ink,fontSize:12.5,lineHeight:1.5}}>{r.explicacao}</div>
    {r.sugerido&&<button onClick={()=>onDirecionar&&onDirecionar(r.sugerido.id)}
      style={{marginTop:9,width:"100%",background:forte?"#2F80C4":C.green,color:"#fff",border:"none",borderRadius:9,
        padding:"9px",fontSize:12.5,fontWeight:600,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",gap:6}}>
      <Icon n="transfer" size={13}/> Direcionar para {first(r.sugerido.nome)}</button>}
    <div style={{color:C.faint,fontSize:10,marginTop:7,lineHeight:1.4}}>
      Calculado do histórico da equipe: conversão por temperatura do lead, com amostra mínima de {5} atendimentos concluídos.</div>
  </div>;
}

const roleParaTexto=(r)=>r==="adm"?"Gestor(a)":r==="sdr"?"Atendente":"Corretor(a)";

/* ===== ENVIAR IMÓVEL PARA O LEAD =====
   O corretor escolhe o produto e o que vai junto. A localização fica DESMARCADA
   por padrão: mandar endereço sem querer não tem desfazer no WhatsApp. */
function EnviarImovel({lead,acoes,isMobile,aoFechar}){
  const [lista,setLista]=useState(null);
  const [busca,setBusca]=useState("");
  const [sel,setSel]=useState(null);
  const [opc,setOpc]=useState({fotos:true,video:false,localizacao:false});
  const [enviando,setEnviando]=useState(false);
  const [erro,setErro]=useState("");
  /* Quais fotos vão. `null` = todas, que é o padrão e o caso mais comum.
     Vira lista só quando o corretor abre a escolha. */
  const [escolhidas,setEscolhidas]=useState(null);
  const [escolhendo,setEscolhendo]=useState(false);
  // Trocar de imóvel zera a escolha: foto do apartamento anterior não tem nada
  // a ver com este, e mandar a errada não tem desfazer no WhatsApp.
  useEffect(()=>{ setEscolhidas(null); setEscolhendo(false); },[sel&&sel.id]);

  useEffect(()=>{let vivo=true;
    const t=setTimeout(()=>acoes.produtos({status:"ativo",q:busca}).then(r=>vivo&&setLista(r)).catch(e=>vivo&&setErro(e.message)),300);
    return()=>{vivo=false;clearTimeout(t);};},[busca]);

  async function enviar(){
    if(!sel||enviando) return;
    setEnviando(true); setErro("");
    try{
      await acoes.enviarProduto(lead.id,{produto_id:sel.id,...opc,
        ...(opc.fotos&&escolhidas?{fotos_ids:escolhidas}:{})});
      aoFechar();
    }
    catch(e){ setErro(e.message); setEnviando(false); }
  }
  const marca=(chave,texto,aviso)=><label style={{display:"flex",alignItems:"flex-start",gap:9,cursor:"pointer",padding:"9px 10px",borderRadius:9,background:opc[chave]?C.greenSoft:C.surface,border:`1px solid ${opc[chave]?C.green+"55":C.line}`}}>
    <input type="checkbox" checked={opc[chave]} onChange={e=>setOpc({...opc,[chave]:e.target.checked})} style={{width:17,height:17,marginTop:1,accentColor:C.green}}/>
    <span style={{fontSize:13,color:C.ink}}>{texto}{aviso&&<span style={{display:"block",color:C.faint,fontSize:11,marginTop:2}}>{aviso}</span>}</span>
  </label>;

  return <div className="tela-cheia" style={{zIndex:40,background:"rgba(0,0,0,.4)",display:"flex",alignItems:isMobile?"flex-end":"center",justifyContent:"center",padding:isMobile?0:20}} onClick={aoFechar}>
    <div onClick={e=>e.stopPropagation()} style={{background:C.card,width:"100%",maxWidth:520,maxHeight:"100%",borderRadius:isMobile?"18px 18px 0 0":16,display:"flex",flexDirection:"column",overflow:"hidden"}}>
      <div style={{padding:"14px 16px",borderBottom:`1px solid ${C.line}`,display:"flex",alignItems:"center",gap:10}}>
        <div style={{flex:1}}>
          <div style={{color:C.ink,fontSize:15,fontWeight:700}}>Enviar imóvel para {first(lead.nome)}</div>
          <div style={{color:C.faint,fontSize:11.5}}>O cliente recebe as informações e as fotos pelo WhatsApp.</div>
        </div>
        <button onClick={aoFechar} style={{border:"none",background:"transparent",color:C.faint,fontSize:22,cursor:"pointer",lineHeight:1}}>×</button>
      </div>

      <div style={{padding:"10px 16px",borderBottom:`1px solid ${C.line}`}}>
        <div style={{display:"flex",alignItems:"center",gap:8,border:`1px solid ${C.line}`,background:C.surface,borderRadius:10,padding:"0 11px"}}>
          <Icon n="search" size={15} color={C.faint}/>
          <input value={busca} onChange={e=>setBusca(e.target.value)} placeholder="Buscar imóvel"
            style={{flex:1,border:"none",outline:"none",background:"transparent",fontSize:isMobile?16:13,padding:"9px 0",color:C.ink,minWidth:0}}/>
        </div>
      </div>

      <div style={{flex:1,overflowY:"auto",padding:"8px 16px",minHeight:120}}>
        {lista===null&&<div style={{color:C.faint,fontSize:13,padding:16,textAlign:"center"}}>Carregando…</div>}
        {lista&&lista.length===0&&<div style={{color:C.faint,fontSize:13,padding:16,textAlign:"center"}}>Nenhum imóvel disponível com esse termo.</div>}
        {(lista||[]).map(p=>{const capa=(p.midias||[]).find(m=>m.tipo==="foto");
          return <button key={p.id} onClick={()=>setSel(p)} style={{width:"100%",textAlign:"left",display:"flex",gap:10,alignItems:"center",padding:9,marginBottom:6,borderRadius:11,cursor:"pointer",
            border:`1px solid ${sel&&sel.id===p.id?C.green:C.line}`,background:sel&&sel.id===p.id?C.greenSoft:C.card}}>
            <div style={{width:52,height:52,borderRadius:9,background:C.surface,flexShrink:0,overflow:"hidden",display:"flex",alignItems:"center",justifyContent:"center"}}>
              {capa?<img src={capa.url} alt="" style={{width:"100%",height:"100%",objectFit:"cover"}}/>:<Icon n="pin" size={17} color={C.faint}/>}
            </div>
            <div style={{minWidth:0,flex:1}}>
              <div style={{color:C.ink,fontSize:13.5,fontWeight:600,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{p.titulo}</div>
              <div style={{color:C.faint,fontSize:11.5}}>{[p.bairro,p.cidade].filter(Boolean).join(" · ")}</div>
              <div style={{color:C.greenDeep,fontFamily:MONO,fontSize:12.5,fontWeight:700}}>{p.valor?fmtMoeda(p.valor):"a combinar"}</div>
            </div>
            <span style={{color:C.faint,fontSize:10.5,flexShrink:0}}>{(p.midias||[]).filter(m=>m.tipo==="foto").length} foto(s)</span>
          </button>;})}
      </div>

      {sel&&<div style={{padding:"12px 16px",borderTop:`1px solid ${C.line}`,display:"flex",flexDirection:"column",gap:7}}>
        {(()=>{const fotosDoAnuncio=(sel.midias||[]).filter(m=>m.tipo==="foto");
          const quantas=escolhidas?escolhidas.length:fotosDoAnuncio.length;
          return <React.Fragment>
            {marca("fotos",escolhidas
              ? `Enviar ${quantas} de ${fotosDoAnuncio.length} foto(s)`
              : `Enviar as ${fotosDoAnuncio.length} foto(s)`)}

            {/* ESCOLHER ALGUMAS. O captador sobe dez fotos do empreendimento e
                o corretor quer mandar as três do apartamento que interessa
                àquele cliente — mandar as dez é o jeito rápido de o cliente
                parar de olhar. Fica fechado por padrão: quem quer o anúncio
                inteiro (a maioria) não ganha um passo a mais. */}
            {opc.fotos&&fotosDoAnuncio.length>1&&<React.Fragment>
              {!escolhendo
                ?<button onClick={()=>{setEscolhendo(true);if(!escolhidas)setEscolhidas(fotosDoAnuncio.map(m=>m.id));}}
                  style={{alignSelf:"flex-start",border:"none",background:"transparent",color:C.greenDeep,
                    fontSize:11.5,fontWeight:700,cursor:"pointer",padding:"2px 0",textDecoration:"underline",textUnderlineOffset:3}}>
                  escolher quais fotos</button>
                :<div style={{background:C.surface,borderRadius:10,padding:9}}>
                  <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:7,flexWrap:"wrap"}}>
                    <span style={{color:C.sub,fontSize:11.5,fontWeight:700,flex:1}}>
                      {quantas} de {fotosDoAnuncio.length} selecionada(s)</span>
                    <button onClick={()=>setEscolhidas(fotosDoAnuncio.map(m=>m.id))}
                      style={{border:"none",background:"transparent",color:C.greenDeep,fontSize:11,fontWeight:700,cursor:"pointer"}}>todas</button>
                    <button onClick={()=>setEscolhidas([])}
                      style={{border:"none",background:"transparent",color:C.faint,fontSize:11,cursor:"pointer"}}>nenhuma</button>
                    <button onClick={()=>{setEscolhendo(false);setEscolhidas(null);}}
                      style={{border:"none",background:"transparent",color:C.faint,fontSize:11,cursor:"pointer"}}>mandar todas</button>
                  </div>
                  <div style={{display:"flex",gap:6,flexWrap:"wrap"}}>
                    {fotosDoAnuncio.map((m,i)=>{const marcada=!escolhidas||escolhidas.includes(m.id);
                      return <button key={m.id} onClick={()=>setEscolhidas(a=>{
                          const base=a||fotosDoAnuncio.map(x=>x.id);
                          return base.includes(m.id)?base.filter(x=>x!==m.id):[...base,m.id];})}
                        title={marcada?"Tirar esta foto do envio":"Incluir esta foto"}
                        style={{position:"relative",width:58,height:58,borderRadius:9,overflow:"hidden",padding:0,cursor:"pointer",
                          border:`2px solid ${marcada?C.green:C.line}`,background:C.card,opacity:marcada?1:.45}}>
                        <img src={m.url} alt="" style={{width:"100%",height:"100%",objectFit:"cover"}}/>
                        {/* A capa leva a legenda no WhatsApp — quem escolhe
                            precisa saber qual é. */}
                        {i===0&&<span style={{position:"absolute",left:0,bottom:0,right:0,background:"rgba(10,20,16,.65)",
                          color:"#fff",fontSize:8,fontWeight:700,padding:"1px 0"}}>capa</span>}
                        {marcada&&<span style={{position:"absolute",top:2,right:2,width:15,height:15,borderRadius:99,
                          background:C.green,color:"#fff",fontSize:9,fontWeight:700,display:"flex",alignItems:"center",justifyContent:"center"}}>✓</span>}
                      </button>;})}
                  </div>
                  {quantas===0&&<div style={{color:C.hot,fontSize:11,marginTop:7}}>
                    Nenhuma foto selecionada — o cliente vai receber só o texto do imóvel.</div>}
                </div>}
            </React.Fragment>}
          </React.Fragment>;})()}
        {(sel.midias||[]).some(m=>m.tipo==="video")&&marca("video","Enviar o vídeo")}
        {sel.maps_url&&marca("localizacao","Enviar a localização","Fica desmarcado de propósito — mandar endereço sem querer não tem desfazer.")}
        {erro&&<div style={{color:C.hot,background:C.hotSoft,fontSize:12,borderRadius:8,padding:"8px 10px"}}>{erro}</div>}
        <button onClick={enviar} disabled={enviando} style={{background:enviando?C.faint:C.green,color:"#fff",border:"none",borderRadius:11,padding:"13px",fontSize:14.5,fontWeight:600,cursor:enviando?"default":"pointer",display:"flex",alignItems:"center",justifyContent:"center",gap:8}}>
          <Icon n={enviando?"loader":"send"} size={16} spin={enviando}/>{enviando?"Enviando…":"Enviar pelo WhatsApp"}
        </button>
      </div>}
    </div>
  </div>;
}

/* ===== IMÓVEIS E TERRENOS =====
   O ponto do módulo: a equipe para de depender de grupo de WhatsApp para
   saber o que está disponível e quem captou. */
const SITUACAO_PRODUTO={
  ativo:{t:"Disponível",c:C.greenMid,bg:C.greenSoft},
  aguardando_aprovacao:{t:"Aguardando aprovação",c:"#8a6d1f",bg:C.amberSoft},
  recusado:{t:"Recusado",c:C.hot,bg:C.hotSoft},
  vendido:{t:"Vendido",c:C.greenDeep,bg:C.greenSoft},
  inativo:{t:"Inativo",c:C.faint,bg:C.coolSoft},
};
const LIMITE_MIDIA={casa:{foto:10,video:1},terreno:{foto:4,video:1}};

function Imoveis({acoes,session,pessoas,equipeToda,isMobile,supervisor}){
  // Mesmo caso das conversas: filtro escolhido é trabalho da pessoa, e voltar
  // do segundo plano não pode desfazê-lo.
  const [f,setF]=usarEscolha("imoveis.filtros",{q:"",tipo:"",cidade:"",bairro:"",quartos:"",valor_max:"",modalidade:"",status:""});
  const [busca,setBusca]=usarEscolha("imoveis.busca","");
  const [lista,setLista]=useState(null);
  const [opcoes,setOpcoes]=useState({cidades:[],bairros:[]});
  const [erro,setErro]=useState("");
  const [editando,setEditando]=useState(null); // objeto do produto, ou "novo"
  const [aberto,setAberto]=useState(null);     // produto em detalhe
  const [recarga,setRecarga]=useState(0);
  const [filtrosAbertos,setFiltrosAbertos]=usarEscolha("imoveis.gaveta",false);
  // A busca não conta: ela fica sempre à vista, fora do bloco recolhível.
  const filtrosAtivos=[f.tipo,f.cidade,f.bairro,f.quartos,f.valor_max,f.modalidade,f.status].filter(Boolean).length;

  useEffect(()=>{const t=setTimeout(()=>setF(p=>({...p,q:busca})),350);return()=>clearTimeout(t);},[busca]);
  useEffect(()=>{acoes.produtoOpcoes().then(setOpcoes).catch(()=>{});},[recarga]);
  useEffect(()=>{
    let vivo=true;
    const params={}; Object.entries(f).forEach(([k,v])=>{if(v)params[k]=v;});
    acoes.produtos(params).then(r=>vivo&&setLista(r)).catch(e=>vivo&&setErro(e.message));
    return()=>{vivo=false;};
  },[f.q,f.tipo,f.cidade,f.bairro,f.quartos,f.valor_max,f.modalidade,f.status,recarga]);

  const atualizar=()=>setRecarga(r=>r+1);
  const decidir=async(p,status)=>{ setErro("");
    try{ await acoes.situacaoProduto(p.id,status); atualizar(); }catch(e){ setErro(e.message); } };
  const apagar=async(p)=>{ setErro("");
    if(!window.confirm(`Excluir "${p.titulo}" do catálogo?\n\nO cadastro e as fotos são apagados e não dá para desfazer.`)) return;
    try{ await acoes.apagarProduto(p.id); setAberto(null); atualizar(); }catch(e){ setErro(e.message); } };

  if(editando) return <FormularioProduto produto={editando==="novo"?null:editando} pessoas={pessoas} equipeToda={equipeToda} acoes={acoes}
    isMobile={isMobile} aoFechar={(mudou)=>{setEditando(null);if(mudou)atualizar();}}/>;
  if(aberto) return <DetalheProduto produto={aberto} acoes={acoes} isMobile={isMobile} supervisor={supervisor} session={session}
    aoFechar={()=>setAberto(null)} aoEditar={()=>{setEditando(aberto);setAberto(null);}} aoMudarSituacao={decidir} aoApagar={apagar}/>;

  const campo=(label,valor,chave,opts)=><select value={valor} onChange={e=>setF({...f,[chave]:e.target.value})}
    style={{fontSize:isMobile?16:12.5,fontWeight:500,color:valor?C.ink:C.sub,background:valor?C.greenSoft:C.surface,
      border:`1px solid ${valor?C.green+"66":C.line}`,borderRadius:9,padding:"7px 10px",outline:"none",maxWidth:"100%"}}>
    <option value="">{label}</option>
    {opts.map(o=><option key={o.v} value={o.v}>{o.t}</option>)}
  </select>;

  return <div style={{height:"100%",overflowY:"auto",padding:isMobile?14:20}}>
    <div style={{maxWidth:1020,margin:"0 auto"}}>
      {erro&&<div style={{background:C.hotSoft,color:C.hot,fontSize:12.5,borderRadius:10,padding:"10px 12px",marginBottom:12}}>{erro}</div>}

      <div style={{background:C.card,border:`1px solid ${C.line}`,borderRadius:14,padding:13,marginBottom:16,display:"flex",flexDirection:"column",gap:9}}>
        <div style={{display:"flex",gap:8,flexDirection:isMobile?"column":"row"}}>
          <div style={{flex:1,display:"flex",alignItems:"center",gap:8,border:`1px solid ${C.line}`,background:C.surface,borderRadius:10,padding:"0 11px",minWidth:0}}>
            <Icon n="search" size={15} color={C.faint}/>
            <input value={busca} onChange={e=>setBusca(e.target.value)} placeholder="Buscar por nome, bairro, cidade ou construtora"
              style={{flex:1,border:"none",outline:"none",background:"transparent",fontSize:isMobile?16:13,padding:"10px 0",color:C.ink,minWidth:0}}/>
          </div>
          <button onClick={()=>setEditando("novo")} style={{background:C.green,color:"#fff",border:"none",borderRadius:10,padding:"11px 16px",fontSize:13.5,fontWeight:600,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",gap:6,flexShrink:0}}>
            <Icon n="userplus" size={15}/> Cadastrar
          </button>
        </div>
        {/* Ferramentas da Caixa em linha própria: o corretor abre no meio da
            conversa com o cliente, sem sair do CRM. */}
        <div style={{display:"flex",gap:8}}>
          {[[CALCULADORA_CAIXA,"Poder de compra","zap","Estimativa em 1 minuto pela renda ou pela parcela"],
            [SIMULADOR_CAIXA,"Simulação completa","chart","Simulação oficial da Caixa, com todos os dados"]]
            .map(([url,texto,icone,dica])=>
            <a key={texto} href={url} target="_blank" rel="noreferrer" title={dica+" — abre em outra aba"}
              style={{flex:1,textDecoration:"none",background:C.surface,color:C.greenDeep,border:`1px solid ${C.green}55`,
                borderRadius:10,padding:isMobile?"10px 8px":"10px 14px",fontSize:isMobile?12.5:13,fontWeight:600,
                display:"flex",alignItems:"center",justifyContent:"center",gap:6,textAlign:"center"}}>
              <Icon n={icone} size={14}/>{texto}
            </a>)}
        </div>

        {/* Mesmo tratamento que os filtros das conversas receberam: abertos, os
            sete seletores empurravam o catálogo para fora da tela no celular.
            O contador ao lado do botão avisa quando algum ficou ligado. */}
        <div style={{display:"flex",alignItems:"center",gap:8}}>
          <button onClick={()=>setFiltrosAbertos(a=>!a)}
            style={{display:"flex",alignItems:"center",gap:6,border:`1px solid ${filtrosAtivos?C.green+"66":C.line}`,background:filtrosAtivos?C.greenSoft:C.surface,color:filtrosAtivos?C.greenDeep:C.sub,borderRadius:9,padding:"7px 12px",fontSize:12.5,fontWeight:600,cursor:"pointer"}}>
            <Icon n="columns" size={13}/>Filtros
            {filtrosAtivos>0&&<span style={{minWidth:17,height:17,padding:"0 5px",borderRadius:999,background:C.green,color:"#fff",fontSize:10.5,fontWeight:700,display:"flex",alignItems:"center",justifyContent:"center"}}>{filtrosAtivos}</span>}
            <span style={{display:"inline-flex",transform:filtrosAbertos?"rotate(90deg)":"none",transition:"transform .15s"}}><Icon n="chevron" size={13}/></span>
          </button>
          {filtrosAtivos>0&&<button onClick={()=>setF({...f,tipo:"",cidade:"",bairro:"",quartos:"",valor_max:"",modalidade:"",status:""})}
            style={{border:"none",background:"transparent",color:C.faint,fontSize:11.5,cursor:"pointer",textDecoration:"underline"}}>limpar</button>}
          <span style={{marginLeft:"auto",color:C.faint,fontSize:11}}>{lista===null?"Buscando…":`${lista.length} produto(s)`}</span>
        </div>
        {filtrosAbertos&&<div style={{display:"flex",gap:6,flexWrap:"wrap"}}>
          {campo("Casa ou terreno",f.tipo,"tipo",[{v:"casa",t:"Casas"},{v:"terreno",t:"Terrenos"}])}
          {campo("Cidade",f.cidade,"cidade",opcoes.cidades.map(c=>({v:c,t:c})))}
          {campo("Bairro",f.bairro,"bairro",opcoes.bairros.map(c=>({v:c,t:c})))}
          {campo("Quartos",f.quartos,"quartos",[1,2,3,4].map(n=>({v:n,t:`${n}+ quartos`})))}
          {campo("Até R$",f.valor_max,"valor_max",[100000,150000,200000,300000,500000].map(v=>({v,t:"até "+fmtMoeda(v)})))}
          {campo("Modalidade",f.modalidade,"modalidade",MODALIDADES.map(m=>({v:m,t:m})))}
          {supervisor&&campo("Situação",f.status,"status",Object.entries(SITUACAO_PRODUTO).map(([v,s])=>({v,t:s.t})))}
        </div>}
      </div>

      {lista&&lista.length===0&&<div style={{background:C.card,border:`1px solid ${C.line}`,borderRadius:16,padding:34,textAlign:"center"}}>
        <Icon n="pin" size={26} color={C.faint}/>
        <div style={{color:C.ink,fontSize:14,fontWeight:600,marginTop:10}}>Nenhum produto encontrado</div>
        <div style={{color:C.faint,fontSize:12.5,marginTop:6,lineHeight:1.5}}>Ajuste os filtros ou cadastre o primeiro imóvel.</div>
      </div>}

      <div style={{display:"grid",gridTemplateColumns:isMobile?"1fr":"repeat(auto-fill,minmax(280px,1fr))",gap:12}}>
        {(lista||[]).map(p=>{const capa=(p.midias||[]).find(m=>m.tipo==="foto"),s=SITUACAO_PRODUTO[p.status]||SITUACAO_PRODUTO.ativo;
          return <button key={p.id} onClick={()=>setAberto(p)} style={{textAlign:"left",background:C.card,border:`1px solid ${C.line}`,borderRadius:14,padding:0,overflow:"hidden",cursor:"pointer",display:"flex",flexDirection:"column"}}>
            <div style={{height:150,background:C.surface,display:"flex",alignItems:"center",justifyContent:"center",position:"relative"}}>
              {capa?<img src={capa.url} alt="" style={{width:"100%",height:"100%",objectFit:"cover"}}/>
                   :<Icon n={p.tipo==="casa"?"grid":"pin"} size={30} color={C.faint}/>}
              <span style={{position:"absolute",top:8,left:8,background:C.card,color:C.sub,fontSize:10.5,fontWeight:700,padding:"3px 8px",borderRadius:999}}>{p.tipo==="casa"?"Casa":"Terreno"}</span>
              {p.modalidade&&<span style={{position:"absolute",top:8,right:8,background:C.greenDeep,color:"#fff",fontSize:10,fontWeight:700,padding:"3px 8px",borderRadius:999}}>{p.modalidade==="Minha Casa Minha Vida"?"MCMV":p.modalidade}</span>}
            </div>
            <div style={{padding:12,display:"flex",flexDirection:"column",gap:5,flex:1}}>
              <div style={{color:C.ink,fontSize:14,fontWeight:600,lineHeight:1.3}}>{p.titulo}</div>
              <div style={{color:C.faint,fontSize:11.5}}>{[p.bairro,p.cidade].filter(Boolean).join(" · ")||"sem localização"}</div>
              {p.tipo==="casa"&&<div style={{color:C.sub,fontSize:11.5}}>{[p.quartos&&`${p.quartos} quarto(s)`,p.banheiros&&`${p.banheiros} banheiro(s)`,p.metragem&&`${p.metragem} m²`].filter(Boolean).join(" · ")}</div>}
              {p.tipo==="terreno"&&p.metragem&&<div style={{color:C.sub,fontSize:11.5}}>{p.metragem} m²</div>}
              <div style={{color:C.greenDeep,fontFamily:MONO,fontSize:16,fontWeight:700,marginTop:2}}>{p.valor?fmtMoeda(p.valor):"valor a combinar"}</div>
              <div style={{marginTop:"auto",paddingTop:8,display:"flex",gap:6,flexWrap:"wrap",alignItems:"center"}}>
                <Pill c={s.c} bg={s.bg}>{s.t}</Pill>
                <span style={{color:C.faint,fontSize:10.5}}>captou: {first(p.captador_nome||"—")}</span>
              </div>
            </div>
          </button>;})}
      </div>
    </div>
  </div>;
}

const rotulo=(t)=><label style={{display:"block",color:C.faint,fontSize:10.5,fontWeight:600,textTransform:"uppercase",letterSpacing:.4,marginBottom:4}}>{t}</label>;

/* Número no formato brasileiro: ponto separa milhar, vírgula separa decimal.
   Sem isso, "285.000" vira 285 — o JavaScript lê o ponto como decimal. */
function numeroBR(v){
  if(v===null||v===undefined||v==="") return null;
  if(typeof v==="number") return isFinite(v)?v:null;
  const s=String(v).trim();
  let normal;
  if(s.includes(",")) normal=s.replace(/\./g,"").replace(",",".");          // 1.250.000,50
  else if(/^\d{1,3}(\.\d{3})+$/.test(s)) normal=s.replace(/\./g,"");        // 285.000 = 285 mil
  else normal=s;                                                            // 285000 ou 285000.50
  const n=Number(normal);
  return isFinite(n)?n:null;
}

/* Campo de dinheiro. A pessoa digita só os números e o campo formata sozinho —
   é como todo app brasileiro faz, e elimina a dúvida de onde vai ponto ou vírgula.
   Guardamos centavos internamente para não depender de como foi digitado. */
function CampoMoeda({valor,onChange,placeholder="0,00",isMobile}){
  const texto=valor===null||valor===undefined||valor===""?""
    :Number(valor).toLocaleString("pt-BR",{minimumFractionDigits:2,maximumFractionDigits:2});
  function digitou(e){
    const digitos=e.target.value.replace(/\D/g,"").slice(0,12);
    onChange(digitos===""?"":Number(digitos)/100);
  }
  return <div style={{display:"flex",alignItems:"center",gap:8,border:`1px solid ${C.line}`,background:C.surface,borderRadius:9,padding:"0 11px"}}>
    <span style={{color:C.faint,fontSize:14,fontWeight:600,flexShrink:0}}>R$</span>
    <input value={texto} onChange={digitou} inputMode="numeric" placeholder={placeholder}
      style={{flex:1,minWidth:0,border:"none",outline:"none",background:"transparent",fontSize:16,padding:"10px 0",color:C.ink,fontFamily:MONO,fontWeight:600}}/>
  </div>;
}
const entrada={width:"100%",fontSize:16,border:`1px solid ${C.line}`,borderRadius:9,padding:"10px 11px",outline:"none",background:C.surface,color:C.ink,fontFamily:FONT};

function FormularioProduto({produto,pessoas,equipeToda,acoes,isMobile,aoFechar}){
  const [f,setF]=useState(()=>produto?{...produto,modalidade:produto.modalidade||""}:{
    tipo:"casa",titulo:"",formato:"empreendimento",quartos:"",banheiros:"",construtor:"",valor:"",metragem:"",
    cidade:"",bairro:"",endereco:"",maps_url:"",modalidade:"",comissao_pct:"",captador_id:"",observacoes:"",
  });
  const [midias,setMidias]=useState(produto?produto.midias||[]:[]);
  const [id,setId]=useState(produto?produto.id:null);
  const [erro,setErro]=useState(""); const [salvando,setSalvando]=useState(false);
  const [subindo,setSubindo]=useState(false); const [progresso,setProgresso]=useState("");
  const set=(k)=>(e)=>setF({...f,[k]:e.target.type==="checkbox"?e.target.checked:e.target.value});
  const limites=LIMITE_MIDIA[f.tipo]||LIMITE_MIDIA.casa;
  const fotos=midias.filter(m=>m.tipo==="foto"), videos=midias.filter(m=>m.tipo==="video");

  async function salvar(){
    setErro(""); setSalvando(true);
    try{
      const salvo=await acoes.salvarProduto({...f,
        valor:numeroBR(f.valor), quartos:numeroBR(f.quartos), banheiros:numeroBR(f.banheiros),
        metragem:numeroBR(f.metragem), comissao_pct:numeroBR(f.comissao_pct)}, id);
      setId(salvo.id); setF({...salvo,modalidade:salvo.modalidade||""});
      if(!id) setErro(""); // agora dá para enviar as fotos
      return salvo.id;
    }catch(e){ setErro(e.message); return null; }
    finally{ setSalvando(false); }
  }

  /* Prepara a foto antes de subir. Resolve três coisas de uma vez:

     - foto de celular passa de 8 MB e batia no limite do servidor. Reduzida
       para 1920px, uma foto de imóvel fica em torno de 300 KB sem perder nada
       na tela nem no WhatsApp
     - iPhone entrega HEIC, que o servidor recusa ("formato não aceito"). O
       canvas devolve JPEG sempre, então o problema deixa de existir
     - upload no 4G do corretor, na rua, fica dez vezes mais rápido

     Vídeo passa direto: recodificar vídeo no navegador não vale a pena. Se
     algo der errado na conversão, manda o arquivo original — melhor tentar e
     o servidor recusar do que travar aqui. */
  const LADO_MAX=1920, QUALIDADE=0.82;
  async function prepararArquivo(arq){
    const cru=()=>new Promise((ok,falhou)=>{const fr=new FileReader();
      fr.onload=()=>ok({mime:arq.type,base64:fr.result});fr.onerror=falhou;fr.readAsDataURL(arq);});
    if(!String(arq.type||"").startsWith("image/")) return cru();
    try{
      const img=await new Promise((ok,falhou)=>{
        const el=new Image(); const url=URL.createObjectURL(arq);
        el.onload=()=>{URL.revokeObjectURL(url);ok(el);};
        el.onerror=()=>{URL.revokeObjectURL(url);falhou(new Error("não consegui abrir a imagem"));};
        el.src=url;
      });
      const escala=Math.min(1,LADO_MAX/Math.max(img.width,img.height));
      const c=document.createElement("canvas");
      c.width=Math.round(img.width*escala); c.height=Math.round(img.height*escala);
      const ctx=c.getContext("2d");
      // Fundo branco: PNG com transparência viraria fundo preto no JPEG.
      ctx.fillStyle="#fff"; ctx.fillRect(0,0,c.width,c.height);
      ctx.drawImage(img,0,0,c.width,c.height);
      const base64=c.toDataURL("image/jpeg",QUALIDADE);
      if(!base64||base64.length<100) throw new Error("conversão vazia");
      return {mime:"image/jpeg",base64};
    }catch(e){ return cru(); }
  }

  // Aceita vários arquivos de uma vez. Sobem em fila, um de cada vez: dez fotos
  // em paralelo derrubariam o servidor e o corretor não saberia qual falhou.
  async function enviarArquivo(ev){
    const arquivos=[...(ev.target.files||[])];
    ev.target.value="";
    if(!arquivos.length) return;

    /* As fotos precisam de um dono, então o produto é salvo antes.
       Se esse salvamento falhar, quem manda é a mensagem do servidor ("Informe
       o título", "Valor inválido"...). Antes ela era substituída por um
       "confira os dados" que não dizia O QUE conferir — o corretor escolhia as
       fotos, via um erro vago e não sabia onde mexer. */
    let alvo=id;
    if(!alvo){
      alvo=await salvar();
      if(!alvo){ setErro(e=>e||"Confira os dados do imóvel antes de enviar as fotos."); return; }
    }

    setSubindo(true); setErro("");
    const problemas=[];
    for(let i=0;i<arquivos.length;i++){
      const arq=arquivos[i];
      setProgresso(`Enviando ${i+1} de ${arquivos.length}…`);
      try{
        const {mime,base64}=await prepararArquivo(arq);
        const r=await acoes.subirMidia(alvo,mime,base64);
        setMidias(m=>[...m,r.midia]);
      }catch(e){
        problemas.push(`${arq.name}: ${e.message}`);
        // Limite atingido não adianta insistir com o resto da fila.
        if(/Limite de/.test(e.message)) break;
      }
    }
    setProgresso(""); setSubindo(false);
    if(problemas.length) setErro(problemas.length===1?problemas[0]
      :`${problemas.length} arquivo(s) não subiram:\n• ${problemas.join("\n• ")}`);
  }
  async function removerMidia(m){
    try{ await acoes.apagarMidia(id,m.id); setMidias(x=>x.filter(y=>y.id!==m.id)); }catch(e){ setErro(e.message); }
  }
  const comissao=numeroBR(f.valor)&&numeroBR(f.comissao_pct)?(numeroBR(f.valor)*numeroBR(f.comissao_pct))/100:null;

  return <div style={{height:"100%",overflowY:"auto",padding:isMobile?14:20}}>
    <div style={{maxWidth:640,margin:"0 auto"}}>
      <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:16}}>
        <button onClick={()=>aoFechar(false)} aria-label="Voltar" style={{width:34,height:34,borderRadius:10,border:"none",background:C.card,color:C.sub,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",transform:"scaleX(-1)"}}><Icon n="chevron" size={17}/></button>
        <div style={{fontFamily:DISPLAY,color:C.ink,fontSize:17,fontWeight:700}}>{id?"Editar produto":"Cadastrar produto"}</div>
      </div>
      {erro&&<div style={{background:C.hotSoft,color:C.hot,fontSize:12.5,borderRadius:10,padding:"10px 12px",marginBottom:12,whiteSpace:"pre-line",lineHeight:1.5}}>{erro}</div>}

      <div style={{background:C.card,border:`1px solid ${C.line}`,borderRadius:14,padding:16,display:"flex",flexDirection:"column",gap:13}}>
        <div>
          {rotulo("O que é")}
          <div style={{display:"flex",gap:8}}>
            {[["casa","Casa"],["terreno","Terreno"]].map(([v,t])=>
              <button key={v} onClick={()=>setF({...f,tipo:v})} style={{flex:1,padding:"11px",borderRadius:10,fontSize:14,fontWeight:600,cursor:"pointer",
                border:`1px solid ${f.tipo===v?C.green:C.line}`,background:f.tipo===v?C.greenSoft:C.surface,color:f.tipo===v?C.greenDeep:C.sub}}>{t}</button>)}
          </div>
        </div>

        {f.tipo==="casa"&&<div>
          {rotulo("Empreendimento ou casa solta")}
          <div style={{display:"flex",gap:8}}>
            {[["empreendimento","Empreendimento"],["solta","Casa solta"]].map(([v,t])=>
              <button key={v} onClick={()=>setF({...f,formato:v})} style={{flex:1,padding:"9px",borderRadius:10,fontSize:13,fontWeight:600,cursor:"pointer",
                border:`1px solid ${f.formato===v?C.green:C.line}`,background:f.formato===v?C.greenSoft:C.surface,color:f.formato===v?C.greenDeep:C.sub}}>{t}</button>)}
          </div>
        </div>}

        <div>{rotulo("Nome do produto")}<input value={f.titulo} onChange={set("titulo")} placeholder="Ex.: Casa 3 quartos no Jardim Amazonas" style={entrada}/></div>

        <div>{rotulo("Valor do imóvel")}<CampoMoeda valor={f.valor} onChange={v=>setF({...f,valor:v})} placeholder="285.000,00" isMobile={isMobile}/></div>
        <div style={{display:"grid",gridTemplateColumns:isMobile?"1fr 1fr":"repeat(3,1fr)",gap:10}}>
          <div>{rotulo("Terreno (m²)")}<input value={f.metragem} onChange={set("metragem")} inputMode="decimal" placeholder="200" style={entrada}/></div>
          {f.tipo==="casa"&&<React.Fragment>
            <div>{rotulo("Quartos")}<input value={f.quartos} onChange={set("quartos")} inputMode="numeric" placeholder="3" style={entrada}/></div>
            <div>{rotulo("Banheiros")}<input value={f.banheiros} onChange={set("banheiros")} inputMode="numeric" placeholder="2" style={entrada}/></div>
          </React.Fragment>}
        </div>

        {f.tipo==="casa"&&<div>{rotulo("Construtora")}<input value={f.construtor||""} onChange={set("construtor")} placeholder="Nome da construtora" style={entrada}/></div>}

        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10}}>
          <div>{rotulo("Cidade")}<input value={f.cidade||""} onChange={set("cidade")} placeholder="Petrolina" style={entrada}/></div>
          <div>{rotulo("Bairro")}<input value={f.bairro||""} onChange={set("bairro")} placeholder="Jardim Amazonas" style={entrada}/></div>
        </div>
        <div>{rotulo("Endereço")}<input value={f.endereco||""} onChange={set("endereco")} placeholder="Rua, número e referência" style={entrada}/></div>
        <div>
          {rotulo("Link do Google Maps")}
          <input value={f.maps_url||""} onChange={set("maps_url")} placeholder="https://maps.app.goo.gl/..." style={entrada}/>
          <div style={{color:C.faint,fontSize:11,marginTop:5,lineHeight:1.45}}>Abra o local no Maps, toque em Compartilhar e cole o link aqui. Vira um botão clicável na ficha.</div>
        </div>

        {/* Antes era uma caixinha "Morar Bem sim/não". Virou escolha entre as três
            modalidades reais da Conecta. Clicar na opção já marcada desmarca —
            imóvel sem programa definido continua sendo possível. */}
        <div>
          <div style={{color:C.sub,fontSize:12,fontWeight:600,marginBottom:6}}>Modalidade de financiamento</div>
          <div style={{display:"flex",gap:7,flexWrap:"wrap"}}>
            {MODALIDADES.map(m=>{
              const ativa=f.modalidade===m;
              return <button key={m} type="button" onClick={()=>setF({...f,modalidade:ativa?"":m})}
                style={{flex:"1 1 150px",fontSize:13,fontWeight:600,padding:"11px 12px",borderRadius:10,cursor:"pointer",
                  border:`1px solid ${ativa?C.green+"88":C.line}`,background:ativa?C.greenSoft:C.surface,
                  color:ativa?C.greenDeep:C.sub,display:"flex",alignItems:"center",justifyContent:"center",gap:6}}>
                {ativa&&<Icon n="check" size={13}/>}{m}</button>;
            })}
          </div>
          <div style={{color:C.faint,fontSize:11,marginTop:5}}>Opcional. Aparece na ficha e na apresentação enviada ao cliente.</div>
        </div>

        <div>
          {rotulo("Quem captou")}
          <select value={f.captador_id||""} onChange={set("captador_id")} style={entrada}>
            <option value="">Eu mesmo</option>
            {(equipeToda||pessoas).map(p=><option key={p.id} value={p.id}>{p.name}{p.role==="adm"?" (gestor)":p.role==="sdr"?" (atendente)":""}</option>)}
          </select>
          <div style={{color:C.faint,fontSize:11,marginTop:5}}>Aparece no catálogo para quem precisar falar sobre chaves e disponibilidade.</div>
        </div>

        <div>
          {rotulo("Comissão da venda (%)")}
          <input value={f.comissao_pct||""} onChange={set("comissao_pct")} inputMode="decimal" placeholder="6" style={entrada}/>
          {comissao!=null&&<div style={{background:C.surface,borderRadius:9,padding:"9px 11px",marginTop:7,fontSize:12,color:C.sub,lineHeight:1.6}}>
            Comissão total: <b style={{color:C.ink}}>{fmtMoeda(comissao)}</b><br/>
            Conecta (45%): {fmtMoeda(comissao*0.45)} · Corretor (55%): <b style={{color:C.greenDeep}}>{fmtMoeda(comissao*0.55)}</b>
          </div>}
        </div>

        <div>{rotulo("Observações")}<textarea value={f.observacoes||""} onChange={set("observacoes")} rows={3} placeholder="Prazo de entrega, condições, o que for útil ao cliente" style={{...entrada,resize:"vertical"}}/></div>

        <div>
          {rotulo(`Fotos (${fotos.length}/${limites.foto}) e vídeo (${videos.length}/${limites.video})`)}
          <div style={{display:"flex",gap:8,flexWrap:"wrap",marginBottom:9}}>
            {midias.map(m=><div key={m.id} style={{position:"relative",width:80,height:80,borderRadius:10,overflow:"hidden",border:`1px solid ${C.line}`,background:C.surface}}>
              {m.tipo==="foto"?<img src={m.url} alt="" style={{width:"100%",height:"100%",objectFit:"cover"}}/>
                :<div style={{width:"100%",height:"100%",display:"flex",alignItems:"center",justifyContent:"center",color:C.sub}}><Icon n="phone2" size={20}/></div>}
              <button onClick={()=>removerMidia(m)} aria-label="Remover" style={{position:"absolute",top:3,right:3,width:20,height:20,borderRadius:999,border:"none",background:"rgba(0,0,0,.6)",color:"#fff",fontSize:12,cursor:"pointer",lineHeight:1}}>×</button>
            </div>)}
          </div>
          <label style={{display:"inline-flex",alignItems:"center",gap:7,border:`1px dashed ${C.green}66`,background:C.greenSoft,color:C.greenMid,borderRadius:10,padding:"10px 14px",fontSize:13,fontWeight:600,cursor:subindo?"default":"pointer"}}>
            <Icon n={subindo?"loader":"userplus"} size={15} spin={subindo}/>{subindo?(progresso||"Enviando…"):"Adicionar fotos ou vídeo"}
            <input type="file" multiple accept="image/*,video/mp4,video/quicktime" onChange={enviarArquivo} disabled={subindo} style={{display:"none"}}/>
          </label>
          <div style={{color:C.faint,fontSize:11,marginTop:6,lineHeight:1.45}}>
            Dá para escolher várias de uma vez: segure <b>Ctrl</b> (ou <b>Cmd</b>) ao clicar, ou toque em "Selecionar" no celular.
            {!id&&" Ao enviar a primeira, o produto é salvo automaticamente."}
          </div>
        </div>

        <div style={{display:"flex",gap:8,borderTop:`1px solid ${C.line}`,paddingTop:13}}>
          <button onClick={async()=>{const r=await salvar();if(r)aoFechar(true);}} disabled={salvando}
            style={{flex:1,background:salvando?C.faint:C.green,color:"#fff",border:"none",borderRadius:10,padding:"13px",fontSize:14.5,fontWeight:600,cursor:salvando?"default":"pointer"}}>
            {salvando?"Salvando…":id?"Salvar alterações":"Cadastrar produto"}
          </button>
          <button onClick={()=>aoFechar(!!id)} style={{background:C.card,color:C.sub,border:`1px solid ${C.line}`,borderRadius:10,padding:"13px 18px",fontSize:14,cursor:"pointer"}}>Fechar</button>
        </div>
      </div>
    </div>
  </div>;
}

function DetalheProduto({produto:p,acoes,isMobile,supervisor,session,aoFechar,aoEditar,aoMudarSituacao,aoApagar}){
  const fotos=(p.midias||[]).filter(m=>m.tipo==="foto"), videos=(p.midias||[]).filter(m=>m.tipo==="video");
  const s=SITUACAO_PRODUTO[p.status]||SITUACAO_PRODUTO.ativo;
  const meu=p.created_by===session.id;
  const linha=(k,v)=>v?<div key={k} style={{display:"flex",justifyContent:"space-between",gap:12,padding:"8px 0",borderBottom:`1px solid ${C.line}`}}>
    <span style={{color:C.faint,fontSize:12}}>{k}</span><span style={{color:C.ink,fontSize:13,fontWeight:600,textAlign:"right"}}>{v}</span></div>:null;

  return <div style={{height:"100%",overflowY:"auto",padding:isMobile?14:20}}>
    <div style={{maxWidth:640,margin:"0 auto"}}>
      <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:14}}>
        <button onClick={aoFechar} aria-label="Voltar" style={{width:34,height:34,borderRadius:10,border:"none",background:C.card,color:C.sub,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",transform:"scaleX(-1)"}}><Icon n="chevron" size={17}/></button>
        <div style={{flex:1,minWidth:0}}>
          <div style={{fontFamily:DISPLAY,color:C.ink,fontSize:17,fontWeight:700,lineHeight:1.25}}>{p.titulo}</div>
          <div style={{color:C.faint,fontSize:12}}>{[p.bairro,p.cidade].filter(Boolean).join(" · ")}</div>
        </div>
        <Pill c={s.c} bg={s.bg}>{s.t}</Pill>
      </div>

      {fotos.length>0&&<div style={{display:"flex",gap:8,overflowX:"auto",paddingBottom:8,marginBottom:12}}>
        {fotos.map(m=><a key={m.id} href={m.url} target="_blank" rel="noreferrer" style={{flexShrink:0}}>
          <img src={m.url} alt="" style={{width:isMobile?220:240,height:160,objectFit:"cover",borderRadius:12,border:`1px solid ${C.line}`}}/></a>)}
      </div>}
      {videos.map(m=><video key={m.id} src={m.url} controls style={{width:"100%",borderRadius:12,marginBottom:12,background:"#000"}}/>)}

      <div style={{background:C.card,border:`1px solid ${C.line}`,borderRadius:14,padding:"4px 14px 14px",marginBottom:12}}>
        {linha("Valor",p.valor?fmtMoeda(p.valor):null)}
        {linha("Tipo",p.tipo==="casa"?(p.formato==="empreendimento"?"Casa em empreendimento":"Casa solta"):"Terreno")}
        {linha("Quartos",p.quartos)}
        {linha("Banheiros",p.banheiros)}
        {linha("Terreno",p.metragem?`${p.metragem} m²`:null)}
        {linha("Construtora",p.construtor)}
        {linha("Modalidade",p.modalidade||null)}
        {linha("Endereço",p.endereco)}
        {linha("Captado por",p.captador_nome)}
        {p.observacoes&&<div style={{paddingTop:10,color:C.sub,fontSize:13,lineHeight:1.6}}>{p.observacoes}</div>}
      </div>

      {p.maps_url&&<a href={p.maps_url} target="_blank" rel="noreferrer"
        style={{display:"flex",alignItems:"center",justifyContent:"center",gap:8,textDecoration:"none",background:C.greenSoft,border:`1px solid ${C.green}44`,color:C.greenMid,borderRadius:12,padding:"13px",fontSize:14,fontWeight:600,marginBottom:12}}>
        <Icon n="pin" size={16}/> Abrir no Google Maps
      </a>}

      {p.comissao&&<div style={{background:C.card,border:`1px solid ${C.line}`,borderRadius:14,padding:14,marginBottom:12}}>
        <div style={{color:C.ink,fontSize:13,fontWeight:700,marginBottom:8}}>Comissão da venda</div>
        <div style={{color:C.greenDeep,fontFamily:MONO,fontSize:20,fontWeight:700}}>{fmtMoeda(p.comissao.total)}</div>
        <div style={{color:C.sub,fontSize:12,marginTop:6,lineHeight:1.6}}>
          Conecta ({p.comissao.split.imobiliaria}%): {fmtMoeda(p.comissao.imobiliaria)}<br/>
          Corretor ({p.comissao.split.corretor}%): <b style={{color:C.greenDeep}}>{fmtMoeda(p.comissao.corretor)}</b>
        </div>
      </div>}

      <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
        {(supervisor||meu)&&<button onClick={aoEditar} style={{flex:1,minWidth:130,background:C.card,color:C.sub,border:`1px solid ${C.line}`,borderRadius:10,padding:"12px",fontSize:13.5,fontWeight:600,cursor:"pointer"}}>Editar</button>}
        {supervisor&&p.status==="aguardando_aprovacao"&&<React.Fragment>
          <button onClick={()=>{aoMudarSituacao(p,"ativo");aoFechar();}} style={{flex:1,minWidth:130,background:C.green,color:"#fff",border:"none",borderRadius:10,padding:"12px",fontSize:13.5,fontWeight:600,cursor:"pointer"}}>Aprovar</button>
          <button onClick={()=>{aoMudarSituacao(p,"recusado");aoFechar();}} style={{flex:1,minWidth:130,background:C.card,color:C.hot,border:`1px solid ${C.hot}55`,borderRadius:10,padding:"12px",fontSize:13.5,fontWeight:600,cursor:"pointer"}}>Recusar</button>
        </React.Fragment>}
        {supervisor&&p.status==="ativo"&&<button onClick={()=>{aoMudarSituacao(p,"vendido");aoFechar();}} style={{flex:1,minWidth:130,background:C.greenDeep,color:"#fff",border:"none",borderRadius:10,padding:"12px",fontSize:13.5,fontWeight:600,cursor:"pointer"}}>Marcar como vendido</button>}
      </div>
      {/* Excluir é só da gestão, e fica separado do resto para não ser clicado sem querer. */}
      {supervisor&&<div style={{borderTop:`1px solid ${C.line}`,marginTop:16,paddingTop:14}}>
        <button onClick={()=>aoApagar(p)} style={{width:"100%",display:"flex",alignItems:"center",justifyContent:"center",gap:7,background:C.card,color:C.hot,border:`1px solid ${C.hot}44`,borderRadius:10,padding:"12px",fontSize:13.5,fontWeight:600,cursor:"pointer"}}>
          Excluir este {p.tipo==="casa"?"imóvel":"terreno"} do catálogo
        </button>
        <div style={{color:C.faint,fontSize:11,textAlign:"center",marginTop:7,lineHeight:1.45}}>Apaga o cadastro e as fotos. Não dá para desfazer — se for só tirar do ar, use "Marcar como vendido".</div>
      </div>}
    </div>
  </div>;
}

/* ===== EQUIPE E APROVAÇÕES =====
   Corretor entra direto pelo link. Atendente e gestor param aqui esperando
   o aval — são papéis que enxergam a operação inteira. */
// Papel interno -> valor do formulário. Os dois nomes existem de propósito: o
// banco herdou adm/sdr, e a equipe fala gestor/atendente.
const PAPEL_PARA_FORM={corretor:"corretor",sdr:"atendente",adm:"gestor"};

const SELO_STATUS={
  aguardando_aprovacao:{t:"Aguardando sua aprovação",c:"#8a6d1f",bg:C.amberSoft},
  pendente:{t:"Não confirmou o e-mail",c:C.cool,bg:C.coolSoft},
  recusado:{t:"Acesso recusado",c:C.hot,bg:C.hotSoft},
  removido:{t:"Fora da equipe",c:C.hot,bg:C.hotSoft},
  ativo:{t:"Ativo",c:C.greenMid,bg:C.greenSoft},
};

/* Painel de saída: antes de desligar alguém, é preciso dizer para onde vão os
   leads em aberto dele. Sem isso, cliente fica esperando resposta de quem saiu. */
function PainelRemocao({alvo,candidatos,onConfirmar,onCancelar,isMobile}){
  const [destino,setDestino]=useState("");
  const temLeads=alvo.leads_abertos>0;
  return <div style={{background:C.hotSoft,border:`1px solid ${C.hot}44`,borderRadius:12,padding:13,marginTop:10}}>
    <div style={{color:C.ink,fontSize:13,fontWeight:700,marginBottom:6}}>Remover {first(alvo.name)} da equipe?</div>
    <div style={{color:C.sub,fontSize:12,lineHeight:1.5,marginBottom:temLeads?9:12}}>
      O acesso é encerrado na hora e a pessoa sai da catraca. O histórico de atendimento
      e as vendas dela continuam nos relatórios.
    </div>
    {temLeads&&<React.Fragment>
      <div style={{color:C.ink,fontSize:12.5,fontWeight:600,marginBottom:6}}>
        {alvo.leads_abertos} lead(s) em aberto — para onde vão?
      </div>
      <select value={destino} onChange={e=>setDestino(e.target.value)}
        style={{width:"100%",fontSize:isMobile?16:13,border:`1px solid ${C.line}`,borderRadius:9,padding:"9px 10px",marginBottom:12,background:C.card,color:C.ink,outline:"none"}}>
        <option value="">Voltar para a fila da catraca</option>
        {candidatos.map(p=><option key={p.id} value={p.id}>Passar para {p.name}</option>)}
      </select>
    </React.Fragment>}
    <div style={{display:"flex",gap:8}}>
      <button onClick={()=>onConfirmar(destino)} style={{flex:1,background:C.hot,color:"#fff",border:"none",borderRadius:9,padding:"10px",fontSize:13,fontWeight:600,cursor:"pointer"}}>Confirmar remoção</button>
      <button onClick={onCancelar} style={{background:C.card,color:C.sub,border:`1px solid ${C.line}`,borderRadius:9,padding:"10px 16px",fontSize:13,cursor:"pointer"}}>Cancelar</button>
    </div>
  </div>;
}

/* O link de nova senha, pronto para copiar e mandar no WhatsApp.

   Aparece uma vez só, logo depois de gerado. Não fica guardado em lugar
   nenhum da tela: quem entra com este link entra na conta da pessoa, então
   ele não pode ficar sobrando num painel que qualquer um abre depois. Se
   perder, é só gerar outro — e gerar outro derruba o anterior. */
function LinkNovaSenha({dados,isMobile,aoFechar}){
  const [copiado,setCopiado]=useState(false);
  const copiar=()=>{
    const texto=`Oi, ${first(dados.nome)}! Para criar uma senha nova no ConHub, abra este link: ${dados.link}`;
    const pronto=()=>{setCopiado(true);setTimeout(()=>setCopiado(false),2500);};
    // O clipboard moderno só existe em HTTPS; o método antigo cobre o resto.
    if(navigator.clipboard&&navigator.clipboard.writeText) navigator.clipboard.writeText(texto).then(pronto).catch(()=>{});
    else{ const a=document.createElement("textarea"); a.value=texto; document.body.appendChild(a); a.select();
      try{document.execCommand("copy");pronto();}catch(e){} document.body.removeChild(a); }
  };
  return <div style={{background:C.greenSoft,border:`1px solid ${C.green}44`,borderRadius:12,padding:12,marginTop:10}}>
    <div style={{color:C.greenDeep,fontSize:12.5,fontWeight:700,marginBottom:3}}>
      Link de nova senha para {first(dados.nome)}
    </div>
    <div style={{color:C.sub,fontSize:11.5,lineHeight:1.5,marginBottom:9}}>
      {dados.email_enviado
        ?<React.Fragment>Também foi por e-mail para <b>{dados.email}</b>. </React.Fragment>
        :<React.Fragment>O e-mail ainda não está ligado, então <b>mande você mesmo</b> no WhatsApp. </React.Fragment>}
      Vale por <b>{dados.horas} horas</b> e só pode ser usado uma vez.
    </div>
    <div style={{display:"flex",gap:8,flexDirection:isMobile?"column":"row"}}>
      <div style={{flex:1,minWidth:0,background:C.card,border:`1px solid ${C.line}`,borderRadius:9,
        padding:"9px 11px",fontSize:11.5,color:C.greenMid,wordBreak:"break-all"}}>{dados.link}</div>
      <div style={{display:"flex",gap:7,flexShrink:0}}>
        <button onClick={copiar} style={{flex:isMobile?1:"none",background:copiado?C.card:C.greenDeep,
          color:copiado?C.greenMid:"#fff",border:copiado?`1px solid ${C.green}55`:"none",borderRadius:9,
          padding:"9px 16px",fontSize:12.5,fontWeight:600,cursor:"pointer"}}>{copiado?"Copiado!":"Copiar recado"}</button>
        <button onClick={aoFechar} style={{background:C.card,color:C.sub,border:`1px solid ${C.line}`,
          borderRadius:9,padding:"9px 14px",fontSize:12.5,fontWeight:600,cursor:"pointer"}}>Fechar</button>
      </div>
    </div>
  </div>;
}

function Equipe({acoes,session,org,isMobile,versao}){
  const [users,setUsers]=useState(null);
  const [erro,setErro]=useState("");
  const [copiado,setCopiado]=useState(false);
  const [removendo,setRemovendo]=useState(null); // id de quem está no painel de saída
  const [gerando,setGerando]=useState(null);     // id de quem está tendo o link gerado
  const [senha,setSenha]=useState(null);         // {id, nome, link, ...} do link recém-criado

  useEffect(()=>{let vivo=true;
    acoes.equipe().then(u=>vivo&&setUsers(u)).catch(e=>vivo&&setErro(e.message));
    return()=>{vivo=false;};},[versao]);

  const decidir=async(id,acao)=>{ setErro("");
    try{ await acoes.decidirCadastro(id,acao); setUsers(await acoes.equipe()); }
    catch(e){ setErro(e.message); } };
  const remover=async(id,destino)=>{ setErro("");
    try{ await acoes.removerDaEquipe(id,destino); setRemovendo(null); setUsers(await acoes.equipe()); }
    catch(e){ setErro(e.message); setRemovendo(null); } };
  const trocarFuncao=async(id,funcao)=>{ setErro("");
    try{ await acoes.mudarFuncao(id,funcao); setUsers(await acoes.equipe()); }
    catch(e){ setErro(e.message); } };
  const novaSenha=async(u)=>{ setErro(""); setSenha(null); setGerando(u.id);
    try{ const r=await acoes.linkNovaSenha(u.id); setSenha({...r,id:u.id}); }
    catch(e){ setErro(e.message); }
    finally{ setGerando(null); } };
  const apagar=async(u)=>{ setErro("");
    if(!window.confirm(`Apagar o cadastro de ${u.name} definitivamente?\n\nIsso não pode ser desfeito. As conversas antigas continuam guardadas, mas o cadastro some da plataforma.`)) return;
    try{ await acoes.apagarCadastro(u.id); setUsers(await acoes.equipe()); }
    catch(e){ setErro(e.message); } };
  const codigo=org&&org.codigo;
  const CADASTRO_URL=linkDeCadastro(codigo);
  const copiar=()=>{ navigator.clipboard.writeText(CADASTRO_URL).then(()=>{setCopiado(true);setTimeout(()=>setCopiado(false),2200);}).catch(()=>{}); };

  if(!users) return <div style={{height:"100%",display:"flex",alignItems:"center",justifyContent:"center",color:C.faint,fontSize:13,gap:8}}><Icon n="loader" size={16} spin/> Carregando a equipe…</div>;

  const aguardando=users.filter(u=>u.status==="aguardando_aprovacao");
  const resto=users.filter(u=>u.status!=="aguardando_aprovacao");
  const corDe=(id)=>COLORS[[...id].reduce((s,c)=>s+c.charCodeAt(0),0)%COLORS.length];

  // Um gestor só é mexido por outro gestor; ninguém se remove sozinho.
  const podeMexer=(u)=>u.id!==session.id&&(u.role!=="adm"||session.role==="adm");
  const candidatos=(u)=>users.filter(p=>p.status==="ativo"&&p.id!==u.id&&(p.role==="corretor"||p.role==="sdr"));

  const cartao=(u,comBotoes)=><div key={u.id} style={{background:C.card,border:`1px solid ${comBotoes?C.amber+"55":C.line}`,borderRadius:14,padding:13}}>
    <div style={{display:"flex",alignItems:"center",gap:12,flexWrap:"wrap"}}>
      <Avatar ini={initials(u.name)} color={u.role==="adm"?C.greenDeep:corDe(u.id)} size={38} foto={u.avatar_url}/>
      <div style={{flex:1,minWidth:150}}>
        <div style={{color:C.ink,fontSize:14,fontWeight:600}}>{u.name}{u.id===session.id&&<span style={{color:C.faint,fontWeight:500}}> · você</span>}</div>
        <div style={{color:C.faint,fontSize:11.5}}>{u.email}{u.phone?" · "+fmtTel(u.phone):""}</div>
        <div style={{display:"flex",gap:6,marginTop:5,flexWrap:"wrap"}}>
          <Pill c={C.sub} bg={C.surface}>{u.funcao}</Pill>
          <Pill c={SELO_STATUS[u.status].c} bg={SELO_STATUS[u.status].bg}>{SELO_STATUS[u.status].t}</Pill>
          {u.status==="ativo"&&u.role!=="adm"&&<Pill c={u.available?C.greenMid:C.faint} bg={u.available?C.greenSoft:C.coolSoft}>{u.available?"disponível hoje":"indisponível"}</Pill>}
          {u.status==="ativo"&&u.leads_abertos>0&&<Pill c={C.cool} bg={C.coolSoft}>{u.leads_abertos} lead(s) em aberto</Pill>}
        </div>
      </div>
      {comBotoes&&<div style={{display:"flex",gap:7,flexShrink:0,width:isMobile?"100%":"auto"}}>
        <button onClick={()=>decidir(u.id,"aprovar")} style={{flex:isMobile?1:"none",background:C.green,color:"#fff",border:"none",borderRadius:9,padding:"9px 16px",fontSize:13,fontWeight:600,cursor:"pointer"}}>Aprovar</button>
        <button onClick={()=>decidir(u.id,"recusar")} style={{flex:isMobile?1:"none",background:C.card,color:C.hot,border:`1px solid ${C.hot}55`,borderRadius:9,padding:"9px 16px",fontSize:13,fontWeight:600,cursor:"pointer"}}>Recusar</button>
      </div>}
      {comBotoes&&<div style={{width:"100%",color:C.sub,fontSize:11.5,lineHeight:1.4}}>Confira a função antes de aprovar — dá para corrigir no seletor acima.</div>}
      {podeMexer(u)&&<div style={{display:"flex",gap:7,flexShrink:0,alignItems:"center",flexWrap:"wrap"}}>
        {/* Trocar a função vale em qualquer estado — inclusive antes de aprovar. */}
        {/* O banco guarda corretor/sdr/adm; o seletor fala corretor/atendente/gestor.
            Sem essa tradução, quem é sdr aparecia como "Corretor(a)" na caixinha. */}
        {u.status!=="removido"&&<select value={PAPEL_PARA_FORM[u.role]||"corretor"} onChange={e=>trocarFuncao(u.id,e.target.value)} title="Mudar a função"
          style={{fontSize:isMobile?16:12,fontWeight:600,color:C.sub,background:C.surface,border:`1px solid ${C.line}`,borderRadius:9,padding:"7px 9px",outline:"none",cursor:"pointer"}}>
          <option value="corretor">Corretor(a)</option>
          <option value="atendente">Atendente</option>
          {session.role==="adm"&&<option value="gestor">Gestor(a)</option>}
        </select>}
        {/* Esqueceu a senha: só o gestor gera, porque com este link se entra na
            conta da pessoa. Enquanto o e-mail não está ligado, é a única saída. */}
        {session.role==="adm"&&u.status!=="removido"&&u.status!=="recusado"&&u.id!==session.id&&
          <button onClick={()=>novaSenha(u)} disabled={gerando===u.id} title="Gerar link para a pessoa criar uma senha nova"
            style={{background:C.surface,color:C.greenDeep,border:`1px solid ${C.green}55`,borderRadius:9,padding:"7px 13px",fontSize:12,fontWeight:600,cursor:"pointer",display:"flex",alignItems:"center",gap:5}}>
            <Icon n={gerando===u.id?"loader":"link"} size={12} spin={gerando===u.id}/>{gerando===u.id?"Gerando…":"Nova senha"}</button>}
        {!comBotoes&&u.status==="ativo"&&<button onClick={()=>setRemovendo(removendo===u.id?null:u.id)} style={{background:C.card,color:C.hot,border:`1px solid ${C.hot}44`,borderRadius:9,padding:"7px 13px",fontSize:12,fontWeight:600,cursor:"pointer"}}>Remover</button>}
        {!comBotoes&&u.status==="removido"&&<React.Fragment>
          <button onClick={()=>decidir(u.id,"aprovar")} style={{background:C.surface,color:C.greenMid,border:`1px solid ${C.line}`,borderRadius:9,padding:"7px 13px",fontSize:12,fontWeight:600,cursor:"pointer"}}>Reativar</button>
          {session.role==="adm"&&<button onClick={()=>apagar(u)} title="Apagar definitivamente" style={{background:C.hotSoft,color:C.hot,border:`1px solid ${C.hot}44`,borderRadius:9,padding:"7px 11px",fontSize:12,fontWeight:600,cursor:"pointer"}}>Apagar de vez</button>}
        </React.Fragment>}
        {!comBotoes&&u.status==="recusado"&&<button onClick={()=>decidir(u.id,"aprovar")} style={{background:C.surface,color:C.greenMid,border:`1px solid ${C.line}`,borderRadius:9,padding:"7px 13px",fontSize:12,fontWeight:600,cursor:"pointer"}}>Liberar</button>}
      </div>}
    </div>
    {removendo===u.id&&<PainelRemocao alvo={u} candidatos={candidatos(u)} isMobile={isMobile}
      onConfirmar={(destino)=>remover(u.id,destino)} onCancelar={()=>setRemovendo(null)}/>}
    {senha&&senha.id===u.id&&<LinkNovaSenha dados={senha} isMobile={isMobile} aoFechar={()=>setSenha(null)}/>}
  </div>;

  return <div style={{height:"100%",overflowY:"auto",padding:isMobile?14:20}}>
    <div style={{maxWidth:760,margin:"0 auto"}}>
      {erro&&<div style={{background:C.hotSoft,color:C.hot,fontSize:12.5,borderRadius:10,padding:"10px 12px",marginBottom:14}}>{erro}</div>}

      <div style={{background:C.card,border:`1px solid ${C.line}`,borderRadius:14,padding:14,marginBottom:16}}>
        <div style={{color:C.ink,fontSize:13,fontWeight:700,marginBottom:6,display:"flex",alignItems:"center",gap:7}}><Icon n="link" size={14} color={C.green}/> Link de cadastro da equipe</div>
        <div style={{color:C.sub,fontSize:12,lineHeight:1.5,marginBottom:9}}>Mande este link no grupo. Corretor entra direto; atendente e gestor aparecem aqui para você aprovar.</div>
        <div style={{display:"flex",gap:8,flexDirection:isMobile?"column":"row"}}>
          <div style={{flex:1,minWidth:0,background:C.surface,border:`1px solid ${C.line}`,borderRadius:9,padding:"9px 11px",fontSize:11.5,color:C.greenMid,wordBreak:"break-all"}}>{CADASTRO_URL}</div>
          <button onClick={copiar} style={{background:copiado?C.greenSoft:C.greenDeep,color:copiado?C.greenMid:"#fff",border:"none",borderRadius:9,padding:"10px 16px",fontSize:12.5,fontWeight:600,cursor:"pointer",flexShrink:0}}>{copiado?"Copiado!":"Copiar"}</button>
        </div>
      </div>

      {/* Disponibilidade da equipe: é aqui que o gestor cobra quem não se
          prontificou e ajusta o horário em que a prontidão é encerrada. */}
      <div style={{marginBottom:18}}>
        <HistoricoDisponibilidade acoes={acoes} isMobile={isMobile} podeConfigurar={session.role==="adm"}/>
      </div>

      {aguardando.length>0&&<div style={{marginBottom:18}}>
        <div style={{color:C.ink,fontSize:13,fontWeight:700,marginBottom:10,display:"flex",alignItems:"center",gap:7}}>
          <span style={{minWidth:20,height:20,padding:"0 6px",borderRadius:999,background:C.hot,color:"#fff",fontSize:11,fontWeight:700,display:"flex",alignItems:"center",justifyContent:"center"}}>{aguardando.length}</span>
          Aguardando sua aprovação
        </div>
        <div style={{display:"flex",flexDirection:"column",gap:10}}>{aguardando.map(u=>cartao(u,true))}</div>
      </div>}

      <div style={{color:C.ink,fontSize:13,fontWeight:700,marginBottom:10}}>Equipe ({resto.length})</div>
      <div style={{display:"flex",flexDirection:"column",gap:10}}>
        {resto.length===0&&<div style={{color:C.faint,fontSize:13,textAlign:"center",padding:24}}>Ninguém cadastrado ainda.</div>}
        {resto.map(u=>cartao(u,false))}
      </div>
    </div>
  </div>;
}

/* ===== CONFIGURAÇÕES =====

   Duas seções, com donos diferentes de propósito:

   - MENSAGENS AUTOMÁTICAS: gestor E atendente. É texto de abordagem, muda toda
     semana conforme o que converte, e quem sabe isso é quem atende.
   - CONEXÃO: só leitura para a atendente, mexida só pelo gestor. Desconectar
     derruba o WhatsApp da imobiliária inteira. */
function Configuracoes({acoes,session,isMobile,aoMudarMensagens}){
  const [aba,setAba]=useState("mensagens");
  const abas=[["mensagens","Mensagens automáticas"],["conexao","Conexão"],["ia","Uso da IA"]];
  return <div style={{height:"100%",overflowY:"auto",padding:isMobile?14:20}}>
    <div style={{maxWidth:760,margin:"0 auto"}}>
      <div style={{display:"flex",gap:6,marginBottom:16,flexWrap:"wrap"}}>
        {abas.map(([k,t])=><button key={k} onClick={()=>setAba(k)}
          style={{fontSize:12.5,fontWeight:600,padding:"8px 15px",borderRadius:999,border:"none",cursor:"pointer",
            background:aba===k?C.greenDeep:C.card,color:aba===k?"#fff":C.sub}}>{t}</button>)}
      </div>
      {aba==="mensagens"&&<MensagensAutomaticas acoes={acoes} isMobile={isMobile} aoMudar={aoMudarMensagens}/>}
      {aba==="conexao"&&<ConexaoConfig acoes={acoes} session={session} isMobile={isMobile}/>}
      {aba==="ia"&&<UsoDaIA acoes={acoes} isMobile={isMobile}/>}
    </div>
  </div>;
}

/* O formulário de uma mensagem rápida.

   Ele é um componente à parte porque aparece em dois lugares: no alto da tela
   quando é uma mensagem NOVA, e dentro do próprio cartão quando é uma edição.
   Antes o formulário abria sempre no alto — clicar em "Editar" na quarta
   mensagem obrigava a rolar a tela para cima para achar o campo, e ninguém
   sabia qual das quatro estava sendo editada. */
function FormMensagem({novo,titulo,setTitulo,corpo,setCorpo,erro,salvando,isMobile,aoSalvar,aoCancelar}){
  /* O formulário é mais alto que o cartão que ele substitui: se ele abre no pé
     da tela, o botão Salvar nasce fora dela. Este empurrãozinho é o mínimo
     para o formulário inteiro caber — quem já estava vendo tudo não sente. */
  const fim=useRef(null);
  useEffect(()=>{ fim.current&&fim.current.scrollIntoView({block:"nearest",behavior:"smooth"}); },[]);
  const rotulo={color:C.faint,fontSize:10.5,fontWeight:600,textTransform:"uppercase",letterSpacing:.5};
  const campo={width:"100%",boxSizing:"border-box",marginTop:4,fontSize:isMobile?16:13,
    border:`1px solid ${C.line}`,background:C.surface,borderRadius:9,padding:"9px 11px",color:C.ink,outline:"none"};
  return <React.Fragment>
    <div style={{color:C.greenDeep,fontSize:13,fontWeight:700,marginBottom:9}}>
      {novo?"Nova mensagem":"Editando a mensagem"}</div>
    <label style={rotulo}>Nome do botão</label>
    <input value={titulo} onChange={e=>setTitulo(e.target.value)} maxLength={40} placeholder="Ex.: Follow-up"
      autoFocus style={{...campo,marginBottom:10}}/>
    <label style={rotulo}>Texto da mensagem</label>
    <textarea value={corpo} onChange={e=>setCorpo(e.target.value)} rows={5} maxLength={1200}
      placeholder="Oi {nome}, tudo bem?" style={{...campo,marginBottom:4,resize:"vertical",fontFamily:FONT}}/>
    <div style={{color:C.faint,fontSize:10.5,marginBottom:10}}>{corpo.length}/1200</div>
    {erro&&<div style={{background:C.hotSoft,color:C.hot,fontSize:12,borderRadius:9,padding:"8px 10px",marginBottom:10}}>{erro}</div>}
    <div ref={fim} style={{display:"flex",gap:7,flexWrap:"wrap"}}>
      <button onClick={aoSalvar} disabled={salvando||!titulo.trim()||!corpo.trim()}
        style={{background:titulo.trim()&&corpo.trim()?C.greenDeep:C.faint,color:"#fff",border:"none",borderRadius:9,
          padding:"9px 16px",fontSize:12.5,fontWeight:700,cursor:"pointer"}}>{salvando?"Salvando…":"Salvar"}</button>
      <button onClick={aoCancelar} disabled={salvando}
        style={{background:C.card,color:C.sub,border:`1px solid ${C.line}`,borderRadius:9,padding:"9px 14px",fontSize:12.5,fontWeight:600,cursor:"pointer"}}>Cancelar</button>
    </div>
  </React.Fragment>;
}

function MensagensAutomaticas({acoes,isMobile,aoMudar}){
  const [lista,setLista]=useState(null);
  const [erro,setErro]=useState("");
  const [editando,setEditando]=useState(null);   // id ou "nova"
  const [titulo,setTitulo]=useState("");
  const [corpo,setCorpo]=useState("");
  const [salvando,setSalvando]=useState(false);
  const [apagando,setApagando]=useState(null);

  const aplicar=(r)=>{ setLista(r.mensagens); aoMudar&&aoMudar(); };
  useEffect(()=>{acoes.mensagensRapidas(true).then(r=>setLista(r.mensagens)).catch(e=>setErro(e.message));},[]);

  const abrir=(m)=>{ setEditando(m?m.id:"nova"); setTitulo(m?m.titulo:""); setCorpo(m?m.corpo:""); setErro(""); };
  async function salvar(){
    if(!titulo.trim()||!corpo.trim()||salvando) return;
    setSalvando(true); setErro("");
    try{
      const r=editando==="nova"
        ? await acoes.criarMensagem({titulo,corpo})
        : await acoes.editarMensagem2(editando,{titulo,corpo});
      aplicar(r); setEditando(null);
    }catch(e){ setErro(e.message); } finally{ setSalvando(false); }
  }
  const acao=async(fn)=>{ setErro(""); try{ aplicar(await fn()); }catch(e){ setErro(e.message); } };

  if(!lista) return <div style={{color:C.faint,fontSize:13,padding:20,textAlign:"center"}}>Carregando…</div>;

  return <React.Fragment>
    <div style={{background:C.card,border:`1px solid ${C.line}`,borderRadius:14,padding:isMobile?13:16,marginBottom:14}}>
      <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:4,flexWrap:"wrap"}}>
        <Icon n="zap" size={15} color={C.greenMid}/>
        <span style={{color:C.ink,fontSize:13.5,fontWeight:700,flex:1}}>Mensagens automáticas</span>
        <button onClick={()=>abrir(null)}
          style={{background:C.greenDeep,color:"#fff",border:"none",borderRadius:9,padding:"8px 14px",fontSize:12.5,fontWeight:600,cursor:"pointer"}}>
          + Nova mensagem</button>
      </div>
      <div style={{color:C.faint,fontSize:11.5,lineHeight:1.55}}>
        São os botões que aparecem acima do campo de conversa. Escreva <b style={{color:C.sub}}>{"{nome}"}</b> onde
        o primeiro nome do cliente deve entrar. Desligar guarda o texto sem mostrar na conversa.
      </div>
    </div>

    {/* Erro que não é de formulário (ligar/desligar, mover, apagar). O erro de
        quem está editando aparece dentro do próprio formulário. */}
    {erro&&!editando&&<div style={{background:C.hotSoft,color:C.hot,fontSize:12.5,borderRadius:10,padding:"10px 12px",marginBottom:12}}>{erro}</div>}

    {/* Mensagem nova não tem cartão ainda, então nasce aqui em cima. */}
    {editando==="nova"&&<div style={{background:C.card,border:`1px solid ${C.green}55`,borderRadius:14,padding:14,marginBottom:14}}>
      <FormMensagem novo {...{titulo,setTitulo,corpo,setCorpo,erro,salvando,isMobile}}
        aoSalvar={salvar} aoCancelar={()=>{setEditando(null);setErro("");}}/>
    </div>}

    <div style={{display:"flex",flexDirection:"column",gap:9}}>
      {lista.length===0&&<div style={{color:C.faint,fontSize:13,textAlign:"center",padding:20}}>Nenhuma mensagem cadastrada.</div>}
      {lista.map((m,i)=>editando===m.id
        /* Editar abre AQUI, no lugar do cartão: o campo nasce onde o dedo
           clicou, sem rolar a tela e sem dúvida sobre qual texto está mudando. */
        ?<div key={m.id} style={{background:C.card,border:`1px solid ${C.green}55`,borderRadius:12,padding:isMobile?12:14}}>
          <FormMensagem {...{titulo,setTitulo,corpo,setCorpo,erro,salvando,isMobile}}
            aoSalvar={salvar} aoCancelar={()=>{setEditando(null);setErro("");}}/>
        </div>
        :<div key={m.id} style={{background:C.card,border:`1px solid ${C.line}`,borderRadius:12,
        padding:isMobile?12:14,opacity:m.ativo?1:.6}}>
        <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:5,flexWrap:"wrap"}}>
          <Icon n="zap" size={12} color={m.ativo?C.greenMid:C.faint}/>
          <span style={{color:C.ink,fontSize:13,fontWeight:700,flex:1,minWidth:0}}>{m.titulo}</span>
          {!m.ativo&&<span style={{background:C.coolSoft,color:C.cool,fontSize:10,fontWeight:700,padding:"2px 8px",borderRadius:999}}>desligada</span>}
        </div>
        <div style={{color:C.sub,fontSize:12,lineHeight:1.5,marginBottom:9,whiteSpace:"pre-wrap"}}>{m.corpo}</div>
        <div style={{display:"flex",gap:6,flexWrap:"wrap"}}>
          <button onClick={()=>abrir(m)} style={{background:C.surface,color:C.greenDeep,border:`1px solid ${C.green}44`,borderRadius:8,padding:"6px 12px",fontSize:11.5,fontWeight:600,cursor:"pointer"}}>Editar</button>
          <button onClick={()=>acao(()=>acoes.editarMensagem2(m.id,{ativo:!m.ativo}))}
            style={{background:C.card,color:C.sub,border:`1px solid ${C.line}`,borderRadius:8,padding:"6px 12px",fontSize:11.5,fontWeight:600,cursor:"pointer"}}>
            {m.ativo?"Desligar":"Ligar"}</button>
          <button onClick={()=>acao(()=>acoes.moverMensagem(m.id,"cima"))} disabled={i===0} title="Subir"
            style={{background:C.card,color:i===0?C.line:C.sub,border:`1px solid ${C.line}`,borderRadius:8,padding:"6px 10px",fontSize:11.5,fontWeight:600,cursor:i===0?"default":"pointer"}}>↑</button>
          <button onClick={()=>acao(()=>acoes.moverMensagem(m.id,"baixo"))} disabled={i===lista.length-1} title="Descer"
            style={{background:C.card,color:i===lista.length-1?C.line:C.sub,border:`1px solid ${C.line}`,borderRadius:8,padding:"6px 10px",fontSize:11.5,fontWeight:600,cursor:i===lista.length-1?"default":"pointer"}}>↓</button>
          <span style={{flex:1}}/>
          {apagando===m.id
            ?<React.Fragment>
              <span style={{color:C.hot,fontSize:11.5,alignSelf:"center"}}>apagar de vez?</span>
              <button onClick={()=>{setApagando(null);acao(()=>acoes.apagarMensagem(m.id));}}
                style={{background:C.hot,color:"#fff",border:"none",borderRadius:8,padding:"6px 12px",fontSize:11.5,fontWeight:700,cursor:"pointer"}}>Sim</button>
              <button onClick={()=>setApagando(null)}
                style={{background:C.card,color:C.sub,border:`1px solid ${C.line}`,borderRadius:8,padding:"6px 12px",fontSize:11.5,fontWeight:600,cursor:"pointer"}}>Não</button>
            </React.Fragment>
            :<button onClick={()=>setApagando(m.id)}
              style={{background:C.card,color:C.hot,border:`1px solid ${C.hot}33`,borderRadius:8,padding:"6px 12px",fontSize:11.5,fontWeight:600,cursor:"pointer"}}>Apagar</button>}
        </div>
      </div>)}
    </div>
  </React.Fragment>;
}

/* Conexão do WhatsApp: qual provedor, como está, e como contratar.

   O tutorial fica DENTRO da ferramenta de propósito. Quem assina o ConHub não
   tem obrigação de saber o que é Uazapi — e mandar o cliente "procurar no
   site deles" é onde a instalação para. */

/* ===== USO DA IA =====

   A pergunta de quem paga a conta é dupla: "quanto já gastamos" e "quem usou".
   A segunda não é vigilância — é como se descobre que o recurso está parado
   (ninguém clicou) ou que uma pessoa carrega o time sozinha.

   Uma coisa esta tela NÃO mostra: o saldo da conta de IA. Ele vive no painel
   do provedor e o CRM não tem como consultá-lo. Dizer isso é melhor do que
   exibir um número que não é o saldo e deixar a gestão achar que é. */
function UsoDaIA({acoes,isMobile}){
  const [d,setD]=useState(null);
  const [dias,setDias]=useState(30);
  const [erro,setErro]=useState("");
  useEffect(()=>{let vivo=true; setD(null);
    acoes.usoDaIA(dias).then(r=>vivo&&setD(r)).catch(e=>vivo&&setErro(e.message));
    return()=>{vivo=false;};},[dias]);

  // Dólar aproximado só para dar noção de grandeza; o número exato é o de lá.
  const emReais=(usd)=>`R$ ${(usd*5.4).toLocaleString("pt-BR",{minimumFractionDigits:2,maximumFractionDigits:2})}`;

  if(erro) return <div style={{background:C.hotSoft,color:C.hot,fontSize:12.5,borderRadius:10,padding:"10px 12px"}}>{erro}</div>;
  if(!d) return <div style={{color:C.faint,fontSize:13,padding:20,textAlign:"center"}}>Carregando…</div>;

  if(!d.configurada) return <div style={{background:C.card,border:`1px solid ${C.line}`,borderRadius:14,padding:isMobile?14:18}}>
    <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:5}}>
      <Icon n="sparkles" size={15} color={C.faint}/>
      <span style={{color:C.ink,fontSize:13.5,fontWeight:700}}>IA não configurada</span>
    </div>
    <div style={{color:C.sub,fontSize:12,lineHeight:1.55}}>
      Sem a chave da IA, o resumo da conversa e a leitura do print da Caixa ficam escondidos e nada é gasto.
    </div>
  </div>;

  const cartao=(rot,valor,sub)=><div style={{flex:"1 1 150px",background:C.card,border:`1px solid ${C.line}`,borderRadius:12,padding:12}}>
    <div style={{color:C.faint,fontSize:10.5,fontWeight:600,textTransform:"uppercase",letterSpacing:.5}}>{rot}</div>
    <div style={{fontFamily:MONO,color:C.ink,fontSize:19,fontWeight:700,lineHeight:1.2,marginTop:3}}>{valor}</div>
    {sub&&<div style={{color:C.faint,fontSize:10.5,marginTop:2}}>{sub}</div>}
  </div>;

  return <React.Fragment>
    {/* O saldo não é nosso para mostrar — dizemos onde ele está. */}
    <div style={{background:C.amberSoft,color:"#8a6d1f",fontSize:11.5,lineHeight:1.55,borderRadius:11,padding:"10px 12px",marginBottom:14}}>
      <b>O saldo da conta não fica aqui.</b> Este painel mostra o que o CRM <b>gastou</b>. O crédito que resta
      aparece no painel do provedor de IA (console.anthropic.com → Billing) — o CRM não consegue consultá-lo.
    </div>

    <div style={{display:"flex",gap:6,marginBottom:12,flexWrap:"wrap"}}>
      {[[7,"7 dias"],[30,"30 dias"],[90,"90 dias"]].map(([n,t])=>
        <button key={n} onClick={()=>setDias(n)}
          style={{fontSize:11.5,fontWeight:600,padding:"6px 12px",borderRadius:999,cursor:"pointer",
            border:dias===n?"none":`1px solid ${C.line}`,background:dias===n?C.greenDeep:C.card,color:dias===n?"#fff":C.sub}}>{t}</button>)}
    </div>

    <div style={{display:"flex",gap:10,flexWrap:"wrap",marginBottom:14}}>
      {cartao("Usos no período",d.total.usos,`${d.total.entrada+d.total.saida} tokens`)}
      {cartao("Gasto no período",emReais(d.total.custo),`US$ ${d.total.custo.toFixed(4)}`)}
      {cartao("Hoje",d.hoje.usos,emReais(d.hoje.custo))}
      {cartao("Desde o início",d.sempre.usos,emReais(d.sempre.custo))}
    </div>

    <div style={{background:C.card,border:`1px solid ${C.line}`,borderRadius:14,padding:isMobile?13:16,marginBottom:14}}>
      <div style={{color:C.ink,fontSize:13,fontWeight:700,marginBottom:9,display:"flex",alignItems:"center",gap:7}}>
        <Icon n="users" size={14} color={C.greenMid}/> Quem usou</div>
      {d.por_pessoa.length===0
        ?<div style={{color:C.faint,fontSize:12.5,lineHeight:1.5}}>Ninguém usou a IA neste período. Se o recurso é útil, vale lembrar a equipe de que ele existe.</div>
        :<div style={{display:"flex",flexDirection:"column",gap:8}}>
          {d.por_pessoa.map((p,i)=><div key={i} style={{display:"flex",alignItems:"center",gap:9,flexWrap:"wrap"}}>
            <Avatar ini={initials(p.nome)} color={COLORS[i%COLORS.length]} size={26}/>
            <div style={{flex:1,minWidth:100}}>
              <div style={{color:C.ink,fontSize:12.5,fontWeight:600}}>{p.nome}</div>
              <div style={{color:C.faint,fontSize:10.5}}>{roleParaTexto(p.papel)} · último uso {fmtData(p.ultimo)}</div>
            </div>
            <div style={{textAlign:"right"}}>
              <div style={{fontFamily:MONO,color:C.ink,fontSize:13,fontWeight:700}}>{p.usos}</div>
              <div style={{color:C.faint,fontSize:10.5}}>{emReais(p.custo)}</div>
            </div>
          </div>)}
        </div>}
    </div>

    <div style={{background:C.card,border:`1px solid ${C.line}`,borderRadius:14,padding:isMobile?13:16}}>
      <div style={{color:C.ink,fontSize:13,fontWeight:700,marginBottom:9,display:"flex",alignItems:"center",gap:7}}>
        <Icon n="chart" size={14} color={C.greenMid}/> Em que foi usado</div>
      {d.por_recurso.length===0
        ?<div style={{color:C.faint,fontSize:12.5}}>Nada ainda.</div>
        :d.por_recurso.map((x,i)=><div key={i} style={{display:"flex",alignItems:"center",gap:8,padding:"5px 0",borderTop:i?`1px solid ${C.line}`:"none"}}>
          <span style={{color:C.ink,fontSize:12.5,flex:1}}>{x.rotulo}</span>
          <span style={{fontFamily:MONO,color:C.sub,fontSize:12}}>{x.usos}</span>
          <span style={{color:C.faint,fontSize:11,minWidth:70,textAlign:"right"}}>{emReais(x.custo)}</span>
        </div>)}
      <div style={{color:C.faint,fontSize:10.5,marginTop:10,lineHeight:1.5}}>
        Modelo em uso: <b style={{color:C.sub}}>{d.modelo}</b>.
        {d.preco_conhecido
          ?" Os valores são calculados pelo preço de tabela no momento de cada uso, convertidos por um dólar aproximado."
          :" O preço deste modelo não está na tabela do CRM, então o gasto aparece como zero — os tokens continuam certos."}
      </div>
    </div>
  </React.Fragment>;
}

function ConexaoConfig({acoes,session,isMobile}){
  const [d,setD]=useState(null);
  const [erro,setErro]=useState("");
  const [tutorial,setTutorial]=useState(false);
  const [confirmando,setConfirmando]=useState(false);
  const [palavra,setPalavra]=useState("");
  const [saindo,setSaindo]=useState(false);
  const [copiado,setCopiado]=useState(false);
  /* Ligar a instância DESTA imobiliária. Antes o endereço e o token viviam no
     servidor e valiam para todas — a imobiliária nova abria esta tela e via o
     WhatsApp da vizinha como se fosse dela. */
  const [ligando,setLigando]=useState(false);
  const [cred,setCred]=useState({host:"",token:""});
  const [salvandoCred,setSalvandoCred]=useState(false);
  const [avisoCred,setAvisoCred]=useState("");
  const ehGestor=session.role==="adm";

  const rever=()=>acoes.conexao().then(setD).catch(e=>setErro(e.message));
  useEffect(()=>{rever();},[]);

  const copiar=(t)=>{
    const pronto=()=>{setCopiado(true);setTimeout(()=>setCopiado(false),2200);};
    if(navigator.clipboard&&navigator.clipboard.writeText) navigator.clipboard.writeText(t).then(pronto).catch(()=>{});
    else{const a=document.createElement("textarea");a.value=t;document.body.appendChild(a);a.select();
      try{document.execCommand("copy");pronto();}catch(e){}document.body.removeChild(a);}
  };
  async function conectar(){
    if(!cred.host.trim()||!cred.token.trim()||salvandoCred) return;
    setSalvandoCred(true); setErro(""); setAvisoCred("");
    try{
      const r=await acoes.conectarWhats(cred.host.trim(),cred.token.trim());
      setCred({host:"",token:""}); setLigando(false);
      if(r.aviso) setAvisoCred(r.aviso);
      await rever();
    }catch(e){ setErro(e.message); }
    finally{ setSalvandoCred(false); }
  }
  async function desconectar(){
    setSaindo(true); setErro("");
    try{ await acoes.desconectarWhats(palavra); setConfirmando(false); setPalavra(""); await rever(); }
    catch(e){ setErro(e.message); } finally{ setSaindo(false); }
  }

  if(!d) return <div style={{color:C.faint,fontSize:13,padding:20,textAlign:"center"}}>Carregando…</div>;
  const w=d.whatsapp||{};
  const ligado=w.configurado&&w.ok;

  return <React.Fragment>
    {erro&&<div style={{background:C.hotSoft,color:C.hot,fontSize:12.5,borderRadius:10,padding:"10px 12px",marginBottom:12,lineHeight:1.5}}>{erro}</div>}

    {/* Estado atual */}
    <div style={{background:C.card,border:`1px solid ${C.line}`,borderRadius:14,padding:isMobile?14:18,marginBottom:14}}>
      <div style={{display:"flex",alignItems:"center",gap:10,flexWrap:"wrap"}}>
        <div style={{background:ligado?C.greenSoft:C.hotSoft,width:44,height:44,borderRadius:12,display:"flex",
          alignItems:"center",justifyContent:"center",color:ligado?C.green:C.hot,flexShrink:0}}>
          <Icon n={ligado?"wifi":"wifioff"} size={20}/></div>
        <div style={{flex:"1 1 180px",minWidth:0}}>
          <div style={{color:C.ink,fontSize:14,fontWeight:700}}>
            {ligado?"WhatsApp conectado":w.configurado?"WhatsApp desconectado":"Nenhum WhatsApp conectado"}</div>
          <div style={{color:C.faint,fontSize:11.5,marginTop:2}}>
            {ligado?<React.Fragment>Número {fmtTel(w.numero)} · via Uazapi</React.Fragment>
              :w.configurado?(w.erro||w.status||"a instância não respondeu")
              :"Contrate a Uazapi e conecte para a equipe atender pelo CRM."}
          </div>
        </div>
        {ehGestor&&w.configurado&&<button onClick={()=>{setConfirmando(c=>!c);setPalavra("");}}
          style={{background:C.card,color:C.hot,border:`1px solid ${C.hot}44`,borderRadius:9,padding:"8px 14px",
            fontSize:12.5,fontWeight:600,cursor:"pointer"}}>Desconectar</button>}
        {ehGestor&&<button onClick={()=>{setLigando(l=>!l);setAvisoCred("");}}
          style={{background:w.configurado?C.card:C.greenDeep,color:w.configurado?C.greenDeep:"#fff",
            border:w.configurado?`1px solid ${C.green}55`:"none",borderRadius:9,padding:"8px 14px",
            fontSize:12.5,fontWeight:600,cursor:"pointer"}}>{w.configurado?"Trocar a instância":"Conectar"}</button>}
      </div>

      {avisoCred&&<div style={{background:C.amberSoft,color:"#8a6d1f",fontSize:11.5,lineHeight:1.5,borderRadius:10,padding:"9px 11px",marginTop:10}}>{avisoCred}</div>}

      {ligando&&<div style={{background:C.surface,border:`1px solid ${C.line}`,borderRadius:11,padding:12,marginTop:12}}>
        <div style={{color:C.greenDeep,fontSize:12.5,fontWeight:700,marginBottom:3}}>Conectar a instância da sua imobiliária</div>
        <div style={{color:C.sub,fontSize:11.5,lineHeight:1.5,marginBottom:10}}>
          Os dois campos estão no painel da Uazapi, na <b>sua</b> instância — o tutorial aqui embaixo mostra onde.
          Use o <b>token da instância</b>, nunca o de administrador. Cada imobiliária precisa da própria instância:
          duas contas no mesmo número misturam as conversas.
        </div>
        <label style={{color:C.faint,fontSize:10.5,fontWeight:600,textTransform:"uppercase",letterSpacing:.5}}>Endereço (host)</label>
        <input value={cred.host} onChange={e=>setCred({...cred,host:e.target.value})} placeholder="https://suaempresa.uazapi.com"
          style={{width:"100%",boxSizing:"border-box",marginTop:4,marginBottom:9,fontSize:isMobile?16:13,fontFamily:MONO,
            border:`1px solid ${C.line}`,background:C.card,borderRadius:9,padding:"9px 11px",color:C.ink,outline:"none"}}/>
        <label style={{color:C.faint,fontSize:10.5,fontWeight:600,textTransform:"uppercase",letterSpacing:.5}}>Token da instância</label>
        <input value={cred.token} onChange={e=>setCred({...cred,token:e.target.value})} placeholder="cole aqui" type="password"
          style={{width:"100%",boxSizing:"border-box",marginTop:4,marginBottom:10,fontSize:isMobile?16:13,fontFamily:MONO,
            border:`1px solid ${C.line}`,background:C.card,borderRadius:9,padding:"9px 11px",color:C.ink,outline:"none"}}/>
        <div style={{display:"flex",gap:7,flexWrap:"wrap"}}>
          <button onClick={conectar} disabled={salvandoCred||!cred.host.trim()||!cred.token.trim()}
            style={{background:cred.host.trim()&&cred.token.trim()?C.greenDeep:C.faint,color:"#fff",border:"none",
              borderRadius:9,padding:"9px 16px",fontSize:12.5,fontWeight:700,cursor:"pointer"}}>
            {salvandoCred?"Conectando…":"Salvar e conectar"}</button>
          <button onClick={()=>{setLigando(false);setCred({host:"",token:""});}} disabled={salvandoCred}
            style={{background:C.card,color:C.sub,border:`1px solid ${C.line}`,borderRadius:9,padding:"9px 14px",fontSize:12.5,fontWeight:600,cursor:"pointer"}}>Cancelar</button>
        </div>
      </div>}

      {confirmando&&<div style={{background:C.hotSoft,border:`1px solid ${C.hot}44`,borderRadius:11,padding:12,marginTop:12}}>
        <div style={{color:C.hot,fontSize:12.5,fontWeight:700,marginBottom:3}}>Desconectar o WhatsApp da imobiliária?</div>
        <div style={{color:C.sub,fontSize:11.5,lineHeight:1.5,marginBottom:9}}>
          <b>A equipe inteira</b> para de enviar e de receber até alguém parear o número de novo lendo o QR Code.
          As conversas ficam guardadas. Escreva <b>DESCONECTAR</b> para confirmar.
        </div>
        <div style={{display:"flex",gap:7,flexWrap:"wrap"}}>
          <input value={palavra} onChange={e=>setPalavra(e.target.value.toUpperCase())} placeholder="DESCONECTAR"
            style={{flex:"1 1 140px",minWidth:0,fontSize:isMobile?16:13,fontFamily:MONO,border:`1px solid ${C.line}`,
              background:C.card,borderRadius:9,padding:"9px 11px",color:C.ink,outline:"none"}}/>
          <button onClick={desconectar} disabled={saindo||palavra!=="DESCONECTAR"}
            style={{background:palavra==="DESCONECTAR"?C.hot:C.faint,color:"#fff",border:"none",borderRadius:9,
              padding:"9px 16px",fontSize:12.5,fontWeight:700,cursor:"pointer"}}>{saindo?"Desconectando…":"Desconectar"}</button>
        </div>
      </div>}
    </div>

    {/* Provedores */}
    <div style={{color:C.ink,fontSize:13,fontWeight:700,marginBottom:9}}>Como conectar o WhatsApp</div>
    {d.provedores.map(p=><div key={p.id} style={{background:C.card,border:`1px solid ${d.ativo===p.id?C.green+"66":C.line}`,
      borderRadius:14,padding:isMobile?13:16,marginBottom:14}}>
      <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:5,flexWrap:"wrap"}}>
        <span style={{color:C.ink,fontSize:13.5,fontWeight:700}}>{p.nome}</span>
        <span style={{background:p.oficial?C.greenSoft:C.amberSoft,color:p.oficial?C.greenMid:"#8a6d1f",
          fontSize:10,fontWeight:700,padding:"2px 8px",borderRadius:999}}>
          {p.oficial?"API oficial":"API não oficial"}</span>
        {d.ativo===p.id&&<span style={{background:C.greenSoft,color:C.greenDeep,fontSize:10,fontWeight:700,padding:"2px 8px",borderRadius:999}}>em uso</span>}
      </div>
      <div style={{color:C.sub,fontSize:12,lineHeight:1.5,marginBottom:8}}>{p.descricao}</div>
      {/* O risco vem antes do botão, não em letra miúda no rodapé. */}
      <div style={{background:C.amberSoft,color:"#8a6d1f",fontSize:11.5,lineHeight:1.5,borderRadius:10,padding:"9px 11px",marginBottom:10}}>
        <b>Atenção:</b> {p.risco}
      </div>
      <button onClick={()=>setTutorial(t=>t===p.id?false:p.id)}
        style={{background:C.surface,color:C.greenDeep,border:`1px solid ${C.green}55`,borderRadius:9,
          padding:"8px 14px",fontSize:12.5,fontWeight:600,cursor:"pointer",display:"flex",alignItems:"center",gap:6}}>
        <span style={{display:"inline-flex",transform:tutorial===p.id?"rotate(90deg)":"none",transition:"transform .15s"}}><Icon n="chevron" size={13}/></span>
        Como contratar e conectar a {p.nome}</button>

      {tutorial===p.id&&<TutorialUazapi webhook={d.webhook} site={p.site} copiar={copiar} copiado={copiado} isMobile={isMobile}/>}
    </div>)}

    {/* Webhook */}
    <div style={{background:C.card,border:`1px solid ${C.line}`,borderRadius:14,padding:isMobile?13:16}}>
      <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:4,flexWrap:"wrap"}}>
        <Icon n="link" size={14} color={C.greenMid}/>
        <span style={{color:C.ink,fontSize:13.5,fontWeight:700,flex:1}}>Webhook — para o CRM RECEBER as mensagens</span>
      </div>
      <div style={{color:C.faint,fontSize:11.5,lineHeight:1.55,marginBottom:10}}>{d.webhook.observacao}</div>
      <div style={{display:"flex",gap:8,flexDirection:isMobile?"column":"row"}}>
        <div style={{flex:1,minWidth:0,background:C.surface,border:`1px solid ${C.line}`,borderRadius:9,
          padding:"10px 11px",fontSize:11.5,color:C.greenMid,wordBreak:"break-all",fontFamily:MONO}}>{d.webhook.url}</div>
        <button onClick={()=>copiar(d.webhook.url)}
          style={{background:copiado?C.card:C.greenDeep,color:copiado?C.greenMid:"#fff",
            border:copiado?`1px solid ${C.green}55`:"none",borderRadius:9,padding:"10px 16px",
            fontSize:12.5,fontWeight:600,cursor:"pointer",flexShrink:0}}>{copiado?"Copiado!":"Copiar"}</button>
      </div>
      <div style={{color:C.faint,fontSize:11,marginTop:9,lineHeight:1.5}}>
        Na Uazapi, marque o evento <b style={{color:C.sub}}>{d.webhook.eventos.join(", ")}</b>.
        Sem o webhook o CRM envia, mas as respostas do cliente não aparecem na conversa.
      </div>
    </div>
  </React.Fragment>;
}

/* O passo a passo escrito para quem nunca ouviu falar de API. */
function TutorialUazapi({webhook,site,copiar,copiado,isMobile}){
  const passos=[
    ["Crie a conta na Uazapi",<React.Fragment>Acesse <b>{site.replace("https://","")}</b> e cadastre-se. É um serviço pago por instância (cada número conectado é uma instância), contratado pela imobiliária direto com eles — o ConHub não revende nem cobra por isso.</React.Fragment>],
    ["Crie uma instância",<React.Fragment>No painel da Uazapi, crie uma instância para o número da imobiliária. Use um <b>número dedicado</b>, nunca o WhatsApp pessoal de alguém.</React.Fragment>],
    ["Conecte o WhatsApp",<React.Fragment>A Uazapi mostra um <b>QR Code</b>. No celular do número da imobiliária, abra o WhatsApp → <b>Aparelhos conectados</b> → <b>Conectar aparelho</b> e leia o código, igual ao WhatsApp Web.</React.Fragment>],
    ["Copie o endereço e o token",<React.Fragment>No painel, copie o <b>host</b> (algo como suaempresa.uazapi.com) e o <b>token da instância</b> — não o token de administrador. São essas duas informações que o ConHub precisa.</React.Fragment>],
    ["Cole o webhook",<React.Fragment>Ainda na instância, procure o campo <b>Webhook</b> e cole o endereço abaixo. É por ele que a resposta do cliente chega no CRM.</React.Fragment>],
    ["Mande o host e o token para o suporte do ConHub",<React.Fragment>Hoje quem liga as duas pontas é o suporte. <b>Nunca mande o token em grupo</b> — ele dá acesso ao WhatsApp da imobiliária.</React.Fragment>],
  ];
  return <div style={{background:C.surface,borderRadius:12,padding:isMobile?12:14,marginTop:11}}>
    {passos.map(([titulo,texto],i)=><div key={i} style={{display:"flex",gap:10,marginBottom:i===passos.length-1?0:12}}>
      <div style={{width:22,height:22,borderRadius:99,background:C.greenDeep,color:"#fff",fontSize:11,fontWeight:700,
        display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}>{i+1}</div>
      <div style={{flex:1,minWidth:0}}>
        <div style={{color:C.ink,fontSize:12.5,fontWeight:700,marginBottom:2}}>{titulo}</div>
        <div style={{color:C.sub,fontSize:11.5,lineHeight:1.55}}>{texto}</div>
        {i===4&&<div style={{display:"flex",gap:7,marginTop:7,flexWrap:"wrap"}}>
          <div style={{flex:"1 1 180px",minWidth:0,background:C.card,border:`1px solid ${C.line}`,borderRadius:8,
            padding:"7px 9px",fontSize:11,color:C.greenMid,wordBreak:"break-all",fontFamily:MONO}}>{webhook.url}</div>
          <button onClick={()=>copiar(webhook.url)}
            style={{background:C.greenDeep,color:"#fff",border:"none",borderRadius:8,padding:"7px 12px",
              fontSize:11.5,fontWeight:600,cursor:"pointer"}}>{copiado?"Copiado!":"Copiar"}</button>
        </div>}
      </div>
    </div>)}
  </div>;
}

/* ===== CONEXÃO (ADM, número único) ===== */
function Conexao({conecta}){
  const isMobile=useIsMobile();
  return <div style={{height:"100%",overflowY:"auto",padding:isMobile?14:24}}>
    <div style={{maxWidth:560,margin:"0 auto"}}>
      <div style={{background:C.card,border:`1px solid ${C.line}`,borderRadius:16,padding:24,textAlign:"center"}}>
        <div style={{background:conecta.connected?C.greenSoft:C.hotSoft,width:64,height:64,borderRadius:16,display:"flex",alignItems:"center",justifyContent:"center",margin:"0 auto 16px",color:conecta.connected?C.green:C.hot}}><Icon n={conecta.connected?"wifi":"wifioff"} size={28}/></div>
        <div style={{color:C.ink,fontFamily:DISPLAY,fontSize:18,fontWeight:700}}>{conecta.connected?"WhatsApp da Conecta conectado":"WhatsApp desconectado"}</div>
        {conecta.connected?<React.Fragment>
          <div style={{color:C.sub,fontSize:13,marginTop:4}}>Todos os corretores atendem por este número:</div>
          <div style={{color:C.green,fontFamily:MONO,fontSize:16,fontWeight:600,margin:"8px 0"}}>{fmtTel(conecta.number)}</div>
          <Pill c={C.greenMid} bg={C.greenSoft}>Ativo via Uazapi</Pill>
        </React.Fragment>:<div style={{color:C.sub,fontSize:13,margin:"6px 0 0",lineHeight:1.6}}>
          O CRM não está conseguindo falar com a Uazapi. Confira no painel da Uazapi se a instância
          está <b>connected</b>, e na hospedagem se <b>UAZAPI_HOST</b> e <b>UAZAPI_TOKEN</b> continuam preenchidos.
        </div>}
        {/* A conexão em si é feita no painel da Uazapi (QR / pareamento). Aqui só espelhamos o estado real —
            botão de "conectar" aqui daria a falsa impressão de que o CRM controla o pareamento. */}
      </div>
      <div style={{background:C.card,border:`1px solid ${C.line}`,borderRadius:16,padding:20,marginTop:16}}>
        <div style={{color:C.ink,fontSize:13,fontWeight:700,marginBottom:8,display:"flex",alignItems:"center",gap:8}}><Icon n="link" size={15} color={C.green}/> Como funciona</div>
        <div style={{color:C.sub,fontSize:12.5,lineHeight:1.6}}>Um único número da Conecta conectado via Uazapi. Todos os corretores atendem por ele, e cada mensagem sai assinada com o nome de quem enviou — o lead sempre sabe com quem está falando.</div>
      </div>
    </div>
  </div>;
}

/* ===== RELATÓRIOS (dados reais, com filtro de período) ===== */
const hojeISO=()=>new Date().toISOString().slice(0,10);
const diasAtras=(n)=>new Date(Date.now()-n*86400000).toISOString().slice(0,10);

/* ===== LEADS RECEBIDOS, DIA A DIA =====

   "Quantos leads o Rafael recebeu no dia 4?" era uma pergunta que só se
   respondia puxando o relatório de um dia por vez. O total do período não
   serve: 40 leads no mês pode ser 2 por dia ou 30 numa terça e nada no resto,
   e as duas coisas pedem conversas bem diferentes com o corretor.

   Junto vem o cruzamento com a escala: dia de plantão aparece marcado, e o
   rodapé diz quantos leads caíram justamente nesses dias. */
function LeadsPorDia({linha,isMobile}){
  const dias=linha.por_dia||[];
  const pl=linha.plantao||{};
  const maior=Math.max(1,...dias.map(d=>d.recebidos));
  const total=dias.reduce((s,d)=>s+d.recebidos,0);
  const dd=(ms)=>new Date(ms).toLocaleDateString("pt-BR",{day:"2-digit",month:"2-digit"});
  const semana=(ms)=>["dom","seg","ter","qua","qui","sex","sáb"][new Date(ms).getDay()];

  /* Um dia por vez, e não os trinta de uma vez.
     O mês inteiro em barras empurrava o resto do relatório para fora da tela,
     e a pergunta do gestor é quase sempre sobre UM dia. Então a tela abre no
     dia escolhido; a lista completa continua a um clique, para quando ele
     quiser procurar o buraco no mês. */
  const chave=(ms)=>{const x=new Date(ms);
    return `${x.getFullYear()}-${String(x.getMonth()+1).padStart(2,"0")}-${String(x.getDate()).padStart(2,"0")}`;};
  const [tudo,setTudo]=useState(false);
  const [escolhido,setEscolhido]=useState(()=>chave(Date.now()));

  const porChave=new Map(dias.map(d=>[chave(d.dia),d.recebidos]));
  const deuPlantao=new Set((pl.dias_plantao||[]).map(chave));
  const recebidos=porChave.get(escolhido)||0;
  const noPlantao=deuPlantao.has(escolhido);
  const data=new Date(escolhido+"T12:00:00");
  // Só a primeira letra: com o capitalize do CSS sairia "Terça-Feira, 04 De Agosto".
  const porExtenso=isFinite(data.getTime())
    ?data.toLocaleDateString("pt-BR",{weekday:"long",day:"2-digit",month:"long"}):"—";
  const extenso=porExtenso.charAt(0).toUpperCase()+porExtenso.slice(1);
  // Os dias com movimento, para ele saber onde procurar sem abrir a lista toda.
  const comMovimento=dias.filter(d=>d.recebidos>0).length;

  return <div style={{background:C.card,border:`1px solid ${C.line}`,borderRadius:16,padding:isMobile?14:18,marginBottom:16}}>
    <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:3,flexWrap:"wrap"}}>
      <Icon n="calendar" size={15} color={C.greenMid}/>
      <span style={{color:C.ink,fontSize:13.5,fontWeight:700,flex:1}}>Leads recebidos por dia</span>
      <span style={{fontFamily:MONO,color:C.ink,fontSize:15,fontWeight:700}}>{total}</span>
      <span style={{color:C.faint,fontSize:11}}>no período</span>
    </div>

    {pl.dias_escalado>0&&<div style={{color:C.faint,fontSize:11.5,lineHeight:1.5,marginBottom:10}}>
      Esteve de plantão em <b style={{color:C.ink}}>{pl.dias_escalado}</b> dia(s), e
      se prontificou em <b style={{color:pl.dias_que_se_prontificou<pl.dias_escalado?C.hot:C.greenMid}}>{pl.dias_que_se_prontificou}</b> deles ·
      <b style={{color:C.ink}}> {pl.leads_em_dia_de_plantao}</b> lead(s) chegaram em dia de plantão dele.
    </div>}

    <div style={{display:"flex",alignItems:"center",gap:8,flexWrap:"wrap",marginBottom:10}}>
      <span style={{color:C.faint,fontSize:11.5,fontWeight:600}}>Dia</span>
      <input type="date" value={escolhido} onChange={e=>{setEscolhido(e.target.value);setTudo(false);}}
        style={{fontSize:isMobile?16:12.5,fontFamily:MONO,border:`1px solid ${C.line}`,background:C.surface,
          borderRadius:9,padding:"6px 9px",color:C.ink,outline:"none"}}/>
      <button onClick={()=>setTudo(t=>!t)}
        style={{background:"transparent",border:"none",padding:0,cursor:"pointer",color:C.greenMid,fontSize:11.5,fontWeight:600,marginLeft:"auto"}}>
        {tudo?"ver só o dia escolhido":`ver o período todo (${comMovimento} dia(s) com lead)`}</button>
    </div>

    {tudo
      ?(dias.length===0
        ?<div style={{color:C.faint,fontSize:12.5}}>Nenhum lead recebido neste período.</div>
        :<div style={{display:"flex",flexDirection:"column",gap:3}}>
          {dias.map(d=><button key={d.dia} onClick={()=>{setEscolhido(chave(d.dia));setTudo(false);}}
            style={{display:"flex",alignItems:"center",gap:9,background:"transparent",border:"none",padding:0,cursor:"pointer",width:"100%"}}>
            <span style={{fontFamily:MONO,color:C.sub,fontSize:11.5,width:64,flexShrink:0,textAlign:"left"}}>{dd(d.dia)} <span style={{color:C.faint}}>{semana(d.dia)}</span></span>
            <div style={{flex:1,height:16,background:C.surface,borderRadius:5,overflow:"hidden",minWidth:40}}>
              <div style={{width:`${Math.max(6,(d.recebidos/maior)*100)}%`,height:"100%",
                background:deuPlantao.has(chave(d.dia))?C.greenDeep:C.green,borderRadius:5}}/>
            </div>
            <span style={{fontFamily:MONO,color:C.ink,fontSize:12.5,fontWeight:700,width:26,textAlign:"right"}}>{d.recebidos}</span>
          </button>)}
        </div>)
      :<div style={{background:C.surface,borderRadius:12,padding:isMobile?12:14,display:"flex",alignItems:"center",gap:12,flexWrap:"wrap"}}>
        <div style={{flex:"1 1 140px",minWidth:0}}>
          <div style={{color:C.ink,fontSize:13,fontWeight:700}}>{extenso}</div>
          <div style={{color:C.faint,fontSize:11.5,marginTop:2}}>
            {noPlantao?<span style={{color:C.greenDeep,fontWeight:700}}>estava de plantão neste dia</span>:"não estava escalado neste dia"}
          </div>
        </div>
        <div style={{textAlign:"right"}}>
          <div style={{fontFamily:MONO,color:recebidos?C.ink:C.faint,fontSize:26,fontWeight:700,lineHeight:1}}>{recebidos}</div>
          <div style={{color:C.faint,fontSize:11,marginTop:3}}>lead(s) recebido(s)</div>
        </div>
      </div>}
  </div>;
}

/* ===== PONTO DAS ATENDENTES =====
   Diário, semanal e mensal. A atendente enxerga o próprio; a equipe inteira,
   só o gestor (quem filtra é o servidor, não esta tela).

   Duas colunas carregam o peso: "de onde" (imobiliária ou fora, com o motivo
   que ela escreveu) e "fechado pelo sistema" — que é o dia em que ela não
   marcou a saída e o corte das 18:00 fechou por ela. */
function PontoDaEquipe({acoes,isMobile,ehGestor}){
  const [d,setD]=useState(null);
  const [periodo,setPeriodo]=useState("semana");
  const [aberta,setAberta]=useState(null);   // pessoa com os dias expandidos
  useEffect(()=>{ setD(null); acoes.ponto({periodo}).then(setD).catch(()=>setD({pessoas:[]})); },[periodo]);

  const hhmm=(ms)=>ms?new Date(ms).toLocaleTimeString("pt-BR",{hour:"2-digit",minute:"2-digit"}):"—";
  const dia=(ms)=>new Date(ms).toLocaleDateString("pt-BR",{day:"2-digit",month:"2-digit"});
  const tempo=(min)=>min<60?`${min} min`:`${Math.floor(min/60)}h${String(min%60).padStart(2,"0")}`;
  const ROTULOS={dia:"Hoje",semana:"7 dias",mes:"30 dias"};

  if(!d) return null;
  if(!d.pessoas.length) return null;

  return <div style={{background:C.card,border:`1px solid ${C.line}`,borderRadius:16,padding:isMobile?14:18,marginBottom:16}}>
    <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:4,flexWrap:"wrap"}}>
      <Icon n="clock" size={15} color={C.greenMid}/>
      <span style={{color:C.ink,fontSize:13.5,fontWeight:700,flex:1}}>{ehGestor?"Ponto das atendentes":"Meu ponto"}</span>
      <div style={{display:"flex",gap:5}}>
        {["dia","semana","mes"].map(k=><button key={k} onClick={()=>setPeriodo(k)}
          style={{fontSize:isMobile?12.5:11.5,fontWeight:600,padding:isMobile?"9px 14px":"5px 10px",borderRadius:999,border:"none",cursor:"pointer",
            background:periodo===k?C.greenDeep:C.surface,color:periodo===k?"#fff":C.sub}}>{ROTULOS[k]}</button>)}
      </div>
    </div>
    <div style={{color:C.faint,fontSize:11.5,lineHeight:1.5,marginBottom:12}}>
      Registro de presença: início, encerramento e de onde o atendimento começou.
    </div>

    <div style={{display:"flex",flexDirection:"column",gap:8}}>
      {d.pessoas.map(p=><div key={p.id} style={{background:C.surface,borderRadius:12,padding:"11px 12px"}}>
        <div style={{display:"flex",alignItems:"center",gap:10,flexWrap:"wrap"}}>
          <div style={{flex:"1 1 130px",minWidth:0}}>
            <div style={{color:C.ink,fontSize:13,fontWeight:700}}>{p.nome}</div>
            <div style={{color:C.faint,fontSize:10.5}}>
              {p.dias_com_registro} dia(s) com registro
              {p.dias_fora>0?` · ${p.dias_fora} começou fora`:""}
              {p.dias_sem_saida>0?` · ${p.dias_sem_saida} sem marcar saída`:""}
            </div>
          </div>
          <div style={{textAlign:"right"}}>
            <div style={{fontFamily:MONO,color:C.ink,fontSize:15,fontWeight:700,lineHeight:1}}>{tempo(p.total_minutos)}</div>
            <div style={{color:C.faint,fontSize:10}}>no período</div>
          </div>
          {p.dias.length>0&&<button onClick={()=>setAberta(a=>a===p.id?null:p.id)}
            style={{background:"transparent",border:"none",cursor:"pointer",color:C.greenMid,fontSize:11.5,fontWeight:600,display:"flex",alignItems:"center",gap:4}}>
            <span style={{display:"inline-flex",transform:aberta===p.id?"rotate(90deg)":"none",transition:"transform .15s"}}><Icon n="chevron" size={12}/></span>
            {aberta===p.id?"ocultar":"ver dias"}</button>}
        </div>

        {aberta===p.id&&<div style={{marginTop:10,borderTop:`1px solid ${C.line}`,paddingTop:8,overflowX:"auto"}}>
          <table style={{width:"100%",borderCollapse:"collapse",minWidth:420}}>
            <thead><tr>
              {["Dia","Entrada","Saída","Total","De onde"].map(h=>
                <th key={h} style={{textAlign:"left",color:C.faint,fontSize:10,fontWeight:700,textTransform:"uppercase",padding:"4px 6px",whiteSpace:"nowrap"}}>{h}</th>)}
            </tr></thead>
            <tbody>{p.dias.map(x=><React.Fragment key={x.dia}>
              <tr style={{borderTop:`1px solid ${C.line}`}}>
                <td style={{padding:"6px",fontFamily:MONO,fontSize:11.5,color:C.sub,whiteSpace:"nowrap"}}>{dia(x.dia)}</td>
                <td style={{padding:"6px",fontFamily:MONO,fontSize:11.5,color:C.ink}}>{hhmm(x.entrada)}</td>
                <td style={{padding:"6px",fontFamily:MONO,fontSize:11.5,color:x.fechado_pelo_sistema?C.faint:C.ink,whiteSpace:"nowrap"}}>
                  {hhmm(x.saida)}{x.fechado_pelo_sistema&&<span style={{fontFamily:FONT,fontSize:9.5,color:C.faint}}> auto</span>}</td>
                <td style={{padding:"6px",fontFamily:MONO,fontSize:11.5,color:C.ink,fontWeight:700}}>{tempo(x.minutos)}</td>
                <td style={{padding:"6px"}}>
                  {x.local==="fora"
                    ?<span style={{color:"#8a6d1f",background:C.amberSoft,fontSize:10.5,fontWeight:700,padding:"2px 7px",borderRadius:999,whiteSpace:"nowrap"}}>fora</span>
                    :x.local==="imobiliaria"
                    ?<span style={{color:C.greenDeep,background:C.greenSoft,fontSize:10.5,fontWeight:700,padding:"2px 7px",borderRadius:999,whiteSpace:"nowrap"}}>imobiliária</span>
                    :<span style={{color:C.faint,fontSize:10.5}}>—</span>}
                </td>
              </tr>
              {x.observacao&&<tr><td colSpan={5} style={{padding:"0 6px 7px 6px",color:C.sub,fontSize:11.5,lineHeight:1.45}}>
                <Icon n="msg" size={10} color={C.faint}/> {x.observacao}</td></tr>}
            </React.Fragment>)}</tbody>
          </table>
        </div>}
      </div>)}
    </div>
  </div>;
}

/* ===== ATENDIMENTO (a atendente) =====

   Bloco separado do funil dos corretores porque o trabalho é outro. Ela não
   agenda visita nem fecha venda: ela pega o lead que acabou de entrar, fala
   primeiro e repassa. Medir a atendente por conversão é cobrar dela uma coisa
   que não está no papel dela.

   Os números vêm do PRIMEIRO CONTATO de cada conversa, não de quem está com o
   lead agora — senão tudo que ela repassou sumiria da conta dela. */
function BlocoAtendimento({linhas,isMobile}){
  if(!linhas||!linhas.length) return null;
  const tempo=(min)=>min<60?`${Math.round(min)} min`:`${Math.floor(min/60)}h${String(Math.round(min%60)).padStart(2,"0")}`;
  return <div style={{background:C.card,border:`1px solid ${C.line}`,borderRadius:16,padding:isMobile?14:18,marginBottom:16}}>
    <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:3}}>
      <Icon n="msg" size={15} color={C.greenMid}/>
      <span style={{color:C.ink,fontSize:13.5,fontWeight:700}}>Primeiro atendimento</span>
    </div>
    <div style={{color:C.faint,fontSize:11.5,lineHeight:1.5,marginBottom:12}}>
      A função da atendente é falar primeiro e repassar — por isso aqui não tem visita nem venda.
    </div>
    <div style={{display:"flex",flexDirection:"column",gap:10}}>
      {linhas.map(a=><div key={a.id} style={{background:C.surface,borderRadius:12,padding:"12px 13px"}}>
        <div style={{color:C.ink,fontSize:13,fontWeight:700,marginBottom:9}}>{a.nome}</div>
        <div style={{display:"grid",gridTemplateColumns:isMobile?"repeat(2,1fr)":"repeat(auto-fit,minmax(96px,1fr))",gap:10}}>
          {[["Recebidos",a.recebidos,null],
            ["Falou primeiro",a.primeiro_contato,null],
            ["Tempo até falar",tempo(a.primeira_resposta_mediana_min),null],
            ["Repassados",a.repassados,null],
            ["Ainda com ela",a.com_ela,null],
            // O único número que merece alarme: lead que entrou e ninguém falou.
            ["Sem contato",a.sem_contato,a.sem_contato>0?C.hot:null]].map(([t,v,cor])=>
            <div key={t}>
              <div style={{fontFamily:MONO,color:cor||C.ink,fontSize:17,fontWeight:700,lineHeight:1.1}}>{v}</div>
              <div style={{color:C.faint,fontSize:10.5}}>{t}</div>
            </div>)}
        </div>
      </div>)}
    </div>
  </div>;
}

/* Quem está numa etapa, dentro do relatório — e cada nome abre a conversa.

   Busca no servidor com os MESMOS filtros do relatório (corretor, etapa,
   período). Assim a lista não pode discordar do número que está do lado: é a
   mesma pergunta, feita ao mesmo lugar. */
function LeadsDaEtapa({acoes,etapa,atendente,periodo,isMobile,abrirConversa}){
  const [lista,setLista]=useState(null);
  useEffect(()=>{let vivo=true; setLista(null);
    acoes.buscar({etapa,atendente,de:periodo.de,ate:periodo.ate,finalizados:"1"})
      .then(r=>vivo&&setLista(r)).catch(()=>vivo&&setLista([]));
    return()=>{vivo=false;};},[etapa,atendente,periodo.de,periodo.ate]);

  return <div style={{background:C.surface,borderRadius:10,padding:"8px 10px",margin:"-2px 0 10px",
    marginLeft:isMobile?0:12}}>
    {lista===null
      ?<div style={{color:C.faint,fontSize:11.5,display:"flex",alignItems:"center",gap:6}}><Icon n="loader" size={12} spin/> carregando…</div>
      :lista.length===0
      ?<div style={{color:C.faint,fontSize:11.5}}>Nenhum lead nesta etapa no período.</div>
      :<div style={{display:"flex",flexWrap:"wrap",gap:5}}>
        {lista.map(l=><button key={l.id} onClick={()=>abrirConversa&&abrirConversa(l.id)}
          title="Abrir a conversa"
          style={{display:"flex",alignItems:"center",gap:5,background:C.card,border:`1px solid ${C.line}`,
            borderRadius:999,padding:"4px 11px",cursor:abrirConversa?"pointer":"default",fontSize:11.5,color:C.ink}}>
          <span style={{width:6,height:6,borderRadius:99,background:prioDe(l.prio).c,flexShrink:0}}/>
          {first(l.nome)}
        </button>)}
      </div>}
  </div>;
}

/* ===== RELATÓRIO DO CORRETOR, PARA LEVAR À REUNIÃO =====

   A exigência do Ali, e ela manda em tudo aqui: FIEL AO QUE O CRM MOSTRA.
   Mesmo período, mesma definição de cada número, nenhuma métrica que só exista
   no papel. Por isso esta tela NÃO calcula nada: ela busca exatamente as duas
   mesmas rotas que a tela de Relatórios já usa, com o mesmo intervalo, e
   desenha o resultado. Se o número mudar aqui e não lá, é bug — não é "outro
   critério".

   Sai pela impressão do navegador, que é como se faz PDF sem instalar nada:
   Imprimir → Salvar como PDF. O CSS de impressão vive no index.html (regra da
   casa: JS em app.jsx, CSS global no index.html).

   O bloco "Como cada número é medido" não é rodapé decorativo. É o que faz o
   relatório sobreviver à primeira pessoa que perguntar "de onde saiu isso". */
function RelatorioParaReuniao({acoes,linha,dados,periodo,org,isMobile,aoFechar}){
  const alturaBarra=usarAlturaDaBarra();
  /* `score` fica `false` quando a nota não está disponível para quem abriu.

     O corretor não tem acesso ao ranking — é decisão antiga da casa: a nota é
     material de decisão sobre pessoas, não painel de auto-avaliação. Mas o
     relatório dele tem que sair assim mesmo, com os números que são dele.
     Recusar a folha inteira por causa do bloco da nota seria trocar uma regra
     por um impedimento. */
  const [score,setScore]=useState(null);
  const [erro,setErro]=useState("");
  useEffect(()=>{let vivo=true; setScore(null); setErro("");
    acoes.score({de:periodo.de,ate:periodo.ate})
      .then(x=>vivo&&setScore(x))
      .catch(e=>{ if(!vivo) return;
        setScore(false);
        if(!/permiss/i.test(e.message||"")) setErro(e.message); });
    return()=>{vivo=false;};},[periodo.de,periodo.ate]);

  const meu=score&&score.equipe.find(x=>x.id===linha.id);
  const pronto=score!==null;   // veio a nota, ou veio a recusa: nos dois a folha existe
  const cor=(n)=>n==null?C.faint:n>=70?C.green:n>=45?C.amber:C.hot;
  const hoje=new Date().toLocaleString("pt-BR",{day:"2-digit",month:"2-digit",year:"numeric",hour:"2-digit",minute:"2-digit"});

  const titulo=(t)=><div style={{color:C.ink,fontFamily:DISPLAY,fontSize:13.5,fontWeight:700,
    borderBottom:`1px solid ${C.line}`,paddingBottom:6,margin:"22px 0 12px"}}>{t}</div>;

  const numero=(rot,val,sub)=><div style={{flex:"1 1 128px",minWidth:112}}>
    <div style={{fontFamily:MONO,color:C.ink,fontSize:22,fontWeight:700,lineHeight:1.05}}>{val}</div>
    <div style={{color:C.sub,fontSize:11,fontWeight:600,marginTop:3}}>{rot}</div>
    {sub&&<div style={{color:C.faint,fontSize:10,marginTop:1}}>{sub}</div>}
  </div>;

  return <div className="folha tela-cheia" style={{zIndex:80,background:C.surface,overflowY:"auto"}}>
    <div className="nao-imprimir" style={{position:"sticky",top:0,zIndex:2,background:C.card,borderBottom:`1px solid ${C.line}`,
      padding:isMobile?"10px 14px":"10px 20px",display:"flex",alignItems:"center",gap:9,flexWrap:"wrap"}}>
      <button onClick={aoFechar} style={{border:`1px solid ${C.line}`,background:C.surface,color:C.sub,borderRadius:9,
        padding:"8px 14px",fontSize:12.5,fontWeight:600,cursor:"pointer"}}>Voltar</button>
      <span style={{color:C.faint,fontSize:11.5,flex:1,minWidth:120}}>
        Imprimir → <b style={{color:C.sub}}>Salvar como PDF</b> para levar à reunião.
      </span>
      <button onClick={()=>window.print()} disabled={!pronto}
        style={{background:pronto?C.greenDeep:C.faint,color:"#fff",border:"none",borderRadius:9,padding:"8px 16px",
          fontSize:12.5,fontWeight:700,cursor:pronto?"pointer":"default",display:"flex",alignItems:"center",gap:6}}>
        <Icon n="download" size={13}/>Imprimir / PDF</button>
    </div>

    {/* O fim do documento livra a barra de baixo: sem isto o último botão fica
        encostado nela, que é onde o dedo erra. */}
    <div style={{maxWidth:800,margin:"0 auto",
      padding:isMobile?`16px 14px ${alturaBarra+32}px`:"24px 26px 48px"}}>
      <div style={{display:"flex",alignItems:"flex-start",gap:12,flexWrap:"wrap",borderBottom:`2px solid ${C.greenDeep}`,paddingBottom:12}}>
        <div style={{flex:1,minWidth:180}}>
          <div style={{color:C.greenDeep,fontFamily:DISPLAY,fontSize:isMobile?18:21,fontWeight:700,lineHeight:1.15}}>
            {linha.nome}</div>
          <div style={{color:C.sub,fontSize:12.5,marginTop:3}}>
            {linha.papel==="sdr"?"Atendente (SDR)":"Corretor(a)"} · {org&&org.nome?org.nome:"Conecta Imóveis"}</div>
          <div style={{color:C.faint,fontSize:11.5,marginTop:2}}>
            Período: <b style={{color:C.sub}}>{fmtData(dados.periodo.de)} a {fmtData(dados.periodo.ate)}</b></div>
        </div>
        {meu&&!meu.sem_dados&&<div style={{textAlign:"right"}}>
          <div style={{fontFamily:MONO,fontSize:38,fontWeight:700,lineHeight:1,color:cor(meu.score)}}>{meu.score}</div>
          <div style={{color:C.faint,fontSize:10.5,marginTop:2}}>score de 100</div>
        </div>}
      </div>

      {erro&&<div style={{background:C.hotSoft,color:C.hot,fontSize:12,borderRadius:10,padding:"9px 11px",marginTop:12}}>{erro}</div>}
      {!pronto&&!erro&&<div style={{color:C.faint,fontSize:12.5,padding:"18px 0"}}>Montando o relatório…</div>}

      {titulo("Números do período")}
      <div style={{display:"flex",gap:14,flexWrap:"wrap"}}>
        {numero("Leads recebidos",linha.recebidos,"entraram no período")}
        {numero("Atendidos",linha.atendidos,linha.taxa_atendimento+"% de resposta")}
        {numero("1ª resposta",fmtMin(linha.primeira_resposta_mediana_min),"mediana")}
        {numero("Agendados / visitas",linha.agendamentos,`${linha.agendamentos_confirmados||0} confirmado(s) por pessoa`)}
        {numero("Vendas",linha.vendas,"fechadas no período")}
        {numero("Valor vendido",fmtMoeda(linha.valor_vendido),null)}
      </div>

      {meu&&!meu.sem_dados&&<React.Fragment>
        {titulo("Como a nota foi formada")}
        <table style={{width:"100%",borderCollapse:"collapse"}}>
          <thead><tr style={{borderBottom:`1px solid ${C.line}`}}>
            {["Item","Resultado","Nota","Peso","Pontos"].map((h,i)=>
              <th key={h} style={{padding:"6px 6px",fontSize:10,fontWeight:700,color:C.faint,textTransform:"uppercase",
                textAlign:i?"right":"left"}}>{h}</th>)}
          </tr></thead>
          <tbody>{meu.partes.map(p=><tr key={p.chave} style={{borderBottom:`1px solid ${C.line}`}}>
            <td style={{padding:"7px 6px",fontSize:11.5,color:C.ink}}>
              {p.rotulo}
              <div style={{color:C.faint,fontSize:10,lineHeight:1.4,marginTop:2}}>{p.regua}</div>
            </td>
            <td style={{padding:"7px 6px",fontSize:12,fontFamily:MONO,color:C.ink,textAlign:"right",whiteSpace:"nowrap"}}>{p.valor_texto}</td>
            <td style={{padding:"7px 6px",fontSize:12,fontFamily:MONO,color:cor(p.nota),fontWeight:700,textAlign:"right"}}>{p.nota}</td>
            <td style={{padding:"7px 6px",fontSize:11.5,fontFamily:MONO,color:C.faint,textAlign:"right"}}>{p.peso}%</td>
            <td style={{padding:"7px 6px",fontSize:12,fontFamily:MONO,color:C.sub,fontWeight:700,textAlign:"right"}}>{p.contribuiu}</td>
          </tr>)}</tbody>
          <tfoot><tr>
            <td colSpan={4} style={{padding:"8px 6px",fontSize:11.5,color:C.sub,fontWeight:700,textAlign:"right"}}>Nota final</td>
            <td style={{padding:"8px 6px",fontFamily:MONO,fontSize:14,fontWeight:700,color:cor(meu.score),textAlign:"right"}}>{meu.score}</td>
          </tr></tfoot>
        </table>
      </React.Fragment>}

      {titulo("Onde estão os leads do período")}
      <div style={{display:"flex",flexDirection:"column",gap:5}}>
        {STAGES.filter(st=>(linha.por_etapa[st]||0)>0).map(st=>{
          const v=linha.por_etapa[st]||0, p=linha.recebidos?v/linha.recebidos*100:0;
          return <div key={st} style={{display:"flex",alignItems:"center",gap:9}}>
            <span style={{color:C.sub,fontSize:11.5,width:isMobile?106:160,flexShrink:0}}>{st}</span>
            <div style={{height:9,borderRadius:999,background:C.surface,flex:1,overflow:"hidden"}}>
              <div style={{width:Math.max(p,3)+"%",height:"100%",borderRadius:999,background:STAGE_C[st]}}/></div>
            <span style={{fontFamily:MONO,color:C.ink,fontSize:12,fontWeight:700,width:34,textAlign:"right"}}>{v}</span>
          </div>;})}
        {linha.recebidos===0&&<div style={{color:C.faint,fontSize:12}}>Nenhum lead entrou para esta pessoa no período.</div>}
      </div>

      {linha.por_dia&&linha.por_dia.length>0&&<React.Fragment>
        {titulo("Leads recebidos, dia a dia")}
        <div style={{display:"flex",flexWrap:"wrap",gap:5}}>
          {linha.por_dia.map(d=><span key={d.dia} style={{background:C.surface,borderRadius:8,padding:"5px 10px",
            fontSize:11,color:C.sub}}>{fmtData(d.dia)} · <b style={{fontFamily:MONO,color:C.ink}}>{d.recebidos}</b></span>)}
        </div>
      </React.Fragment>}

      {linha.plantao&&linha.plantao.dias_escalado>0&&<React.Fragment>
        {titulo("Plantão")}
        <div style={{display:"flex",gap:14,flexWrap:"wrap"}}>
          {numero("Dias escalado",linha.plantao.dias_escalado,null)}
          {numero("Dias que se prontificou",linha.plantao.dias_que_se_prontificou,null)}
          {numero("Leads em dia de plantão",linha.plantao.leads_em_dia_de_plantao,null)}
        </div>
      </React.Fragment>}

      {titulo("Como cada número é medido")}
      <div style={{color:C.sub,fontSize:11,lineHeight:1.65}}>
        <div><b>Leads recebidos</b> — entraram no período e estão com esta pessoa.</div>
        <div><b>Vendas</b> — fechadas <b>dentro do período</b>, venha o lead de quando vier. Uma venda registrada hoje de um lead de junho conta neste mês.</div>
        <div><b>Conversão</b> — dos leads que <b>entraram</b> no período, quantos já viraram venda.</div>
        <div><b>1ª resposta</b> — mediana do tempo entre o lead entrar e a primeira resposta. Mediana, não média: um lead esquecido no fim de semana não define o mês inteiro.</div>
        <div><b>Agendados / visitas</b> — onde os leads do período estão <b>hoje</b> no funil. O número menor é quantos foram colocados ali por uma <b>pessoa</b> (mudança na mão ou sugestão da IA confirmada); o resto veio da regra automática de palavra-chave. <b>Só os confirmados entram na nota</b> — enquanto a equipe não usa as palavras, a etapa descreve o palpite do sistema, não o atendimento.</div>
        <div><b>1ª resposta e Atendidos</b> — contam a partir da hora em que o lead ficou com esta pessoa, e só as mensagens que ela mesma escreveu. O primeiro contato da atendente, antes do repasse, não entra na conta do corretor.</div>
        {(score&&score.componentes||[]).some(c=>c.comparativo)&&
          <div style={{marginTop:6}}><b>Vendas e ligações na nota</b> — são comparativas: valem 100 para quem mais fez na equipe no período. Mudam quando a equipe muda.</div>}
      </div>

      {/* O MESMO botão outra vez, no fim do documento.

          Não é repetição por desatenção: no celular a folha é longa, e quem
          rolou até aqui teria que voltar ao topo para imprimir. E se a barra de
          cima ficar inalcançável por qualquer motivo — foi o que aconteceu no
          iPhone —, este continua ao alcance. Ação importante com um caminho só
          é ação que some quando esse caminho falha. */}
      <button className="nao-imprimir" onClick={()=>window.print()} disabled={!pronto}
        style={{width:"100%",marginTop:22,background:pronto?C.greenDeep:C.faint,color:"#fff",border:"none",
          borderRadius:11,padding:"14px",fontSize:14,fontWeight:700,cursor:pronto?"pointer":"default",
          display:"flex",alignItems:"center",justifyContent:"center",gap:8}}>
        <Icon n="download" size={15}/>Imprimir / salvar em PDF</button>

      <div style={{borderTop:`1px solid ${C.line}`,marginTop:20,paddingTop:10,color:C.faint,fontSize:10.5,lineHeight:1.5}}>
        Gerado pelo ConHub em {hoje}. Os números são os mesmos da tela de Relatórios, no mesmo período —
        qualquer diferença entre este papel e o sistema é erro, não critério diferente.
      </div>
    </div>
  </div>;
}

/* ===== DE ONDE SAIU CADA PONTO DA NOTA =====

   Nota fechada é palavra contra palavra. Numa reunião, "você tirou 62" só se
   sustenta se der para abrir e ver que 62 é a soma de seis contas, cada uma
   com o valor, a régua e o peso à vista. */
function DetalheDaNota({m,componentes,periodo,aoFechar,isMobile}){
  const cor=(n)=>n>=70?C.green:n>=45?C.amber:C.hot;
  return <div className="tela-cheia" style={{zIndex:70,background:"rgba(10,20,16,.5)",
    display:"flex",alignItems:isMobile?"flex-end":"center",justifyContent:"center",padding:isMobile?0:20}}>
    <div style={{background:C.card,borderRadius:isMobile?"16px 16px 0 0":16,width:"100%",maxWidth:560,
      maxHeight:"100%",overflowY:"auto"}}>
      <div style={{padding:isMobile?15:18}}>
        <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:4}}>
          <div style={{minWidth:0,flex:1}}>
            <div style={{color:C.ink,fontFamily:DISPLAY,fontSize:17,fontWeight:700}}>{m.nome}</div>
            <div style={{color:C.faint,fontSize:11.5}}>{fmtData(periodo.de)} a {fmtData(periodo.ate)}</div>
          </div>
          <div style={{textAlign:"right"}}>
            <div style={{fontFamily:MONO,fontSize:30,fontWeight:700,lineHeight:1,color:cor(m.score)}}>{m.score}</div>
            <div style={{color:C.faint,fontSize:10.5,marginTop:2}}>de 100</div>
          </div>
          <button onClick={aoFechar} aria-label="Fechar" style={{border:"none",background:C.surface,color:C.sub,
            width:32,height:32,borderRadius:9,cursor:"pointer",fontSize:16,flexShrink:0}}>×</button>
        </div>

        <div style={{color:C.faint,fontSize:11.5,lineHeight:1.5,margin:"10px 0 12px"}}>
          A nota é a média das seis partes abaixo, pesada. Cada valor é o mesmo que aparece na tabela do relatório — não existe número aqui que não exista lá.
        </div>

        <div style={{display:"flex",flexDirection:"column",gap:8}}>
          {(m.partes||[]).map(p=><div key={p.chave} style={{background:C.surface,borderRadius:11,padding:"10px 12px"}}>
            <div style={{display:"flex",alignItems:"baseline",gap:8,flexWrap:"wrap"}}>
              <span style={{color:C.ink,fontSize:12.5,fontWeight:700,flex:1,minWidth:0}}>{p.rotulo}</span>
              <span style={{fontFamily:MONO,color:C.ink,fontSize:14,fontWeight:700}}>{p.valor_texto}</span>
              <span style={{fontFamily:MONO,color:cor(p.nota),fontSize:12,fontWeight:700,minWidth:52,textAlign:"right"}}>{p.nota}/100</span>
            </div>
            <div style={{height:7,borderRadius:999,background:C.card,overflow:"hidden",margin:"7px 0 6px"}}>
              <div style={{width:Math.max(p.nota,2)+"%",height:"100%",borderRadius:999,background:cor(p.nota)}}/>
            </div>
            <div style={{color:C.sub,fontSize:11,lineHeight:1.45}}>{p.como}</div>
            <div style={{color:C.faint,fontSize:10.5,lineHeight:1.45,marginTop:3}}>
              {p.regua} · peso {p.peso}% · entrou com <b style={{fontFamily:MONO,color:C.sub}}>{p.contribuiu}</b> ponto(s) na nota
            </div>
          </div>)}
        </div>

        {/* Régua comparativa muda de significado quando a equipe muda. Quem vai
            usar isso numa reunião precisa saber disso antes de alguém apontar. */}
        {(componentes||[]).some(c=>c.comparativo)&&
          <div style={{background:C.amberSoft,color:"#8a6d1f",fontSize:11,lineHeight:1.5,borderRadius:10,padding:"9px 11px",marginTop:12}}>
            Vendas e ligações são notas <b>comparativas</b>: valem 100 para quem mais fez na equipe no período.
            Quer dizer que essas duas mudam quando a equipe muda, mesmo sem o corretor mudar nada.
          </div>}
      </div>
    </div>
  </div>;
}

function Relatorios({acoes,session,pickable,isMobile,abrirConversa,org}){
  // Nota aberta de alguém da equipe: {m, componentes}.
  const [nota,setNota]=useState(null);
  // Relatório de reunião do corretor selecionado, aberto em tela cheia.
  const [paraReuniao,setParaReuniao]=useState(false);
  const [periodo,setPeriodo]=useState({de:diasAtras(30),ate:hojeISO()});
  const [dados,setDados]=useState(null);
  const [carregando,setCarregando]=useState(true);
  const [sel,setSel]=useState(null);
  // Etapa aberta para ver QUEM está nela. Número sozinho não resolve: o gestor
  // vê "3 em Aprovação" e a pergunta seguinte é sempre "quais três?".
  const [etapaAberta,setEtapaAberta]=useState(null);
  useEffect(()=>{setEtapaAberta(null);},[sel,periodo.de,periodo.ate]);

  useEffect(()=>{
    let vivo=true; setCarregando(true);
    acoes.relatorio(periodo).then(d=>{if(vivo){setDados(d);setCarregando(false);
      setSel(p=>p&&d.atendentes.some(a=>a.id===p)?p:(d.atendentes[0]||{}).id);}}).catch(()=>vivo&&setCarregando(false));
    return()=>{vivo=false;};
  },[periodo.de,periodo.ate]);

  /* 6px de altura de padding dá um alvo de 26px. O dedo erra abaixo de ~32,
     e estes três são os botões mais apertados da tela de relatórios. */
  const atalho=(label,dias)=><button key={label} onClick={()=>setPeriodo({de:diasAtras(dias),ate:hojeISO()})}
    style={{fontSize:isMobile?13:12,fontWeight:600,padding:isMobile?"10px 16px":"6px 11px",borderRadius:999,border:"none",cursor:"pointer",
      background:periodo.de===diasAtras(dias)?C.greenDeep:C.surface,color:periodo.de===diasAtras(dias)?"#fff":C.sub}}>{label}</button>;

  if(carregando&&!dados) return <div style={{height:"100%",display:"flex",alignItems:"center",justifyContent:"center",color:C.faint,fontSize:13,gap:8}}><Icon n="loader" size={16} spin/> Calculando…</div>;
  if(!dados) return <div style={{padding:24,color:C.faint}}>Não consegui carregar o relatório.</div>;

  const linha=dados.atendentes.find(a=>a.id===sel)||dados.atendentes[0];

  return <div style={{height:"100%",overflowY:"auto",padding:isMobile?14:20}}>
    <div style={{maxWidth:920,margin:"0 auto"}}>
      {/* Ponto das atendentes. Fica no topo dos relatórios porque é a primeira
          coisa que a gestão confere de manhã: quem abriu, a que horas e de onde. */}
      <PontoDaEquipe acoes={acoes} isMobile={isMobile} ehGestor={session.role==="adm"}/>
      <div style={{background:C.card,border:`1px solid ${C.line}`,borderRadius:16,padding:14,marginBottom:16}}>
        <div style={{display:"flex",gap:7,flexWrap:"wrap",marginBottom:10}}>
          {atalho("7 dias",7)}{atalho("30 dias",30)}{atalho("90 dias",90)}
        </div>
        {/* Cada data com o rótulo colado nela. Numa linha só, o celular quebrava
            como "De [data] até" / "[data]" — o "até" órfão no fim da primeira
            linha, longe da data que ele apresenta. */}
        <div style={{display:"flex",gap:8,alignItems:"flex-end",flexWrap:"wrap"}}>
          {[["De","de"],["até","ate"]].map(([rot,campo])=>
            <div key={campo} style={{display:"flex",flexDirection:"column",gap:3,flex:isMobile?"1 1 140px":"0 0 auto",minWidth:0}}>
              <span style={{color:C.faint,fontSize:11,fontWeight:600}}>{rot}</span>
              <input type="date" value={periodo[campo]} onChange={e=>setPeriodo({...periodo,[campo]:e.target.value})}
                style={{fontSize:isMobile?16:12.5,border:`1px solid ${C.line}`,borderRadius:8,
                  padding:isMobile?"10px 8px":"6px 8px",background:C.surface,color:C.ink,outline:"none",minWidth:0,width:"100%"}}/>
            </div>)}
        </div>
      </div>

      <div style={{display:"flex",gap:12,flexWrap:"wrap",marginBottom:16}}>
        {/* Total da imobiliária é informação de gestão: faturamento e volume da
            casa não entram na tela de produtividade do corretor. O backend nem
            manda mais; aqui a guarda evita quebrar se vier nulo. */}
        {dados.total&&<Metric n="users" label="Leads no período" value={dados.total.leads} accent={C.cool}/>}
        {dados.total&&<Metric n="transfer" label="Ainda na fila" value={dados.total.na_fila} accent={dados.total.na_fila?C.hot:C.green}/>}
        {dados.total&&<Metric n="check" label="Vendas" value={dados.total.vendas} accent={C.greenDeep}/>}
        {dados.total&&<Metric n="award" label="Valor vendido" value={fmtMoeda(dados.total.valor_vendido)} accent={C.green}/>}
      </div>

      {/* Só quem supervisiona vê o ranking: é material de decisão sobre pessoas,
          não painel de auto-avaliação do corretor. */}
      {pickable&&<ScoreEquipe acoes={acoes} isMobile={isMobile} periodo={periodo} aoAbrirDetalhe={(m,c)=>setNota({m,componentes:c})}/>}
      {nota&&<DetalheDaNota m={nota.m} componentes={nota.componentes} periodo={dados.periodo} isMobile={isMobile} aoFechar={()=>setNota(null)}/>}
      {paraReuniao&&linha&&<RelatorioParaReuniao acoes={acoes} linha={linha} dados={dados} periodo={periodo}
        org={org} isMobile={isMobile} aoFechar={()=>setParaReuniao(false)}/>}
      <BlocoAtendimento linhas={dados.atendimento} isMobile={isMobile}/>
      {/* No celular a faixa QUEBRA em linhas em vez de rolar para o lado. Rolando,
          o último corretor aparecia cortado ao meio e nada indicava que havia
          mais — quem não conhece a lista não descobre que falta gente. */}
      {pickable&&dados.atendentes.length>0&&<div style={{display:"flex",gap:8,marginBottom:16,
        ...(isMobile?{flexWrap:"wrap"}:{overflowX:"auto",paddingBottom:4})}}>
        {dados.atendentes.map(a=><button key={a.id} onClick={()=>setSel(a.id)} style={{flexShrink:0,display:"flex",alignItems:"center",gap:8,border:`1px solid ${sel===a.id?C.green:C.line}`,background:sel===a.id?C.greenSoft:C.card,borderRadius:999,padding:"4px 12px 4px 4px",cursor:"pointer"}}>
          <Avatar ini={initials(a.nome)} color={COLORS[[...a.id].reduce((s,c)=>s+c.charCodeAt(0),0)%COLORS.length]} size={26}/>
          <span style={{color:C.ink,fontSize:13,fontWeight:500}}>{first(a.nome)}</span></button>)}
      </div>}

      {linha&&<LeadsPorDia linha={linha} isMobile={isMobile}/>}
      {!linha?((dados.atendimento||[]).length?null
        :<div style={{background:C.card,border:`1px solid ${C.line}`,borderRadius:16,padding:32,textAlign:"center",color:C.faint,fontSize:13}}>Nenhum corretor cadastrado ainda.</div>)
      :<React.Fragment>
        {/* No celular isto empilha: nome em cima, o tempo de resposta embaixo e o
            botão do relatório em largura inteira. Numa linha só, os três se
            espremiam — o botão ficava minúsculo entre o nome e o número, que é
            justamente o botão que a gestão procura. */}
        <div style={{background:C.card,border:`1px solid ${C.line}`,borderRadius:16,padding:16,marginBottom:16,display:"flex",
          alignItems:isMobile?"stretch":"center",flexDirection:isMobile?"column":"row",gap:12,flexWrap:"wrap"}}>
          <div style={{display:"flex",alignItems:"center",gap:12,minWidth:0}}>
          <Avatar ini={initials(linha.nome)} color={COLORS[[...linha.id].reduce((s,c)=>s+c.charCodeAt(0),0)%COLORS.length]} size={46}/>
          <div style={{minWidth:0}}>
            <div style={{color:C.ink,fontFamily:DISPLAY,fontSize:isMobile?16:18,fontWeight:700}}>{linha.nome}</div>
            <div style={{color:C.faint,fontSize:12}}>{linha.papel==="sdr"?"SDR":"Corretor(a)"} · {fmtData(dados.periodo.de)} a {fmtData(dados.periodo.ate)}</div>
          </div>
          </div>
          {/* O relatório de reunião sai daqui, do lado do nome de quem ele
              descreve — e não num menu geral, onde daria para imprimir sem
              reparar de quem é. */}
          <button className="nao-imprimir" onClick={()=>setParaReuniao(true)}
            style={{border:`1px solid ${C.green}55`,background:C.greenSoft,color:C.greenDeep,borderRadius:9,
              padding:isMobile?"12px 13px":"7px 13px",fontSize:isMobile?13.5:12,fontWeight:700,cursor:"pointer",
              display:"flex",alignItems:"center",justifyContent:"center",gap:6,order:isMobile?2:0,width:isMobile?"100%":"auto"}}>
            <Icon n="download" size={13}/>Relatório para reunião</button>
          <div style={{marginLeft:isMobile?0:"auto",textAlign:isMobile?"left":"right"}}>
            <div style={{color:linha.primeira_resposta_mediana_min<=10?C.green:linha.primeira_resposta_mediana_min<=30?C.amber:C.hot,fontFamily:MONO,fontSize:isMobile?26:30,fontWeight:600,lineHeight:1}}>{fmtMin(linha.primeira_resposta_mediana_min)}</div>
            <div style={{color:C.faint,fontSize:11,marginTop:4}}>1ª resposta (mediana)</div>
            {linha.atendimento_mediana_min!=null&&<div style={{color:C.sub,fontSize:11.5,marginTop:7,paddingTop:7,borderTop:`1px solid ${C.line}`}}>
              Atendimento: <b style={{fontFamily:MONO}}>{fmtMin(linha.atendimento_mediana_min)}</b>
              <div style={{color:C.faint,fontSize:10.5,marginTop:2}}>espera média a cada pergunta do cliente</div>
            </div>}
          </div>
        </div>

        <div style={{display:"flex",gap:12,flexWrap:"wrap",marginBottom:16}}>
          <Metric n="users" label="Recebidos" value={linha.recebidos} accent={C.cool} sub="entraram no período"/>
          <Metric n="msg" label="Atendidos" value={linha.atendidos} sub={linha.taxa_atendimento+"% de resposta"} accent={C.green}/>
          <Metric n="calendar" label="Agendados / visitas" value={linha.agendamentos}
            sub={`${linha.agendamentos_confirmados||0} confirmado(s) por pessoa`} accent="#3B7BC4"/>
          <Metric n="check" label="Vendas" value={linha.vendas} sub={fmtMoeda(linha.valor_vendido)} accent={C.greenDeep}/>
        </div>
        {/* Cada número responde a uma pergunta diferente, e misturar as duas foi
            o que fez o relatório parecer errado. Dizer isso na tela custa uma
            linha e evita a conta de cabeça que ninguém faz igual. */}
        <div style={{color:C.faint,fontSize:11,lineHeight:1.5,marginTop:-8,marginBottom:16}}>
          <b>Vendas</b> são as fechadas dentro do período, venha o lead de quando vier.
          <b> Recebidos</b> e as etapas do funil falam de quem entrou no período.
          <b> Atendidos</b> e <b>1ª resposta</b> contam a partir da hora em que o lead ficou com esta pessoa,
          e só as mensagens que ela mesma escreveu — o primeiro contato da atendente não entra aqui.
        </div>
        {/* A diferença entre o que está no funil e o que alguém confirmou É a
            informação. Enquanto a equipe não usa as palavras-chave, a etapa
            descreve o palpite da regra, e um ranking montado em cima disso não
            descreve o trabalho de ninguém. */}
        {linha.agendamentos>(linha.agendamentos_confirmados||0)&&
          <div style={{background:C.amberSoft,color:"#8a6d1f",fontSize:11.5,lineHeight:1.5,borderRadius:10,
            padding:"9px 11px",marginTop:-8,marginBottom:16}}>
            Dos <b>{linha.agendamentos}</b> em Agendamento/Visita, <b>{linha.agendamentos_confirmados||0}</b> foram
            colocados ali por uma pessoa. Os outros <b>{linha.agendamentos-(linha.agendamentos_confirmados||0)}</b> vieram
            da regra automática de palavra-chave — e é por isso que a nota conta só os confirmados.
          </div>}

        <div style={{background:C.card,border:`1px solid ${C.line}`,borderRadius:16,padding:16}}>
          <div style={{color:C.ink,fontSize:13,fontWeight:700,marginBottom:12}}>Avanço pelas etapas do funil</div>
          {STAGES.map(st=>{const v=linha.por_etapa[st]||0,pct=linha.recebidos?v/linha.recebidos*100:0;
            const aberta=etapaAberta===st;
            return <React.Fragment key={st}>
              <button onClick={()=>v&&setEtapaAberta(aberta?null:st)} disabled={!v}
                title={v?"Ver quem está nesta etapa":undefined}
                style={{display:"flex",alignItems:"center",gap:8,marginBottom:8,width:"100%",background:"transparent",
                  border:"none",padding:0,cursor:v?"pointer":"default",textAlign:"left"}}>
                <span style={{color:aberta?C.ink:C.sub,fontSize:11.5,fontWeight:aberta?700:400,width:isMobile?104:150,flexShrink:0,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{st}</span>
                <div style={{height:10,borderRadius:999,background:C.surface,flex:1,overflow:"hidden"}}><div style={{width:Math.max(pct,v?6:0)+"%",height:"100%",borderRadius:999,background:STAGE_C[st]}}/></div>
                <span style={{color:C.ink,fontFamily:MONO,fontSize:12,fontWeight:600,width:20,textAlign:"right"}}>{v}</span>
              </button>
              {aberta&&<LeadsDaEtapa acoes={acoes} etapa={st} atendente={linha.id} periodo={periodo}
                isMobile={isMobile} abrirConversa={abrirConversa}/>}
            </React.Fragment>;})}
        </div>
      </React.Fragment>}
    </div>
  </div>;
}

/* ===== DASHBOARD (ADM) ===== */
function Dashboard({acoes,pessoas,fila,setView,openLead,isMobile}){
  const [d,setD]=useState(null);
  useEffect(()=>{
    let vivo=true;
    const carregar=()=>acoes.relatorio({de:diasAtras(30),ate:hojeISO()}).then(r=>vivo&&setD(r)).catch(()=>{});
    carregar(); const t=setInterval(carregar,30000);
    return()=>{vivo=false;clearInterval(t);};
  },[]);

  if(!d) return <div style={{height:"100%",display:"flex",alignItems:"center",justifyContent:"center",color:C.faint,fontSize:13,gap:8}}><Icon n="loader" size={16} spin/> Carregando o painel…</div>;

  const team=d.atendentes;
  const medianas=team.map(a=>a.primeira_resposta_mediana_min).filter(x=>x>0);
  const medianaGeral=medianas.length?Math.round(medianas.reduce((a,b)=>a+b,0)/medianas.length):0;
  const ranked=[...team].sort((a,b)=>b.vendas-a.vendas||b.conversao-a.conversao);
  const maxBar=Math.max(1,...team.map(a=>a.recebidos));
  const totalPorEtapa=(st)=>team.reduce((s,a)=>s+(a.por_etapa[st]||0),0);
  const corDe=(id)=>COLORS[[...id].reduce((s,c)=>s+c.charCodeAt(0),0)%COLORS.length];
  const disponivel=(id)=>(pessoas.find(p=>p.id===id)||{}).available;

  return <div style={{height:"100%",overflowY:"auto",padding:isMobile?14:20}}>
    <div style={{maxWidth:1020,margin:"0 auto"}}>
      {/* Primeiro do painel: o que precisa de decisão hoje. O resto é retrato,
          isto é pauta. */}
      <PainelRecomendacoes acoes={acoes} openLead={openLead} isMobile={isMobile}/>
      {fila.length>0&&<button onClick={()=>setView("conversas")} style={{width:"100%",textAlign:"left",background:C.hotSoft,border:`1px solid ${C.hot}40`,borderRadius:12,padding:12,marginBottom:16,display:"flex",alignItems:"center",gap:12,cursor:"pointer"}}>
        <Icon n="flame" size={18} color={C.hot}/><span style={{color:C.ink,fontSize:13,fontWeight:500,flex:1}}>{fila.length} lead(s) na fila aguardando distribuição.</span><Icon n="chevron" size={15} color={C.hot}/>
      </button>}
      <div style={{display:"flex",gap:12,flexWrap:"wrap",marginBottom:16}}>
        <Metric n="users" label="Leads (30 dias)" value={d.total.leads} accent={C.cool}/>
        <Metric n="clock" label="1ª resposta (mediana)" value={fmtMin(medianaGeral)} sub="meta: até 10 min" accent={medianaGeral<=10?C.green:C.amber}/>
        <Metric n="check" label="Vendas" value={d.total.vendas} accent={C.greenDeep}/>
        <Metric n="award" label="Valor vendido" value={fmtMoeda(d.total.valor_vendido)} accent={C.green}/>
      </div>
      <div style={{background:C.card,border:`1px solid ${C.line}`,borderRadius:16,padding:16,marginBottom:16}}>
        <div style={{color:C.ink,fontSize:13,fontWeight:700,marginBottom:12}}>Avanço de leads por etapa (equipe)</div>
        <div style={{display:"flex",gap:6,overflowX:"auto",paddingBottom:4}}>
          {STAGES.map(st=>{const v=totalPorEtapa(st);
            return <div key={st} style={{flexShrink:0,width:92}}><div style={{background:STAGE_C[st]+"14",border:`1px solid ${STAGE_C[st]}40`,borderRadius:12,padding:8,textAlign:"center"}}><div style={{color:STAGE_C[st],fontFamily:MONO,fontSize:20,fontWeight:700,lineHeight:1}}>{v}</div><div style={{color:C.sub,fontSize:10,marginTop:4,lineHeight:1.1}}>{st}</div></div></div>;})}
        </div>
      </div>
      {team.length===0?<div style={{background:C.card,border:`1px solid ${C.line}`,borderRadius:16,padding:32,textAlign:"center"}}>
        <Icon n="userplus" size={26} color={C.faint}/>
        <div style={{color:C.ink,fontSize:14,fontWeight:600,marginTop:10}}>Nenhum corretor cadastrado ainda</div>
        <div style={{color:C.faint,fontSize:12.5,marginTop:6,lineHeight:1.5}}>Mande o link de cadastro para a equipe. Assim que eles criarem a conta,<br/>aparecem aqui e passam a receber leads na catraca.</div>
      </div>
      :<div style={{display:"grid",gridTemplateColumns:isMobile?"1fr":"3fr 2fr",gap:16}} className="dashgrid">
        <div style={{background:C.card,border:`1px solid ${C.line}`,borderRadius:16,padding:16}}>
          <div style={{color:C.ink,fontSize:13,fontWeight:700,marginBottom:14}}>Comparativo por corretor</div>
          <div style={{display:"flex",flexDirection:"column",gap:14}}>
            {team.map(a=><div key={a.id}>
              <div style={{display:"flex",justifyContent:"space-between",fontSize:12,marginBottom:4,gap:8}}><span style={{color:C.ink,fontWeight:600}}>{first(a.nome)}</span><span style={{color:C.faint,fontFamily:MONO}}>{a.recebidos} leads · {a.vendas} vendas</span></div>
              <div style={{display:"flex",height:16,borderRadius:6,overflow:"hidden",background:C.surface}}>
                <div style={{width:a.recebidos/maxBar*100+"%",background:C.cool,height:"100%"}} title="recebidos"/>
                <div style={{width:a.atendidos/maxBar*100+"%",background:C.green,height:"100%"}} title="atendidos"/>
                <div style={{width:a.vendas/maxBar*100+"%",background:C.greenDeep,height:"100%"}} title="vendas"/>
              </div>
            </div>)}
          </div>
          <div style={{display:"flex",gap:14,marginTop:12}}>{[["Recebidos",C.cool],["Atendidos",C.green],["Vendas",C.greenDeep]].map(([l,c])=><div key={l} style={{display:"flex",alignItems:"center",gap:5}}><span style={{width:10,height:10,borderRadius:3,background:c}}/><span style={{color:C.sub,fontSize:11}}>{l}</span></div>)}</div>
        </div>
        <div style={{background:C.card,border:`1px solid ${C.line}`,borderRadius:16,padding:16}}>
          <div style={{color:C.ink,fontSize:13,fontWeight:700,marginBottom:12}}>Ranking & tempo de resposta</div>
          <div style={{display:"flex",flexDirection:"column",gap:8}}>
            {ranked.map((a,i)=><button key={a.id} onClick={()=>setView("relatorios")} style={{width:"100%",display:"flex",alignItems:"center",gap:10,borderRadius:12,padding:10,textAlign:"left",border:"none",cursor:"pointer",background:C.surface}}>
              <span style={{color:i===0?C.green:C.faint,fontFamily:MONO,fontSize:14,fontWeight:700,width:20}}>{i+1}º</span>
              <Avatar ini={initials(a.nome)} color={corDe(a.id)} size={30}/>
              <div style={{minWidth:0,flex:1}}>
                <div style={{color:C.ink,fontSize:13,fontWeight:600,display:"flex",alignItems:"center",gap:4}}>{first(a.nome)} <span style={{color:disponivel(a.id)?C.green:C.faint,display:"inline-flex"}}><Icon n={disponivel(a.id)?"toggleOn":"toggleOff"} size={13}/></span></div>
                <div style={{color:a.primeira_resposta_mediana_min<=10?C.green:C.amber,fontSize:11,fontWeight:500}}>{fmtMin(a.primeira_resposta_mediana_min)} · {a.conversao}% conv.</div>
              </div>
              <div style={{textAlign:"right"}}><div style={{color:C.greenDeep,fontFamily:MONO,fontSize:16,fontWeight:700}}>{a.vendas}</div><div style={{color:C.faint,fontSize:10}}>vendas</div></div>
            </button>)}
          </div>
        </div>
      </div>}
    </div>
  </div>;
}

/* ===== REDE DE SEGURANÇA =====
   Sem isto, um erro de JavaScript em qualquer canto derruba a árvore inteira e
   o corretor vê uma TELA BRANCA — que não diz nada nem para ele nem para quem
   vai consertar. Aqui o erro vira uma tela legível, com o texto que dá para
   mandar num print, e um botão para voltar a usar o sistema.

   Não é enfeite: descobrir um erro pelo relato "ficou branco" custa horas. */
class Rede extends React.Component{
  constructor(p){ super(p); this.state={erro:null}; }
  static getDerivedStateFromError(erro){ return {erro}; }
  componentDidCatch(erro,info){ console.error("[ConHub] erro na tela:",erro,info); }
  render(){
    if(!this.state.erro) return this.props.children;
    const e=this.state.erro;
    return <div style={{fontFamily:FONT,padding:24,maxWidth:520,margin:"0 auto",color:C.ink}}>
      <div style={{fontFamily:DISPLAY,fontSize:19,fontWeight:700,marginBottom:8}}>Algo quebrou nesta tela</div>
      <div style={{color:C.sub,fontSize:13.5,lineHeight:1.6,marginBottom:14}}>
        O resto do sistema continua funcionando. Mande um print desta tela para o suporte —
        o texto abaixo diz exatamente o que aconteceu.
      </div>
      <div style={{background:C.hotSoft,color:C.hot,border:`1px solid ${C.hot}33`,borderRadius:10,padding:12,
        fontFamily:MONO,fontSize:11.5,lineHeight:1.5,whiteSpace:"pre-wrap",wordBreak:"break-word",marginBottom:14}}>
        {String(e&&e.message||e)}
      </div>
      <button onClick={()=>{this.setState({erro:null});}}
        style={{width:"100%",background:C.green,color:"#fff",border:"none",borderRadius:11,padding:"13px",
          fontSize:14,fontWeight:600,cursor:"pointer",marginBottom:9}}>Voltar</button>
      <button onClick={()=>window.location.reload()}
        style={{width:"100%",background:C.surface,color:C.sub,border:`1px solid ${C.line}`,borderRadius:11,
          padding:"13px",fontSize:14,fontWeight:600,cursor:"pointer"}}>Recarregar o ConHub</button>
    </div>;
  }
}

/* ===== AVISO DE VERSÃO NOVA =====

   O que aconteceu em 03/08: o backend já estava atualizado e o navegador da
   Vanessa ainda rodava o app antigo. O servidor recusava a ação com a regra
   nova, ela via a mensagem de erro, e a tela não tinha nem o botão que a
   mensagem pedia. Não havia como ela descobrir sozinha.

   A conferência é direta: relê o próprio index.html sem passar pelo cache e
   compara o carimbo gravado no build (window.CONHUB_BUILD). Se o servidor tem
   um arquivo mais novo, oferece atualizar. Não depende de lista de recursos
   nem de nada para manter em sincronia.

   Atualizar limpa o service worker e os caches antes de recarregar: só dar
   F5 muitas vezes devolve o mesmo arquivo guardado. */
function AvisoVersao(){
  const [nova,setNova]=useState(false);
  const meu=typeof window!=="undefined"?window.CONHUB_BUILD:null;

  useEffect(()=>{
    if(!meu||location.protocol==="file:") return;
    let vivo=true;
    /* Confere pelo /versao.txt, que o build grava e o servidor entrega sem
       cache.

       Antes isto relia o /index.html. No Netlify funcionava — era o próprio
       arquivo do site. Depois que o CRM passou a ser servido pelo backend a
       página virou /app (o index.html nem existe mais lá dentro), e o pedido
       passou a voltar 401. O erro era engolido pelo catch e o aviso de versão
       nova NUNCA aparecia: cada publicação dependia da pessoa desconfiar
       sozinha e apertar Ctrl+Shift+R.

       Falhar calado foi o pior desta história — um aviso que não avisa é
       indistinguível de "não há nada de novo". */
    const conferir=async()=>{
      try{
        const r=await fetch("/versao.txt?v="+Date.now(),{cache:"no-store"});
        if(!r.ok) return;
        const publicada=(await r.text()).trim();
        if(vivo&&publicada&&publicada!==meu) setNova(true);
      }catch(e){}
    };
    conferir();
    const t=setInterval(conferir,5*60*1000);
    /* Confere também ao voltar para a aba. No celular o CRM passa o dia em
       segundo plano: sem isto, a pessoa poderia ficar horas com a versão velha
       entre uma conferência e outra. */
    const aoVoltar=()=>{ if(document.visibilityState==="visible") conferir(); };
    document.addEventListener("visibilitychange",aoVoltar);
    window.addEventListener("focus",aoVoltar);
    return()=>{vivo=false;clearInterval(t);
      document.removeEventListener("visibilitychange",aoVoltar);
      window.removeEventListener("focus",aoVoltar);};
  },[]);

  if(!nova) return null;

  return <div style={{position:"fixed",left:0,right:0,bottom:0,zIndex:60,background:C.greenDeep,color:"#fff",
    padding:"11px 14px",display:"flex",alignItems:"center",gap:10,flexWrap:"wrap",
    paddingBottom:"calc(env(safe-area-inset-bottom, 0px) + 11px)",boxShadow:"0 -6px 24px rgba(0,0,0,.2)"}}>
    <Icon n="zap" size={15}/>
    <span style={{flex:1,fontSize:13,fontWeight:600,minWidth:140}}>Tem uma versão nova do ConHub.</span>
    <button onClick={atualizarConHub} style={{background:"#fff",color:C.greenDeep,border:"none",borderRadius:9,
      padding:"8px 16px",fontSize:13,fontWeight:700,cursor:"pointer",whiteSpace:"nowrap"}}>Atualizar agora</button>
  </div>;
}

ReactDOM.createRoot(document.getElementById("root")).render(<Rede><ConCRM/><AvisoVersao/></Rede>);
