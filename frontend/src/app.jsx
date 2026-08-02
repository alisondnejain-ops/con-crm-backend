const { useState, useEffect, useMemo, useRef } = React;

/* ===== IDENTIDADE ===== */
const C = {
  ink:"#14181F", sub:"#5A6472", faint:"#8A93A0", line:"#E6E9E7", surface:"#F4F6F5", card:"#FFFFFF",
  green:"#0E8F6E", greenDeep:"#0A3D30", greenMid:"#0C6B52", greenSoft:"#E5F2EC",
  hot:"#E1553A", hotSoft:"#FBE7E1", amber:"#C8912B", amberSoft:"#F7EFD9", cool:"#5C6B7A", coolSoft:"#ECEFF2", white:"#FFF",
};
const DISPLAY="'Sora',sans-serif", FONT="'Inter',sans-serif", MONO="'IBM Plex Mono',monospace";
const ADM_CODE="CONECTA-JAZ-2026";

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
   As páginas são copiadas para cá no build (ver build.mjs). */
const CADASTRO_URL=(typeof window!=="undefined"?window.location.origin:"")+`/cadastro?c=${ADM_CODE}`;

// Token guardado no navegador para o corretor não ter que logar toda vez (importante no celular).
const STORE="concrm_token";
let TOKEN=null;
try{ TOKEN=localStorage.getItem(STORE); }catch(e){}
function setToken(t){ TOKEN=t; try{ t?localStorage.setItem(STORE,t):localStorage.removeItem(STORE); }catch(e){} }

async function api(path,{method="GET",body}={}){
  let res;
  try{
    res=await fetch(API+path,{method,
      headers:{...(body?{"Content-Type":"application/json"}:{}),...(TOKEN?{Authorization:"Bearer "+TOKEN}:{})},
      body:body?JSON.stringify(body):undefined});
  }catch(e){ throw new Error("Sem conexão com o servidor. Confira sua internet e tente de novo."); }
  const data=await res.json().catch(()=>({}));
  if(!res.ok) throw new Error(data.error||`Erro ${res.status} ao falar com o servidor.`);
  return data;
}

/* ===== tradução backend -> telas =====
   O backend fala em name/phone/stage; as telas nasceram falando nome/tel/status.
   Traduzimos aqui, num lugar só, em vez de espalhar a mudança por tudo. */
const QUAL_VAZIA={renda:"—",entrada:"—",situacao:"—",cpf:"—",prazo:"—"};
function adaptLead(l,anterior){
  return {
    id:l.id, nome:l.name||"Sem nome", tel:l.phone||"", email:l.email||"",
    prio:l.priority||"MORNO", origem:l.origem||"WhatsApp",
    createdAt:l.created_at, firstRespAt:l.first_resp_at,
    assignedTo:l.assigned_to, assignedName:l.assigned_name,
    status:l.stage||"Lead",
    qual:{...QUAL_VAZIA,...(l.qual||{})},
    unread:l.unread||0, lastBody:l.last_body, lastDirection:l.last_direction, lastAt:l.last_at,
    finalizado:!!l.closed_at, finalizadoEm:l.closed_at||null,
    venda:l.sale_value?{valor:l.sale_value,data:l.sale_date,imovel:l.sale_property}:null,
    // As mensagens só chegam ao abrir a conversa; preservamos as já carregadas.
    msgs:l.messages?l.messages.map(adaptMsg):(anterior?anterior.msgs:[]),
    carregado:!!l.messages||(anterior?anterior.carregado:false),
  };
}
const adaptMsg=(m)=>({
  from:m.direction==="in"?"lead":"corretor",
  text:m.body, at:m.created_at, by:m.from_user_id, byName:m.from_name,
  midia:m.media_url?{url:m.media_url,mime:m.media_mime||"",nome:m.media_name||""}:null,
  // "Foto"/"Vídeo"/"Áudio" existem para a prévia da lista de conversas. Dentro
  // do balão seriam redundantes — a mídia já está à vista.
  rotuloAuto:!!m.media_url&&["Foto","Vídeo","Áudio"].includes(m.body),
});
const PRIO={QUENTE:{c:C.hot,bg:C.hotSoft,label:"Quente"},MORNO:{c:C.amber,bg:C.amberSoft,label:"Morno"},FRIO:{c:C.cool,bg:C.coolSoft,label:"Frio"}};
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

/* O avanço automático de etapa agora acontece no backend (services/stages.js).
   O frontend só exibe a etapa que o servidor devolve — uma fonte da verdade só. */


const TEMPLATES=[
  {t:"Primeiro contato (forte)",body:"Oi {nome}! Aqui é o time da Conecta Imóveis. Você se cadastrou pra realizar o sonho da casa própria no Jardim Amazonas e eu não quero que você perca as condições dessa fase. Posso te mostrar agora quanto ficaria a sua entrada e a parcela que cabe no seu bolso?"},
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
// Abre o discador do celular com o número já preenchido.
function BotaoLigar({tel,compacto,leadId,acoes}){
  if(!tel) return null;
  return <a href={"tel:+"+String(tel).replace(/\D/g,"")} title="Ligar para o lead" aria-label="Ligar"
    onClick={()=>{ if(leadId&&acoes&&acoes.registrarLigacao) acoes.registrarLigacao(leadId); }}
    style={{display:"flex",alignItems:"center",gap:6,textDecoration:"none",border:`1px solid ${C.line}`,background:C.surface,color:C.greenMid,fontSize:12,fontWeight:600,padding:compacto?"8px":"7px 12px",borderRadius:10}}>
    <Icon n="phone" size={14}/>{!compacto&&"Ligar"}
  </a>;
}

/* ===== ícones (SVG inline) ===== */
const ICO={
  send:<React.Fragment><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></React.Fragment>,
  search:<React.Fragment><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></React.Fragment>,
  phone:<path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.8 19.8 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.11 4.18 2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.81.36 1.6.7 2.34a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.74-1.74a2 2 0 0 1 2.11-.45c.74.34 1.53.57 2.34.7A2 2 0 0 1 22 16.92z"/>,
  clock:<React.Fragment><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></React.Fragment>,
  timer:<React.Fragment><line x1="10" y1="2" x2="14" y2="2"/><line x1="12" y1="14" x2="15" y2="11"/><circle cx="12" cy="14" r="8"/></React.Fragment>,
  flame:<path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.07-2.14-.22-4.05 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.15.43-2.29 1-3a2.5 2.5 0 0 0 2.5 2.5z"/>,
  check:<React.Fragment><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></React.Fragment>,
  calendar:<React.Fragment><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></React.Fragment>,
  zap:<polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>,
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
  msg:<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>,
  pin:<React.Fragment><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></React.Fragment>,
  link:<React.Fragment><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></React.Fragment>,
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
function Metric({n,label,value,sub,accent=C.green}){
  return <div style={{background:C.card,border:`1px solid ${C.line}`,borderRadius:16,padding:16,flex:1,minWidth:150}}>
    <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:12}}>
      <div style={{background:accent+"18",color:accent,width:32,height:32,borderRadius:8,display:"flex",alignItems:"center",justifyContent:"center"}}><Icon n={n} size={16}/></div>
      <span style={{color:C.sub,fontSize:12,fontWeight:500}}>{label}</span>
    </div>
    <div style={{color:C.ink,fontFamily:MONO,fontSize:26,fontWeight:600,lineHeight:1}}>{value}</div>
    {sub&&<div style={{color:C.faint,fontSize:11,marginTop:4}}>{sub}</div>}
  </div>;
}
function Brand({size=44}){
  return <div style={{display:"flex",alignItems:"center",gap:10}}>
    <div style={{background:C.green,width:size,height:size,borderRadius:12,display:"flex",alignItems:"center",justifyContent:"center",color:"#fff"}}><Icon n="dot" size={size*0.5}/></div>
    <div style={{fontFamily:DISPLAY,lineHeight:1}}>
      <div style={{color:C.ink,fontSize:20,fontWeight:700}}>Con<span style={{color:C.green}}>Hub</span></div>
      <div style={{color:C.faint,fontSize:10,fontWeight:500,letterSpacing:.5}}>CONECTA IMÓVEIS</div>
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
      setToken(d.token); onLogin(d.user);
    }catch(e){ setErr(e.message); }
    finally{ setBusy(false); }
  }
  const onEnter=(e)=>{ if(e.key==="Enter") entrar(); };
  return <div style={{fontFamily:FONT,background:C.surface,width:"100%",minHeight:"100dvh",display:"flex",alignItems:isMobile?"stretch":"center",justifyContent:"center",padding:isMobile?0:24}}>
    <div style={{width:"100%",maxWidth:isMobile?"none":860,display:"grid",gridTemplateColumns:"1fr 1fr",borderRadius:isMobile?0:24,overflow:"hidden",boxShadow:isMobile?"none":"0 20px 60px rgba(0,0,0,.12)",border:isMobile?"none":`1px solid ${C.line}`}} className="authgrid">
      <div style={{background:C.greenDeep,padding:isMobile?"24px 22px":32,color:"#fff",display:"flex",flexDirection:"column",justifyContent:"space-between",gap:isMobile?16:0,minHeight:isMobile?0:460}}>
        <Brand size={isMobile?38:44}/>
        <div><div style={{fontFamily:DISPLAY,fontSize:isMobile?21:26,fontWeight:700,lineHeight:1.15,marginBottom:isMobile?8:12}}>Cada lead na mão certa, no tempo certo.</div>
          {!isMobile&&<p style={{color:"rgba(255,255,255,.75)",fontSize:13,lineHeight:1.6}}>Todos atendem pelo número da Conecta, cada mensagem assinada com o nome do corretor. A SDR distribui na catraca, e o funil avança sozinho conforme a conversa evolui.</p>}</div>
        {!isMobile&&<div style={{color:"rgba(255,255,255,.5)",fontSize:11}}>Acesso restrito à equipe da Conecta</div>}
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
        <div style={{borderTop:`1px solid ${C.line}`,marginTop:22,paddingTop:18,textAlign:"center"}}>
          <div style={{color:C.sub,fontSize:12.5,marginBottom:10}}>Ainda não tem conta?</div>
          <a href={CADASTRO_URL} style={{display:"inline-flex",alignItems:"center",gap:7,textDecoration:"none",border:`1px solid ${C.line}`,background:C.surface,color:C.greenMid,fontSize:13.5,fontWeight:600,padding:"11px 18px",borderRadius:12}}>
            <Icon n="userplus" size={15}/> Criar minha conta
          </a>
          <div style={{color:C.faint,fontSize:11,marginTop:10,lineHeight:1.5}}>Você vai receber um e-mail para confirmar e definir sua senha.</div>
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
          avatar:u.avatar_url||null,ini:initials(u.name),
          color:u.role==="adm"?C.greenDeep:COLORS[h%COLORS.length]};
}
const INTERVALO_ATUALIZACAO=10000; // busca novidades a cada 10s

function ConCRM(){
  const [session,setSession]=useState(null);
  const [carregando,setCarregando]=useState(!!TOKEN);
  const [leads,setLeads]=useState([]);
  const [fila,setFila]=useState([]);
  const [equipe,setEquipe]=useState([]);
  const [conecta,setConecta]=useState({connected:false,number:""});
  const [erro,setErro]=useState("");
  const [selId,setSelId]=useState(null);
  // Sobe a cada recarga. Telas que fazem a própria busca (Conversas) observam este
  // número para se atualizarem depois de uma ação, em vez de mostrar dado velho.
  const [versao,setVersao]=useState(0);
  const selRef=useRef(null); selRef.current=selId;
  /* Situação da mensalidade. Consultada no login e de hora em hora: se o
     pagamento cair enquanto a equipe está trabalhando, o sistema destrava
     sozinho, sem ninguém precisar sair e entrar de novo. */
  const [assinatura,setAssinatura]=useState(null);
  useEffect(()=>{
    if(!session) return;
    let vivo=true;
    const ver=()=>acoes.assinatura().then(a=>vivo&&setAssinatura(a)).catch(()=>{});
    ver();
    const t=setInterval(ver,60*60*1000);
    return()=>{vivo=false;clearInterval(t);};
  },[session]);

  useEffect(()=>{
    if(!TOKEN){setCarregando(false);return;}
    api("/auth/me").then(d=>setSession(toSession(d.user))).catch(()=>setToken(null)).finally(()=>setCarregando(false));
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
      const [ls,eq]=await Promise.all([
        // Traz os finalizados também: eles somem da caixa de entrada, mas
        // continuam no funil e nos contadores. Quem esconde é a tela, não a busca.
        api("/leads?finalizados=1"),
        supervisiona?api("/auth/users"):Promise.resolve(null),
      ]);
      mesclar(ls);
      if(eq) setEquipe(eq);
      if(supervisiona) setFila((await api("/leads/queue")).map(l=>adaptLead(l)));
      setErro(""); setVersao(v=>v+1);
    }catch(e){ setErro(e.message); }
  }

  useEffect(()=>{ if(!session) return; recarregar();
    api("/integracoes").then(d=>setConecta({connected:!!(d.whatsapp&&d.whatsapp.ok),number:d.whatsapp&&d.whatsapp.numero||""})).catch(()=>{});
    const t=setInterval(()=>{ recarregar(); if(selRef.current) abrir(selRef.current,true); },INTERVALO_ATUALIZACAO);
    return ()=>clearInterval(t);
  },[session]);

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

  const acoes={
    enviar:acao((leadId,text)=>api(`/leads/${leadId}/messages`,{method:"POST",body:{text}})),
    mudarEtapa:acao((leadId,stage)=>api(`/leads/${leadId}/stage`,{method:"PATCH",body:{stage}})),
    registrarVenda:acao((leadId,dados)=>api(`/leads/${leadId}/venda`,{method:"PATCH",body:dados})),
    transferir:acao((leadId,userId)=>api("/distribution/transfer",{method:"POST",body:{lead_id:leadId,user_id:userId}})),
    proximo:acao((leadId)=>api("/distribution/next",{method:"POST",body:{lead_id:leadId}})),
    repassar:acao((leadId,userId)=>api("/distribution/handoff",{method:"POST",body:{lead_id:leadId,...(userId?{user_id:userId}:{})}})),
    assumir:acao((leadId)=>api("/distribution/assumir",{method:"POST",body:{lead_id:leadId}})),
    devolver:acao((leadId,userId)=>api("/distribution/devolver",{method:"POST",body:{lead_id:leadId,...(userId?{user_id:userId}:{})}})),
    disponibilidade:acao((userId,available)=>api("/distribution/availability",{method:"POST",body:{user_id:userId,available}})),
    buscar:(params)=>api("/leads?"+new URLSearchParams(params)).then(r=>r.map(l=>adaptLead(l))),
    // Controle da conversa: encerrar o atendimento e o vai-e-vem do "lida".
    score:(dias)=>api("/reports/score"+(dias?`?dias=${dias}`:"")),
    recomendacoes:()=>api("/reports/recomendacoes"),
    assinatura:()=>api("/assinatura"),
    configurarAssinatura:(dados)=>api("/assinatura",{method:"PATCH",body:dados}),
    marcarMensalidadePaga:()=>api("/assinatura/pagar",{method:"POST"}),
    criarAssinaturaAsaas:(dados)=>api("/assinatura/asaas",{method:"POST",body:dados}),
    importarLeads:(linhas)=>api("/leads/import",{method:"POST",body:{linhas}}),
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
    registrarLigacao:(leadId)=>api(`/leads/${leadId}/ligacao`,{method:"POST"}).catch(()=>{}),
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
    abrir,
  };

  function sair(){ setToken(null); setSession(null); setLeads([]); setFila([]); }

  if(carregando) return <Splash/>;
  if(!session) return <Auth onLogin={(u)=>setSession(toSession(u))}/>;
  // Bloqueado: o trabalho para, mas a saída (sair, exportar, pagar) continua.
  if(assinatura&&assinatura.status==="bloqueado")
    return <Bloqueado assinatura={assinatura} session={session} acoes={acoes} aoSair={sair}
      aoRever={()=>acoes.assinatura().then(setAssinatura).catch(()=>{})}/>;

  return <Workspace {...{session,setSession:sair,equipe,conecta,leads,fila,acoes,selId,setSelId,erro,setErro,versao,assinatura}}/>;
}

/* ===== MENSALIDADE ===== */
/* Painel da assinatura, dentro de Minha conta e só para o gestor.
   Existe para você não precisar mexer no banco nem no painel do Asaas para as
   coisas do dia a dia: ver como está, dar baixa num pagamento por fora e
   ajustar o vencimento. */
function PainelAssinatura({acoes,isMobile}){
  const [a,setA]=useState(null);
  const [f,setF]=useState({plano:"",valor_mensal:"",vence_em:"",dias_carencia:5});
  const [novo,setNovo]=useState({nome:"",cpfCnpj:"",email:"",telefone:"",valor:"",vencimento:""});
  const [ocupado,setOcupado]=useState("");
  const [aviso,setAviso]=useState(null);

  const rever=()=>acoes.assinatura().then(d=>{
    setA(d);
    setF({plano:d.plano||"",valor_mensal:d.valor||"",
      vence_em:d.vence_em?new Date(d.vence_em).toISOString().slice(0,10):"",
      dias_carencia:d.carencia==null?5:d.carencia});
  }).catch(()=>{});
  useEffect(()=>{rever();},[]);
  if(!a) return null;

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
      <button onClick={roda("pagar",()=>acoes.marcarMensalidadePaga())} disabled={!!ocupado}
        style={{flex:1,background:C.surface,color:C.greenDeep,border:`1px solid ${C.green}55`,borderRadius:10,padding:"12px",fontSize:13.5,fontWeight:600,cursor:"pointer"}}>
        {ocupado==="pagar"?"Registrando…":"Registrar pagamento"}</button>
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

function Workspace({session,setSession,equipe,conecta,leads,fila,acoes,selId,setSelId,erro,setErro,versao,assinatura}){
  const role=session.role;
  const canAttend=role==="corretor"||role==="sdr";
  // Atendente tem o mesmo alcance do gestor — por isso o cadastro dele é aprovado.
  const supervisor=role==="adm"||role==="sdr";
  const [view,setView]=useState(role==="adm"?"dashboard":role==="sdr"?"catraca":"atendimento");
  const [tick,setTick]=useState(0);
  const [draft,setDraft]=useState("");
  const [enviando,setEnviando]=useState(false);
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
  const euDisponivel=(pessoas.find(p=>p.id===session.id)||{}).available;

  useEffect(()=>{const t=setInterval(()=>setTick(x=>x+1),1000);return()=>clearInterval(t);},[]);
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

  const myLeads=useMemo(()=>leads.filter(l=>l.assignedTo===session.id)
    .sort((a,b)=>{const o={QUENTE:0,MORNO:1,FRIO:2};
      // Quem está esperando resposta sobe na lista, independente da temperatura.
      return (b.unread>0)-(a.unread>0)||o[a.prio]-o[b.prio]||b.createdAt-a.createdAt;}),[leads,session,tick]);
  const sel=leads.find(l=>l.id===selId);

  async function send(){
    if(!draft.trim()||!sel||enviando)return;
    const text=draft.replace("{nome}",first(sel.nome));
    setEnviando(true); setDraft("");
    try{ await acoes.enviar(sel.id,text); }finally{ setEnviando(false); }
  }
  const setStatus=(id,status)=>acoes.mudarEtapa(id,status);
  const openLead=(id)=>{acoes.abrir(id);setView("atendimento");};
  const toggleAvail=(id,estaDisponivel)=>acoes.disponibilidade(id,!estaDisponivel);

  // O atendente tem o mesmo alcance do gestor, somado ao que já era dele.
  const NAV={
    adm:[["atendimento","msg","Atender"],["dashboard","grid","Painel"],["imoveis","pin","Imóveis"],["funil","columns","Funil"],["relatorios","chart","Relatórios"],["base","columns","Base de leads"],["equipe","users","Equipe"],["conexao","phone2","Conexão"]],
    // "Atender" da atendente já é a tela completa de conversas — ter as duas
    // separadas só criava dúvida sobre qual usar.
    sdr:[["catraca","transfer","Catraca"],["atendimento","msg","Atender"],["imoveis","pin","Imóveis"],["dashboard","grid","Painel"],["funil","columns","Funil"],["equipe","userplus","Equipe"],["disp","toggleOn","Disponib."],["relatorios","chart","Relatórios"]],
    corretor:[["atendimento","msg","Atender"],["imoveis","pin","Imóveis"],["funil","columns","Funil"],["disp","toggleOn","Disponib."],["produtividade","trend","Produção"]],
  }[role].concat([["conta","users","Minha conta"]]);
  const TITLES={dashboard:"Painel da equipe",conversas:"Conversas da equipe",relatorios:"Relatórios",equipe:"Equipe e aprovações",conexao:"Conexão da Conecta",base:"Base de leads",catraca:"Catraca de distribuição",atendimento:supervisor?"Atendimento da equipe":"Atendimento",imoveis:"Imóveis e terrenos",conta:"Minha conta",funil:supervisor?"Funil da equipe":"Meu funil",disp:"Minha disponibilidade",produtividade:"Minha produtividade"};
  // O aviso na navegação conta só o que ainda está em aberto: atendimento
  // finalizado não pode ficar cobrando resposta.
  const naoLidas=myLeads.reduce((s,l)=>s+(l.unread>0&&!l.finalizado?1:0),0);
  const aprovacoesPendentes=equipe.filter(u=>u.status==="aguardando_aprovacao").length;
  const aviso=(v)=>v==="atendimento"?naoLidas:v==="catraca"?fila.length:v==="equipe"?aprovacoesPendentes:0;

  const roleLabel=role==="adm"?"Gestor(a)":role==="sdr"?"Atendente":"Corretor(a)";

  return <div style={{fontFamily:FONT,background:C.surface,color:C.ink,width:"100%",height:"100dvh",display:"flex",flexDirection:isMobile?"column":"row",overflow:"hidden"}}>
    {!isMobile&&<aside style={{background:C.greenDeep,width:74,flexShrink:0,display:"flex",flexDirection:"column",alignItems:"center",padding:"20px 0"}}>
      <div style={{background:C.green,width:40,height:40,borderRadius:12,display:"flex",alignItems:"center",justifyContent:"center",color:"#fff",marginBottom:4}}><Icon n="dot" size={20}/></div>
      <div style={{fontFamily:DISPLAY,color:"#fff",fontSize:10,fontWeight:700,textAlign:"center",lineHeight:1.1,marginBottom:20}}>Con<br/>Hub</div>
      <div style={{display:"flex",flexDirection:"column",gap:4,flex:1}}>
        {NAV.map(([v,n,label])=><button key={v} onClick={()=>setView(v)} title={label} style={{position:"relative",width:52,padding:"8px 0",borderRadius:12,border:"none",cursor:"pointer",display:"flex",flexDirection:"column",alignItems:"center",gap:4,background:view===v?"rgba(255,255,255,.14)":"transparent",color:view===v?"#fff":"rgba(255,255,255,.55)"}}>
          <Icon n={n} size={19}/><span style={{fontSize:9,fontWeight:500}}>{label}</span>
          {aviso(v)>0&&<Badge n={aviso(v)} top={4} right={8}/>}
        </button>)}
      </div>
      <button onClick={()=>setSession(null)} title="Sair" style={{width:52,padding:"8px 0",borderRadius:12,border:"none",cursor:"pointer",background:"transparent",color:"rgba(255,255,255,.55)",display:"flex",flexDirection:"column",alignItems:"center",gap:4}}><Icon n="logout" size={18}/><span style={{fontSize:9}}>Sair</span></button>
    </aside>}
    <main style={{flex:1,display:"flex",flexDirection:"column",minWidth:0,minHeight:0}}>
      <header style={{background:C.card,borderBottom:`1px solid ${C.line}`,height:isMobile?52:58,flexShrink:0,display:"flex",alignItems:"center",justifyContent:"space-between",padding:isMobile?"0 14px":"0 20px",gap:12}}>
        <div style={{display:"flex",alignItems:"center",gap:12,minWidth:0}}>
          <h1 style={{fontFamily:DISPLAY,color:C.ink,fontSize:isMobile?15.5:17,fontWeight:700,margin:0,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{TITLES[view]}</h1>
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
      {erro&&<div style={{background:C.hotSoft,borderBottom:`1px solid ${C.hot}44`,color:C.hot,fontSize:12.5,padding:"8px 16px",display:"flex",alignItems:"center",gap:8,flexShrink:0}}>
        <Icon n="wifioff" size={14}/><span style={{flex:1}}>{erro}</span>
        <button onClick={()=>setErro("")} style={{border:"none",background:"transparent",color:C.hot,cursor:"pointer",fontWeight:700}}>×</button>
      </div>}
      <div style={{flex:1,minHeight:0}}>
        {/* O corretor tem a caixa de entrada simples; quem supervisiona usa a tela
            completa, com filtros e acesso a qualquer conversa — é a mesma aba. */}
        {role==="corretor"&&view==="atendimento"&&<Atendimento {...{myLeads,sel,abrir:acoes.abrir,draft,setDraft,send,enviando,setStatus,chatRef,conecta,session,acoes,canHandoff:false,availCorretores,isMobile}}/>}
        {/* Quem supervisiona vê o funil da equipe inteira; o corretor, só o dele. */}
        {view==="funil"&&<Funil leads={supervisor?leads:myLeads} openLead={openLead} setStatus={setStatus} isMobile={isMobile} mostrarDono={supervisor}/>}
        {canAttend&&view==="disp"&&<Disponibilidade avail={euDisponivel} toggle={()=>toggleAvail(session.id,euDisponivel)} name={session.name}/>}
        {canAttend&&view==="produtividade"&&<Relatorios acoes={acoes} session={session} isMobile={isMobile}/>}
        {role==="sdr"&&view==="catraca"&&<Catraca {...{fila,pessoas,disponiveis,toggleAvail,acoes,isMobile}}/>}
        {/* Gestor e atendente compartilham as telas de supervisão. */}
        {supervisor&&view==="dashboard"&&<Dashboard {...{acoes,pessoas,fila,setView,openLead,isMobile}}/>}
        {supervisor&&(view==="conversas"||view==="atendimento")&&<Conversas {...{acoes,pessoas,sel,session,chatRef,isMobile,versao}}/>}
        {supervisor&&view==="relatorios"&&<Relatorios acoes={acoes} session={session} pickable isMobile={isMobile}/>}
        {/* Catálogo aberto a todos: é o que tira a equipe do grupo de WhatsApp. */}
        {view==="imoveis"&&<Imoveis {...{acoes,session,pessoas,equipeToda,isMobile,supervisor}}/>}
        {/* Minha conta é igual para os três papéis. */}
        {view==="conta"&&<MinhaConta {...{session,acoes,isMobile}}/>}
        {supervisor&&view==="equipe"&&<Equipe {...{acoes,session,isMobile,versao}}/>}
        {role==="adm"&&view==="base"&&<BaseLeads acoes={acoes} isMobile={isMobile}/>}
        {role==="adm"&&view==="conexao"&&<Conexao conecta={conecta}/>}
      </div>
    </main>
    {isMobile&&<NavCelular nav={NAV} view={view} setView={setView} aviso={aviso}/>}
  </div>;
}

/* Barra inferior do celular. Acima de 5 abas, as extras vão para "Mais" —
   espremer sete ícones em 375px torna todos difíceis de acertar com o dedo. */
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
  const cabem=nav.length<=5?nav:nav.slice(0,4);
  const extras=nav.length<=5?[]:nav.slice(4);
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
      {extras.map(([v,n,label])=><button key={v} onClick={()=>escolher(v)} style={{width:"100%",display:"flex",alignItems:"center",gap:12,padding:"13px 10px",border:"none",borderBottom:`1px solid ${C.line}`,background:"transparent",cursor:"pointer",color:view===v?C.green:C.ink,fontSize:14.5,fontWeight:view===v?700:500}}>
        <Icon n={n} size={19}/><span style={{flex:1,textAlign:"left"}}>{label}</span>
        {aviso(v)>0&&<span style={{minWidth:20,height:20,padding:"0 6px",borderRadius:999,background:C.hot,color:"#fff",fontSize:11,fontWeight:700,display:"flex",alignItems:"center",justifyContent:"center"}}>{aviso(v)}</span>}
      </button>)}
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
function ItemLead({l,ativo,onClick,isMobile,mostrarDono}){
  const naoLida=l.unread>0, espera=Date.now()-(l.lastAt||l.createdAt);
  return <button onClick={onClick} style={{width:"100%",textAlign:"left",padding:isMobile?"13px 14px":"10px 12px",borderBottom:`1px solid ${C.line}`,borderLeft:`3px solid ${ativo?C.green:naoLida?C.hot:"transparent"}`,background:ativo?C.greenSoft:naoLida?"#FFFBFA":"transparent",border:"none",cursor:"pointer",display:"flex",flexDirection:"column",gap:4}}>
    <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",gap:8}}>
      <span style={{color:C.ink,fontSize:13.5,fontWeight:naoLida?700:600,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{l.nome}</span>
      <div style={{display:"flex",alignItems:"center",gap:5,flexShrink:0}}>
        {naoLida&&<span style={{minWidth:18,height:18,padding:"0 5px",borderRadius:999,background:C.hot,color:"#fff",fontSize:10.5,fontWeight:700,display:"flex",alignItems:"center",justifyContent:"center"}}>{l.unread}</span>}
        <Pill c={PRIO[l.prio].c} bg={PRIO[l.prio].bg}>{PRIO[l.prio].label}</Pill>
      </div>
    </div>
    <span style={{color:naoLida?C.ink:C.faint,fontWeight:naoLida?500:400,fontSize:11.5,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>
      {l.lastBody?(l.lastDirection==="in"?"":"Você: ")+l.lastBody:"Novo lead — sem contato"}
    </span>
    <div style={{display:"flex",alignItems:"center",gap:6,marginTop:2,flexWrap:"wrap"}}>
      {naoLida
        ?<span style={{display:"flex",alignItems:"center",gap:4,color:ageColor(espera),fontFamily:MONO,fontSize:11,fontWeight:600}}><Icon n="timer" size={12} color={ageColor(espera)}/>aguardando há {fmtAge(espera)}</span>
        :<span style={{color:STAGE_C[l.status],background:STAGE_C[l.status]+"16",fontSize:10,fontWeight:600,padding:"1px 6px",borderRadius:4}}>{l.status}</span>}
      {mostrarDono&&<span style={{color:C.faint,fontSize:10.5}}>{l.assignedName||"na fila"}</span>}
    </div>
  </button>;
}

/* ===== DIA DA CONVERSA =====
   A faixa "Hoje / Ontem / 12 de julho" que separa os dias, como no WhatsApp.
   Sem ela a conversa vira um bloco só e não dá para saber o que foi falado hoje
   e o que é de semanas atrás. */
const SEMANA=["domingo","segunda-feira","terça-feira","quarta-feira","quinta-feira","sexta-feira","sábado"];
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
function Atendimento({myLeads,sel,abrir,draft,setDraft,send,enviando,setStatus,chatRef,conecta,session,acoes,canHandoff,availCorretores,isMobile}){
  const [filter,setFilter]=useState("Todos");
  // No celular só cabe um painel por vez: lista → conversa → ficha.
  const [pane,setPane]=useState(()=>sel?"chat":"lista");
  const [enviandoImovel,setEnviandoImovel]=useState(false);
  // Avisos do anexo (limite de fotos, microfone negado, GPS bloqueado). Falha de
  // envio já é tratada pelo aviso geral do topo; aqui é o que acontece antes de sair.
  const [erroAnexo,setErroAnexo]=useState("");
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
      <div style={{flex:1,overflowY:"auto",WebkitOverflowScrolling:"touch"}}>
        {list.length===0&&<div style={{color:C.faint,fontSize:13,textAlign:"center",padding:32}}>Nenhum lead aqui 🎉</div>}
        {list.map(l=><ItemLead key={l.id} l={l} ativo={!isMobile&&sel&&sel.id===l.id} onClick={()=>openChat(l.id)} isMobile={isMobile}/>)}
      </div>
    </div>}
    {showChat&&<div style={{flex:1,display:"flex",flexDirection:"column",minWidth:0,minHeight:0,background:C.surface}}>
      <div style={{background:C.card,borderBottom:`1px solid ${C.line}`,height:56,display:"flex",alignItems:"center",justifyContent:"space-between",padding:isMobile?"0 10px":"0 16px",gap:8,flexShrink:0}}>
        <div style={{display:"flex",alignItems:"center",gap:isMobile?8:12,minWidth:0}}>
          {isMobile&&backBtn(()=>setPane("lista"),"Voltar para a lista")}
          <Avatar ini={initials(sel.nome)} color={PRIO[sel.prio].c} size={36}/>
          <div style={{minWidth:0}}><div style={{color:C.ink,fontSize:14,fontWeight:600,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{sel.nome}</div><div style={{color:C.faint,fontSize:11.5,display:"flex",alignItems:"center",gap:4}}><Icon n="phone" size={11}/>{fmtTel(sel.tel)}</div></div>
        </div>
        <div style={{display:"flex",alignItems:"center",gap:7,flexShrink:0}}>
          <BotaoLigar tel={sel.tel} compacto={isMobile} leadId={sel.id} acoes={acoes}/>
          {fichaPorBotao
            ?<button onClick={()=>setPane("ficha")} style={{display:"flex",alignItems:"center",gap:5,border:`1px solid ${C.line}`,background:C.surface,color:C.sub,fontSize:12,fontWeight:600,padding:"7px 12px",borderRadius:10,cursor:"pointer"}}><Icon n="star" size={13} color={PRIO[sel.prio].c} fill={PRIO[sel.prio].c}/> Ficha</button>
            :<div style={{color:conecta.connected?C.green:C.faint,background:conecta.connected?C.greenSoft:C.coolSoft,fontSize:11,fontWeight:600,padding:"4px 10px",borderRadius:999,display:"flex",alignItems:"center",gap:4}}><Icon n={conecta.connected?"wifi":"wifioff"} size={12}/>Número da Conecta</div>}
        </div>
      </div>
      <ControleConversa lead={sel} acoes={acoes} isMobile={isMobile}/>
      <div ref={chatRef} style={{flex:1,overflowY:"auto",WebkitOverflowScrolling:"touch",padding:isMobile?"14px 12px":"16px 20px",display:"flex",flexDirection:"column",gap:8,minHeight:0}}>
        {sel.msgs.length===0&&<div style={{color:C.faint,margin:"auto",textAlign:"center",maxWidth:280}}><Icon n="spark" size={22} color={C.green}/><div style={{fontSize:13,marginTop:8}}>Lead ainda não contatado.<br/>Use um modelo e fale agora — quanto mais rápido, maior a chance.</div></div>}
        {sel.msgs.map((m,i)=>{
          const abreDia=i===0||!mesmoDia(m.at,sel.msgs[i-1].at);
          if(m.from==="system")return <div key={i} style={{alignSelf:"center",background:C.amberSoft,color:"#8a6d1f",fontSize:11,fontWeight:600,padding:"3px 10px",borderRadius:999,margin:"2px 0"}}>{m.text}</div>;
          const mine=m.from==="corretor";const senderName=m.byName||first(session.name);
          return <React.Fragment key={i}>
            {abreDia&&<SeparadorDia ts={m.at}/>}
            <div style={{display:"flex",justifyContent:mine?"flex-end":"flex-start"}}>
            <div style={{maxWidth:isMobile?"86%":"74%",padding:"8px 12px",fontSize:13.5,lineHeight:1.35,borderRadius:16,background:mine?C.green:C.card,color:mine?"#fff":C.ink,border:mine?"none":`1px solid ${C.line}`,boxShadow:"0 1px 2px rgba(0,0,0,.04)",borderBottomRightRadius:mine?4:16,borderBottomLeftRadius:mine?16:4}}>
              {mine&&<div style={{fontSize:10.5,fontWeight:700,color:"rgba(255,255,255,.85)",marginBottom:2}}>{senderName} · Conecta</div>}
              {m.midia&&<Midia m={m} mine={mine} isMobile={isMobile}/>}
              {!m.rotuloAuto&&m.text}<div style={{color:mine?"rgba(255,255,255,.7)":C.faint,fontSize:10,marginTop:2,textAlign:"right"}}>{fmtClock(m.at)}</div>
            </div>
            </div>
          </React.Fragment>;})}
        {sel.finalizado&&sel.finalizadoEm&&<FechoAtendimento lead={sel}/>}
      </div>
      <div style={{background:C.card,borderTop:`1px solid ${C.line}`,padding:12,flexShrink:0}}>
        <div style={{display:"flex",gap:6,marginBottom:8,overflowX:"auto",paddingBottom:4}}>
          <button onClick={()=>setEnviandoImovel(true)} style={{fontSize:11,fontWeight:600,padding:"4px 10px",borderRadius:999,border:`1px solid ${C.green}55`,cursor:"pointer",whiteSpace:"nowrap",display:"flex",alignItems:"center",gap:4,color:C.greenDeep,background:C.card,flexShrink:0}}><Icon n="pin" size={11}/> Enviar imóvel</button>
          {TEMPLATES.map(tp=><button key={tp.t} onClick={()=>setDraft(tp.body)} style={{fontSize:11,fontWeight:500,padding:"4px 10px",borderRadius:999,border:"none",cursor:"pointer",whiteSpace:"nowrap",display:"flex",alignItems:"center",gap:4,color:C.greenMid,background:C.greenSoft,flexShrink:0}}><Icon n="zap" size={11}/> {tp.t}</button>)}
        </div>
        {enviandoImovel&&<EnviarImovel lead={sel} acoes={acoes} isMobile={isMobile} aoFechar={()=>setEnviandoImovel(false)}/>}
        <div style={{display:"flex",alignItems:"flex-end",gap:8}}>
          <Anexar lead={sel} acoes={acoes} isMobile={isMobile} aoAvisar={setErroAnexo}/>
          {/* 16px no celular evita o zoom automático do iOS ao focar o campo */}
          <textarea value={draft} onChange={e=>setDraft(e.target.value)} onKeyDown={e=>{if(e.key==="Enter"&&!e.shiftKey&&!isMobile){e.preventDefault();send();}}} rows={2} placeholder={isMobile?"Escreva a mensagem…":"Escreva a mensagem…  ({nome} vira o primeiro nome do lead)"} style={{flex:1,minWidth:0,fontSize:isMobile?16:13.5,borderRadius:12,border:`1px solid ${C.line}`,padding:"8px 12px",outline:"none",resize:"none",color:C.ink,background:C.surface,fontFamily:FONT}}/>
          <button onClick={send} disabled={enviando||!draft.trim()} style={{width:44,height:44,borderRadius:12,border:"none",cursor:enviando?"default":"pointer",background:enviando||!draft.trim()?C.faint:C.green,color:"#fff",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}><Icon n={enviando?"loader":"send"} size={18} spin={enviando}/></button>
        </div>
        {erroAnexo&&<div onClick={()=>setErroAnexo("")} style={{color:C.hot,background:C.hotSoft,fontSize:11.5,marginTop:6,padding:"6px 9px",borderRadius:8,cursor:"pointer"}}>{erroAnexo}</div>}
        <div style={{color:C.faint,fontSize:10.5,marginTop:6,display:"flex",alignItems:"center",gap:5}}><Icon n="msg" size={11} color={C.faint}/> Sai pelo número da Conecta, assinada como <b style={{color:C.sub}}>&nbsp;{first(session.name)}</b>.</div>
      </div>
    </div>}
    {!isMobile&&!sel&&<div style={{flex:1,background:C.surface}}/>}
    {showFicha&&<div style={{width:fichaPorBotao?"100%":264,flex:fichaPorBotao?1:"none",flexShrink:0,borderLeft:fichaPorBotao?"none":`1px solid ${C.line}`,background:C.card,overflowY:"auto",WebkitOverflowScrolling:"touch",minHeight:0}}>
      <div style={{padding:16}}>
        <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:12}}>
          {fichaPorBotao&&backBtn(()=>setPane("chat"),"Voltar para a conversa")}
          <Icon n="star" size={14} color={PRIO[sel.prio].c} fill={PRIO[sel.prio].c}/><span style={{color:C.ink,fontSize:13,fontWeight:700}}>Ficha do lead</span>
        </div>
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
        <div style={{color:C.faint,fontSize:10.5,marginBottom:12,lineHeight:1.4}}>A etapa avança sozinha conforme a conversa. Você pode ajustar manualmente aqui.</div>
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
function Funil({leads,openLead,setStatus,isMobile,mostrarDono}){
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
    style={{height:"100%",overflowX:"auto",overflowY:"hidden",WebkitOverflowScrolling:"touch",padding:isMobile?12:16,
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
            {items.map(l=>{const waiting=l.firstRespAt==null,age=Date.now()-l.createdAt;
              const sendoArrastado=arrasto&&arrasto.id===l.id;
              return <div key={l.id}
                onPointerDown={(e)=>aoPressionar(e,l)}
                onContextMenu={(e)=>e.preventDefault()}   /* segurar no celular abriria o menu do sistema */
                style={{background:C.card,border:`1px solid ${C.line}`,borderRadius:8,padding:8,
                  opacity:sendoArrastado?.35:1,cursor:arrasto?"grabbing":"grab",touchAction:"pan-x",userSelect:"none"}}>
                <button onClick={()=>{ if(!moveu.current) openLead(l.id); }} style={{width:"100%",textAlign:"left",border:"none",background:"transparent",cursor:"inherit",padding:0}}>
                  <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",gap:4}}><span style={{color:C.ink,fontSize:12,fontWeight:600,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{l.nome}</span><span style={{background:PRIO[l.prio].c,width:6,height:6,borderRadius:"50%",flexShrink:0}}/></div>
                  {mostrarDono&&<div style={{color:C.faint,fontSize:10,marginTop:3,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{l.assignedName||"na fila"}</div>}
                  {waiting&&<div style={{display:"flex",alignItems:"center",gap:4,marginTop:4}}><Icon n="timer" size={10} color={ageColor(age)}/><span style={{color:ageColor(age),fontFamily:MONO,fontSize:10,fontWeight:600}}>{fmtAge(age)}</span></div>}
                </button>
              </div>;})}
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
  </div>;
}

/* ===== DISPONIBILIDADE (corretor) ===== */
function Disponibilidade({avail,toggle,name}){
  return <div style={{height:"100%",overflowY:"auto",WebkitOverflowScrolling:"touch",padding:16}}>
    <div style={{maxWidth:520,margin:"0 auto"}}>
      <div style={{background:C.card,border:`1px solid ${C.line}`,borderRadius:16,padding:24,textAlign:"center"}}>
        <div style={{background:avail?C.greenSoft:C.coolSoft,width:64,height:64,borderRadius:16,display:"flex",alignItems:"center",justifyContent:"center",margin:"0 auto 16px",color:avail?C.green:C.cool}}><Icon n={avail?"toggleOn":"toggleOff"} size={30}/></div>
        <div style={{color:C.ink,fontFamily:DISPLAY,fontSize:18,fontWeight:700}}>{avail?"Você está disponível hoje":"Você está indisponível"}</div>
        <div style={{color:C.sub,fontSize:13,marginTop:6,lineHeight:1.5}}>{avail?"A SDR pode te transferir novos leads da campanha na catraca de hoje.":"Enquanto indisponível, você não entra na catraca e não recebe leads novos. Fale com a SDR e ative aqui."}</div>
        <button onClick={toggle} style={{marginTop:18,background:avail?C.coolSoft:C.green,color:avail?C.sub:"#fff",border:"none",cursor:"pointer",fontSize:14,fontWeight:600,padding:"10px 22px",borderRadius:12}}>{avail?"Ficar indisponível":"Me prontificar para atendimento"}</button>
      </div>
      <div style={{background:C.card,border:`1px solid ${C.line}`,borderRadius:16,padding:20,marginTop:16}}>
        <div style={{color:C.ink,fontSize:13,fontWeight:700,marginBottom:8,display:"flex",alignItems:"center",gap:8}}><Icon n="transfer" size={15} color={C.green}/> Como funciona a catraca</div>
        <div style={{color:C.sub,fontSize:12.5,lineHeight:1.6}}>Só recebe lead quem se prontifica no dia. A SDR confirma a sua disponibilidade e transfere os leads manualmente, um a um, apenas para quem está ativo — mantendo a fila justa.</div>
      </div>
    </div>
  </div>;
}

/* ===== CATRACA (SDR) ===== */
function Catraca({fila,pessoas,disponiveis,toggleAvail,acoes,isMobile}){
  const novos=[...fila].sort((a,b)=>({QUENTE:0,MORNO:1,FRIO:2}[a.prio]-{QUENTE:0,MORNO:1,FRIO:2}[b.prio]));
  const brokers=pessoas, disp=disponiveis;
  const transfer=(leadId,uid)=>acoes.transferir(leadId,uid);
  const catracaNext=(leadId)=>acoes.proximo(leadId);
  return <div style={{height:"100%",overflowY:"auto",WebkitOverflowScrolling:"touch",padding:isMobile?14:20}}>
    <div style={{maxWidth:860,margin:"0 auto"}}>
      {/* roster de disponibilidade */}
      <div style={{background:C.card,border:`1px solid ${C.line}`,borderRadius:16,padding:16,marginBottom:16}}>
        <div style={{color:C.ink,fontSize:13,fontWeight:700,marginBottom:10,display:"flex",alignItems:"center",gap:8}}><Icon n="users" size={15} color={C.green}/> Disponíveis hoje ({disp.length}/{brokers.length})</div>
        <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
          {brokers.length===0&&<span style={{color:C.faint,fontSize:12}}>Ninguém cadastrado ainda — mande o link de cadastro para a equipe.</span>}
          {brokers.map(b=>{const on=b.available;return <button key={b.id} onClick={()=>toggleAvail(b.id,on)} style={{display:"flex",alignItems:"center",gap:8,border:`1px solid ${on?C.green:C.line}`,background:on?C.greenSoft:C.card,borderRadius:999,padding:"5px 12px 5px 5px",cursor:"pointer"}}>
            <Avatar ini={b.ini} color={b.color} size={26}/><span style={{color:C.ink,fontSize:12.5,fontWeight:600}}>{first(b.name)}</span><Icon n={on?"toggleOn":"toggleOff"} size={18} color={on?C.green:C.faint}/></button>;})}
        </div>
        <div style={{color:C.faint,fontSize:11,marginTop:8}}>Clique para marcar quem falou com você e está pronto para atender. Só quem está verde entra na catraca.</div>
      </div>

      <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:12}}>
        <div><div style={{color:C.ink,fontFamily:DISPLAY,fontSize:16,fontWeight:700}}>{novos.length} lead(s) na fila</div><div style={{color:C.faint,fontSize:12}}>Transfira manualmente para quem está disponível.</div></div>
      </div>
      {novos.length===0&&<div style={{background:C.card,border:`1px solid ${C.line}`,borderRadius:16,padding:40,textAlign:"center"}}><Icon n="check" size={30} color={C.green}/><div style={{color:C.ink,fontSize:14,fontWeight:600,marginTop:8}}>Fila zerada</div><div style={{color:C.faint,fontSize:12,marginTop:4}}>Novos leads da campanha caem aqui automaticamente.</div></div>}
      <div style={{display:"flex",flexDirection:"column",gap:10}}>
        {novos.map(l=>{const age=Date.now()-l.createdAt;
          return <div key={l.id} style={{background:C.card,border:`1px solid ${C.line}`,borderRadius:16,padding:12}}>
            <div style={{display:"flex",alignItems:"center",gap:12}}>
              <Avatar ini={initials(l.nome)} color={PRIO[l.prio].c} size={38}/>
              <div style={{minWidth:0,flex:1}}><div style={{display:"flex",alignItems:"center",gap:8,flexWrap:"wrap"}}><span style={{color:C.ink,fontSize:13.5,fontWeight:600}}>{l.nome}</span><Pill c={PRIO[l.prio].c} bg={PRIO[l.prio].bg}>{PRIO[l.prio].label}</Pill></div><div style={{color:C.faint,fontSize:11.5,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{fmtTel(l.tel)} · {l.lastBody||"sem mensagem"}</div></div>
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
  const [escopo,setEscopo]=useState(session.role==="sdr"?"meus":"todos");
  const [f,setF]=useState({atendente:"",etapa:"",prioridade:"",q:"",de:"",ate:""});
  const [rapido,setRapido]=useState("Todos"); // atalhos que existiam na caixa de entrada
  const [filtrosAbertos,setFiltrosAbertos]=useState(false);
  // Quantos filtros detalhados estão ligados. A busca não conta: ela fica sempre à vista.
  const filtrosAtivos=[f.atendente,f.etapa,f.prioridade,f.de,f.ate].filter(Boolean).length;
  const [verFinalizados,setVerFinalizados]=useState(false);
  const [lista,setLista]=useState([]);
  const [carregando,setCarregando]=useState(true);
  const [pane,setPane]=useState("lista");
  const [busca,setBusca]=useState("");

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
  // Atalhos aplicados sobre o resultado já filtrado pelo servidor. "Aguardando"
  // é o cliente esperando resposta — o mesmo sinal vermelho da caixa de entrada.
  const visiveis=useMemo(()=>lista.filter(l=>
    rapido==="Meus"?l.assignedTo===session.id:
    rapido==="Aguardando"?l.unread>0:
    rapido==="Quente"?l.prio==="QUENTE":
    rapido==="Morno"?l.prio==="MORNO":true
  ).sort((a,b)=>(b.unread>0)-(a.unread>0)||(b.lastAt||b.createdAt)-(a.lastAt||a.createdAt)),[lista,rapido,session.id]);

  const abrir=(id)=>{acoes.abrir(id);setPane("chat");};
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
        <div style={{display:"flex",gap:6,flexWrap:"wrap"}}>
          {["Todos","Meus","Aguardando","Quente","Morno"].map(a=><button key={a} onClick={()=>setRapido(a)}
            style={{fontSize:isMobile?12.5:11,fontWeight:500,padding:isMobile?"7px 13px":"5px 11px",borderRadius:999,border:"none",cursor:"pointer",
              background:rapido===a?C.greenDeep:C.surface,color:rapido===a?"#fff":C.sub}}>{a}</button>)}
        </div>
        {/* Os filtros detalhados ficam recolhidos: abertos, empurravam a lista de
            conversas para baixo e sobravam duas visíveis. O contador ao lado do
            botão avisa quando algum está ativo, para ninguém esquecer ligado. */}
        <div style={{display:"flex",alignItems:"center",gap:8}}>
          <button onClick={()=>setFiltrosAbertos(a=>!a)}
            style={{display:"flex",alignItems:"center",gap:6,border:`1px solid ${filtrosAtivos?C.green+"66":C.line}`,background:filtrosAtivos?C.greenSoft:C.surface,color:filtrosAtivos?C.greenDeep:C.sub,borderRadius:9,padding:"6px 11px",fontSize:12,fontWeight:600,cursor:"pointer"}}>
            <Icon n="columns" size={13}/>Filtros
            {filtrosAtivos>0&&<span style={{minWidth:17,height:17,padding:"0 5px",borderRadius:999,background:C.green,color:"#fff",fontSize:10.5,fontWeight:700,display:"flex",alignItems:"center",justifyContent:"center"}}>{filtrosAtivos}</span>}
            <span style={{display:"inline-flex",transform:filtrosAbertos?"rotate(90deg)":"none",transition:"transform .15s"}}><Icon n="chevron" size={13}/></span>
          </button>
          {filtrosAtivos>0&&<button onClick={()=>setF({atendente:"",etapa:"",prioridade:"",q:f.q,de:"",ate:""})}
            style={{border:"none",background:"transparent",color:C.faint,fontSize:11.5,cursor:"pointer",textDecoration:"underline"}}>limpar</button>}
          {/* Atendimento finalizado sai da lista; este é o caminho de volta,
              para consultar ou reabrir sem precisar caçar no funil. */}
          <button onClick={()=>setVerFinalizados(v=>!v)} title="Mostrar também os atendimentos finalizados"
            style={{border:`1px solid ${verFinalizados?C.green+"66":C.line}`,background:verFinalizados?C.greenSoft:C.surface,
              color:verFinalizados?C.greenDeep:C.sub,borderRadius:9,padding:"6px 10px",fontSize:11.5,fontWeight:600,cursor:"pointer",whiteSpace:"nowrap"}}>
            Finalizados</button>
          <span style={{marginLeft:"auto",color:C.faint,fontSize:11}}>{carregando?"Buscando…":`${visiveis.length} conversa(s)`}</span>
        </div>

        {filtrosAbertos&&<React.Fragment>
          <div style={{display:"flex",gap:6,flexWrap:"wrap"}}>
            {selo("Todo mundo",f.atendente,"atendente",[{v:session.id,t:"Comigo"},{v:"fila",t:"Na fila (sem dono)"},...pessoas.map(p=>({v:p.id,t:p.name}))])}
            {selo("Etapa",f.etapa,"etapa",STAGES.map(s=>({v:s,t:s})))}
            {selo("Prioridade",f.prioridade,"prioridade",[{v:"QUENTE",t:"Quente"},{v:"MORNO",t:"Morno"},{v:"FRIO",t:"Frio"}])}
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
      <div style={{flex:1,overflowY:"auto",WebkitOverflowScrolling:"touch"}}>
        {!carregando&&visiveis.length===0&&<div style={{color:C.faint,fontSize:13,textAlign:"center",padding:32}}>Nada encontrado com esses filtros.</div>}
        {visiveis.map(l=><ItemLead key={l.id} l={l} ativo={!isMobile&&sel&&sel.id===l.id} onClick={()=>abrir(l.id)} isMobile={isMobile} mostrarDono/>)}
      </div>
    </div>}

    {mostrarChat?<div style={{flex:1,display:"flex",flexDirection:"column",minWidth:0,minHeight:0,background:C.surface}}>
      <div style={{background:C.card,borderBottom:`1px solid ${C.line}`,padding:"10px 14px",display:"flex",alignItems:"center",gap:10,flexShrink:0}}>
        {isMobile&&<button onClick={()=>setPane("lista")} aria-label="Voltar" style={{width:34,height:34,borderRadius:10,border:"none",background:C.surface,color:C.sub,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",transform:"scaleX(-1)",flexShrink:0}}><Icon n="chevron" size={17}/></button>}
        <Avatar ini={initials(sel.nome)} color={PRIO[sel.prio].c} size={36}/>
        <div style={{minWidth:0,flex:1}}>
          <div style={{color:C.ink,fontSize:14,fontWeight:600,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{sel.nome}</div>
          <div style={{color:C.faint,fontSize:11.5}}>{fmtTel(sel.tel)} · {sel.assignedName?"com "+first(sel.assignedName):"na fila"}</div>
        </div>
        <BotaoLigar tel={sel.tel} compacto leadId={sel.id} acoes={acoes}/>
        {fichaPorBotao&&<button onClick={()=>setPane("ficha")} style={{display:"flex",alignItems:"center",gap:5,border:`1px solid ${C.line}`,background:C.surface,color:C.sub,fontSize:12,fontWeight:600,padding:"7px 12px",borderRadius:10,cursor:"pointer",flexShrink:0}}><Icon n="star" size={13} color={PRIO[sel.prio].c} fill={PRIO[sel.prio].c}/> Ficha</button>}
      </div>
      {/* A supervisão não mexe na caixa alheia: quem está olhando controla o que
          é dele. Lead na fila também entra — não é de ninguém, então não há aviso
          de corretor para apagar, e alguém precisa poder encerrar. */}
      {(sel.assignedTo===session.id||!sel.assignedTo)&&<ControleConversa lead={sel} acoes={acoes} isMobile={isMobile}/>}
      <BarraControleADM lead={sel} session={session} pessoas={pessoas} acoes={acoes} isMobile={isMobile}/>
      <div ref={chatRef} style={{flex:1,overflowY:"auto",WebkitOverflowScrolling:"touch",padding:isMobile?"14px 12px":"16px 20px",display:"flex",flexDirection:"column",gap:8,minHeight:0}}>
        {sel.msgs.length===0&&<div style={{color:C.faint,margin:"auto",fontSize:13}}>Nenhuma mensagem trocada ainda.</div>}
        {sel.msgs.map((m,i)=>{
          const abreDia=i===0||!mesmoDia(m.at,sel.msgs[i-1].at);
          const meu=m.from==="corretor";
          return <React.Fragment key={i}>
            {abreDia&&<SeparadorDia ts={m.at}/>}
            <div style={{display:"flex",justifyContent:meu?"flex-end":"flex-start"}}>
            <div style={{maxWidth:isMobile?"86%":"74%",padding:"8px 12px",fontSize:13.5,lineHeight:1.35,borderRadius:16,background:meu?C.green:C.card,color:meu?"#fff":C.ink,border:meu?"none":`1px solid ${C.line}`,borderBottomRightRadius:meu?4:16,borderBottomLeftRadius:meu?16:4}}>
              {meu&&<div style={{fontSize:10.5,fontWeight:700,color:"rgba(255,255,255,.85)",marginBottom:2}}>{m.byName||"Conecta"}</div>}
              {m.midia&&<Midia m={m} mine={meu} isMobile={isMobile}/>}
              {!m.rotuloAuto&&m.text}<div style={{color:meu?"rgba(255,255,255,.7)":C.faint,fontSize:10,marginTop:2,textAlign:"right"}}>{fmtClock(m.at)}</div>
            </div>
            </div>
          </React.Fragment>;})}
        {sel.finalizado&&sel.finalizadoEm&&<FechoAtendimento lead={sel}/>}
      </div>
      <ComporADM lead={sel} session={session} acoes={acoes} isMobile={isMobile}/>
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
function FichaLead({lead,acoes,corretoresDisponiveis,aoVoltar,largura}){
  const [simulando,setSimulando]=useState(false);
  // Ocupa o lugar da ficha, como o cadastro de imóveis faz. Sem sobreposição,
  // não há barra do celular por cima nem disputa de camada.
  if(simulando) return <div style={{width:largura,flex:aoVoltar?1:"none",flexShrink:0,borderLeft:aoVoltar?"none":`1px solid ${C.line}`,background:C.card,minHeight:0,height:"100%"}}>
    <Simulacao lead={lead} acoes={acoes} isMobile={largura==="100%"} aoFechar={()=>setSimulando(false)}/>
  </div>;
  return <div style={{width:largura,flex:aoVoltar?1:"none",flexShrink:0,borderLeft:aoVoltar?"none":`1px solid ${C.line}`,background:C.card,overflowY:"auto",WebkitOverflowScrolling:"touch",minHeight:0}}>
    <div style={{padding:16}}>
      <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:12}}>
        {aoVoltar&&<button onClick={aoVoltar} aria-label="Voltar para a conversa" style={{width:34,height:34,borderRadius:10,border:"none",background:C.surface,color:C.sub,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",transform:"scaleX(-1)",flexShrink:0}}><Icon n="chevron" size={17}/></button>}
        <Icon n="star" size={14} color={PRIO[lead.prio].c} fill={PRIO[lead.prio].c}/>
        <span style={{color:C.ink,fontSize:13,fontWeight:700}}>Ficha do lead</span>
      </div>

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
      <div style={{color:C.faint,fontSize:10.5,marginBottom:12,lineHeight:1.4}}>A etapa avança sozinha conforme a conversa. Você pode ajustar aqui.</div>

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
function ComporADM({lead,session,acoes,isMobile}){
  const [draft,setDraft]=useState("");
  const [enviando,setEnviando]=useState(false);
  const [enviandoImovel,setEnviandoImovel]=useState(false);
  const [erroAnexo,setErroAnexo]=useState("");
  useEffect(()=>setDraft(""),[lead.id]);

  async function enviar(){
    if(!draft.trim()||enviando) return;
    const texto=draft.replace("{nome}",first(lead.nome));
    setEnviando(true); setDraft("");
    try{ await acoes.enviar(lead.id,texto); } finally{ setEnviando(false); }
  }

  return <div style={{background:C.card,borderTop:`1px solid ${C.line}`,padding:12,flexShrink:0}}>
    <div style={{display:"flex",gap:6,marginBottom:8,overflowX:"auto",paddingBottom:4}}>
      <button onClick={()=>setEnviandoImovel(true)} style={{fontSize:11,fontWeight:600,padding:"4px 10px",borderRadius:999,border:`1px solid ${C.green}55`,cursor:"pointer",whiteSpace:"nowrap",display:"flex",alignItems:"center",gap:4,color:C.greenDeep,background:C.card,flexShrink:0}}><Icon n="pin" size={11}/> Enviar imóvel</button>
      {TEMPLATES.map(tp=><button key={tp.t} onClick={()=>setDraft(tp.body)} style={{fontSize:11,fontWeight:500,padding:"4px 10px",borderRadius:999,border:"none",cursor:"pointer",whiteSpace:"nowrap",display:"flex",alignItems:"center",gap:4,color:C.greenMid,background:C.greenSoft,flexShrink:0}}><Icon n="zap" size={11}/> {tp.t}</button>)}
    </div>
    {enviandoImovel&&<EnviarImovel lead={lead} acoes={acoes} isMobile={isMobile} aoFechar={()=>setEnviandoImovel(false)}/>}
    <div style={{display:"flex",alignItems:"flex-end",gap:8}}>
      <Anexar lead={lead} acoes={acoes} isMobile={isMobile} aoAvisar={setErroAnexo}/>
      <textarea value={draft} onChange={e=>setDraft(e.target.value)}
        onKeyDown={e=>{if(e.key==="Enter"&&!e.shiftKey&&!isMobile){e.preventDefault();enviar();}}}
        rows={2} placeholder="Responder como direção…"
        style={{flex:1,minWidth:0,fontSize:isMobile?16:13.5,borderRadius:12,border:`1px solid ${C.line}`,padding:"8px 12px",outline:"none",resize:"none",color:C.ink,background:C.surface,fontFamily:FONT}}/>
      <button onClick={enviar} disabled={enviando||!draft.trim()} style={{width:44,height:44,borderRadius:12,border:"none",cursor:enviando?"default":"pointer",background:enviando||!draft.trim()?C.faint:C.green,color:"#fff",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}><Icon n={enviando?"loader":"send"} size={18} spin={enviando}/></button>
    </div>
    {erroAnexo&&<div onClick={()=>setErroAnexo("")} style={{color:C.hot,background:C.hotSoft,fontSize:11.5,marginTop:6,padding:"6px 9px",borderRadius:8,cursor:"pointer"}}>{erroAnexo}</div>}
    <div style={{color:C.faint,fontSize:10.5,marginTop:6,display:"flex",alignItems:"center",gap:5}}>
      <Icon n="msg" size={11} color={C.faint}/> Sai pelo número da Conecta, assinada como <b style={{color:C.sub}}>&nbsp;{first(session.name)}</b>.
    </div>
  </div>;
}

/* ===== MINHA CONTA =====
   Igual para corretor, atendente e gestor. Cada um cuida dos próprios dados. */
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

  return <div style={{height:"100%",overflowY:"auto",WebkitOverflowScrolling:"touch",padding:isMobile?14:20}}>
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
  return <div style={{height:"100%",overflowY:"auto",WebkitOverflowScrolling:"touch",background:C.card,
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
function BaseLeads({acoes,isMobile}){
  const [lista,setLista]=useState(null);
  const [busca,setBusca]=useState("");
  const [baixando,setBaixando]=useState(false);
  const [erro,setErro]=useState("");

  useEffect(()=>{let vivo=true;
    acoes.buscar({finalizados:"1"}).then(r=>vivo&&setLista(r)).catch(e=>vivo&&setErro(e.message));
    return()=>{vivo=false;};},[]);

  const baixar=async()=>{ setErro(""); setBaixando(true);
    try{ await acoes.baixarLeads(); }catch(e){ setErro(e.message); } finally{ setBaixando(false); } };

  const arquivo=useRef(null);
  const [subindo,setSubindo]=useState(false);
  const [resultado,setResultado]=useState(null);

  async function importar(e){
    const f=e.target.files[0]; e.target.value=""; if(!f) return;
    setErro(""); setResultado(null); setSubindo(true);
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
        origem:pegar(l,"origem")||("Importado de "+f.name.replace(/\.[^.]+$/,"")),
        temperatura:pegar(l,"temperatura"), etapa:pegar(l,"etapa"),
        corretor:pegar(l,"corretor"), entrou_em:pegar(l,"entrou_em"),
      }));
      const r=await acoes.importarLeads(dados);
      setResultado(r);
      const atualizada=await acoes.buscar({finalizados:"1"});
      setLista(atualizada);
    }catch(err){ setErro(err.message); }
    finally{ setSubindo(false); }
  }

  const filtrados=(lista||[]).filter(l=>{
    const t=busca.trim().toLowerCase();
    return !t||[l.nome,l.tel,l.assignedName,l.status].some(v=>String(v||"").toLowerCase().includes(t));
  });
  const cel={padding:"9px 8px",fontSize:12,color:C.sub,whiteSpace:"nowrap"};

  return <div style={{height:"100%",overflowY:"auto",WebkitOverflowScrolling:"touch",padding:isMobile?14:20}}>
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
          <input ref={arquivo} type="file" accept=".csv,text/csv" onChange={importar} style={{display:"none"}}/>
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
          <tbody>{filtrados.map(l=><tr key={l.id} style={{borderBottom:`1px solid ${C.line}`}}>
            <td style={{...cel,color:C.ink,fontWeight:600}}>{l.nome}</td>
            <td style={{...cel,fontFamily:MONO}}>{fmtTel(l.tel)}</td>
            <td style={cel}>{l.origem}</td>
            <td style={cel}><span style={{color:PRIO[l.prio].c,fontWeight:700,fontSize:11}}>{PRIO[l.prio].label}</span></td>
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
function ScoreEquipe({acoes,isMobile}){
  const [d,setD]=useState(null);
  const [dias,setDias]=useState(90);
  useEffect(()=>{let vivo=true; setD(null);
    acoes.score(dias).then(x=>vivo&&setD(x)).catch(()=>{});
    return()=>{vivo=false;};},[dias]);

  const cor=(n)=>n==null?C.faint:n>=70?C.green:n>=45?C.amber:C.hot;
  const celula={padding:"9px 8px",fontSize:12,color:C.sub,whiteSpace:"nowrap"};

  return <div style={{background:C.card,border:`1px solid ${C.line}`,borderRadius:14,padding:isMobile?13:16,marginBottom:16}}>
    <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:4,flexWrap:"wrap"}}>
      <Icon n="award" size={16} color={C.greenMid}/>
      <span style={{color:C.ink,fontSize:13.5,fontWeight:700}}>Score de performance</span>
      <select value={dias} onChange={e=>setDias(Number(e.target.value))}
        style={{marginLeft:"auto",fontSize:12,border:`1px solid ${C.line}`,background:C.surface,color:C.sub,borderRadius:8,padding:"5px 8px",outline:"none"}}>
        {[30,60,90,180].map(x=><option key={x} value={x}>últimos {x} dias</option>)}
      </select>
    </div>
    <div style={{color:C.faint,fontSize:11,marginBottom:10,lineHeight:1.45}}>
      Conversão, tempo de resposta, visitas, perdas, vendas e ligações — pesados nessa ordem.
    </div>
    {!d&&<div style={{color:C.faint,fontSize:12,padding:"10px 0"}}>Calculando…</div>}
    {d&&<div style={{overflowX:"auto"}}>
      <table style={{width:"100%",borderCollapse:"collapse",minWidth:520}}>
        <thead><tr style={{borderBottom:`1px solid ${C.line}`}}>
          {["#","Corretor","Score","Conversão","1ª resposta","Atendimento","Visitas","Perdas","Vendas","Ligações"].map((h,i)=>
            <th key={h} style={{...celula,fontWeight:700,color:C.faint,fontSize:10.5,textTransform:"uppercase",textAlign:i<2?"left":"right"}}>{h}</th>)}
        </tr></thead>
        <tbody>{d.equipe.map((m,i)=><tr key={m.id} style={{borderBottom:`1px solid ${C.line}`}}>
          <td style={{...celula,fontFamily:MONO,color:C.faint}}>{m.sem_dados?"–":i+1}</td>
          <td style={{...celula,color:C.ink,fontWeight:600}}>{m.nome}{m.papel==="sdr"&&<span style={{color:C.faint,fontWeight:400}}> · atendente</span>}</td>
          <td style={{...celula,textAlign:"right"}}>
            {m.sem_dados?<span style={{color:C.faint,fontSize:11}}>sem dados</span>
              :<span style={{fontFamily:MONO,fontSize:15,fontWeight:700,color:cor(m.score)}}>{m.score}</span>}</td>
          <td style={{...celula,textAlign:"right"}}>{m.sem_dados?"—":m.conversao+"%"}</td>
          <td style={{...celula,textAlign:"right"}}>{m.resposta_min==null?"—":fmtMin(m.resposta_min)}</td>
          {/* Espera média a cada pergunta do cliente, não só a primeira. */}
          <td style={{...celula,textAlign:"right"}}>{m.atendimento_min==null?"—":fmtMin(m.atendimento_min)}</td>
          <td style={{...celula,textAlign:"right"}}>{m.sem_dados?"—":m.visitas}</td>
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

  useEffect(()=>{let vivo=true;
    const t=setTimeout(()=>acoes.produtos({status:"ativo",q:busca}).then(r=>vivo&&setLista(r)).catch(e=>vivo&&setErro(e.message)),300);
    return()=>{vivo=false;clearTimeout(t);};},[busca]);

  async function enviar(){
    if(!sel||enviando) return;
    setEnviando(true); setErro("");
    try{ await acoes.enviarProduto(lead.id,{produto_id:sel.id,...opc}); aoFechar(); }
    catch(e){ setErro(e.message); setEnviando(false); }
  }
  const marca=(chave,texto,aviso)=><label style={{display:"flex",alignItems:"flex-start",gap:9,cursor:"pointer",padding:"9px 10px",borderRadius:9,background:opc[chave]?C.greenSoft:C.surface,border:`1px solid ${opc[chave]?C.green+"55":C.line}`}}>
    <input type="checkbox" checked={opc[chave]} onChange={e=>setOpc({...opc,[chave]:e.target.checked})} style={{width:17,height:17,marginTop:1,accentColor:C.green}}/>
    <span style={{fontSize:13,color:C.ink}}>{texto}{aviso&&<span style={{display:"block",color:C.faint,fontSize:11,marginTop:2}}>{aviso}</span>}</span>
  </label>;

  return <div style={{position:"fixed",inset:0,zIndex:40,background:"rgba(0,0,0,.4)",display:"flex",alignItems:isMobile?"flex-end":"center",justifyContent:"center",padding:isMobile?0:20}} onClick={aoFechar}>
    <div onClick={e=>e.stopPropagation()} style={{background:C.card,width:"100%",maxWidth:520,maxHeight:isMobile?"88vh":"84vh",borderRadius:isMobile?"18px 18px 0 0":16,display:"flex",flexDirection:"column",overflow:"hidden"}}>
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
        {marca("fotos",`Enviar as ${(sel.midias||[]).filter(m=>m.tipo==="foto").length} foto(s)`)}
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
  const [f,setF]=useState({q:"",tipo:"",cidade:"",bairro:"",quartos:"",valor_max:"",modalidade:"",status:""});
  const [busca,setBusca]=useState("");
  const [lista,setLista]=useState(null);
  const [opcoes,setOpcoes]=useState({cidades:[],bairros:[]});
  const [erro,setErro]=useState("");
  const [editando,setEditando]=useState(null); // objeto do produto, ou "novo"
  const [aberto,setAberto]=useState(null);     // produto em detalhe
  const [recarga,setRecarga]=useState(0);
  const [filtrosAbertos,setFiltrosAbertos]=useState(false);
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

  return <div style={{height:"100%",overflowY:"auto",WebkitOverflowScrolling:"touch",padding:isMobile?14:20}}>
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

  // Aceita vários arquivos de uma vez. Sobem em fila, um de cada vez: dez fotos
  // em paralelo derrubariam o servidor e o corretor não saberia qual falhou.
  async function enviarArquivo(ev){
    const arquivos=[...(ev.target.files||[])];
    ev.target.value="";
    if(!arquivos.length) return;

    // As fotos precisam de um dono, então o produto é salvo antes.
    let alvo=id;
    if(!alvo){ alvo=await salvar(); if(!alvo){ setErro("Confira os dados do produto antes de enviar as fotos."); return; } }

    setSubindo(true); setErro("");
    const problemas=[];
    for(let i=0;i<arquivos.length;i++){
      const arq=arquivos[i];
      setProgresso(`Enviando ${i+1} de ${arquivos.length}…`);
      try{
        const base64=await new Promise((ok,falhou)=>{const fr=new FileReader();fr.onload=()=>ok(fr.result);fr.onerror=falhou;fr.readAsDataURL(arq);});
        const r=await acoes.subirMidia(alvo,arq.type,base64);
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

  return <div style={{height:"100%",overflowY:"auto",WebkitOverflowScrolling:"touch",padding:isMobile?14:20}}>
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
            <input type="file" multiple accept="image/jpeg,image/png,image/webp,video/mp4,video/quicktime" onChange={enviarArquivo} disabled={subindo} style={{display:"none"}}/>
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

  return <div style={{height:"100%",overflowY:"auto",WebkitOverflowScrolling:"touch",padding:isMobile?14:20}}>
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

function Equipe({acoes,session,isMobile,versao}){
  const [users,setUsers]=useState(null);
  const [erro,setErro]=useState("");
  const [copiado,setCopiado]=useState(false);
  const [removendo,setRemovendo]=useState(null); // id de quem está no painel de saída

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
  const apagar=async(u)=>{ setErro("");
    if(!window.confirm(`Apagar o cadastro de ${u.name} definitivamente?\n\nIsso não pode ser desfeito. As conversas antigas continuam guardadas, mas o cadastro some da plataforma.`)) return;
    try{ await acoes.apagarCadastro(u.id); setUsers(await acoes.equipe()); }
    catch(e){ setErro(e.message); } };
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
  </div>;

  return <div style={{height:"100%",overflowY:"auto",WebkitOverflowScrolling:"touch",padding:isMobile?14:20}}>
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

/* ===== CONEXÃO (ADM, número único) ===== */
function Conexao({conecta}){
  const isMobile=useIsMobile();
  return <div style={{height:"100%",overflowY:"auto",WebkitOverflowScrolling:"touch",padding:isMobile?14:24}}>
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

function Relatorios({acoes,session,pickable,isMobile}){
  const [periodo,setPeriodo]=useState({de:diasAtras(30),ate:hojeISO()});
  const [dados,setDados]=useState(null);
  const [carregando,setCarregando]=useState(true);
  const [sel,setSel]=useState(null);

  useEffect(()=>{
    let vivo=true; setCarregando(true);
    acoes.relatorio(periodo).then(d=>{if(vivo){setDados(d);setCarregando(false);
      setSel(p=>p&&d.atendentes.some(a=>a.id===p)?p:(d.atendentes[0]||{}).id);}}).catch(()=>vivo&&setCarregando(false));
    return()=>{vivo=false;};
  },[periodo.de,periodo.ate]);

  const atalho=(label,dias)=><button key={label} onClick={()=>setPeriodo({de:diasAtras(dias),ate:hojeISO()})}
    style={{fontSize:12,fontWeight:600,padding:"6px 11px",borderRadius:999,border:"none",cursor:"pointer",
      background:periodo.de===diasAtras(dias)?C.greenDeep:C.surface,color:periodo.de===diasAtras(dias)?"#fff":C.sub}}>{label}</button>;

  if(carregando&&!dados) return <div style={{height:"100%",display:"flex",alignItems:"center",justifyContent:"center",color:C.faint,fontSize:13,gap:8}}><Icon n="loader" size={16} spin/> Calculando…</div>;
  if(!dados) return <div style={{padding:24,color:C.faint}}>Não consegui carregar o relatório.</div>;

  const linha=dados.atendentes.find(a=>a.id===sel)||dados.atendentes[0];

  return <div style={{height:"100%",overflowY:"auto",WebkitOverflowScrolling:"touch",padding:isMobile?14:20}}>
    <div style={{maxWidth:920,margin:"0 auto"}}>
      <div style={{background:C.card,border:`1px solid ${C.line}`,borderRadius:16,padding:14,marginBottom:16}}>
        <div style={{display:"flex",gap:7,flexWrap:"wrap",marginBottom:10}}>
          {atalho("7 dias",7)}{atalho("30 dias",30)}{atalho("90 dias",90)}
        </div>
        <div style={{display:"flex",gap:8,alignItems:"center",flexWrap:"wrap"}}>
          <span style={{color:C.faint,fontSize:11.5,fontWeight:600}}>De</span>
          <input type="date" value={periodo.de} onChange={e=>setPeriodo({...periodo,de:e.target.value})} style={{fontSize:isMobile?16:12.5,border:`1px solid ${C.line}`,borderRadius:8,padding:"6px 8px",background:C.surface,color:C.ink,outline:"none"}}/>
          <span style={{color:C.faint,fontSize:11.5,fontWeight:600}}>até</span>
          <input type="date" value={periodo.ate} onChange={e=>setPeriodo({...periodo,ate:e.target.value})} style={{fontSize:isMobile?16:12.5,border:`1px solid ${C.line}`,borderRadius:8,padding:"6px 8px",background:C.surface,color:C.ink,outline:"none"}}/>
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
      {pickable&&<ScoreEquipe acoes={acoes} isMobile={isMobile}/>}
      {pickable&&dados.atendentes.length>0&&<div style={{display:"flex",gap:8,marginBottom:16,overflowX:"auto",paddingBottom:4}}>
        {dados.atendentes.map(a=><button key={a.id} onClick={()=>setSel(a.id)} style={{flexShrink:0,display:"flex",alignItems:"center",gap:8,border:`1px solid ${sel===a.id?C.green:C.line}`,background:sel===a.id?C.greenSoft:C.card,borderRadius:999,padding:"4px 12px 4px 4px",cursor:"pointer"}}>
          <Avatar ini={initials(a.nome)} color={COLORS[[...a.id].reduce((s,c)=>s+c.charCodeAt(0),0)%COLORS.length]} size={26}/>
          <span style={{color:C.ink,fontSize:13,fontWeight:500}}>{first(a.nome)}</span></button>)}
      </div>}

      {!linha?<div style={{background:C.card,border:`1px solid ${C.line}`,borderRadius:16,padding:32,textAlign:"center",color:C.faint,fontSize:13}}>Nenhum atendente cadastrado ainda.</div>
      :<React.Fragment>
        <div style={{background:C.card,border:`1px solid ${C.line}`,borderRadius:16,padding:16,marginBottom:16,display:"flex",alignItems:"center",gap:12,flexWrap:"wrap"}}>
          <Avatar ini={initials(linha.nome)} color={COLORS[[...linha.id].reduce((s,c)=>s+c.charCodeAt(0),0)%COLORS.length]} size={46}/>
          <div style={{minWidth:0}}>
            <div style={{color:C.ink,fontFamily:DISPLAY,fontSize:isMobile?16:18,fontWeight:700}}>{linha.nome}</div>
            <div style={{color:C.faint,fontSize:12}}>{linha.papel==="sdr"?"SDR":"Corretor(a)"} · {fmtData(dados.periodo.de)} a {fmtData(dados.periodo.ate)}</div>
          </div>
          <div style={{marginLeft:"auto",textAlign:"right"}}>
            <div style={{color:linha.primeira_resposta_mediana_min<=10?C.green:linha.primeira_resposta_mediana_min<=30?C.amber:C.hot,fontFamily:MONO,fontSize:isMobile?26:30,fontWeight:600,lineHeight:1}}>{fmtMin(linha.primeira_resposta_mediana_min)}</div>
            <div style={{color:C.faint,fontSize:11,marginTop:4}}>1ª resposta (mediana)</div>
            {linha.atendimento_mediana_min!=null&&<div style={{color:C.sub,fontSize:11.5,marginTop:7,paddingTop:7,borderTop:`1px solid ${C.line}`}}>
              Atendimento: <b style={{fontFamily:MONO}}>{fmtMin(linha.atendimento_mediana_min)}</b>
              <div style={{color:C.faint,fontSize:10.5,marginTop:2}}>espera média a cada pergunta do cliente</div>
            </div>}
          </div>
        </div>

        <div style={{display:"flex",gap:12,flexWrap:"wrap",marginBottom:16}}>
          <Metric n="users" label="Recebidos" value={linha.recebidos} accent={C.cool}/>
          <Metric n="msg" label="Atendidos" value={linha.atendidos} sub={linha.taxa_atendimento+"% de resposta"} accent={C.green}/>
          <Metric n="calendar" label="Agendados / visitas" value={linha.agendamentos} accent="#3B7BC4"/>
          <Metric n="check" label="Vendas" value={linha.vendas} sub={fmtMoeda(linha.valor_vendido)} accent={C.greenDeep}/>
        </div>

        <div style={{background:C.card,border:`1px solid ${C.line}`,borderRadius:16,padding:16}}>
          <div style={{color:C.ink,fontSize:13,fontWeight:700,marginBottom:12}}>Avanço pelas etapas do funil</div>
          {STAGES.map(st=>{const v=linha.por_etapa[st]||0,pct=linha.recebidos?v/linha.recebidos*100:0;
            return <div key={st} style={{display:"flex",alignItems:"center",gap:8,marginBottom:8}}>
              <span style={{color:C.sub,fontSize:11.5,width:isMobile?104:150,flexShrink:0,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{st}</span>
              <div style={{height:10,borderRadius:999,background:C.surface,flex:1,overflow:"hidden"}}><div style={{width:Math.max(pct,v?6:0)+"%",height:"100%",borderRadius:999,background:STAGE_C[st]}}/></div>
              <span style={{color:C.ink,fontFamily:MONO,fontSize:12,fontWeight:600,width:20,textAlign:"right"}}>{v}</span>
            </div>;})}
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

  return <div style={{height:"100%",overflowY:"auto",WebkitOverflowScrolling:"touch",padding:isMobile?14:20}}>
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

ReactDOM.createRoot(document.getElementById("root")).render(<Rede><ConCRM/></Rede>);
